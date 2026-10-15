export type Merchant = {
  id: string;
  name: string;
  sample: boolean;
  example: boolean;
  disclaimer: string;
};

export type Product = {
  sku: string;
  name: string;
  description: string;
  price_cents: number;
  currency: "usd";
  weight_oz: number;
  inventory: number;
  category: string;
  sample: boolean;
  example: boolean;
};

export type Catalog = {
  merchant: Merchant;
  products: Product[];
};

export type ShippingRate = {
  id: string;
  object: "Rate";
  carrier: "FedEx" | "UPS" | "USPS";
  service: string;
  rate: string;
  currency: "USD";
  delivery_days: number;
  delivery_date_guaranteed: false;
  carrier_account_id: "ca_stub";
  shipment_id: string;
  mode: "stub";
};

export type StoredRate = ShippingRate & {
  sku: string | null;
  quantity: number;
  weight_oz: number;
  to_postal_code: string;
  to_country: string;
};

export type ShipTo = {
  name: string;
  line1: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
};

export type PaymentIntentStub = {
  id: string;
  object: "payment_intent";
  amount: number;
  currency: "usd";
  status: "requires_action" | "succeeded";
  livemode: false;
  next_action: { type: "grokshop_human_approval" } | null;
  metadata: {
    grokshop_checkout_id: string;
    grokshop_mode: "stub";
    grokshop_charged: "false";
  };
};

export type ApprovalRecord = {
  approved_at: string;
  method: "cli" | "http";
  note: string;
};

export type OrderRecord = {
  id: string;
  object: "order";
  status: "confirmed";
  confirmed_at: string;
  human_approved: true;
  payment_intent_id: string;
  charged: false;
  note: string;
};

export type Checkout = {
  id: string;
  object: "checkout";
  merchant: Merchant;
  status: "requires_action" | "confirmed";
  human_approved: boolean;
  next_action: { type: "grokshop_human_approval" } | null;
  currency: "usd";
  amount_subtotal: number;
  amount_shipping: number;
  amount_total: number;
  line_items: Array<{
    sku: string;
    name: string;
    quantity: number;
    unit_amount: number;
    sample: boolean;
    example: boolean;
  }>;
  shipping_rate: ShippingRate;
  ship_to: ShipTo;
  payment_intent: PaymentIntentStub;
  approval: ApprovalRecord | null;
  order: OrderRecord | null;
  created_at: string;
  labels_purchased: false;
  charged: false;
};

export type ShopState = {
  version: 1;
  checkouts: Record<string, Checkout>;
  rates: Record<string, StoredRate>;
};
