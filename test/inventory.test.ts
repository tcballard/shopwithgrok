import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { repoRoot } from "../src/context.js";
import { GrokShopError } from "../src/errors.js";
import { readState } from "../src/store.js";
import {
  approveCheckout,
  confirmOrder,
  createCheckout,
  getProduct,
  listInventory,
  quoteShipping,
  searchProducts,
} from "../src/service.js";
import type { ShopContext } from "../src/context.js";
import { sampleShipTo, testContext } from "./helpers.js";

function openCheckout(ctx: ShopContext, sku: string, quantity = 1) {
  const quote = quoteShipping(
    { sku, quantity, to_postal_code: "94107", to_country: "US" },
    ctx,
  );
  const rate = quote.rates[0];
  assert.ok(rate);
  return createCheckout(
    { sku, quantity, rate_id: rate.id, ship_to: sampleShipTo },
    ctx,
  );
}

function lastUnitCatalog() {
  return {
    merchant: {
      id: "fixture",
      name: "Fixture (SAMPLE)",
      sample: true,
      example: true,
      disclaimer: "SAMPLE / EXAMPLE",
    },
    products: [fixtureProduct("SAMPLE-KB-01", "Last Harbor Hex Keyboard Kit", 1)],
  };
}

function fixtureProduct(sku: string, name: string, inventory: number) {
  return {
    sku,
    name,
    description: "SAMPLE / EXAMPLE",
    price_cents: 18900,
    currency: "usd",
    weight_oz: 42,
    inventory,
    category: "keyboard",
    sample: true,
    example: true,
  };
}

function confirmInChild(
  ctx: ShopContext,
  checkoutId: string,
): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(repoRoot, "test/confirm-child.ts")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GROKSHOP_DATA_DIR: ctx.dataDir,
        GROKSHOP_CATALOG_PATH: ctx.catalogPath,
        GROKSHOP_SHIPPING_MODE: "stub",
        GROKSHOP_PAYMENTS_MODE: "stub",
        CHECKOUT_ID: checkoutId,
      },
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stderr }));
  });
}

function onHand(ctx: ShopContext, sku: string): number {
  const row = listInventory({ sku }, ctx).inventory[0];
  assert.equal(row?.sku, sku);
  return row.inventory;
}

test("confirm_order decrements effective stock and does not rewrite the catalog", () => {
  const ctx = testContext();
  const catalogBefore = readFileSync(ctx.catalogPath);
  assert.equal(onHand(ctx, "SAMPLE-KB-01"), 14);
  assert.equal(getProduct({ sku: "SAMPLE-KB-01" }, ctx).product.inventory, 14);
  assert.equal(searchProducts({ query: "keyboard" }, ctx).products[0]?.inventory, 14);

  const checkout = openCheckout(ctx, "SAMPLE-KB-01", 1);
  assert.equal(onHand(ctx, "SAMPLE-KB-01"), 14);
  assert.deepEqual(readState(ctx).inventory_sold, {});

  approveCheckout(checkout.id, "cli", ctx);
  const confirmed = confirmOrder({ checkout_id: checkout.id, human_approved: true }, ctx);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.payment_intent.status, "succeeded");
  assert.equal(onHand(ctx, "SAMPLE-KB-01"), 13);
  assert.equal(getProduct({ sku: "SAMPLE-KB-01" }, ctx).product.inventory, 13);
  assert.equal(searchProducts({ query: "keyboard" }, ctx).products[0]?.inventory, 13);
  assert.equal(readState(ctx).inventory_sold["SAMPLE-KB-01"], 1);
  assert.deepEqual(readFileSync(ctx.catalogPath), catalogBefore);

  const cable = openCheckout(ctx, "SAMPLE-CBL-01", 2);
  approveCheckout(cable.id, "cli", ctx);
  confirmOrder({ checkout_id: cable.id, human_approved: true }, ctx);
  assert.equal(onHand(ctx, "SAMPLE-CBL-01"), 118);
  assert.equal(readState(ctx).inventory_sold["SAMPLE-CBL-01"], 2);
  assert.deepEqual(readFileSync(ctx.catalogPath), catalogBefore);
});

