#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  authenticate,
  loadPublicAccount,
  login,
  recordCheckout,
  signup,
  assertCheckoutCapacity,
  consumeToolCall,
  type AccountRecord,
  type AccountStore,
  type IssuedAccount,
} from "./accounts.js";
import { defaultCatalogPath, type ShopContext } from "./context.js";
import { asGrokShopError, errorBody, GrokShopError } from "./errors.js";
import { FREE_CHECKOUTS_PER_DAY, FREE_TOOL_CALLS_PER_DAY, readPositiveInt } from "./limits.js";
import { renderError, renderHome, renderIssuedKey, type PageInfo } from "./pages.js";
import { approveInput } from "./schemas.js";
import { createGrokShopServer } from "./server.js";
import { approveCheckout, getCheckout } from "./service.js";

const MAX_BODY = 1_000_000;

const APPROVAL_HINT =
  "confirm_order refused: {checkout_id} has no stored human approval. Approve outside MCP with POST /checkouts/{checkout_id}/approve and Authorization: Bearer <your API key>. There is no approve tool.";

type LiveSession = {
  transport: StreamableHTTPServerTransport;
  accountId: string;
  close: () => Promise<void>;
};

export type RemoteServerOptions = {
  dataDir?: string;
  host?: string;
  port?: number;
  publicUrl?: string;
  toolCallsPerDay?: number;
  checkoutsPerDay?: number;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
};

export type RemoteServerHandle = {
  url: string;
  host: string;
  port: number;
  publicUrl: string;
  mcpUrl: string;
  close: () => Promise<void>;
};

type Host = {
  store: AccountStore;
  host: string;
  port: number;
  page: PageInfo;
  sessions: Map<string, LiveSession>;
};

export function assertHostedModes(env: NodeJS.ProcessEnv): void {
  const shipping = (env.GROKSHOP_SHIPPING_MODE ?? "stub").trim().toLowerCase();
  const payments = (env.GROKSHOP_PAYMENTS_MODE ?? "stub").trim().toLowerCase();
  if (shipping !== "stub") {
    throw new Error(
      `Hosted GrokShop refuses GROKSHOP_SHIPPING_MODE=${shipping}. Only stub is allowed. No carrier is called.`,
    );
  }
  if (payments !== "stub") {
    throw new Error(
      `Hosted GrokShop refuses GROKSHOP_PAYMENTS_MODE=${payments}. Only stub is allowed. No card is charged.`,
    );
  }
}

export function startRemoteServer(options: RemoteServerOptions = {}): Promise<RemoteServerHandle> {
  const resolved = resolveOptions(options);
  const hostState: Host = {
    store: {
      dataDir: resolved.dataDir,
      now: resolved.now,
      toolCallsPerDay: resolved.toolCallsPerDay,
      checkoutsPerDay: resolved.checkoutsPerDay,
    },
    host: resolved.host,
    port: resolved.port,
    page: {
      publicUrl: resolved.publicUrl,
      mcpUrl: `${resolved.publicUrl}/mcp`,
      toolCallsPerDay: resolved.toolCallsPerDay,
      checkoutsPerDay: resolved.checkoutsPerDay,
    },
    sessions: new Map(),
  };

  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    void handle(req, res, hostState).catch((err: unknown) => {
      if (res.headersSent) return;
      const normalized = asGrokShopError(err);
      sendJson(res, normalized.status, errorBody(normalized));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(resolved.port, resolved.host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Remote server did not bind a TCP port"));
        return;
      }
      const boundHost = resolved.host;
      const boundPort = address.port;
      resolve({
        url: `http://${boundHost}:${boundPort}`,
        host: boundHost,
        port: boundPort,
        publicUrl: resolved.publicUrl,
        mcpUrl: hostState.page.mcpUrl,
        close: async () => {
          await Promise.all([...hostState.sessions.values()].map((session) => session.close()));
          hostState.sessions.clear();
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          });
        },
      });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, host: Host): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (method === "GET" && pathname === "/") {
    sendHtml(res, 200, renderHome(host.page));
    return;
  }

  if (method === "GET" && pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "grokshop",
      mode: "hosted",
      tier: "free",
      catalog: "sample",
      shipping_mode: "stub",
      payments_mode: "stub",
      live_shipping: false,
      live_payments: false,
      charged: false,
      mcp: "/mcp",
      limits: {
        tool_calls_per_day: host.store.toolCallsPerDay,
        checkouts_per_day: host.store.checkoutsPerDay,
      },
    });
    return;
  }

  if (pathname === "/mcp") {
    await handleMcp(req, res, host);
    return;
  }

  if (pathname === "/signup" && method === "POST") {
    await handleIssue(req, res, host, "signup");
    return;
  }
  if (pathname === "/login" && method === "POST") {
    await handleIssue(req, res, host, "login");
    return;
  }

  if (pathname === "/me" && method === "GET") {
    const account = requireAccount(req, res, host);
    if (!account) return;
    sendJson(res, 200, {
      ...loadPublicAccount(host.store, account.id),
      mcp_url: host.page.mcpUrl,
    });
    return;
  }

  const checkoutMatch = pathname.match(/^\/checkouts\/(chk_[a-f0-9]+)$/);
  if (checkoutMatch?.[1] && method === "GET") {
    const account = requireAccount(req, res, host);
    if (!account) return;
    try {
      sendJson(res, 200, getCheckout(checkoutMatch[1], tenantContext(host, account)));
    } catch (err) {
      sendKnownError(res, err);
    }
    return;
  }

  const approveMatch = pathname.match(/^\/checkouts\/(chk_[a-f0-9]+)\/approve$/);
  if (approveMatch?.[1] && method === "POST") {
    const account = requireAccount(req, res, host);
    if (!account) return;
    const body = await readBody(req);
    try {
      const note = approveInput.parse(body.value ?? {}).note;
      sendJson(res, 200, approveCheckout(approveMatch[1], "http", tenantContext(host, account), note));
    } catch (err) {
      sendKnownError(res, err);
    }
    return;
  }

  if (pathname.startsWith("/tools")) {
    sendJson(res, 404, {
      error: {
        code: "not_found",
        message: "Hosted tools are the MCP endpoint at POST /mcp. There is no approve tool.",
      },
    });
    return;
  }

  sendJson(res, 404, { error: { code: "not_found", message: `No route ${method} ${pathname}` } });
}

