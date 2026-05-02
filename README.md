# OptionsAI — Plaid Investment Integration

Wires Plaid Link (Investments product) to Supabase. The server creates a Link
token, exchanges the public token for an access token, persists the access
token to the `accounts` table, and syncs investment holdings to the `holdings`
table.

## Setup

1. Install deps: `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `PLAID_CLIENT_ID`, `PLAID_SECRET` (sandbox)
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
3. Apply the schema in `supabase/schema.sql` to your Supabase project.
4. Start the server: `npm start`

> Sandbox note: Plaid sandbox enforces a host allowlist for some accounts.
> If `linkTokenCreate` returns `403 Host not in allowlist`, add the calling
> server's IP under Team Settings → Allowed IPs in the Plaid dashboard.

## Endpoints

### `POST /plaid/link-token`
Create a Link token for the investments product.

```json
{ "user_id": "user-uuid" }
```

Response: Plaid `LinkTokenCreateResponse` (use `link_token` to initialize Plaid Link on the client).

### `POST /plaid/exchange-public-token`
Exchanges the public token returned from Plaid Link for an access token,
loads accounts, and upserts them (with the access token) into `accounts`.

```json
{ "public_token": "public-sandbox-...", "user_id": "user-uuid" }
```

Response: `{ "item_id": "...", "accounts": [ ... ] }`

### `POST /plaid/holdings/sync`
Calls `investments/holdings/get` for the item and upserts each holding into
`holdings`, joined to its account row.

```json
{ "item_id": "..." }
```

Response: `{ "count": <n>, "holdings": [...], "accounts": [...] }`

## Client flow

1. Call `POST /plaid/link-token` and pass `link_token` to Plaid Link.
2. After the user finishes Link, you'll receive a `public_token` in the
   `onSuccess` callback. POST it to `/plaid/exchange-public-token`.
3. Call `POST /plaid/holdings/sync` with the returned `item_id` to populate
   holdings (also safe to schedule periodically).

## Files

- `src/plaidClient.js` — Plaid SDK client (sandbox by default)
- `src/supabaseClient.js` — Supabase service-role client (lazy)
- `src/plaidService.js` — `createLinkToken`, `exchangePublicToken`, `syncHoldings*`
- `src/server.js` — Express endpoints
- `supabase/schema.sql` — `accounts` and `holdings` tables
