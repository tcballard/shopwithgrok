import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_NAMES } from "../src/tools.js";
import { callTool, sampleShipTo, testContext, withMcpClient } from "./helpers.js";

test("MCP exposes the six merchant tools and no approve tool", async () => {
  const ctx = testContext();
  await withMcpClient(ctx, async (client) => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...TOOL_NAMES].sort());
    assert.equal(names.includes("approve"), false);
    const confirm = listed.tools.find((tool) => tool.name === "confirm_order");
    assert.match(confirm?.description ?? "", /no approve tool/i);
    assert.match(confirm?.description ?? "", /human_approved/);
  });
});

test("MCP confirm_order fails before approval and succeeds after the CLI gate", async () => {
  const ctx = testContext();
  await withMcpClient(ctx, async (client) => {
    const quote = await callTool(client, "quote_shipping", {
      sku: "SAMPLE-KB-01",
      quantity: 1,
      to_postal_code: "94107",
    });
    assert.equal(quote.isError, false);
    const rates = (quote.value as { rates: Array<{ id: string }> }).rates;
    const created = await callTool(client, "create_checkout", {
      sku: "SAMPLE-KB-01",
      quantity: 1,
      rate_id: rates[0]?.id,
      ship_to: sampleShipTo,
    });
    assert.equal(created.isError, false);
    const checkout = created.value as {
      id: string;
      status: string;
      next_action: { type: string };
      payment_intent: { status: string; next_action: { type: string }; livemode: boolean };
    };
    assert.equal(checkout.status, "requires_action");
    assert.equal(checkout.next_action.type, "grokshop_human_approval");
    assert.equal(checkout.payment_intent.status, "requires_action");
    assert.equal(checkout.payment_intent.next_action.type, "grokshop_human_approval");
    assert.equal(checkout.payment_intent.livemode, false);

    const refused = await callTool(client, "confirm_order", {
      checkout_id: checkout.id,
      human_approved: true,
    });
    assert.equal(refused.isError, true);
    assert.equal((refused.value as { error: { code: string } }).error.code, "approval_not_recorded");

    const { approveCheckout } = await import("../src/service.js");
    approveCheckout(checkout.id, "cli", ctx);

    const confirmed = await callTool(client, "confirm_order", {
      checkout_id: checkout.id,
      human_approved: true,
    });
    assert.equal(confirmed.isError, false);
    const order = confirmed.value as {
      status: string;
      charged: boolean;
      order: { id: string; charged: boolean };
      payment_intent: { metadata: { grokshop_charged: string } };
    };
    assert.equal(order.status, "confirmed");
    assert.equal(order.charged, false);
    assert.equal(order.order.charged, false);
    assert.equal(order.payment_intent.metadata.grokshop_charged, "false");
    assert.match(order.order.id, /^ord_/);
  });
});
