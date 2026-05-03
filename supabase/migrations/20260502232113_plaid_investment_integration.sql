-- Plaid investments integration: extend public.accounts with the Plaid item id
-- and access token, and restrict the access token to the service_role key
-- only.

alter table public.accounts
    add column if not exists plaid_item_id text,
    add column if not exists plaid_access_token text;

create index if not exists accounts_plaid_item_id_idx
    on public.accounts (plaid_item_id);

revoke select (plaid_access_token) on public.accounts from anon, authenticated;
