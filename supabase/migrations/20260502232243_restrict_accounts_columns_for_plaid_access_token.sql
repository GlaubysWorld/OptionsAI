-- The previous migration's `revoke select (plaid_access_token)` had no effect
-- because Postgres column-level REVOKE is overridden by a table-level SELECT
-- grant. Drop the table-level SELECT for anon/authenticated and re-grant
-- SELECT only on the non-secret columns. service_role retains full access.

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