async function handleIssue(
  req: IncomingMessage,
  res: ServerResponse,
  host: Host,
  kind: "signup" | "login",
): Promise<void> {
  const body = await readBody(req);
  try {
    const creds = credentials(body.value);
    const issued = kind === "signup" ? signup(host.store, creds.email, creds.password) : login(host.store, creds.email, creds.password);
    sendIssued(req, res, host, body.contentType, issued, kind === "login");
  } catch (err) {
    sendMaybeHtml(req, res, body.contentType, err);
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, host: Host): Promise<void> {
  const account = authenticate(host.store, req.headers.authorization);
  if (!account) {
    sendUnauthorized(res);
    return;
  }

  const sessionId = headerValue(req.headers["mcp-session-id"]);
  if (sessionId) {
    const existing = host.sessions.get(sessionId);
    if (!existing || existing.accountId !== account.id) {
      sendJson(res, 404, {
        error: { code: "session_not_found", message: "MCP session was not found for this API key." },
      });
      return;
    }
    await existing.transport.handleRequest(req, res);
    return;
  }

  if ((req.method ?? "GET") !== "POST") {
    sendJson(res, 400, {
      error: { code: "validation_error", message: "POST /mcp to initialize a session. Include Authorization: Bearer <key>." },
    });
    return;
  }

  const ctx = tenantContext(host, account);
  const mcp = createGrokShopServer(ctx);
  const box: { session?: LiveSession } = {};
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      if (box.session) host.sessions.set(id, box.session);
    },
  });
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    const id = transport.sessionId;
    if (id) host.sessions.delete(id);
    await Promise.allSettled([transport.close(), mcp.close()]);
  };
  const session: LiveSession = {
    accountId: account.id,
    transport,
    close: finish,
  };
  box.session = session;
  transport.onclose = () => {
    if (finished) return;
    finished = true;
    const id = transport.sessionId;
    if (id) host.sessions.delete(id);
    void mcp.close().catch(() => undefined);
  };
  transport.onerror = (error) => {
    process.stderr.write(`grokshop mcp session error: ${error.message}\n`);
  };
  await mcp.connect(transport);
  try {
    await transport.handleRequest(req, res);
  } finally {
    if (!transport.sessionId) await finish();
  }
}

function tenantContext(host: Host, account: AccountRecord): ShopContext {
  return {
    dataDir: path.join(host.store.dataDir, "tenants", account.id),
    catalogPath: defaultCatalogPath,
    merchantName: "Harbor & Hex (SAMPLE)",
    shippingMode: "stub",
    paymentsMode: "stub",
    approvalSecret: "",
    httpHost: host.host,
    httpPort: host.port,
    tier: "free",
    approvalHint: APPROVAL_HINT,
    gate: (name) => {
      consumeToolCall(host.store, account.id);
      if (name === "create_checkout") assertCheckoutCapacity(host.store, account.id);
    },
    recordCheckout: () => recordCheckout(host.store, account.id),
  };
}

function requireAccount(req: IncomingMessage, res: ServerResponse, host: Host): AccountRecord | undefined {
  const account = authenticate(host.store, req.headers.authorization);
  if (!account) {
    sendUnauthorized(res);
    return undefined;
  }
  return account;
}

function sendIssued(
  req: IncomingMessage,
  res: ServerResponse,
  host: Host,
  contentType: string,
  issued: IssuedAccount,
  rotated: boolean,
): void {
  if (wantsHtml(req, contentType)) {
    sendHtml(res, rotated ? 200 : 201, renderIssuedKey(host.page, issued.account.email, issued.api_key, rotated));
    return;
  }
  sendJson(res, rotated ? 200 : 201, {
    api_key: issued.api_key,
    mcp_url: host.page.mcpUrl,
    ...issued.account,
    note: rotated
      ? "This API key replaces the previous one. The old key no longer works. No email was sent."
      : "Copy api_key now. It is not stored in plaintext and is not shown again. POST /login issues a new key. No email was sent.",
  });
}

