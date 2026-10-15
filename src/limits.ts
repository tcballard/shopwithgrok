import { GrokShopError } from "./errors.js";
import type { Catalog } from "./types.js";

export const FREE_TOOL_CALLS_PER_DAY = 50;
export const FREE_CHECKOUTS_PER_DAY = 5;

export const PAID_PLANS_NOTE = "Paid plans are not available in this build.";

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function resetsAt(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new Error(`Bad usage day ${day}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString();
}

export function upgradeError(kind: "tool_calls" | "checkouts", used: number, limit: number, day: string): GrokShopError {
  const label = kind === "tool_calls" ? "tool calls" : "checkouts";
  const resets = resetsAt(day);
  return new GrokShopError(
    "upgrade_required",
    `Free tier limit reached: ${limit} ${label} per day (${used} used). Resets at ${resets}. Upgrade to continue. ${PAID_PLANS_NOTE}`,
    402,
    {
      tier: "free",
      limit: kind,
      used,
      limit_value: limit,
      resets_at: resets,
      upgrade: PAID_PLANS_NOTE,
    },
  );
}

/** Free tier may only serve a catalog that is explicitly SAMPLE / EXAMPLE fiction. */
export function assertFreeTierCatalog(catalog: Catalog): void {
  const badMerchant = !catalog.merchant.sample || !catalog.merchant.example;
  const badProduct = catalog.products.some(
    (product) => !product.sample || !product.example || !product.sku.startsWith("SAMPLE-"),
  );
  if (badMerchant || badProduct) {
    throw new GrokShopError(
      "upgrade_required",
      `Free tier includes the Harbor & Hex SAMPLE catalog only. ${PAID_PLANS_NOTE}`,
      402,
      { tier: "free", limit: "catalog", upgrade: PAID_PLANS_NOTE },
    );
  }
}

export function readPositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000) {
    throw new Error(`${name} must be an integer from 1 to 1000000, got ${raw}`);
  }
  return value;
}
