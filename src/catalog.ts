import { readFileSync } from "node:fs";
import path from "node:path";
import type { ShopContext } from "./context.js";
import { GrokShopError } from "./errors.js";
import type { Catalog, Merchant, Product } from "./types.js";

const SAMPLE_DISCLAIMER =
  "SAMPLE / EXAMPLE data. Not a real merchant, not a real offer, and not affiliated with any hardware brand.";

export function loadCatalog(ctx: ShopContext): Catalog {
  let raw: string;
  try {
    raw = readFileSync(ctx.catalogPath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GrokShopError("catalog_unreadable", `Could not read catalog at ${ctx.catalogPath}: ${message}`, 500);
  }

  const ext = path.extname(ctx.catalogPath).toLowerCase();
  if (ext === ".csv") return catalogFromCsv(raw, ctx.merchantName);
  if (ext === ".json") return catalogFromJson(raw, ctx.merchantName);
  throw new GrokShopError(
    "catalog_unsupported",
    `Catalog ${ctx.catalogPath} must be .json or .csv`,
    400,
  );
}

export function catalogFromJson(raw: string, fallbackMerchantName: string): Catalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GrokShopError("catalog_invalid", "Catalog JSON is not valid JSON", 400);
  }

  if (Array.isArray(parsed)) {
    return {
      merchant: defaultMerchant(fallbackMerchantName, false),
      products: parsed.map((row, index) => normalizeProduct(row, `products[${index}]`)),
    };
  }

  if (!parsed || typeof parsed !== "object") {
    throw new GrokShopError("catalog_invalid", "Catalog JSON must be an object or an array of products", 400);
  }

  const body = parsed as Record<string, unknown>;
  const merchantRaw = body.merchant;
  const productsRaw = body.products ?? body.items;
  if (!Array.isArray(productsRaw)) {
    throw new GrokShopError("catalog_invalid", "Catalog JSON needs a products array", 400);
  }

  const merchant = normalizeMerchant(merchantRaw, fallbackMerchantName);
  return {
    merchant,
    products: productsRaw.map((row, index) => normalizeProduct(row, `products[${index}]`)),
  };
}

export function catalogFromCsv(raw: string, fallbackMerchantName: string): Catalog {
  const { merchantName, rows } = parseCsv(raw);
  if (rows.length === 0) {
    throw new GrokShopError("catalog_invalid", "Catalog CSV has no product rows", 400);
  }
  const name = merchantName || fallbackMerchantName;
  const markedSample = rows.every((row) => boolish(row.sample) && boolish(row.example));
  return {
    merchant: defaultMerchant(name, markedSample),
    products: rows.map((row, index) =>
      normalizeProduct(
        {
          sku: row.sku,
          name: row.name,
          description: row.description,
          price_cents: row.price_cents,
          currency: row.currency,
          weight_oz: row.weight_oz,
          inventory: row.inventory,
          category: row.category,
          sample: row.sample,
          example: row.example,
        },
        `csv row ${index + 2}`,
      ),
    ),
  };
}

function defaultMerchant(name: string, sample: boolean): Merchant {
  const labeled = /\(SAMPLE\)/i.test(name) || sample;
  return {
    id: slug(name),
    name,
    sample: labeled,
    example: labeled,
    disclaimer: labeled
      ? SAMPLE_DISCLAIMER
      : "Merchant-supplied catalog. GrokShop v1 still stubs shipping labels and card charges.",
  };
}

function normalizeMerchant(raw: unknown, fallbackName: string): Merchant {
  if (!raw || typeof raw !== "object") return defaultMerchant(fallbackName, false);
  const body = raw as Record<string, unknown>;
  const name = stringField(body.name) || fallbackName;
  const sample = body.sample === undefined ? /\(SAMPLE\)/i.test(name) : Boolean(body.sample);
  const example = body.example === undefined ? sample : Boolean(body.example);
  return {
    id: stringField(body.id) || slug(name),
    name,
    sample,
    example,
    disclaimer: stringField(body.disclaimer) || (sample ? SAMPLE_DISCLAIMER : defaultMerchant(name, false).disclaimer),
  };
}