test("a repeat confirm returns the same order and does not decrement again", () => {
  const ctx = testContext();
  const checkout = openCheckout(ctx, "SAMPLE-KB-01", 1);
  approveCheckout(checkout.id, "cli", ctx);
  const confirmed = confirmOrder({ checkout_id: checkout.id, human_approved: true }, ctx);
  const again = confirmOrder({ checkout_id: checkout.id, human_approved: true }, ctx);
  assert.equal(again.order?.id, confirmed.order?.id);
  assert.equal(again.status, "confirmed");
  assert.equal(onHand(ctx, "SAMPLE-KB-01"), 13);
  assert.equal(readState(ctx).inventory_sold["SAMPLE-KB-01"], 1);

  const third = confirmOrder({ checkout_id: checkout.id, human_approved: true }, ctx);
  assert.equal(third.order?.id, confirmed.order?.id);
  assert.equal(readState(ctx).inventory_sold["SAMPLE-KB-01"], 1);
});

test("the second checkout for the last unit is refused and stock flips to out_of_stock", () => {
  const ctx = testContext();
  const catalogPath = path.join(ctx.dataDir, "last-unit.json");
  writeFileSync(catalogPath, JSON.stringify(lastUnitCatalog()));
  const shop = testContext({ catalogPath, dataDir: ctx.dataDir });
  const catalogBefore = readFileSync(catalogPath);

  const first = openCheckout(shop, "SAMPLE-KB-01", 1);
  const second = openCheckout(shop, "SAMPLE-KB-01", 1);
  assert.equal(onHand(shop, "SAMPLE-KB-01"), 1);
  assert.equal(listInventory({ sku: "SAMPLE-KB-01" }, shop).inventory[0]?.status, "in_stock");
  assert.deepEqual(readState(shop).inventory_sold, {});

  approveCheckout(first.id, "cli", shop);
  approveCheckout(second.id, "http", shop);

  const confirmed = confirmOrder({ checkout_id: first.id, human_approved: true }, shop);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(onHand(shop, "SAMPLE-KB-01"), 0);
  const row = listInventory({ sku: "SAMPLE-KB-01" }, shop).inventory[0];
  assert.equal(row?.inventory, 0);
  assert.equal(row?.in_stock, false);
  assert.equal(row?.status, "out_of_stock");
  assert.equal(getProduct({ sku: "SAMPLE-KB-01" }, shop).product.inventory, 0);
  assert.equal(searchProducts({ query: "keyboard" }, shop).products[0]?.inventory, 0);

  assert.throws(
    () => confirmOrder({ checkout_id: second.id, human_approved: true }, shop),
    (err: unknown) =>
      err instanceof GrokShopError && err.code === "out_of_stock" && err.status === 409,
  );

  const stored = readState(shop).checkouts[second.id];
  assert.equal(stored?.status, "requires_action");
  assert.equal(stored?.order, null);
  assert.equal(stored?.payment_intent.status, "requires_action");
  assert.equal(readState(shop).checkouts[first.id]?.status, "confirmed");
  assert.equal(readState(shop).checkouts[first.id]?.order?.id, confirmed.order?.id);
  assert.equal(readState(shop).inventory_sold["SAMPLE-KB-01"], 1);

  const repeated = confirmOrder({ checkout_id: first.id, human_approved: true }, shop);
  assert.equal(repeated.order?.id, confirmed.order?.id);
  assert.equal(onHand(shop, "SAMPLE-KB-01"), 0);
  assert.equal(readState(shop).inventory_sold["SAMPLE-KB-01"], 1);

  assert.throws(
    () => openCheckout(shop, "SAMPLE-KB-01", 1),
    (err: unknown) => err instanceof GrokShopError && err.code === "out_of_stock",
  );
  assert.deepEqual(readFileSync(catalogPath), catalogBefore);
});

