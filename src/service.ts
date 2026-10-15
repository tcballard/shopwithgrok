import type { ShopContext } from "./context.js";
import { effectiveInventory, findProduct, loadCatalog, withInventoryOverlay } from "./catalog.js";
import { GrokShopError } from "./errors.js";
import { newId } from "./ids.js";
import { assertPaymentsStub, stubPaymentIntent } from "./payments.js";
import {
  approveInput,
  confirmOrderInput,
  createCheckoutInput,
  getProductInput,
  listInventoryInput,
  quoteShippingInput,
  searchProductsInput,
} from "./schemas.js";
import { assertShippingStub, buildStubRates, dollarsToCents } from "./shipping.js";
import { readState, updateState } from "./store.js";
import type { Catalog, Checkout, Product, ShippingRate, ShopState, StoredRate } from "./types.js";

const NOT_CHARGED =
  "Stub confirmation only. No card was charged and no shipping label was purchased.";

export function searchProducts(raw: unknown, ctx: ShopContext) {
  const input = searchProductsInput.parse(raw ?? {});
  const catalog = loadShopCatalog(ctx);
  const query = input.query?.trim().toLowerCase() ?? "";
  const limit = input.limit ?? 20;
  const products = catalog.products
    .filter((product) => {
      if (!query) return true;
      const haystack = [product.sku, product.name, product.description, product.category]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    })
    .slice(0, limit);
  return {
    merchant: catalog.merchant,
    query: input.query ?? "",
    products,
  };
}

export function getProduct(raw: unknown, ctx: ShopContext) {
  const input = getProductInput.parse(raw ?? {});
  const catalog = loadShopCatalog(ctx);
  return { merchant: catalog.merchant, product: findProduct(catalog, input.sku) };
}

export function listInventory(raw: unknown, ctx: ShopContext) {
  const input = listInventoryInput.parse(raw ?? {});
  const catalog = loadShopCatalog(ctx);
  const products = input.sku ? [findProduct(catalog, input.sku)] : catalog.products;
  return {
    merchant: catalog.merchant,
    inventory: products.map((product) => ({
      sku: product.sku,
      name: product.name,
      inventory: product.inventory,
      in_stock: product.inventory > 0,
      status: product.inventory > 0 ? "in_stock" : "out_of_stock",
      sample: product.sample,
      example: product.example,
    })),
  };
}

export function quoteShipping(raw: unknown, ctx: ShopContext) {
  assertShippingStub(ctx);
  const input = quoteShippingInput.parse(raw ?? {});
  const catalog = loadCatalog(ctx);
  const quantity = input.quantity ?? 1;
  let product: Product | undefined;
  if (input.sku) product = findProduct(catalog, input.sku);
  const unitWeight = input.weight_oz ?? product?.weight_oz;
  if (!unitWeight) {
    throw new GrokShopError("validation_error", "quote_shipping needs sku or weight_oz", 400);
  }
  const country = (input.to_country ?? "US").toUpperCase();
  const weightOz = roundOz(unitWeight * quantity);
  const rates = buildStubRates({
    weightOz,
    postalCode: input.to_postal_code,
    country,
  });
  const stored: StoredRate[] = rates.map((rate) => ({
    ...rate,
    sku: product?.sku ?? null,
    quantity,
    weight_oz: weightOz,
    to_postal_code: input.to_postal_code,
    to_country: country,
  }));
  updateState(ctx, (state) => {
    for (const rate of stored) state.rates[rate.id] = rate;
  });
  return {
    object: "shipping_quote" as const,
    mode: "stub" as const,
    merchant: catalog.merchant,
    sku: product?.sku ?? null,
    quantity,
    weight_oz: weightOz,
    to: { postal_code: input.to_postal_code, country },
    labels_purchased: false as const,
    note: "Stub EasyPost-shaped rates. No carrier API was called and no label was purchased.",
    rates,
  };
}

