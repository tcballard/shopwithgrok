import assert from "node:assert/strict";
import test from "node:test";
import { startHttpServer } from "../src/http.js";
import { testContext } from "./helpers.js";

test("HTTP mirror refuses confirm, then approves with the bearer secret", async () => {
  const ctx = testContext({ approvalSecret: "desk-secret" });
  const server = await startHttpServer({ context: ctx, host: "127.0.0.1", port: 0 });
  try {
    const health = await request(server.url, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.live_shipping, false);
    assert.equal(health.body.live_payments, false);

    const tools = await request(server.url, "/tools");
    assert.deepEqual(tools.body.tools.includes("confirm_order"), true);
    assert.equal(JSON.stringify(tools.body.tools).includes("approve"), false);

    const quote = await request(server.url, "/tools/quote_shipping", {
      method: "POST",
      body: { sku: "SAMPLE-MAT-01", quantity: 1, to_postal_code: "98101" },
    });
    assert.equal(quote.status, 200);
    const rateId = (quote.body.rates as Array<{ id: string; carrier: string; service: string; rate: string }>)[0]?.id;
    assert.ok(rateId);

    const created = await request(server.url, "/tools/create_checkout", {
      method: "POST",
      body: {
        sku: "SAMPLE-MAT-01",
        quantity: 1,
        rate_id: rateId,
        ship_to: {
          name: "Sample Buyer",
          line1: "1 Example Wharf",
          city: "Seattle",
          state: "WA",
          postal_code: "98101",
          country: "US",
        },
      },
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.status, "requires_action");
    assert.equal(created.body.next_action.type, "grokshop_human_approval");
    const checkoutId = created.body.id as string;

    const early = await request(server.url, "/tools/confirm_order", {
      method: "POST",
      body: { checkout_id: checkoutId, human_approved: true },
    });
    assert.equal(early.status, 403);
    assert.equal(early.body.error.code, "approval_not_recorded");

    const missing = await request(server.url, `/checkouts/${checkoutId}/approve`, { method: "POST", body: {} });
    assert.equal(missing.status, 401);

    const wrong = await request(server.url, `/checkouts/${checkoutId}/approve`, {
      method: "POST",
      body: {},
      headers: { authorization: "Bearer not-the-secret" },
    });
    assert.equal(wrong.status, 401);

    const approved = await request(server.url, `/checkouts/${checkoutId}/approve`, {
      method: "POST",
      body: { note: "Merchant at the desk." },
      headers: { authorization: "Bearer desk-secret" },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.human_approved, true);
    assert.equal(approved.body.approval.method, "http");

    const confirmed = await request(server.url, "/tools/confirm_order", {
      method: "POST",
      body: { checkout_id: checkoutId, human_approved: true },
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.status, "confirmed");
    assert.equal(confirmed.body.charged, false);
    assert.equal(confirmed.body.payment_intent.livemode, false);
    assert.match(confirmed.body.order.id, /^ord_/);
  } finally {
    await server.close();
  }
});

test("HTTP approval is unavailable when the secret is unset", async () => {
  const ctx = testContext({ approvalSecret: "" });
  const server = await startHttpServer({ context: ctx, host: "127.0.0.1", port: 0 });
  try {
    const response = await request(server.url, "/checkouts/chk_abcdef/approve", { method: "POST", body: {} });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "approval_secret_unset");
  } finally {
    await server.close();
  }
});

async function request(
  base: string,
  pathname: string,
  options?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${base}${pathname}`, {
    method: options?.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...options?.headers,
    },
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
