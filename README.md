# OptionsAI — Plaid Investment Integration

Wires Plaid Link (Investments product) to the existing Supabase `accounts`
and `holdings` tables. The server creates a Link token, exchanges the public
token for an access token, persists the access token to `accounts`, and syncs
investment holdings into `holdings`.

The PR is **additive**: it does not create `accounts` / `holdings` (those are
owned by the upstream platform schema), it only adds the Plaid-specific
columns and access-token grants.

## Setup

1. Install deps: `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `PLAID_CLIENT_ID`, `PLAID_SECRET` (sandbox)
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
3. Apply the additive migrations in `supabase/migrations/` to your Supabase
   project (`supabase db push` or pasting them into the SQL editor in order).
   They are idempotent (`add column if not exists` / `create index if not
   exists`).
4. Build and start the server: `npm run build && npm start` (or `npm run dev`
   for watch mode).

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

- `src/plaidClient.ts` — Plaid SDK client (sandbox by default)
- `src/supabaseClient.ts` — Supabase service-role client (lazy)
- `src/plaidService.ts` — `createLinkToken`, `exchangePublicToken`, `syncHoldings*`
- `src/server.ts` — Express endpoints
- `supabase/migrations/20260502232113_plaid_investment_integration.sql` —
  adds `plaid_item_id` and `plaid_access_token` to `accounts`, plus an index
  on `plaid_item_id`
- `supabase/migrations/20260502232243_restrict_accounts_columns_for_plaid_access_token.sql` —
  drops the table-level `SELECT` on `accounts` for `anon`/`authenticated` and
  re-grants column-level `SELECT` on every column except
  `plaid_access_token`, so only the service role can read the token
- `tsconfig.json` — TypeScript config (NodeNext, strict)

## Security notes

- `plaid_access_token` is protected by both row-level security and a
  column-level `REVOKE` from `anon`/`authenticated`. Only the service-role
  key (used server-side) can read it.
- The service-role key must never be exposed to the browser. The Express
  server is the only intended consumer.
