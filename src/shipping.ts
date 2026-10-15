import type { ShopContext } from "./context.js";
import { GrokShopError } from "./errors.js";
import { newId } from "./ids.js";
import type { ShippingRate } from "./types.js";

const SERVICES: Array<{
  carrier: ShippingRate["carrier"];
  service: string;
  base: number;
  perOz: number;
  days: number;
}> = [
  { carrier: "USPS", service: "GroundAdvantage", base: 6.4, perOz: 0.08, days: 5 },
  { carrier: "UPS", service: "Ground", base: 9.15, perOz: 0.11, days: 4 },
  { carrier: "FedEx", service: "FEDEX_GROUND", base: 10.3, perOz: 0.12, days: 4 },
  { carrier: "USPS", service: "Priority", base: 9.7, perOz: 0.1, days: 2 },
  { carrier: "FedEx", service: "FEDEX_2_DAY", base: 18.25, perOz: 0.18, days: 2 },
];

/**
 * Refuse any non-stub shipping mode before rates are computed.
 * v1 has no EasyPost, Shippo, FedEx, UPS, or USPS client and must not grow one here.
 */
export function assertShippingStub(ctx: ShopContext): void {
  if (ctx.shippingMode === "live") {
    throw new GrokShopError(
      "shipping_live_disabled",
      "GROKSHOP_SHIPPING_MODE=live is refused. GrokShop v1 does not buy labels or call EasyPost, Shippo, FedEx, UPS, or USPS. Set GROKSHOP_SHIPPING_MODE=stub.",
      501,
    );
  }
  if (ctx.shippingMode !== "stub") {
    throw new GrokShopError(
      "shipping_mode_invalid",
      `GROKSHOP_SHIPPING_MODE=${ctx.shippingMode} is not supported. Only "stub" is implemented.`,
      400,
    );
  }
}

export function buildStubRates(input: {
  weightOz: number;
  postalCode: string;
  country: string;
}): ShippingRate[] {
  const shipmentId = newId("shp_stub");
  const zone = zoneFactor(input.postalCode, input.country);
  return SERVICES.map((service) => {
    const dollars = (service.base + service.perOz * input.weightOz) * zone;
    return {
      id: newId("rate"),
      object: "Rate" as const,
      carrier: service.carrier,
      service: service.service,
      rate: dollars.toFixed(2),
      currency: "USD" as const,
      delivery_days: input.country.toUpperCase() === "US" ? service.days : service.days + 5,
      delivery_date_guaranteed: false as const,
      carrier_account_id: "ca_stub" as const,
      shipment_id: shipmentId,
      mode: "stub" as const,
    };
  });
}

function zoneFactor(postalCode: string, country: string): number {
  if (country.toUpperCase() !== "US") return 2.35;
  const digit = Number(postalCode.replace(/\D/g, "")[0] ?? "5");
  const zoneDigit = Number.isFinite(digit) ? digit : 5;
  return 1 + zoneDigit * 0.03;
}

export function dollarsToCents(rate: string): number {
  if (!/^\d+\.\d{2}$/.test(rate)) {
    throw new GrokShopError("shipping_rate_invalid", `Rate ${rate} is not a dollar string`, 400);
  }
  return Math.round(Number(rate) * 100);
}
