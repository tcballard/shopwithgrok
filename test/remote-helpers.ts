import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startRemoteServer, type RemoteServerHandle, type RemoteServerOptions } from "../src/remote.js";

export function startTestRemote(
  options: Omit<RemoteServerOptions, "host"> & { dataDir?: string } = {},
): Promise<RemoteServerHandle> {
  return startRemoteServer({
    host: "127.0.0.1",
    port: 0,
    publicUrl: "https://YOUR_HOST",
    dataDir: options.dataDir ?? mkdtempSync(path.join(tmpdir(), "grokshop-remote-")),
    ...options,
  });
}

export async function httpJson(
  base: string,
  pathname: string,
  options?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; body: Record<string, any>; headers: Headers }> {
  const response = await fetch(`${base}${pathname}`, {
    method: options?.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(options?.body === undefined ? {} : { "content-type": "application/json" }),
      ...options?.headers,
    },
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: Record<string, any> = {};
  if (text) body = JSON.parse(text) as Record<string, any>;
  return { status: response.status, body, headers: response.headers };
}

export async function withRemoteMcp(
  handle: RemoteServerHandle,
  apiKey: string,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
  });
  const client = new Client({ name: "grokshop-remote-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}
