# OptionsAI — Plaid Investment Integration

Wires Plaid Link (Investments product) into the existing OptionsAI Supabase
schema. The server creates a Link token, exchanges the public token for an
access token, persists the access token onto the `accounts` table, and syncs
investment holdings into the `holdings` table.

This integration sits on top of the platform's pre-existing `initial_schema`
migration. It does not redefine `accounts` / `holdings`; it only adds the
Plaid-specific columns and locks the access token down at the column level.

## Setup

1. Install deps: `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `PLAID_CLIENT_ID`, `PLAID_SECRET` (sandbox)
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
3. Apply the migrations in `supabase/migrations/` to your Supabase project
   (`supabase db push` or pasting them into the SQL editor in order).
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

### `GET /accounts`
Returns the signed-in user's linked accounts. Reads as the user via the
Supabase anon key + the request's `Authorization: Bearer <jwt>`; RLS
filters to the user's rows and column-level grants keep
`plaid_access_token` out of the response entirely.

```
GET /accounts
Authorization: Bearer <user-jwt>
```

Response: `{ "accounts": [ { id, plaid_account_id, plaid_item_id, institution_name, account_name, account_type, currency, is_active, synced_at, ... }, ... ] }`

### `GET /holdings`
Returns the signed-in user's holdings inner-joined to their account row,
with each holding carrying `account.institution_name` and
`account.account_type`. Auth model is the same as `/accounts`.

```
GET /holdings
Authorization: Bearer <user-jwt>
```

Response:
```json
{
  "holdings": [
    {
      "id": "...",
      "symbol": "AAPL",
      "security_name": "...",
      "asset_class": "equity",
      "quantity": 10,
      "current_price": 175,
      "current_value": 1750,
      "unrealized_pnl": 250,
      "unrealized_pnl_pct": 16.6667,
      "account": { "institution_name": "...", "account_type": "brokerage" }
    }
  ]
}
```

Both GET endpoints return 401 if the bearer token is missing or invalid.

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
- `supabase/migrations/20260502000000_plaid_investment_integration.sql` —
  additive migration that adds `plaid_item_id` / `plaid_access_token` to the
  existing `accounts` table and revokes `select(plaid_access_token)` from
  `anon`/`authenticated`
- `tsconfig.json` — TypeScript config (NodeNext, strict)

## Field mapping

`accounts` (per row, via `accountsGet`):

| Schema column        | Source                                                         |
| -------------------- | -------------------------------------------------------------- |
| `user_id`            | request body (`auth.users.id`)                                 |
| `plaid_account_id`   | Plaid `account.account_id`                                     |
| `plaid_item_id`      | Plaid `item.item_id`                                           |
| `plaid_access_token` | exchange response (service-role-only column)                   |
| `institution_name`   | `institutionsGetById`, falls back to `"Unknown Institution"`   |
| `account_name`       | `account.name` → `account.official_name` → `"Account"`         |
| `account_type`       | mapped from `account.subtype` to schema enum                   |
| `currency`           | `account.balances.iso_currency_code`, defaults to `USD`        |
| `is_active`          | `true`                                                         |
| `synced_at`          | `now()`                                                        |

`holdings` (per row, via `investments/holdings/get`):

| Schema column          | Source                                                 |
| ---------------------- | ------------------------------------------------------ |
| `user_id`, `account_id`| looked up from existing `accounts` row by Plaid IDs    |
| `symbol`               | `security.ticker_symbol` → `cusip` → `isin` → id       |
| `security_name`        | `security.name`                                        |
| `asset_class`          | mapped from `security.type` to schema enum             |
| `quantity`             | `holding.quantity`                                     |
| `cost_basis`           | `holding.cost_basis`                                   |
| `cost_basis_per_share` | `cost_basis / quantity` (when both > 0)                |
| `current_price`        | `holding.institution_price`                            |
| `current_value`        | `holding.institution_value`                            |
| `unrealized_pnl`       | `current_value - cost_basis` (when both present)       |
| `unrealized_pnl_pct`   | `unrealized_pnl / cost_basis * 100`                    |
| `last_price_at`        | `holding.institution_price_as_of`                      |

Holdings are upserted by the schema's `(account_id, symbol)` unique key.

## Security notes

- `plaid_access_token` is protected by row-level security on the row *and* a
  column-level `REVOKE select` from `anon`/`authenticated`, so it never
  reaches the browser even for the row's owner. Only the `service_role` key
  (used server-side) can read it.
- The service-role key must never be exposed to the browser. The Express
  server is the only intended consumer.

## Known limitations

- The sync is additive: holdings that disappear from Plaid (e.g. a sold
  position) are not removed from the `holdings` table. A subsequent pass to
  reconcile deletions can be added separately.
