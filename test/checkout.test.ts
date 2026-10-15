import assert from "node:assert/strict";
import test from "node:test";
import { GrokShopError } from "../src/errors.js";
import { runApprove } from "../src/approve.js";
import { readState } from "../src/store.js";
import {
  approveCheckout,
  confirmOrder,
  createCheckout,
  quoteShipping,
} from "../src/service.js";
import { contextFromEnv } from "../src/context.js";
import { sampleShipTo, testContext } from "./helpers.js";

function cheapestRate(ctx: ReturnType<typeof testContext>, sku = "SAMPLE-KB-01") {
  const quote = quoteShipping({ sku, quantity: 1, to_postal_code: "94107", to_country: "US" }, ctx);
  const rate = [...quote.rates].sort((a, b) => Number(a.rate) - Number(b.rate))[0];
  assert.ok(rate);
  return rate;
}

test("stub quotes include FedEx, UPS, and USPS carrier/service/rate", () => {
  const ctx = testContext();
  const quote = quoteShipping(
    { sku: "SAMPLE-ARM-01", quantity: 1, to_postal_code: "10001" },
    ctx,
  );
  assert.equal(quote.mode, "stub");
  assert.equal(quote.labels_purchased, false);
  const carriers = new Set(quote.rates.map((rate) => rate.carrier));
  assert.deepEqual([...carriers].sort(), ["FedEx", "UPS", "USPS"]);
  for (const rate of quote.rates) {
    assert.equal(rate.object, "Rate");
    assert.equal(rate.mode, "stub");
    assert.equal(rate.currency, "USD");
    assert.match(rate.service, /\S/);
    assert.match(rate.rate, /^\d+\.\d{2}$/);
    assert.equal(rate.delivery_date_guaranteed, false);
  }

  const light = quoteShipping({ sku: "SAMPLE-CBL-01", quantity: 1, to_postal_code: "10001" }, ctx);
  const heavyGround = quote.rates.find((rate) => rate.service === "FEDEX_GROUND");
  const lightGround = light.rates.find((rate) => rate.service === "FEDEX_GROUND");
  assert.ok(heavyGround && lightGround);
  assert.ok(Number(heavyGround.rate) > Number(lightGround.rate));
});

test("GROKSHOP_SHIPPING_MODE=live throws and stores nothing", () => {
  const ctx = testContext({ shippingMode: "live" });
  assert.throws(
    () => quoteShipping({ sku: "SAMPLE-KB-01", to_postal_code: "94107" }, ctx),
    (err: unknown) =>
      err instanceof GrokShopError &&
      err.code === "shipping_live_disabled" &&
      err.message.includes("GROKSHOP_SHIPPING_MODE=live"),
  );
  assert.deepEqual(readState(ctx).rates, {});
});

test("GROKSHOP_PAYMENTS_MODE=stripe throws and stores no checkout", () => {
  const ctx = testContext({ paymentsMode: "stripe" });
  assert.throws(
    () =>
      createCheckout(
        { sku: "SAMPLE-KB-01", quantity: 1, rate_id: "rate_missing", ship_to: sampleShipTo },
        ctx,
      ),
    (err: unknown) =>
      err instanceof GrokShopError &&
      err.code === "payments_stripe_disabled" &&
      err.message.includes("GROKSHOP_PAYMENTS_MODE=stripe"),
  );
  assert.deepEqual(readState(ctx).checkouts, {});
});

test("create_checkout is requires_action / grokshop_human_approval and does not charge", () => {
  const ctx = testContext();
  const rate = cheapestRate(ctx);
  const checkout = createCheckout(
    { sku: "SAMPLE-KB-01", quantity: 1, rate_id: rate.id, ship_to: sampleShipTo },
    ctx,
  );
  assert.match(checkout.id, /^chk_[a-f0-9]+$/);
  assert.equal(checkout.status, "requires_action");
  assert.equal(checkout.human_approved, false);
  assert.equal(checkout.approval, null);
  assert.equal(checkout.next_action?.type, "grokshop_human_approval");
  assert.equal(checkout.payment_intent.object, "payment_intent");
  assert.equal(checkout.payment_intent.status, "requires_action");
  assert.equal(checkout.payment_intent.livemode, false);
  assert.equal(checkout.payment_intent.next_action?.type, "grokshop_human_approval");
  assert.equal(checkout.payment_intent.metadata.grokshop_charged, "false");
  assert.equal(checkout.charged, false);
  assert.equal(checkout.labels_purchased, false);
  assert.equal("client_secret" in checkout.payment_intent, false);
  assert.equal(checkout.amount_subtotal, 18900);
  assert.ok(checkout.amount_total > checkout.amount_subtotal);
});

