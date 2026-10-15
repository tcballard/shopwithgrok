# GrokShop live demo (60–90 seconds)

Harbor & Hex (SAMPLE) only. Fictional catalog. Not a real merchant, not a real offer, and not affiliated with any hardware brand. No card is charged. No shipping label is bought.

**Thesis, say it first and last:** Merchants keep the Amazon margin; agents buy headless over MCP.

Spoken lines below are about 75 seconds. Keep talking while each result paints, and the take stays inside 60–90 seconds.

## Before you hit record

Repo root. Client attached as in [Attach in Grok Bot (MCP)](README.md#attach-in-grok-bot-mcp) and [`examples/mcp-client.json`](examples/mcp-client.json):

```bash
GROKSHOP_SHIPPING_MODE=stub \
GROKSHOP_PAYMENTS_MODE=stub \
GROKSHOP_CATALOG_PATH=data/harbor-hex.sample.json \
GROKSHOP_DATA_DIR=.grokshop \
node --import tsx src/index.ts
```

There is no approve tool. Leave a second terminal in the repo for `npm run approve`. Use the same `GROKSHOP_DATA_DIR` as the server.

`npm run demo` prints these same beats if you want a fallback transcript instead of driving the client by hand.

## On screen

1. `search_products` with `{ "query": "keyboard" }`.
2. `quote_shipping` with `{ "sku": "SAMPLE-KB-01", "quantity": 1, "to_postal_code": "94107" }`.
3. `create_checkout` with that `rate_id`, `SAMPLE-KB-01`, quantity 1, and a `ship_to` whose postal code is `94107`.
4. `confirm_order` with `{ "checkout_id": "chk_…", "human_approved": true }` before anyone approves.
5. In the other terminal: `npm run approve -- chk_…`
6. `confirm_order` again with `human_approved: true`. Point at the `ord_…` id and `charged: false`.

## Say this

**Open.** "Merchants keep the Amazon margin; agents buy headless over MCP. This is Harbor and Hex, sample data. Fictional products. Not a real store. Nothing here charges a card."

Show the tool list. There is no tool named approve.

**Search.** "The agent searches the merchant feed for a keyboard. It gets SAMPLE-KB-01, the Harbor Hex Keyboard Kit. Sample and example. Not a product we ship."

**Quote.** "It asks for shipping to 94107. Stub FedEx, UPS, and USPS rates come back. No label is purchased."

**Checkout.** "It creates a checkout. Status is requires action. A person still has to approve. There is no approve tool, so the agent cannot approve itself."

Show `next_action.type`: `grokshop_human_approval`.

**Refused.** "It tries to confirm. Refused. Approval has not been recorded. Passing the flag does not approve anything."

The error code is `approval_not_recorded`.

**Approve outside the agent.** "I approve it outside the agent, from the CLI. HTTP approval is the other door. Still not a tool the agent can call."

Run `npm run approve -- chk_…` on the checkout id from the screen.

**Confirmed.** "Now confirm succeeds. Here is the order id. Charged is false. Livemode stays false. The merchant keeps the customer and the margin. The agent bought headless over MCP, and a person still said yes."

Point at `order.id` (`ord_…`), `charged: false`, `payment_intent.livemode: false`, and `metadata.grokshop_charged` `"false"`.

**Close.** "Merchants keep the Amazon margin; agents buy headless over MCP."
