import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GrokShopError } from "../src/errors.js";
import { listInventory } from "../src/service.js";
import { callTool, testContext } from "./helpers.js";
import { httpJson, startTestRemote, withRemoteMcp } from "./remote-helpers.js";

test("free tier refuses a catalog other than the bundled sample", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grokshop-paid-feed-"));
  const catalogPath = path.join(dir, "real.json");
  writeFileSync(
    catalogPath,
    JSON.stringify({
      merchant: { id: "real", name: "Real Shop", sample: false, example: false, disclaimer: "Not a sample." },
      products: [
        {
          sku: "REAL-1",
          name: "Real lamp",
          description: "Not a sample",
          price_cents: 100,
          currency: "usd",
          weight_oz: 8,
          inventory: 4,
          category: "lighting",
          sample: false,
          example: false,
        },
      ],
    }),
  );
  assert.throws(
    () => listInventory({}, testContext({ tier: "free", catalogPath })),
    (err: unknown) => err instanceof GrokShopError && err.code === "upgrade_required" && err.status === 402,
  );
});

test("hosted free tier ignores a custom catalog and live payment env", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grokshop-poison-"));
  const catalogPath = path.join(dir, "poison.json");
  writeFileSync(catalogPath, '{"merchant":{"name":"Poison","sample":false,"example":false},"products":[]}');
  const server = await startTestRemote({
    env: {
      GROKSHOP_CATALOG_PATH: catalogPath,
      GROKSHOP_PAYMENTS_MODE: "stripe",
      GROKSHOP_SHIPPING_MODE: "live",
    },
  });
  try {
    const health = await httpJson(server.url, "/health");
    assert.equal(health.body.payments_mode, "stub");
    assert.equal(health.body.shipping_mode, "stub");
    assert.equal(health.body.catalog, "sample");
    const created = await httpJson(server.url, "/signup", {
      method: "POST",
      body: { email: "sample@example.com", password: "correct-horse" },
    });
    assert.equal(created.status, 201);
    await withRemoteMcp(server, created.body.api_key as string, async (client) => {
      const listed = await client.listTools();
      assert.equal(listed.tools.some((tool) => tool.name === "approve"), false);
      const search = await callTool(client, "search_products", { query: "keyboard" });
      assert.equal(search.isError, false);
      const body = search.value as { merchant: { name: string; sample: boolean }; products: Array<{ sku: string }> };
      assert.equal(body.merchant.name, "Harbor & Hex (SAMPLE)");
      assert.equal(body.merchant.sample, true);
      assert.equal(body.products[0]?.sku, "SAMPLE-KB-01");
    });
  } finally {
    await server.close();
  }
});

test("free tier returns upgrade_required at the tool-call cap, then resets the next day", async () => {
  let now = new Date("2026-10-15T12:00:00.000Z");
  const server = await startTestRemote({
    toolCallsPerDay: 2,
    checkoutsPerDay: 1,
    now: () => now,
  });
  try {
    const created = await httpJson(server.url, "/signup", {
      method: "POST",
      body: { email: "limits@example.com", password: "correct-horse" },
    });
    assert.equal(created.status, 201);
    const apiKey = created.body.api_key as string;

    await withRemoteMcp(server, apiKey, async (client) => {
      const first = await callTool(client, "search_products", { query: "dock" });
      assert.equal(first.isError, false);
      const second = await callTool(client, "list_inventory", {});
      assert.equal(second.isError, false);
      const third = await callTool(client, "search_products", { query: "cable" });
      assert.equal(third.isError, true);
      const error = third.value as { error: { code: string; message: string; details: { limit: string; limit_value: number; resets_at: string } } };
      assert.equal(error.error.code, "upgrade_required");
      assert.match(error.error.message, /2 tool calls per day/);
      assert.match(error.error.message, /Paid plans are not available/);
      assert.equal(error.error.details.limit, "tool_calls");
      assert.equal(error.error.details.limit_value, 2);
      assert.equal(error.error.details.resets_at, "2026-10-16T00:00:00.000Z");
    });

    const capped = await httpJson(server.url, "/me", { headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(capped.body.usage.tool_calls, 2);
    assert.equal(capped.body.usage.checkouts, 0);

    now = new Date("2026-10-16T00:05:00.000Z");
    const reset = await httpJson(server.url, "/me", { headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(reset.body.usage.day, "2026-10-16");
    assert.equal(reset.body.usage.tool_calls, 0);
    assert.equal(reset.body.usage.resets_at, "2026-10-17T00:00:00.000Z");

    await withRemoteMcp(server, apiKey, async (client) => {
      const afterReset = await callTool(client, "search_products", { query: "cable" });
      assert.equal(afterReset.isError, false);
    });
    const used = await httpJson(server.url, "/me", { headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(used.body.usage.tool_calls, 1);
  } finally {
    await server.close();
  }
});

test("checkout quota counts successful create_checkout calls only", async () => {
  const server = await startTestRemote({ toolCallsPerDay: 20, checkoutsPerDay: 1 });
  try {
    const created = await httpJson(server.url, "/signup", {
      method: "POST",
      body: { email: "checkout-cap@example.com", password: "correct-horse" },
    });
    const apiKey = created.body.api_key as string;
    const shipTo = {
      name: "Sample Buyer",
      line1: "1 Example Wharf",
      city: "San Francisco",
      state: "CA",
      postal_code: "94107",
      country: "US",
    };
    await withRemoteMcp(server, apiKey, async (client) => {
      const blockedQuote = await callTool(client, "quote_shipping", {
        sku: "SAMPLE-SW-01",
        quantity: 1,
        to_postal_code: "94107",
      });
      const blockedRate = (blockedQuote.value as { rates: Array<{ id: string }> }).rates[0]?.id;
      const outOfStock = await callTool(client, "create_checkout", {
        sku: "SAMPLE-SW-01",
        quantity: 1,
        rate_id: blockedRate,
        ship_to: shipTo,
      });
      assert.equal(outOfStock.isError, true);
      assert.equal((outOfStock.value as { error: { code: string } }).error.code, "out_of_stock");
      const afterMiss = await httpJson(server.url, "/me", { headers: { authorization: `Bearer ${apiKey}` } });
      assert.equal(afterMiss.body.usage.checkouts, 0);

      const quote = await callTool(client, "quote_shipping", {
        sku: "SAMPLE-MAT-01",
        quantity: 1,
        to_postal_code: "94107",
      });
      const rateId = (quote.value as { rates: Array<{ id: string }> }).rates[0]?.id;
      const first = await callTool(client, "create_checkout", {
        sku: "SAMPLE-MAT-01",
        quantity: 1,
        rate_id: rateId,
        ship_to: shipTo,
      });
      assert.equal(first.isError, false);
      const second = await callTool(client, "create_checkout", {
        sku: "SAMPLE-MAT-01",
        quantity: 1,
        rate_id: rateId,
        ship_to: shipTo,
      });
      assert.equal(second.isError, true);
      const error = second.value as { error: { code: string; message: string; details: { limit: string; limit_value: number } } };
      assert.equal(error.error.code, "upgrade_required");
      assert.equal(error.error.details.limit, "checkouts");
      assert.equal(error.error.details.limit_value, 1);
      assert.match(error.error.message, /checkouts per day/);
      assert.match(error.error.message, /Paid plans are not available/);
    });
    const me = await httpJson(server.url, "/me", { headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(me.body.usage.checkouts, 1);
  } finally {
    await server.close();
  }
});
