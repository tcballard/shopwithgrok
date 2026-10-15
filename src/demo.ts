import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { contextFromEnv, repoRoot } from "./context.js";
import { createGrokShopServer } from "./server.js";

type ToolPayload = {
  isError: boolean;
  value: unknown;
};

const shipTo = {
  name: "Sample Buyer",
  line1: "1 Example Wharf",
  city: "San Francisco",
  state: "CA",
  postal_code: "94107",
  country: "US",
};

async function main(): Promise<void> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "grokshop-demo-"));
  process.env.GROKSHOP_DATA_DIR = dataDir;
  process.env.GROKSHOP_SHIPPING_MODE = "stub";
  process.env.GROKSHOP_PAYMENTS_MODE = "stub";
  delete process.env.GROKSHOP_CATALOG_PATH;

  const ctx = contextFromEnv();
  const server = createGrokShopServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "grokshop-demo", version: "0.1.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    section("GrokShop demo — Harbor & Hex (SAMPLE)");
    line("Fictional catalog. Stub shipping. Stub payments. No card is charged. No label is bought.");
    line(`tools: ${names.join(", ")}`);
    if (names.includes("approve") || names.includes("approve_order")) {
      throw new Error("demo invariant failed: an approve tool is registered");
    }
    line("approve tool: absent (approval stays outside MCP)");

    const search = await call(client, "search_products", { query: "keyboard" });
    section("search_products { query: \"keyboard\" }");
    const searchBody = expectOk(search) as { products: Array<{ sku: string; name: string; sample: boolean }> };
    for (const product of searchBody.products) {
      line(`${product.sku}  ${product.name}  sample=${product.sample}`);
    }

    const inventory = await call(client, "list_inventory", { sku: "SAMPLE-SW-01" });
    section("list_inventory { sku: \"SAMPLE-SW-01\" }");
    const inventoryBody = expectOk(inventory) as {
      inventory: Array<{ sku: string; inventory: number; status: string }>;
    };
    const switches = inventoryBody.inventory[0];
    line(`${switches?.sku} inventory=${switches?.inventory} status=${switches?.status}`);

    const quote = await call(client, "quote_shipping", {
      sku: "SAMPLE-KB-01",
      quantity: 1,
      to_postal_code: "94107",
      to_country: "US",
    });
    section("quote_shipping SAMPLE-KB-01 → 94107");
    const quoteBody = expectOk(quote) as {
      rates: Array<{ id: string; carrier: string; service: string; rate: string; currency: string }>;
    };
    for (const rate of quoteBody.rates) {
      line(`${rate.carrier.padEnd(5)} ${rate.service.padEnd(18)} ${rate.currency} ${rate.rate}  ${rate.id}`);
    }
    const selected = [...quoteBody.rates].sort((a, b) => Number(a.rate) - Number(b.rate))[0];
    if (!selected) throw new Error("no stub rates returned");
    line(`selected ${selected.id} (${selected.carrier} ${selected.service})`);

    const created = await call(client, "create_checkout", {
      sku: "SAMPLE-KB-01",
      quantity: 1,
      rate_id: selected.id,
      ship_to: shipTo,
    });
    section("create_checkout");
    const checkout = expectOk(created) as {
      id: string;
      status: string;
      human_approved: boolean;
      next_action: { type: string } | null;
      payment_intent: { id: string; status: string; livemode: boolean; next_action: { type: string } | null };
      charged: boolean;
    };
    line(`checkout_id: ${checkout.id}`);
    line(`status: ${checkout.status}`);
    line(`next_action.type: ${checkout.next_action?.type}`);
    line(`human_approved: ${checkout.human_approved}`);
    line(
      `payment_intent: ${checkout.payment_intent.id} status=${checkout.payment_intent.status} livemode=${checkout.payment_intent.livemode} next_action=${checkout.payment_intent.next_action?.type}`,
    );
    line(`charged: ${checkout.charged}`);

    section(`confirm_order ${checkout.id} before approval`);
    const refused = await call(client, "confirm_order", {
      checkout_id: checkout.id,
      human_approved: true,
    });
    const refusal = expectError(refused);
    line(`REFUSED ${refusal.code}`);
    line(refusal.message);

    section(`npm run approve -- ${checkout.id}`);
    const approve = spawnSync(process.execPath, ["--import", "tsx", "src/approve.ts", checkout.id], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    });
    if (approve.stdout) process.stdout.write(approve.stdout);
    if (approve.status !== 0) {
      if (approve.stderr) process.stderr.write(approve.stderr);
      throw new Error(`approve CLI exited ${approve.status}`);
    }

    section(`confirm_order ${checkout.id} after approval`);
    const confirmed = await call(client, "confirm_order", {
      checkout_id: checkout.id,
      human_approved: true,
    });
    const order = expectOk(confirmed) as {
      id: string;
      status: string;
      human_approved: boolean;
      charged: boolean;
      labels_purchased: boolean;
      payment_intent: { status: string; livemode: boolean; metadata: { grokshop_charged: string } };
      order: { id: string; status: string; charged: boolean; note: string } | null;
    };
    line(`SUCCESS checkout_id=${order.id} status=${order.status} human_approved=${order.human_approved}`);
    line(`order_id: ${order.order?.id} status=${order.order?.status}`);
    line(
      `payment_intent status=${order.payment_intent.status} livemode=${order.payment_intent.livemode} charged=${order.payment_intent.metadata.grokshop_charged}`,
    );
    line(`labels_purchased: ${order.labels_purchased}`);
    line(order.order?.note ?? "");
  } finally {
    await client.close();
    await server.close();
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolPayload> {
  const result = await client.callTool({ name, arguments: args });
  const text = textContent(result.content);
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return { isError: Boolean(result.isError), value };
}

function textContent(content: unknown): string {
  if (!Array.isArray(content) || content.length === 0) return "";
  const first = content[0] as { text?: string };
  return first.text ?? "";
}

function expectOk(payload: ToolPayload): unknown {
  if (payload.isError) {
    throw new Error(`expected success, got ${JSON.stringify(payload.value)}`);
  }
  return payload.value;
}

function expectError(payload: ToolPayload): { code: string; message: string } {
  if (!payload.isError || !payload.value || typeof payload.value !== "object") {
    throw new Error(`expected tool error, got ${JSON.stringify(payload.value)}`);
  }
  const body = payload.value as { error?: { code?: string; message?: string } };
  if (!body.error?.code || !body.error.message) {
    throw new Error(`expected error body, got ${JSON.stringify(payload.value)}`);
  }
  return { code: body.error.code, message: body.error.message };
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n`);
}

function line(text: string): void {
  process.stdout.write(`${text}\n`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
