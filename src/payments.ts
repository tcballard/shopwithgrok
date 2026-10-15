import type { ShopContext } from "./context.js";
import { GrokShopError } from "./errors.js";
import { newId } from "./ids.js";
import type { PaymentIntentStub } from "./types.js";

/**
 * Refuse Stripe and any other non-stub payments mode before a checkout is stored.
 * v1 does not import a Stripe SDK and must not create a live or test PaymentIntent.
 */
export function assertPaymentsStub(ctx: ShopContext): void {
  if (ctx.paymentsMode === "stripe") {
    throw new GrokShopError(
      "payments_stripe_disabled",
      "GROKSHOP_PAYMENTS_MODE=stripe is refused. GrokShop v1 does not create Stripe PaymentIntents and does not charge cards. Set GROKSHOP_PAYMENTS_MODE=stub.",
      501,
    );
  }
  if (ctx.paymentsMode !== "stub") {
    throw new GrokShopError(
      "payments_mode_invalid",
      `GROKSHOP_PAYMENTS_MODE=${ctx.paymentsMode} is not supported. Only "stub" is implemented.`,
      400,
    );
  }
}

export function stubPaymentIntent(amountCents: number, checkoutId: string): PaymentIntentStub {
  return {
    id: newId("pi_stub"),
    object: "payment_intent",
    amount: amountCents,
    currency: "usd",
    status: "requires_action",
    livemode: false,
    next_action: { type: "grokshop_human_approval" },
    metadata: {
      grokshop_checkout_id: checkoutId,
      grokshop_mode: "stub",
      grokshop_charged: "false",
    },
  };
}