export function createCheckout(raw: unknown, ctx: ShopContext): Checkout {
  assertPaymentsStub(ctx);
  assertShippingStub(ctx);
  const input = createCheckoutInput.parse(raw ?? {});
  const quantity = input.quantity ?? 1;
  const catalog = loadShopCatalog(ctx);
  const product = findProduct(catalog, input.sku);
  if (product.inventory < quantity) {
    throw new GrokShopError(
      "out_of_stock",
      `${product.sku} has ${product.inventory} available, requested ${quantity}`,
      409,
    );
  }
  const rate = readState(ctx).rates[input.rate_id];
  if (!rate) {
    throw new GrokShopError(
      "rate_not_found",
      `Unknown rate_id ${input.rate_id}. Call quote_shipping first.`,
      404,
    );
  }
  if (rate.sku && rate.sku !== product.sku) {
    throw new GrokShopError(
      "rate_mismatch",
      `Rate ${rate.id} was quoted for ${rate.sku}, not ${product.sku}`,
      400,
    );
  }
  if (rate.quantity !== quantity) {
    throw new GrokShopError(
      "rate_mismatch",
      `Rate ${rate.id} was quoted for quantity ${rate.quantity}, not ${quantity}`,
      400,
    );
  }
  const country = (input.ship_to.country ?? "US").toUpperCase();
  if (rate.to_country !== country || rate.to_postal_code !== input.ship_to.postal_code) {
    throw new GrokShopError(
      "rate_mismatch",
      `Rate ${rate.id} was quoted to ${rate.to_country} ${rate.to_postal_code}, not ${country} ${input.ship_to.postal_code}`,
      400,
    );
  }

  const checkoutId = newId("chk");
  const shippingCents = dollarsToCents(rate.rate);
  const subtotal = product.price_cents * quantity;
  const checkout: Checkout = {
    id: checkoutId,
    object: "checkout",
    merchant: catalog.merchant,
    status: "requires_action",
    human_approved: false,
    next_action: { type: "grokshop_human_approval" },
    currency: "usd",
    amount_subtotal: subtotal,
    amount_shipping: shippingCents,
    amount_total: subtotal + shippingCents,
    line_items: [
      {
        sku: product.sku,
        name: product.name,
        quantity,
        unit_amount: product.price_cents,
        sample: product.sample,
        example: product.example,
      },
    ],
    shipping_rate: publicRate(rate),
    ship_to: {
      name: input.ship_to.name,
      line1: input.ship_to.line1,
      city: input.ship_to.city,
      state: input.ship_to.state,
      postal_code: input.ship_to.postal_code,
      country: (input.ship_to.country ?? "US").toUpperCase(),
    },
    payment_intent: stubPaymentIntent(subtotal + shippingCents, checkoutId),
    approval: null,
    order: null,
    created_at: new Date().toISOString(),
    labels_purchased: false,
    charged: false,
  };

  updateState(ctx, (state) => {
    state.checkouts[checkout.id] = checkout;
  });
  return checkout;
}

export function approveCheckout(checkoutId: string, method: "cli" | "http", ctx: ShopContext, note?: string): Checkout {
  const parsedNote = approveInput.parse({ note }).note;
  return updateState(ctx, (state) => {
    const checkout = requireCheckout(state.checkouts, checkoutId);
    if (checkout.status === "confirmed") {
      throw new GrokShopError("already_confirmed", `${checkout.id} is already confirmed`, 409);
    }
    if (!checkout.approval) {
      checkout.approval = {
        approved_at: new Date().toISOString(),
        method,
        note: parsedNote ?? (method === "cli" ? "Approved from the local CLI." : "Approved from the local HTTP endpoint."),
      };
      checkout.human_approved = true;
    }
    return checkout;
  });
}

