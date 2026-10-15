# GrokShop

GrokShop is merchant infrastructure for AI agents. It is not a storefront and not an affiliate catalog.

A merchant points the kit at their own JSON or CSV product feed. Agents then use MCP (or a local HTTP mirror) to search inventory, ask for stub shipping rates, and prepare a checkout. A person approves that checkout outside the agent. Only then can `confirm_order` record an order. v1 does not charge cards and does not buy shipping labels.

Harbor & Hex (SAMPLE) is a fictional catalog bundled so you can run the flow locally. Those SKUs are examples. They are not real products, and GrokShop is not affiliated with Omarchy or any hardware brand.

## What an agent can call

| Tool | What it does |
| --- | --- |
| `search_products` | Search the merchant feed. |
| `get_product` | Fetch one SKU. |
| `list_inventory` | On-hand counts, including out-of-stock rows. |
| `quote_shipping` | Stub FedEx, UPS, and USPS rates shaped like an EasyPost `Rate` (`carrier`, `service`, `rate`). |
| `create_checkout` | Prepare a checkout. Status is `requires_action`. `next_action.type` is `grokshop_human_approval`. |
| `confirm_order` | Record the order only when `human_approved` is `true` **and** a stored approval already exists. |

There is no approve tool. Agents cannot approve their own checkout.

`create_checkout` returns a Stripe PaymentIntent-shaped stub with `livemode: false` and no `client_secret`. Nothing is sent to Stripe. `GROKSHOP_PAYMENTS_MODE=stripe` throws. `GROKSHOP_SHIPPING_MODE=live` throws. Neither mode has a network client.

## Run locally (about five minutes)

Requires Node.js 20 or newer.

```bash
git clone https://github.com/tcballard/shopwithgrok.git
cd shopwithgrok
npm install
npm test
npm run demo
```

`npm run demo` talks to the MCP server in-process, prints a checkout id, shows `confirm_order` refusing before approval, runs `npm run approve -- chk_…`, then confirms. The demo uses a temporary data directory and the sample catalog. No card is charged.

Copy [`.env.example`](.env.example) if you want the variable names in front of you. The process reads the environment itself; it does not load a `.env` file. The sample values are not credentials.

## Human approval

A checkout stays in `requires_action` until a person records approval, and `confirm_order` still demands the boolean `human_approved: true`.

The MCP server, the HTTP server, and the approve CLI share `GROKSHOP_DATA_DIR` (default `./.grokshop` under the process working directory).

CLI, from the repo root, using the same data directory as the server:

```bash
npm run approve -- chk_abc123
```

HTTP, with the secret from the environment:

```bash
npm run start:http
curl -s -X POST "http://127.0.0.1:39217/checkouts/chk_abc123/approve" \
  -H "Authorization: Bearer $GROKSHOP_APPROVAL_SECRET" \
  -H "content-type: application/json" \
  -d '{"note":"Approved at the desk."}'
```

The HTTP server binds to `127.0.0.1:39217` unless `GROKSHOP_HTTP_HOST` / `GROKSHOP_HTTP_PORT` are set. Tool routes on that mirror are not authenticated; keep it on localhost. `POST /checkouts/:id/approve` is the exception: it requires `Authorization: Bearer <GROKSHOP_APPROVAL_SECRET>`. If the secret is unset, that route returns 503. The CLI does not use the secret, because it is a local operator command.

After approval:

```bash
curl -s -X POST "http://127.0.0.1:39217/tools/confirm_order" \
  -H "content-type: application/json" \
  -d '{"checkout_id":"chk_abc123","human_approved":true}'
```

Calling `confirm_order` with `human_approved: true` before that approval is stored returns `approval_not_recorded`. Calling it with `human_approved: false` after approval returns `approval_required`. Passing the flag does not record approval.

The confirmed PaymentIntent stub uses status `succeeded` so the object has a terminal shape. `livemode` stays `false`, `metadata.grokshop_charged` stays `"false"`, and the order `note` says no card was charged and no label was purchased.

## Attach an MCP client

Stdio is the agent interface. Do not wrap it in `npm run start`: npm can write to stdout and break the MCP framing. Use Node directly, and set `cwd` to this repo.

[`examples/mcp-client.json`](examples/mcp-client.json):

```json
{
  "mcpServers": {
    "grokshop": {
      "command": "node",
      "args": ["--import", "tsx", "src/index.ts"],
      "cwd": "/absolute/path/to/shopwithgrok",
      "env": {
        "GROKSHOP_SHIPPING_MODE": "stub",
        "GROKSHOP_PAYMENTS_MODE": "stub",
        "GROKSHOP_CATALOG_PATH": "data/harbor-hex.sample.json",
        "GROKSHOP_DATA_DIR": ".grokshop",
        "GROKSHOP_APPROVAL_SECRET": "replace-with-a-long-random-local-secret"
      }
    }
  }
}
```

Replace the `cwd` and generate a local approval secret if you will use the HTTP approve route:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

