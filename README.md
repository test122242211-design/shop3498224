# OGSHOP Support Bot

Discord support/replacement bot using:
- discord.js v14
- OpenRouter for natural-language replies
- SellAuth API adapter for invoice lookup and coupon creation
- SQLite for ticket state and review deadlines
- Express health endpoint for Render

## Important SellAuth setup

The official SellAuth dashboard API docs are account-authenticated and the exact route/payload is not publicly readable from this project environment. Therefore the SellAuth adapter deliberately requires you to set the correct paths from your own dashboard docs.

Set:
- `SELLAUTH_API_BASE`
- `SELLAUTH_INVOICE_PATH` (supports `{shopId}` and `{invoiceId}`)
- `SELLAUTH_COUPON_CREATE_PATH` (supports `{shopId}`)
- `NETFLIX_PRODUCT_ID`

Then inspect `src/sellauth.js` and adjust:
- `isPaidInvoice()` to match the actual invoice response fields/status values.
- `containsNetflix()` to match the actual product line-item structure.
- `createNetflixCoupon()` payload keys to match the documented coupon-create schema.

Do not enable real staff approvals until you have tested:
1. A real paid Netflix invoice returns `found=true`, `paid=true`, `hasNetflix=true`.
2. An unpaid invoice is rejected.
3. An invoice for a different product is rejected.
4. A created coupon is 100%, limited to one redemption, and restricted to the Netflix product.

The bot intentionally refuses to issue a code when SellAuth returns an error. It never falls back to a generic/unrestricted code.

## Discord setup

1. Create an application and bot in the Discord Developer Portal.
2. Enable the **Message Content Intent** under Bot > Privileged Gateway Intents.
3. Invite it with scopes `bot` and `applications.commands`.
4. Bot permissions needed: Manage Channels, View Channels, Send Messages, Read Message History, Embed Links, Attach Files, Use Application Commands.
5. Create a ticket category, staff role, and private staff-log channel.
6. Put their IDs into the environment variables.

## Environment variables

Copy `.env.example` to `.env` and fill in all values.

Required:
- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `OPENROUTER_API_KEY`

For staff review:
- `STAFF_ROLE_ID`
- `STAFF_LOG_CHANNEL_ID`

For tickets:
- `TICKET_CATEGORY_ID`

For SellAuth replacement flow:
- `SELLAUTH_API_KEY`
- `SELLAUTH_SHOP_ID`
- `SELLAUTH_INVOICE_PATH`
- `SELLAUTH_COUPON_CREATE_PATH`
- `NETFLIX_PRODUCT_ID`

OpenRouter:
- Create an API key at https://openrouter.ai/keys
- `OPENROUTER_MODEL=openrouter/free` routes to an available free model. Free models have quotas and availability can change; set a specific `:free` model slug if preferred.

## Run locally

```bash
npm install
cp .env.example .env
# Fill .env
npm run deploy-commands
npm start
```

In Discord, run `/setup` in the server. Use `/close` inside a ticket to close it.

## Render

Create a **Web Service** (not a Background Worker) connected to your repository.

- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`
- Render automatically provides `PORT`; the app listens on `0.0.0.0:$PORT`.

Set all `.env.example` variables in Render's Environment dashboard. Do not commit `.env`.

### PING_URL

If `PING_URL` is set, the process makes an HTTP request to it every 60 seconds. For example:
`PING_URL=https://your-service.onrender.com/health`

This is best-effort only. Render's Free web services can spin down after 15 minutes without inbound traffic, and Render may suspend services that generate unusually high outbound traffic. A self-ping is not a guaranteed uptime solution; use a paid instance or an external uptime monitor if reliable always-on operation is required.

## Data persistence warning

SQLite is stored at `DATABASE_PATH`. Render Free services have ephemeral filesystems, so ticket state can be lost on restart/redeploy/spin-down. For production, use a persistent disk (paid Render service) or migrate the database to PostgreSQL. A persistent database is important because the one-hour approval timer must survive restarts.

## Safety / operational notes

- AI only writes customer-facing wording. It does not verify invoices, accept proof, approve claims, or create coupons.
- File validation checks attachment MIME type or filename extension. It does not prove the media is authentic or actually shows a fault.
- Staff review buttons are restricted to administrators or the configured staff role.
- The one-hour auto-approval currently runs only after a matching paid Netflix invoice and at least one image/video attachment have been recorded.
- Consider keeping auto-approval disabled until your SellAuth coupon integration has been tested in a staging shop.
