import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShopContext } from "./context.js";
import { asGrokShopError, errorBody } from "./errors.js";
import {
  confirmOrderInput,
  createCheckoutInput,
  getProductInput,
  listInventoryInput,
  quoteShippingInput,
  searchProductsInput,
} from "./schemas.js";
import { callTool } from "./tools.js";

const INSTRUCTIONS = [
  "GrokShop is merchant infrastructure for AI agents. It is not a storefront.",
  "The bundled Harbor & Hex catalog is SAMPLE / EXAMPLE fiction. Do not treat it as a real offer.",
  "search_products, get_product, and list_inventory read the merchant feed.",
  "quote_shipping returns stub EasyPost-shaped rates (carrier, service, rate). It does not buy labels.",
  "create_checkout prepares a stub PaymentIntent in requires_action / grokshop_human_approval. It does not charge a card.",
  "confirm_order never auto-buys. It succeeds only when the argument human_approved is true AND a human approval was stored outside MCP.",
  "There is no approve tool. A person runs `npm run approve -- chk_…` or POST /checkouts/:id/approve.",
  "GROKSHOP_SHIPPING_MODE=live and GROKSHOP_PAYMENTS_MODE=stripe are refused.",
].join(" ");

export function createGrokShopServer(ctx: ShopContext): McpServer {
  const server = new McpServer(
    { name: "grokshop", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const writes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool(
    "search_products",
    {
      description:
        "Search the merchant catalog. The bundled feed is Harbor & Hex (SAMPLE): fictional desk hardware, every SKU prefixed SAMPLE-.",
      inputSchema: searchProductsInput.shape,
      annotations: readOnly,
    },
    async (args) => run("search_products", args, ctx),
  );

  server.registerTool(
    "get_product",
    {
      description: "Fetch one catalog product by SKU, including sample/example flags and inventory.",
      inputSchema: getProductInput.shape,
      annotations: readOnly,
    },
    async (args) => run("get_product", args, ctx),
  );

  server.registerTool(
    "list_inventory",
    {
      description: "List on-hand quantities from the catalog feed. Out-of-stock rows are included.",
      inputSchema: listInventoryInput.shape,
      annotations: readOnly,
    },
    async (args) => run("list_inventory", args, ctx),
  );

  server.registerTool(
    "quote_shipping",
    {
      description:
        "Return stub shipping rates shaped like EasyPost Rate objects (carrier, service, rate) for FedEx, UPS, and USPS. Does not buy a label. GROKSHOP_SHIPPING_MODE=live is refused.",
      inputSchema: quoteShippingInput.shape,
      annotations: readOnly,
    },
    async (args) => run("quote_shipping", args, ctx),
  );

  server.registerTool(
    "create_checkout",
    {
      description:
        "Create a checkout that requires human approval. Status is requires_action and next_action.type is grokshop_human_approval. The PaymentIntent is a stub (livemode false). No card is charged. Does not approve the checkout.",
      inputSchema: createCheckoutInput.shape,
      annotations: writes,
    },
    async (args) => run("create_checkout", args, ctx),
  );

  server.registerTool(
    "confirm_order",
    {
      description:
        "Confirm a checkout only after a human approval stored outside MCP. Requires human_approved true AND a prior `npm run approve -- chk_…` or POST /checkouts/:id/approve. There is no approve tool. Never auto-buys. Stub mode does not charge a card or buy a label.",
      inputSchema: confirmOrderInput.shape,
      annotations: writes,
    },
    async (args) => run("confirm_order", args, ctx),
  );

  return server;
}

async function run(name: Parameters<typeof callTool>[0], args: unknown, ctx: ShopContext) {
  try {
    const data = callTool(name, args, ctx);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  } catch (err) {
    const normalized = asGrokShopError(err);
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: JSON.stringify(errorBody(normalized), null, 2) }],
    };
  }
}
