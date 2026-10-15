import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_NAMES } from "../src/tools.js";
import { callTool, sampleShipTo } from "./helpers.js";
import { httpJson, startTestRemote, withRemoteMcp } from "./remote-helpers.js";

test("remote MCP smoke: sample catalog, human approval, no charge, inventory decrement", async () => {
  const server = await startTestRemote();
  try {
    const owner = await httpJson(server.url, "/signup", {
      method: "POST",
      body: { email: "owner@example.com", password: "correct-horse" },
    });
    const other = await httpJson(server.url, "/signup", {
      method: "POST",
      body: { email: "other@example.com", password: "correct-horse" },
    });
    assert.equal(owner.status, 201);
    const apiKey = owner.body.api_key as string;
    const otherKey = other.body.api_key as string;

    await withRemoteMcp(server, apiKey, async (client) => {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [...TOOL_NAMES].sort());
      assert.equal(names.includes("approve"), false);

      const before = await callTool(client, "get_product", { sku: "SAMPLE-KB-01" });
      assert.equal(before.isError, false);
      const stock = (before.value as { product: { inventory: number; sample: boolean } }).product;
      assert.equal(stock.sample, true);
      assert.equal(stock.inventory, 14);

      const quote = await callTool(client, "quote_shipping", {
        sku: "SAMPLE-KB-01",
        quantity: 1,
        to_postal_code: "94107",
      });
      assert.equal(quote.isError, false);
      const quoteBody = quote.value as { mode: string; labels_purchased: boolean; rates: Array<{ id: string; carrier: string }> };
      assert.equal(quoteBody.mode, "stub");
      assert.equal(quoteBody.labels_purchased, false);
      assert.equal(quoteBody.rates.length > 0, true);

      const created = await callTool(client, "create_checkout", {
        sku: "SAMPLE-KB-01",
        quantity: 1,
        rate_id: quoteBody.rates[0]?.id,
        ship_to: sampleShipTo,
      });
      assert.equal(created.isError, false);
      const checkout = created.value as {
        id: string;
        status: string;
        charged: boolean;
        next_action: { type: string };
        payment_intent: { livemode: boolean; metadata: { grokshop_charged: string } };
      };
      assert.equal(checkout.status, "requires_action");
      assert.equal(checkout.next_action.type, "grokshop_human_approval");
      assert.equal(checkout.charged, false);
      assert.equal(checkout.payment_intent.livemode, false);
      assert.equal(checkout.payment_intent.metadata.grokshop_charged, "false");

      const refused = await callTool(client, "confirm_order", {
        checkout_id: checkout.id,
        human_approved: true,
      });
      assert.equal(refused.isError, true);
      const refusal = refused.value as { error: { code: string; message: string } };
      assert.equal(refusal.error.code, "approval_not_recorded");
      assert.match(refusal.error.message, /no approve tool/i);
      assert.match(refusal.error.message, /POST \/checkouts\//);

      const stranger = await httpJson(server.url, `/checkouts/${checkout.id}/approve`, {
        method: "POST",
        body: {},
        headers: { authorization: `Bearer ${otherKey}` },
      });
      assert.equal(stranger.status, 404);

      const unauthenticated = await httpJson(server.url, `/checkouts/${checkout.id}/approve`, {
        method: "POST",
        body: {},
      });
      assert.equal(unauthenticated.status, 401);

      const approved = await httpJson(server.url, `/checkouts/${checkout.id}/approve`, {
        method: "POST",
        body: { note: "Approved in the browser." },
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(approved.status, 200);
      assert.equal(approved.body.human_approved, true);
      assert.equal(approved.body.approval.method, "http");
      assert.equal(approved.body.status, "requires_action");

      const confirmed = await callTool(client, "confirm_order", {
        checkout_id: checkout.id,
        human_approved: true,
      });
      assert.equal(confirmed.isError, false);
      const order = confirmed.value as {
        status: string;
        charged: boolean;
        labels_purchased: boolean;
        order: { id: string; charged: boolean; note: string };
        payment_intent: { livemode: boolean; metadata: { grokshop_charged: string } };
      };
      assert.equal(order.status, "confirmed");
      assert.equal(order.charged, false);
      assert.equal(order.labels_purchased, false);
      assert.equal(order.order.charged, false);
      assert.match(order.order.note, /No card was charged/);
      assert.equal(order.payment_intent.livemode, false);
      assert.equal(order.payment_intent.metadata.grokshop_charged, "false");
      assert.match(order.order.id, /^ord_/);

      const after = await callTool(client, "list_inventory", { sku: "SAMPLE-KB-01" });
      const row = (after.value as { inventory: Array<{ sku: string; inventory: number }> }).inventory[0];
      assert.equal(row?.inventory, 13);
    });

    const me = await httpJson(server.url, "/me", { headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(me.body.usage.tool_calls > 0, true);
    assert.equal(me.body.usage.checkouts, 1);
    assert.equal(me.body.charged, false);
  } finally {
    await server.close();
  }
});
