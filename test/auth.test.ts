import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertHostedModes } from "../src/remote.js";
import { httpJson, startTestRemote } from "./remote-helpers.js";

const password = "correct-horse";

test("signup and login issue bearer keys and do not store them in plaintext", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "grokshop-auth-"));
  const server = await startTestRemote({ dataDir });
  try {
    const home = await fetch(server.url);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Lets your bot buy from independent stores and ship direct/);

    const health = await httpJson(server.url, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.mode, "hosted");
    assert.equal(health.body.catalog, "sample");
    assert.equal(health.body.live_payments, false);
    assert.equal(health.body.charged, false);
    assert.equal(health.body.limits.tool_calls_per_day, 50);
    assert.equal(health.body.limits.checkouts_per_day, 5);

    const created = await httpJson(server.url, "/signup", {
      method: "POST",
      body: { email: "Buyer@Example.com", password },
    });
    assert.equal(created.status, 201);
    assert.match(created.body.api_key, /^gsk_[a-f0-9]{64}$/);
    assert.equal(created.body.email, "buyer@example.com");
    assert.equal(created.body.tier, "free");
    assert.equal(created.body.catalog, "sample");
    assert.equal(created.body.charged, false);
    assert.equal(created.body.mcp_url, "https://YOUR_HOST/mcp");
    assert.equal(created.body.usage.tool_calls, 0);
    assert.equal(JSON.stringify(created.body).includes("password"), false);
    const apiKey = created.body.api_key as string;

    const stored = readFileSync(path.join(dataDir, "accounts.json"), "utf8");
    assert.equal(stored.includes(apiKey), false);
    assert.equal(stored.includes(password), false);
    assert.match(stored, /scrypt\$/);

    const duplicate = await httpJson(server.url, "/signup", {
      method: "POST",
      body: { email: "buyer@example.com", password },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, "email_taken");

    const weak = await httpJson(server.url, "/signup", {
      method: "POST",
      body: { email: "other@example.com", password: "short" },
    });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error.code, "validation_error");

    const me = await httpJson(server.url, "/me", { headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(me.status, 200);
    assert.equal(me.body.email, "buyer@example.com");
    assert.equal(me.body.api_key, undefined);
    assert.equal(me.body.limits.tool_calls_per_day, 50);

    const missing = await httpJson(server.url, "/me");
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error.code, "unauthorized");
    assert.match(missing.headers.get("www-authenticate") ?? "", /Bearer/);

    const wrong = await httpJson(server.url, "/login", {
      method: "POST",
      body: { email: "buyer@example.com", password: "not-the-password" },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, "unauthorized");

    const rotated = await httpJson(server.url, "/login", {
      method: "POST",
      body: { email: "buyer@example.com", password },
    });
    assert.equal(rotated.status, 200);
    assert.match(rotated.body.api_key, /^gsk_[a-f0-9]{64}$/);
    assert.notEqual(rotated.body.api_key, apiKey);

    const oldKey = await httpJson(server.url, "/me", { headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(oldKey.status, 401);
    const newKey = await httpJson(server.url, "/me", {
      headers: { authorization: `Bearer ${rotated.body.api_key}` },
    });
    assert.equal(newKey.status, 200);

    const mcp = await httpJson(server.url, "/mcp", { method: "POST", body: {} });
    assert.equal(mcp.status, 401);
    const badMcp = await httpJson(server.url, "/mcp", {
      method: "POST",
      body: {},
      headers: { authorization: "Bearer gsk_not-a-real-key" },
    });
    assert.equal(badMcp.status, 401);

    const tools = await httpJson(server.url, "/tools/search_products", { method: "POST", body: {} });
    assert.equal(tools.status, 404);
    assert.match(tools.body.error.message, /no approve tool/i);
  } finally {
    await server.close();
  }
});

test("HTML signup form returns the key in the page and not in a log-shaped JSON error", async () => {
  const server = await startTestRemote();
  try {
    const response = await fetch(`${server.url}/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ email: "form@example.com", password }).toString(),
    });
    assert.equal(response.status, 201);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.match(html, /gsk_[a-f0-9]{64}/);
    assert.match(html, /https:\/\/YOUR_HOST\/mcp/);
    assert.match(html, /Copy this key now/);
  } finally {
    await server.close();
  }
});

test("hosted process refuses live shipping and stripe payments", () => {
  assert.throws(
    () => assertHostedModes({ GROKSHOP_SHIPPING_MODE: "live" }),
    /GROKSHOP_SHIPPING_MODE=live/,
  );
  assert.throws(
    () => assertHostedModes({ GROKSHOP_PAYMENTS_MODE: "stripe" }),
    /GROKSHOP_PAYMENTS_MODE=stripe/,
  );
  assert.doesNotThrow(() => assertHostedModes({ GROKSHOP_SHIPPING_MODE: "stub", GROKSHOP_PAYMENTS_MODE: "stub" }));
});
