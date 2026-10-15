import type { ShopContext } from "./context.js";
import { GrokShopError } from "./errors.js";
import {
  confirmOrder,
  createCheckout,
  getProduct,
  listInventory,
  quoteShipping,
  searchProducts,
} from "./service.js";

export const TOOL_NAMES = [
  "search_products",
  "get_product",
  "list_inventory",
  "quote_shipping",
  "create_checkout",
  "confirm_order",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const handlers: Record<ToolName, (raw: unknown, ctx: ShopContext) => unknown> = {
  search_products: searchProducts,
  get_product: getProduct,
  list_inventory: listInventory,
  quote_shipping: quoteShipping,
  create_checkout: createCheckout,
  confirm_order: confirmOrder,
};

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

export function callTool(name: string, raw: unknown, ctx: ShopContext): unknown {
  if (!isToolName(name)) {
    throw new GrokShopError(
      "unknown_tool",
      `Unknown tool ${name}. Approval is not a tool; use npm run approve or POST /checkouts/:id/approve.`,
      404,
    );
  }
  return handlers[name](raw, ctx);
}
