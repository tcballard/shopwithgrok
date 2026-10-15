import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defaultCatalogPath, type ShopContext } from "../src/context.js";
import { createGrokShopServer } from "../src/server.js";

export function testContext(overrides: Partial<ShopContext> = {}): ShopContext {
  return {
    dataDir: mkdtempSync(path.join(tmpdir(), "grokshop-test-")),
    catalogPath: defaultCatalogPath,
    merchantName: "Harbor & Hex (SAMPLE)",
    shippingMode: "stub",
    paymentsMode: "stub",
    approvalSecret: "test-approval-secret",
    httpHost: "127.0.0.1",
    httpPort: 0,
    ...overrides,
  };
}

export const sampleShipTo = {
  name: "Sample Buyer",
  line1: "1 Example Wharf",
  city: "San Francisco",
  state: "CA",
  postal_code: "94107",
  country: "US",
};

export async function withMcpClient(
  ctx: ShopContext,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const server = createGrokShopServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "grokshop-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; value: unknown }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content;
  const text = Array.isArray(content) && content[0] && "text" in content[0] ? String(content[0].text) : "";
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return { isError: Boolean(result.isError), value };
}
