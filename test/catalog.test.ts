import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { catalogFromCsv, loadCatalog } from "../src/catalog.js";
import { repoRoot } from "../src/context.js";
import { GrokShopError } from "../src/errors.js";
import { getProduct, listInventory, searchProducts } from "../src/service.js";
import { testContext } from "./helpers.js";

const EXPECTED_SKUS = [
  "SAMPLE-KB-01",
  "SAMPLE-DOCK-01",
  "SAMPLE-MPC-01",
  "SAMPLE-MAT-01",
  "SAMPLE-ARM-01",
  "SAMPLE-CBL-01",
  "SAMPLE-SW-01",
  "SAMPLE-STAND-01",
];

test("sample catalog is Harbor & Hex and every SKU is marked SAMPLE", () => {
  const catalog = loadCatalog(testContext());
  assert.equal(catalog.merchant.name, "Harbor & Hex (SAMPLE)");
  assert.equal(catalog.merchant.sample, true);
  assert.equal(catalog.merchant.example, true);
  assert.match(catalog.merchant.disclaimer, /Fictional sample merchant/);
  assert.deepEqual(
    catalog.products.map((product) => product.sku),
    EXPECTED_SKUS,
  );
  for (const product of catalog.products) {
    assert.ok(product.sku.startsWith("SAMPLE-"));
    assert.equal(product.sample, true);
    assert.equal(product.example, true);
    assert.match(product.description, /SAMPLE \/ EXAMPLE/);
    assert.equal(product.currency, "usd");
  }
  const switches = catalog.products.find((product) => product.sku === "SAMPLE-SW-01");
  assert.equal(switches?.inventory, 0);
  assert.equal(switches?.name, "Hex Linear Switches");
});

test("search, get, and inventory read the sample feed", () => {
  const ctx = testContext();
  const search = searchProducts({ query: "keyboard" }, ctx);
  assert.equal(search.products.length, 1);
  assert.equal(search.products[0]?.sku, "SAMPLE-KB-01");

  const product = getProduct({ sku: "SAMPLE-DOCK-01" }, ctx);
  assert.equal(product.product.name, "Harbor USB-C Dock");

  const inventory = listInventory({}, ctx);
  const row = inventory.inventory.find((item) => item.sku === "SAMPLE-SW-01");
  assert.equal(row?.status, "out_of_stock");
  assert.equal(row?.in_stock, false);
  assert.equal(inventory.inventory.length, 8);
});

test("unknown sku is a not_found error", () => {
  assert.throws(
    () => getProduct({ sku: "REAL-PRODUCT" }, testContext()),
    (err: unknown) => err instanceof GrokShopError && err.code === "not_found",
  );
});

test("CSV feed with a merchant comment loads", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grokshop-csv-"));
  const catalogPath = path.join(dir, "feed.csv");
  writeFileSync(
    catalogPath,
    [
      "# merchant: Bench Supply (SAMPLE)",
      "sku,name,description,price_cents,currency,weight_oz,inventory,category,sample,example",
      'SAMPLE-MAT-01,Bench Mat,"SAMPLE / EXAMPLE, wool",4500,usd,24,3,desk,true,true',
    ].join("\n"),
  );
  const catalog = loadCatalog(testContext({ catalogPath, merchantName: "ignored" }));
  assert.equal(catalog.merchant.name, "Bench Supply (SAMPLE)");
  assert.equal(catalog.products.length, 1);
  assert.equal(catalog.products[0]?.price_cents, 4500);
  assert.equal(catalog.products[0]?.sample, true);
  assert.match(catalog.products[0]?.description ?? "", /wool/);
});

test("checked-in sample CSV loads the cable and the out-of-stock switches", () => {
  const catalog = loadCatalog(
    testContext({ catalogPath: path.join(repoRoot, "examples", "merchant-feed.sample.csv") }),
  );
  assert.equal(catalog.merchant.name, "Harbor & Hex (SAMPLE)");
  assert.deepEqual(
    catalog.products.map((product) => product.sku),
    ["SAMPLE-CBL-01", "SAMPLE-SW-01"],
  );
  assert.equal(catalog.products[1]?.inventory, 0);
});

test("catalogFromCsv rejects an empty feed", () => {
  assert.throws(
    () => catalogFromCsv("sku,name,price_cents,inventory\n", "Merchant"),
    (err: unknown) => err instanceof GrokShopError && err.code === "catalog_invalid",
  );
});