export function confirmOrder(raw: unknown, ctx: ShopContext): Checkout {
  assertPaymentsStub(ctx);
  assertShippingStub(ctx);
  const input = confirmOrderInput.parse(raw ?? {});
  return updateState(ctx, (state) => {
    const checkout = requireCheckout(state.checkouts, input.checkout_id);
    if (checkout.status === "confirmed" && checkout.order && input.human_approved === true && checkout.approval) {
      return checkout;
    }
    if (input.human_approved !== true) {
      throw new GrokShopError(
        "approval_required",
        "confirm_order refused: human_approved must be true. GrokShop never auto-buys. Passing this flag does not record approval.",
        403,
      );
    }
    if (!checkout.approval || checkout.human_approved !== true) {
      throw new GrokShopError(
        "approval_not_recorded",
        `confirm_order refused: ${checkout.id} has no stored human approval. Approve outside MCP with \`npm run approve -- ${checkout.id}\` or POST /checkouts/${checkout.id}/approve. There is no approve tool.`,
        403,
      );
    }

    const catalog = loadCatalog(ctx);
    commitSoldUnits(state, catalog, checkout.line_items);

    const confirmedAt = new Date().toISOString();
    checkout.status = "confirmed";
    checkout.next_action = null;
    checkout.payment_intent.status = "succeeded";
    checkout.payment_intent.next_action = null;
    checkout.payment_intent.metadata.grokshop_charged = "false";
    checkout.order = {
      id: newId("ord"),
      object: "order",
      status: "confirmed",
      confirmed_at: confirmedAt,
      human_approved: true,
      payment_intent_id: checkout.payment_intent.id,
      charged: false,
      note: NOT_CHARGED,
    };
    checkout.charged = false;
    checkout.labels_purchased = false;
    return checkout;
  });
}

export function getCheckout(checkoutId: string, ctx: ShopContext): Checkout {
  return requireCheckout(readState(ctx).checkouts, checkoutId);
}

function loadShopCatalog(ctx: ShopContext) {
  return withInventoryOverlay(loadCatalog(ctx), readState(ctx).inventory_sold);
}

function commitSoldUnits(state: ShopState, catalog: Catalog, lineItems: Checkout["line_items"]): void {
  const requested = new Map<string, number>();
  for (const item of lineItems) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new GrokShopError("validation_error", `${item.sku} quantity must be a positive integer`, 400);
    }
    requested.set(item.sku, (requested.get(item.sku) ?? 0) + item.quantity);
  }

  const additions: Array<{ sku: string; quantity: number }> = [];
  for (const [sku, quantity] of requested) {
    const product = findProduct(catalog, sku);
    const available = effectiveInventory(product.inventory, state.inventory_sold[sku] ?? 0);
    if (available < quantity) {
      throw new GrokShopError(
        "out_of_stock",
        `${sku} has ${available} available, requested ${quantity}`,
        409,
      );
    }
    additions.push({ sku, quantity });
  }

  for (const { sku, quantity } of additions) {
    state.inventory_sold[sku] = (state.inventory_sold[sku] ?? 0) + quantity;
  }
}

function requireCheckout(checkouts: Record<string, Checkout>, checkoutId: string): Checkout {
  if (!/^chk_[a-f0-9]+$/.test(checkoutId)) {
    throw new GrokShopError("validation_error", "checkout_id must look like chk_ followed by hex", 400);
  }
  const checkout = checkouts[checkoutId];
  if (!checkout) throw new GrokShopError("not_found", `No checkout ${checkoutId}`, 404);
  return checkout;
}

function publicRate(rate: StoredRate): ShippingRate {
  return {
    id: rate.id,
    object: "Rate",
    carrier: rate.carrier,
    service: rate.service,
    rate: rate.rate,
    currency: rate.currency,
    delivery_days: rate.delivery_days,
    delivery_date_guaranteed: false,
    carrier_account_id: "ca_stub",
    shipment_id: rate.shipment_id,
    mode: "stub",
  };
}

function roundOz(value: number): number {
  return Math.round(value * 100) / 100;
}
