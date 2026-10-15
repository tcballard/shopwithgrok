# GrokShop Cursor plugin

Lets your bot buy from independent stores and ship direct, with you approving every payment.

This folder is a Cursor plugin scaffold. It points at a hosted GrokShop MCP server. It does not contain a storefront, a Stripe integration, or a carrier account.

The free server uses the fictional Harbor & Hex SAMPLE catalog. Nothing is charged. You approve every checkout outside the bot. There is no approve tool.

## Connect

1. Deploy the server, or run it locally. See [docs/deploy.md](../docs/deploy.md). Until a host exists, the URL is the placeholder `https://YOUR_HOST/mcp`.
2. Open the signup page and create an account, or `POST /signup` with an email and password. The response includes `api_key` once.
3. In Cursor, set the plugin variable `GROKSHOP_API_KEY` to that key. [`mcp.json`](mcp.json) sends it as `Authorization: Bearer ${GROKSHOP_API_KEY}`.
4. Replace `https://YOUR_HOST/mcp` in [`mcp.json`](mcp.json) with the real origin plus `/mcp` after deploy. Do not commit a real API key.

`POST /login` issues a new key and stops the previous one. No email is sent in this version.

## Marketplace description

Use this, outcome first:

> Lets your bot buy from independent stores and ship direct, with you approving every payment.

## Before Tom submits or buys a domain

Leave these unchecked. An agent must not do them.

- [ ] Tom reviews this description and the free-tier limits (sample catalog, 50 tool calls/day, 5 checkouts/day, no charges).
- [ ] Tom replaces `https://YOUR_HOST` with the deployed `*.fly.dev` or Railway URL, or with a domain he bought.
- [ ] Tom purchases a custom domain. Domain purchase is out of scope until he says so.
- [ ] Tom submits this plugin to the Cursor Marketplace. Marketplace submit is out of scope until he says so. The Grok Bot catalog is fed by Cursor plugins, and submission is manual review.

Docs: [https://cursor.com/docs/plugins](https://cursor.com/docs/plugins). Marketplace: [https://cursor.com/marketplace](https://cursor.com/marketplace).

## What the plugin does not do

- It does not approve a checkout. A person calls `POST /checkouts/<id>/approve` with the API key.
- It does not charge a card or buy a shipping label.
- It does not scrape Amazon or any other retailer.
