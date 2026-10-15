import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Repository root when running from src/ via tsx or from dist/ after tsc. */
export const repoRoot = path.resolve(moduleDir, "..");

export const defaultCatalogPath = path.join(repoRoot, "data", "harbor-hex.sample.json");

export type ShopContext = {
  dataDir: string;
  catalogPath: string;
  merchantName: string;
  shippingMode: string;
  paymentsMode: string;
  approvalSecret: string;
  httpHost: string;
  httpPort: number;
};

export function contextFromEnv(env: NodeJS.ProcessEnv = process.env): ShopContext {
  const port = Number(env.GROKSHOP_HTTP_PORT ?? "39217");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`GROKSHOP_HTTP_PORT must be an integer from 0 to 65535, got ${env.GROKSHOP_HTTP_PORT}`);
  }
  return {
    dataDir: path.resolve(env.GROKSHOP_DATA_DIR ?? path.join(process.cwd(), ".grokshop")),
    catalogPath: path.resolve(env.GROKSHOP_CATALOG_PATH ?? defaultCatalogPath),
    merchantName: env.GROKSHOP_MERCHANT_NAME?.trim() || "Merchant",
    shippingMode: (env.GROKSHOP_SHIPPING_MODE ?? "stub").trim().toLowerCase(),
    paymentsMode: (env.GROKSHOP_PAYMENTS_MODE ?? "stub").trim().toLowerCase(),
    approvalSecret: env.GROKSHOP_APPROVAL_SECRET ?? "",
    httpHost: env.GROKSHOP_HTTP_HOST?.trim() || "127.0.0.1",
    httpPort: port,
  };
}