function sendMaybeHtml(req: IncomingMessage, res: ServerResponse, contentType: string, err: unknown): void {
  const normalized = asGrokShopError(err);
  if (wantsHtml(req, contentType)) {
    sendHtml(res, normalized.status, renderError(normalized.message));
    return;
  }
  sendJson(res, normalized.status, errorBody(normalized));
}

function sendKnownError(res: ServerResponse, err: unknown): void {
  const normalized = asGrokShopError(err);
  sendJson(res, normalized.status, errorBody(normalized));
}

function sendUnauthorized(res: ServerResponse): void {
  sendJson(
    res,
    401,
    {
      error: {
        code: "unauthorized",
        message:
          "Missing or unknown API key. POST /signup with an email and password to get one. Send it as Authorization: Bearer <key>.",
      },
    },
    { "www-authenticate": 'Bearer realm="grokshop"' },
  );
}

function wantsHtml(req: IncomingMessage, contentType: string): boolean {
  if (contentType.includes("application/json")) return false;
  if (contentType.includes("application/x-www-form-urlencoded")) return true;
  const accept = req.headers.accept ?? "";
  return accept.includes("text/html") && !accept.includes("application/json");
}

function credentials(value: unknown): { email: string; password: string } {
  if (!value || typeof value !== "object") {
    throw new GrokShopError("validation_error", "Body must be an object with email and password", 400);
  }
  const body = value as Record<string, unknown>;
  if (typeof body.email !== "string" || typeof body.password !== "string") {
    throw new GrokShopError("validation_error", "email and password must be strings", 400);
  }
  return { email: body.email, password: body.password };
}

function resolveOptions(options: RemoteServerOptions) {
  const env = options.env ?? process.env;
  const portRaw = options.port !== undefined ? String(options.port) : (env.PORT ?? env.GROKSHOP_HTTP_PORT ?? "8080");
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer from 0 to 65535, got ${portRaw}`);
  }
  const host = options.host ?? (env.GROKSHOP_HTTP_HOST?.trim() || (env.PORT ? "0.0.0.0" : "127.0.0.1"));
  const dataDir = path.resolve(options.dataDir ?? env.GROKSHOP_DATA_DIR ?? path.join(process.cwd(), ".grokshop"));
  const publicUrl = normalizePublicUrl(options.publicUrl ?? env.GROKSHOP_PUBLIC_URL ?? "https://YOUR_HOST");
  return {
    host,
    port,
    dataDir,
    publicUrl,
    now: options.now ?? (() => new Date()),
    toolCallsPerDay:
      options.toolCallsPerDay ??
      readPositiveInt(env.GROKSHOP_FREE_TOOL_CALLS_PER_DAY, FREE_TOOL_CALLS_PER_DAY, "GROKSHOP_FREE_TOOL_CALLS_PER_DAY"),
    checkoutsPerDay:
      options.checkoutsPerDay ??
      readPositiveInt(env.GROKSHOP_FREE_CHECKOUTS_PER_DAY, FREE_CHECKOUTS_PER_DAY, "GROKSHOP_FREE_CHECKOUTS_PER_DAY"),
  };
}

function normalizePublicUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`GROKSHOP_PUBLIC_URL is not an http(s) URL: ${raw}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`GROKSHOP_PUBLIC_URL must be http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("GROKSHOP_PUBLIC_URL must not include credentials");
  }
  return trimmed;
}

type ParsedBody = { contentType: string; value: unknown };

function readBody(req: IncomingMessage): Promise<ParsedBody> {
  const contentType = String(req.headers["content-type"] ?? "");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new GrokShopError("validation_error", "Request body exceeds 1 MB", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        resolve({ contentType, value: {} });
        return;
      }
      if (contentType.includes("application/x-www-form-urlencoded")) {
        const params = new URLSearchParams(text);
        const value: Record<string, string> = {};
        for (const [key, item] of params.entries()) value[key] = item;
        resolve({ contentType, value });
        return;
      }
      try {
        resolve({ contentType, value: JSON.parse(text) as unknown });
      } catch {
        reject(new GrokShopError("validation_error", "Request body is not JSON", 400));
      }
    });
    req.on("error", reject);
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(html);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isDirectRun()) {
  try {
    assertHostedModes(process.env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`grokshop remote failed: ${message}\n`);
    process.exit(1);
  }
  startRemoteServer()
    .then((handle) => {
      process.stderr.write(
        `grokshop remote listening on ${handle.url} (public ${handle.publicUrl}, mcp ${handle.mcpUrl})\n`,
      );
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`grokshop remote failed: ${message}\n`);
      process.exit(1);
    });
}
