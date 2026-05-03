-- Plaid investments integration: extend public.accounts with the Plaid item id
-- and access token, and restrict the access token to the service_role key
-- only.
--
-- This migration is additive on top of the existing initial_schema migration
-- (20260419173606). It does not change any existing column or constraint.

alter table public.accounts
    add column if not exists plaid_item_id text,
    add column if not exists plaid_access_token text;

create index if not exists accounts_plaid_item_id_idx
    on public.accounts (plaid_item_id);

-- Existing RLS already gates row visibility on accounts. plaid_access_token
-- needs an additional column-level guard so it never reaches the browser even
-- for the row's owner.
--
-- Postgres column-level REVOKE only takes effect when there is no
-- table-level SELECT grant on the same role. anon and authenticated have
-- table-level SELECT on this table, so we drop it and re-grant SELECT
-- explicitly on the safe columns. service_role bypasses both RLS and column
-- grants, so the server (using the service-role key) is unaffected.
revoke select on public.accounts from anon, authenticated;

grant select (
    id,
    user_id,
    plaid_account_id,
    plaid_item_id,
    institution_name,
    account_name,
    account_type,
    currency,
    is_active,
    synced_at,
    created_at,
    updated_at
) on public.accounts to anon, authenticated;
