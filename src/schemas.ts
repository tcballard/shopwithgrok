import { z } from "zod";

export const searchProductsInput = z.object({
  query: z.string().optional().describe("Case-insensitive match on sku, name, description, or category."),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum rows. Default 20."),
});

export const getProductInput = z.object({
  sku: z.string().min(1).describe("Merchant SKU, for example SAMPLE-KB-01."),
});

export const listInventoryInput = z.object({
  sku: z.string().min(1).optional().describe("Optional SKU filter."),
});

export const quoteShippingInput = z.object({
  sku: z.string().min(1).optional().describe("Catalog SKU. Weight is taken from the catalog unless weight_oz is set."),
  weight_oz: z.number().positive().optional().describe("Override weight in ounces."),
  quantity: z.number().int().min(1).max(99).optional().describe("Units. Default 1."),
  to_postal_code: z.string().min(3).describe("Destination postal code."),
  to_country: z.string().min(2).optional().describe("ISO-ish country code. Default US."),
});

export const shipToInput = z.object({
  name: z.string().min(1),
  line1: z.string().min(1),
  city: z.string().min(1),
  state: z.string().min(1),
  postal_code: z.string().min(3),
  country: z.string().min(2).optional(),
});

export const createCheckoutInput = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().min(1).max(99).optional(),
  rate_id: z.string().min(1).describe("A rate id returned by quote_shipping."),
  ship_to: shipToInput,
});

export const confirmOrderInput = z.object({
  checkout_id: z.string().min(1),
  human_approved: z
    .boolean()
    .describe("Must be true. This flag does not record approval; a human must approve outside MCP first."),
});

export const approveInput = z.object({
  note: z.string().max(200).optional(),
});