function normalizeProduct(raw: unknown, where: string): Product {
  if (!raw || typeof raw !== "object") {
    throw new GrokShopError("catalog_invalid", `${where} is not an object`, 400);
  }
  const body = raw as Record<string, unknown>;
  const sku = stringField(body.sku);
  const name = stringField(body.name);
  if (!sku) throw new GrokShopError("catalog_invalid", `${where} is missing sku`, 400);
  if (!name) throw new GrokShopError("catalog_invalid", `${where} is missing name`, 400);

  const currency = (stringField(body.currency) || "usd").toLowerCase();
  if (currency !== "usd") {
    throw new GrokShopError("catalog_invalid", `${where} currency must be usd in v1`, 400);
  }

  const sample = body.sample === undefined ? sku.startsWith("SAMPLE-") : Boolean(body.sample === true || body.sample === "true");
  const example = body.example === undefined ? sample : Boolean(body.example === true || body.example === "true");

  return {
    sku,
    name,
    description: stringField(body.description) || name,
    price_cents: nonNegativeInt(body.price_cents, `${where} price_cents`),
    currency: "usd",
    weight_oz: positiveNumber(body.weight_oz ?? 16, `${where} weight_oz`),
    inventory: nonNegativeInt(body.inventory, `${where} inventory`),
    category: stringField(body.category) || "general",
    sample,
    example,
  };
}

function nonNegativeInt(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isInteger(n) || n < 0) {
    throw new GrokShopError("catalog_invalid", `${label} must be a non-negative integer`, 400);
  }
  return n;
}

function positiveNumber(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw new GrokShopError("catalog_invalid", `${label} must be a positive number`, 400);
  }
  return n;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function boolish(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes";
}

function slug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/\(sample\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "merchant";
}

type CsvParse = {
  merchantName: string;
  rows: Array<Record<string, string>>;
};

export function parseCsv(raw: string): CsvParse {
  let merchantName = "";
  const table: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  const pushCell = () => {
    row.push(cell);
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    if (row.some((value) => value.trim().length > 0)) table.push(row);
    row = [];
  };

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (inQuotes) {
      if (char === '"') {
        if (raw[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      pushCell();
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && raw[i + 1] === "\n") i += 1;
      pushRow();
      continue;
    }
    cell += char;
  }
  if (cell.length > 0 || row.length > 0) pushRow();

  const filtered: string[][] = [];
  for (const candidate of table) {
    const first = candidate[0]?.trim() ?? "";
    if (first.startsWith("#")) {
      const comment = candidate.join(",").replace(/^#\s?/, "").trim();
      const match = comment.match(/^merchant:\s*(.+)$/i);
      if (match?.[1]) merchantName = match[1].trim();
      continue;
    }
    filtered.push(candidate.map((value) => value.trim()));
  }

  const header = filtered.shift();
  if (!header) return { merchantName, rows: [] };
  const keys = header.map((key) => key.toLowerCase());
  const rows = filtered.map((values) => {
    const record: Record<string, string> = {};
    keys.forEach((key, index) => {
      record[key] = values[index] ?? "";
    });
    return record;
  });
  return { merchantName, rows };
}

export function findProduct(catalog: Catalog, sku: string): Product {
  const product = catalog.products.find((item) => item.sku === sku);
  if (!product) {
    throw new GrokShopError("not_found", `No product with sku ${sku}`, 404);
  }
  return product;
}

/** Catalog quantity minus units already confirmed. Never negative. */
export function effectiveInventory(catalogInventory: number, sold: number): number {
  const available = catalogInventory - sold;
  return available > 0 ? available : 0;
}

/** Return a catalog whose inventory fields reflect confirmed-order deductions. */
export function withInventoryOverlay(catalog: Catalog, sold: Readonly<Record<string, number>>): Catalog {
  return {
    merchant: catalog.merchant,
    products: catalog.products.map((product) => {
      const inventory = effectiveInventory(product.inventory, sold[product.sku] ?? 0);
      if (inventory === product.inventory) return product;
      return { ...product, inventory };
    }),
  };
}