test("concurrent confirms of the last unit let only one order through", async () => {
  const ctx = testContext();
  const catalogPath = path.join(ctx.dataDir, "last-unit.json");
  writeFileSync(catalogPath, JSON.stringify(lastUnitCatalog()));
  const shop = testContext({ catalogPath, dataDir: ctx.dataDir });
  const first = openCheckout(shop, "SAMPLE-KB-01", 1);
  const second = openCheckout(shop, "SAMPLE-KB-01", 1);
  approveCheckout(first.id, "cli", shop);
  approveCheckout(second.id, "cli", shop);

  const [left, right] = await Promise.all([
    confirmInChild(shop, first.id),
    confirmInChild(shop, second.id),
  ]);
  const exits = [left.exitCode, right.exitCode].sort();
  assert.deepEqual(exits, [0, 2], `left=${left.exitCode} ${left.stderr}\nright=${right.exitCode} ${right.stderr}`);

  const state = readState(shop);
  assert.equal(state.inventory_sold["SAMPLE-KB-01"], 1);
  const checkouts = Object.values(state.checkouts);
  const confirmed = checkouts.filter((checkout) => checkout.status === "confirmed");
  const waiting = checkouts.filter((checkout) => checkout.status === "requires_action");
  assert.equal(confirmed.length, 1);
  assert.equal(waiting.length, 1);
  assert.equal(confirmed[0]?.payment_intent.status, "succeeded");
  assert.equal(waiting[0]?.payment_intent.status, "requires_action");
  assert.equal(waiting[0]?.order, null);
  assert.equal(onHand(shop, "SAMPLE-KB-01"), 0);
  assert.equal(listInventory({ sku: "SAMPLE-KB-01" }, shop).inventory[0]?.status, "out_of_stock");
});

test("confirm_order decrements every line item on the checkout", () => {
  const ctx = testContext();
  const catalogPath = path.join(ctx.dataDir, "two-skus.json");
  writeFileSync(
    catalogPath,
    JSON.stringify({
      merchant: {
        id: "fixture",
        name: "Fixture (SAMPLE)",
        sample: true,
        example: true,
        disclaimer: "SAMPLE / EXAMPLE",
      },
      products: [
        fixtureProduct("SAMPLE-A", "First", 5),
        fixtureProduct("SAMPLE-B", "Second", 4),
      ],
    }),
  );
  const shop = testContext({ catalogPath, dataDir: ctx.dataDir });
  const checkout = openCheckout(shop, "SAMPLE-A", 2);
  const file = path.join(shop.dataDir, "state.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    checkouts: Record<string, { line_items: Array<Record<string, unknown>> }>;
  };
  const template = parsed.checkouts[checkout.id]?.line_items[0];
  assert.ok(template);
  parsed.checkouts[checkout.id]?.line_items.push({
    ...template,
    sku: "SAMPLE-B",
    name: "Second",
    quantity: 3,
  });
  writeFileSync(file, JSON.stringify(parsed));

  approveCheckout(checkout.id, "cli", shop);
  const confirmed = confirmOrder({ checkout_id: checkout.id, human_approved: true }, shop);
  assert.equal(confirmed.line_items.length, 2);
  assert.equal(readState(shop).inventory_sold["SAMPLE-A"], 2);
  assert.equal(readState(shop).inventory_sold["SAMPLE-B"], 3);
  assert.equal(onHand(shop, "SAMPLE-A"), 3);
  assert.equal(onHand(shop, "SAMPLE-B"), 1);
});

test("a state file from before the overlay still loads and decrements", () => {
  const ctx = testContext();
  const checkout = openCheckout(ctx, "SAMPLE-DOCK-01", 1);
  const file = path.join(ctx.dataDir, "state.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { inventory_sold?: unknown };
  delete parsed.inventory_sold;
  writeFileSync(file, JSON.stringify(parsed));
  assert.deepEqual(readState(ctx).inventory_sold, {});

  approveCheckout(checkout.id, "cli", ctx);
  confirmOrder({ checkout_id: checkout.id, human_approved: true }, ctx);
  assert.equal(readState(ctx).inventory_sold["SAMPLE-DOCK-01"], 1);
  assert.equal(onHand(ctx, "SAMPLE-DOCK-01"), 29);
});
