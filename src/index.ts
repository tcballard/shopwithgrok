#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { contextFromEnv } from "./context.js";
import { createGrokShopServer } from "./server.js";

async function main(): Promise<void> {
  const ctx = contextFromEnv();
  const server = createGrokShopServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`grokshop mcp failed: ${message}\n`);
  process.exit(1);
});
