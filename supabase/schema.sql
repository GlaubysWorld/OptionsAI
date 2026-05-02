-- Plaid investment integration schema

create extension if not exists "pgcrypto";

create table if not exists accounts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    plaid_item_id text not null,
    plaid_account_id text not null unique,
    plaid_access_token text not null,
    institution_id text,
    institution_name text,
    name text,
    official_name text,
    mask text,
    type text,
    subtype text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists accounts_user_id_idx on accounts (user_id);
create index if not exists accounts_plaid_item_id_idx on accounts (plaid_item_id);

create table if not exists holdings (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references accounts(id) on delete cascade,
    plaid_account_id text not null,
    security_id text not null,
    ticker_symbol text,
    name text,
    type text,
    cusip text,
    isin text,
    quantity numeric,
    institution_price numeric,
    institution_price_as_of date,
    institution_value numeric,
    cost_basis numeric,
    iso_currency_code text,
    unofficial_currency_code text,
    synced_at timestamptz not null default now(),
    unique (plaid_account_id, security_id)
);

create index if not exists holdings_account_id_idx on holdings (account_id);
create index if not exists holdings_security_id_idx on holdings (security_id);