After `npm run build`, the same entry is `node dist/index.js`.

A typical agent turn:

1. `search_products` with `{ "query": "keyboard" }`.
2. `quote_shipping` with `{ "sku": "SAMPLE-KB-01", "quantity": 1, "to_postal_code": "94107" }`.
3. `create_checkout` with the chosen `rate_id`, the SKU, and a `ship_to` address.
4. Stop. Show the checkout id to a person.
5. The person runs `npm run approve -- chk_…`.
6. `confirm_order` with `{ "checkout_id": "chk_…", "human_approved": true }`.

## Merchant onboarding

Point `GROKSHOP_CATALOG_PATH` at your feed. Quantities are read from the file on each call. v1 does not reserve stock and does not decrement inventory when an order is confirmed.

Out-of-stock is still enforced: `create_checkout` rejects a quantity above `inventory`.

### JSON

Either a bare array of products, or:

```json
{
  "merchant": {
    "id": "your-shop",
    "name": "Your Shop",
    "sample": false,
    "example": false,
    "disclaimer": "Optional note shown to agents."
  },
  "products": []
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `sku` | yes | Your identifier. Sample rows in this repo use the `SAMPLE-` prefix. |
| `name` | yes | |
| `description` | no | Defaults to the name. |
| `price_cents` | yes | Integer USD cents. |
| `currency` | no | `usd` only in v1. |
| `weight_oz` | no | Positive number. Default 16. Used by the shipping stub. |
| `inventory` | yes | Integer. `0` is out of stock. |
| `category` | no | Free text. Search matches it. |
| `sample` / `example` | no | Set both `true` on fictional rows. |

The bundled feed is [`data/harbor-hex.sample.json`](data/harbor-hex.sample.json): keyboard kit, USB-C dock, mini PC, desk mat, monitor arm, cable, linear switches (out of stock), and laptop stand. Every row is `SAMPLE` / `EXAMPLE`.

### CSV

Header row, then products. A leading `# merchant: Your Shop` comment sets the display name. See [`examples/merchant-feed.sample.csv`](examples/merchant-feed.sample.csv).

```csv
# merchant: Your Shop
sku,name,description,price_cents,currency,weight_oz,inventory,category,sample,example
DESK-LAMP-1,Desk lamp,"Matte black, fictional example",4200,usd,18,8,lighting,true,true
```

Quoted commas in `description` are fine. `GROKSHOP_MERCHANT_NAME` is the fallback when the file has no merchant name.

Replace the sample path; do not edit the sample file to pretend a real partner is integrated. v1 has no live merchant integrations.

## HTTP mirror

```bash
npm run start:http
```

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/health` | |
| `GET` | `/tools` | |
| `POST` | `/tools/search_products` | tool arguments |
| `POST` | `/tools/get_product` | `{ "sku": "SAMPLE-KB-01" }` |
| `POST` | `/tools/list_inventory` | `{}` or `{ "sku": "…" }` |
| `POST` | `/tools/quote_shipping` | `{ "sku", "quantity", "to_postal_code", "to_country"? }` |
| `POST` | `/tools/create_checkout` | `{ "sku", "quantity", "rate_id", "ship_to" }` |
| `POST` | `/tools/confirm_order` | `{ "checkout_id", "human_approved" }` |
| `GET` | `/checkouts/:id` | |
| `POST` | `/checkouts/:id/approve` | Bearer secret. Optional `{ "note" }`. |

`POST /tools/approve` is not a route.

## Environment

| Variable | Default | |
| --- | --- | --- |
| `GROKSHOP_SHIPPING_MODE` | `stub` | `live` throws. |
| `GROKSHOP_PAYMENTS_MODE` | `stub` | `stripe` throws. |
| `GROKSHOP_APPROVAL_SECRET` | unset | Required for HTTP approval only. |
| `GROKSHOP_HTTP_HOST` | `127.0.0.1` | |
| `GROKSHOP_HTTP_PORT` | `39217` | |
| `GROKSHOP_CATALOG_PATH` | `data/harbor-hex.sample.json` | |
| `GROKSHOP_MERCHANT_NAME` | `Merchant` | CSV fallback. |
| `GROKSHOP_DATA_DIR` | `./.grokshop` | Checkouts and quoted rates. |

## Scripts

| Script | |
| --- | --- |
| `npm test` | Catalog, shipping, checkout, MCP, and HTTP tests. |
| `npm run demo` | End-to-end transcript. |
| `npm start` | MCP server on stdio. Prefer the `node --import tsx` form from a client. |
| `npm run start:http` | Local HTTP mirror. |
| `npm run approve -- chk_…` | Record human approval. |
| `npm run build` | Compile to `dist/`. |

## Out of scope

Live domains, Stripe charges, Stripe Connect, carrier label purchase, Amazon or other retailer scraping, and any tool that buys without a person.

License: MIT. See [LICENSE](LICENSE).
