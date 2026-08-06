create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists plaid_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  plaid_item_id text unique not null,
  plaid_access_token_encrypted text not null,
  institution_name text,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  plaid_item_id uuid not null references plaid_items(id) on delete cascade,
  plaid_account_id text unique not null,
  name text not null,
  type text not null,
  subtype text,
  mask text,
  created_at timestamptz not null default now()
);

create index if not exists idx_plaid_items_user_id on plaid_items(user_id);
create index if not exists idx_accounts_plaid_item_id on accounts(plaid_item_id);
