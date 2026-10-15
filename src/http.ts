#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contextFromEnv, type ShopContext } from "./context.js";
import { asGrokShopError, errorBody } from "./errors.js";
import { approveInput } from "./schemas.js";
import { approveCheckout, getCheckout } from "./service.js";
import { TOOL_NAMES, callTool, isToolName } from "./tools.js";

const MAX_BODY = 1_000_000;

export type HttpServerHandle = {
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
};

export function startHttpServer(options?: {
  context?: ShopContext;
  host?: string;
  port?: number;
}): Promise<HttpServerHandle> {
  const base = options?.context ?? contextFromEnv();
  const ctx: ShopContext = {
    ...base,
    httpHost: options?.host ?? base.httpHost,
    httpPort: options?.port ?? base.httpPort,
  };

  const server = createServer((req, res) => {
    void handle(req, res, ctx).catch((err: unknown) => {
      sendJson(res, 500, errorBody(err));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(ctx.httpPort, ctx.httpHost, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("HTTP server did not bind a TCP port"));
        return;
      }
      const host = ctx.httpHost;
      const port = address.port;
      if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
        process.stderr.write(
          "grokshop http: tool routes are unauthenticated. Bind to 127.0.0.1 unless you are adding your own auth.\n",
        );
      }
      resolve({
        url: `http://${host}:${port}`,
        host,
        port,
        close: () =>
          new Promise((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: ShopContext): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (method === "GET" && pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "grokshop",
      merchant_catalog: ctx.catalogPath,
      shipping_mode: ctx.shippingMode,
      payments_mode: ctx.paymentsMode,
      live_shipping: false,
      live_payments: false,
    });
    return;
  }

  if (method === "GET" && pathname === "/tools") {
    sendJson(res, 200, {
      tools: TOOL_NAMES,
      approval: "POST /checkouts/:id/approve with Authorization: Bearer <GROKSHOP_APPROVAL_SECRET>. Not an MCP tool.",
    });
    return;
  }

  const checkoutMatch = pathname.match(/^\/checkouts\/(chk_[a-f0-9]+)$/);
  if (method === "GET" && checkoutMatch?.[1]) {
    try {
      sendJson(res, 200, getCheckout(checkoutMatch[1], ctx));
    } catch (err) {
      const normalized = asGrokShopError(err);
      sendJson(res, normalized.status, errorBody(normalized));
    }
    return;
  }

  const approveMatch = pathname.match(/^\/checkouts\/(chk_[a-f0-9]+)\/approve$/);
  if (method === "POST" && approveMatch?.[1]) {
    await approveHttp(req, res, ctx, approveMatch[1]);
    return;
  }

  const toolMatch = pathname.match(/^\/tools\/([a-z_]+)$/);
  if (method === "POST" && toolMatch?.[1]) {
    if (!isToolName(toolMatch[1])) {
      sendJson(res, 404, {
        error: {
          code: "unknown_tool",
          message: `Unknown tool ${toolMatch[1]}. Approval is not a tool; POST /checkouts/:id/approve.`,
        },
      });
      return;
    }
    const body = await readJson(req);
    try {
      sendJson(res, 200, callTool(toolMatch[1], body, ctx));
    } catch (err) {
      const normalized = asGrokShopError(err);
      sendJson(res, normalized.status, errorBody(normalized));
    }
    return;
  }

  sendJson(res, 404, { error: { code: "not_found", message: `No route ${method} ${pathname}` } });
}

async function approveHttp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ShopContext,
  checkoutId: string,
): Promise<void> {
  if (!ctx.approvalSecret) {
    sendJson(res, 503, {
      error: {
        code: "approval_secret_unset",
        message: "Set GROKSHOP_APPROVAL_SECRET before using HTTP approval. The local CLI does not need it.",
      },
    });
    return;
  }
  const header = req.headers.authorization;
  if (!bearerMatches(header, ctx.approvalSecret)) {
    sendJson(res, 401, { error: { code: "unauthorized", message: "Bearer token does not match GROKSHOP_APPROVAL_SECRET" } });
    return;
  }
  const body = await readJson(req);
  try {
    const note = approveInput.parse(body ?? {}).note;
    sendJson(res, 200, approveCheckout(checkoutId, "http", ctx, note));
  } catch (err) {
    const normalized = asGrokShopError(err);
    sendJson(res, normalized.status, errorBody(normalized));
  }
}

function bearerMatches(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  if (!match?.[1]) return false;
  const got = Buffer.from(match[1]);
  const expected = Buffer.from(secret);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(asGrokShopError(new Error("Request body exceeds 1 MB")));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(asGrokShopError(new Error("Request body is not JSON")));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isDirectRun()) {
  const ctx = contextFromEnv();
  startHttpServer({ context: ctx })
    .then((handle) => {
      process.stderr.write(`grokshop http listening on ${handle.url}\n`);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`grokshop http failed: ${message}\n`);
      process.exit(1);
    });
}
