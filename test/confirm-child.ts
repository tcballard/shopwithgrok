import { contextFromEnv } from "../src/context.js";
import { GrokShopError } from "../src/errors.js";
import { confirmOrder } from "../src/service.js";

const checkoutId = process.env.CHECKOUT_ID ?? "";

try {
  confirmOrder({ checkout_id: checkoutId, human_approved: true }, contextFromEnv());
  process.exit(0);
} catch (err) {
  if (err instanceof GrokShopError && err.code === "out_of_stock") process.exit(2);
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
