# Deploy hosted GrokShop

The hosted server is `npm run start:remote` (`node dist/remote.js`). It serves signup, login, usage, human approval, and a streamable-HTTP MCP endpoint at `/mcp`.

Placeholder public URL: `https://YOUR_HOST`. MCP URL: `https://YOUR_HOST/mcp`. Replace that after Fly or Railway gives you a hostname. Do not buy a domain as part of deploy.

Free tier on every account:

- Harbor & Hex SAMPLE catalog only (fictional; `GROKSHOP_CATALOG_PATH` is ignored)
- 50 tool calls per day
- 5 checkouts per day
- `charged` stays false
- confirming an order decrements on-hand inventory in that account's state file
- no approve tool

`GROKSHOP_SHIPPING_MODE` and `GROKSHOP_PAYMENTS_MODE` must be `stub` or the process exits. There is no Stripe client and no carrier client.

## Run locally

```bash
npm install
npm run start:remote
```

The process listens on `127.0.0.1:8080` unless `PORT` or `GROKSHOP_HTTP_PORT` is set. Open [http://127.0.0.1:8080](http://127.0.0.1:8080), create an account, and copy the API key.

```bash
curl -s -X POST http://127.0.0.1:8080/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"correct-horse"}'
```

Point a client at `http://127.0.0.1:8080/mcp` with `Authorization: Bearer <api_key>`. For a public placeholder config, see [`examples/remote-mcp.json`](../examples/remote-mcp.json).

Approve outside MCP:

```bash
curl -s -X POST http://127.0.0.1:8080/checkouts/chk_REPLACE/approve \
  -H "Authorization: Bearer $GROKSHOP_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"note":"Approved at the desk."}'
```

`GET /me` with the same bearer token returns today's usage.

Accounts live in `GROKSHOP_DATA_DIR` (default `./.grokshop`): `accounts.json` holds scrypt password hashes and SHA-256 API-key hashes. Plaintext keys are not stored. Each account's checkouts are under `tenants/<account id>/`.

## Fly.io

Hobby / free machines, `*.fly.dev` until a custom domain exists. [fly.toml](../fly.toml) is the config. The container listens on `8080`.

Change `app` in `fly.toml` to a name that is free on Fly, then:

```bash
fly launch --ha=false --copy-config --yes
```

That is the one-shot create-and-deploy. Later updates are:

```bash
fly deploy
```

After the first deploy, set the public origin to the hostname Fly printed (still not a custom domain):

```bash
fly secrets set GROKSHOP_PUBLIC_URL=https://YOUR_APP.fly.dev
```

`secrets set` restarts the machine. Signup responses and the HTML page then show `https://YOUR_APP.fly.dev/mcp`. Put that same URL in [`cursor-plugin/mcp.json`](../cursor-plugin/mcp.json), replacing `https://YOUR_HOST/mcp`.

The image filesystem is ephemeral. Signups disappear when the machine is recreated. For a disk that survives restarts:

```bash
fly volumes create grokshop_data --region iad --size 1
```

Then add this to `fly.toml` and deploy again:

```toml
[[mounts]]
  source = "grokshop_data"
  destination = "/data"
```

`GROKSHOP_DATA_DIR` is already `/data`.

## Railway

[railway.toml](../railway.toml) builds the Dockerfile and checks `/health`. From the repo, logged in to Railway:

```bash
railway up
```

Railway sets `PORT`. The server binds `0.0.0.0` when `PORT` is set. Copy the `*.up.railway.app` URL Railway assigns and set:

```bash
railway variables set GROKSHOP_PUBLIC_URL=https://YOUR_APP.up.railway.app
```

Use that origin plus `/mcp` in the plugin. Attach a volume at `/data` if signups should survive deploys. Railway's hobby plan is enough for this process.

## Email later

v1 returns the API key from `POST /signup` and `POST /login`. It does not send mail, so no Resend or Postmark account is required.

To add one later, keep the password check and send the key (or a one-time link) yourself:

| Variable | Purpose |
| --- | --- |
| `GROKSHOP_EMAIL_PROVIDER` | `resend` or `postmark` |
| `GROKSHOP_EMAIL_FROM` | From address on your domain |
| `RESEND_API_KEY` | Resend API key, set on the host only |
| `POSTMARK_SERVER_TOKEN` | Postmark server token, set on the host only |

Do not commit those secrets. This build does not read them.

## Still unchecked

- [ ] Tom buys a domain
- [ ] Tom submits [`cursor-plugin/`](../cursor-plugin/) to the Cursor Marketplace

See [cursor-plugin/README.md](../cursor-plugin/README.md).