test("a rate quoted for one postal code cannot check out to another", () => {
  const ctx = testContext();
  const quote = quoteShipping({ sku: "SAMPLE-KB-01", quantity: 1, to_postal_code: "94107" }, ctx);
  const rate = quote.rates[0];
  assert.ok(rate);
  assert.throws(
    () =>
      createCheckout(
        {
          sku: "SAMPLE-KB-01",
          quantity: 1,
          rate_id: rate.id,
          ship_to: { ...sampleShipTo, postal_code: "10001" },
        },
        ctx,
      ),
    (err: unknown) => err instanceof GrokShopError && err.code === "rate_mismatch",
  );
});

test("out of stock switches cannot be checked out", () => {
  const ctx = testContext();
  const quote = quoteShipping({ sku: "SAMPLE-SW-01", quantity: 1, to_postal_code: "94107" }, ctx);
  const rate = quote.rates[0];
  assert.ok(rate);
  assert.throws(
    () => createCheckout({ sku: "SAMPLE-SW-01", quantity: 1, rate_id: rate.id, ship_to: sampleShipTo }, ctx),
    (err: unknown) => err instanceof GrokShopError && err.code === "out_of_stock",
  );
});

test("confirm_order requires the flag and a stored approval, then succeeds once", () => {
  const ctx = testContext();
  const rate = cheapestRate(ctx, "SAMPLE-CBL-01");
  const checkout = createCheckout(
    { sku: "SAMPLE-CBL-01", quantity: 1, rate_id: rate.id, ship_to: sampleShipTo },
    ctx,
  );

  assert.throws(
    () => confirmOrder({ checkout_id: checkout.id, human_approved: true }, ctx),
    (err: unknown) => err instanceof GrokShopError && err.code === "approval_not_recorded",
  );

  const approved = approveCheckout(checkout.id, "cli", ctx);
  assert.equal(approved.human_approved, true);
  assert.equal(approved.approval?.method, "cli");
  assert.equal(approved.status, "requires_action");

  assert.throws(
    () => confirmOrder({ checkout_id: checkout.id, human_approved: false }, ctx),
    (err: unknown) => err instanceof GrokShopError && err.code === "approval_required",
  );

  const confirmed = confirmOrder({ checkout_id: checkout.id, human_approved: true }, ctx);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.next_action, null);
  assert.equal(confirmed.charged, false);
  assert.equal(confirmed.labels_purchased, false);
  assert.equal(confirmed.payment_intent.status, "succeeded");
  assert.equal(confirmed.payment_intent.livemode, false);
  assert.equal(confirmed.payment_intent.metadata.grokshop_charged, "false");
  assert.equal(confirmed.order?.human_approved, true);
  assert.equal(confirmed.order?.charged, false);
  assert.match(confirmed.order?.id ?? "", /^ord_/);

  const again = confirmOrder({ checkout_id: checkout.id, human_approved: true }, ctx);
  assert.equal(again.order?.id, confirmed.order?.id);
});

test("npm run approve records approval for a checkout id", () => {
  const ctx = testContext();
  const rate = cheapestRate(ctx, "SAMPLE-STAND-01");
  const checkout = createCheckout(
    { sku: "SAMPLE-STAND-01", quantity: 1, rate_id: rate.id, ship_to: sampleShipTo },
    ctx,
  );
  const previous = {
    data: process.env.GROKSHOP_DATA_DIR,
    shipping: process.env.GROKSHOP_SHIPPING_MODE,
    payments: process.env.GROKSHOP_PAYMENTS_MODE,
    catalog: process.env.GROKSHOP_CATALOG_PATH,
  };
  process.env.GROKSHOP_DATA_DIR = ctx.dataDir;
  process.env.GROKSHOP_SHIPPING_MODE = "stub";
  process.env.GROKSHOP_PAYMENTS_MODE = "stub";
  process.env.GROKSHOP_CATALOG_PATH = ctx.catalogPath;
  const logs: string[] = [];
  const stdout = { write: (chunk: string) => { logs.push(chunk); } };
  const stderr = { write: () => undefined };
  try {
    assert.equal(runApprove([], stdout, stderr), 1);
    assert.equal(runApprove([checkout.id], stdout, stderr), 0);
    const fromEnv = contextFromEnv();
    assert.equal(fromEnv.dataDir, ctx.dataDir);
  } finally {
    restore("GROKSHOP_DATA_DIR", previous.data);
    restore("GROKSHOP_SHIPPING_MODE", previous.shipping);
    restore("GROKSHOP_PAYMENTS_MODE", previous.payments);
    restore("GROKSHOP_CATALOG_PATH", previous.catalog);
  }
  const printed = JSON.parse(logs.join("")) as { checkout_id: string; human_approved: boolean };
  assert.equal(printed.checkout_id, checkout.id);
  assert.equal(printed.human_approved, true);
  const confirmed = confirmOrder({ checkout_id: checkout.id, human_approved: true }, ctx);
  assert.equal(confirmed.status, "confirmed");
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
