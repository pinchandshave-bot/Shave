-- =============================================================================
-- iBag: Investor-Ready Base Migration
-- Purpose: Add audit, webhook dedupe, cents-based money columns (additive),
-- per-card roundup accumulators + batches, and investor domain tables.
-- Idempotent: Use "create ... if not exists" and safe ALTERs where possible.
-- IMPORTANT: BACKUP your database before running in production.
--           Run in development first, verify, then deploy to prod.
-- =============================================================================

-- -------------------------
-- 0) Extensions
-- -------------------------
create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

-- -------------------------
-- 1) Generic updated_at trigger
-- -------------------------
create or replace function ibag_update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- -------------------------
-- 2) Audit trail (generic)
-- -------------------------
create table if not exists ibag_audit (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  row_id uuid null,
  operation text not null, -- INSERT, UPDATE, DELETE
  actor text null, -- optional: user/service id
  changed_at timestamptz not null default now(),
  old_row jsonb,
  new_row jsonb
);

create or replace function ibag_audit_trigger_fn()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into ibag_audit(table_name, row_id, operation, new_row)
      values (tg_table_name, new.id::uuid, tg_op, to_jsonb(new));
    return new;
  elsif tg_op = 'UPDATE' then
    insert into ibag_audit(table_name, row_id, operation, old_row, new_row)
      values (tg_table_name, new.id::uuid, tg_op, to_jsonb(old), to_jsonb(new));
    return new;
  elsif tg_op = 'DELETE' then
    insert into ibag_audit(table_name, row_id, operation, old_row)
      values (tg_table_name, old.id::uuid, tg_op, to_jsonb(old));
    return old;
  end if;
end;
$$;

-- NOTE: Attach this trigger to sensitive tables after reviewing (we do below for key tables)

-- -------------------------
-- 3) Processed webhooks (idempotency/replay defense)
-- -------------------------
create table if not exists processed_webhooks (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_id text not null,
  metadata jsonb,
  processed_at timestamptz not null default now(),
  unique(provider, external_id)
);

-- -------------------------
-- 4) Add cents-based money columns (non-destructive)
--    We add *_cents columns; you can backfill from existing numeric columns
--    in a controlled migration step after verifying types/contents.
-- -------------------------
-- Accounts (add current_balance_cents, available_balance_cents)
alter table if exists accounts
  add column if not exists current_balance_cents bigint,
  add column if not exists available_balance_cents bigint,
  add column if not exists balance_updated_at timestamptz;

-- Transactions: add amount_cents
alter table if exists transactions
  add column if not exists amount_cents bigint,
  add column if not exists settled boolean default false;

-- -------------------------
-- 5) Roundup: per-card accumulators, line items, virtual batches
-- -------------------------
create table if not exists roundup_accumulators (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  accumulated_cents bigint not null default 0,
  threshold_cents integer not null default 200, -- default $2.00 trigger
  last_updated timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(account_id)
);

create index if not exists idx_roundup_accumulators_user on roundup_accumulators(user_id);
create index if not exists idx_roundup_accumulators_threshold on roundup_accumulators(threshold_cents);

-- Line items: one per transaction (idempotent on transaction_id)
create table if not exists roundup_line_items (
  id uuid primary key default gen_random_uuid(),
  accumulator_id uuid not null references roundup_accumulators(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  transaction_id uuid not null references transactions(id) on delete cascade,
  plaid_transaction_id text null,
  amount_cents integer not null check(amount_cents > 0 and amount_cents < 100),
  status text not null default 'calculated', -- calculated, pending, batched, archived
  batch_id uuid null,
  created_at timestamptz not null default now(),
  unique (transaction_id)
);

create index if not exists idx_roundup_line_items_acc on roundup_line_items(accumulator_id);
create index if not exists idx_roundup_line_items_user_status on roundup_line_items(user_id, status);

-- Virtual batches (analytic grouping only)
create table if not exists roundup_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  destination_account_id uuid null references accounts(id) on delete set null,
  source_account_id uuid not null references accounts(id) on delete cascade,
  threshold_cents integer not null default 200,
  total_cents bigint not null default 0,
  item_count integer not null default 0,
  status text not null default 'threshold_reached', -- threshold_reached, ready_for_sweep, swept, archived
  created_at timestamptz not null default now()
);

create index if not exists idx_roundup_batches_user on roundup_batches(user_id);
create index if not exists idx_roundup_batches_status on roundup_batches(status);

-- Trigger to update last_updated on accumulators
create or replace function roundup_accumulators_update_ts()
returns trigger as $$
begin
  new.last_updated = now();
  return new;
end;
$$ language plpgsql;

create or replace trigger trg_roundup_accumulators_update
  before update on roundup_accumulators
  for each row execute function roundup_accumulators_update_ts();

-- Helper: get_or_create_roundup_accumulator (used by application worker)
create or replace function get_or_create_roundup_accumulator(p_user_id uuid, p_account_id uuid, p_threshold_cents integer default 200)
returns uuid language plpgsql as $$
declare
  acc_id uuid;
begin
  select id into acc_id from roundup_accumulators where account_id = p_account_id for update;
  if acc_id is null then
    insert into roundup_accumulators(user_id, account_id, threshold_cents)
    values (p_user_id, p_account_id, p_threshold_cents)
    returning id into acc_id;
  end if;
  return acc_id;
end;
$$;

-- -------------------------
-- 6) Investments domain (first-class tables)
-- -------------------------
-- Securities master
create table if not exists securities (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  cusip text,
  isin text,
  sedol text,
  name text,
  exchange text,
  asset_class text,
  security_type text,
  iso_currency_code text default 'USD',
  issuer text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (symbol, exchange)
);

create index if not exists idx_securities_symbol on securities(lower(symbol));
create index if not exists idx_securities_isin on securities(isin);

-- Price time-series
create table if not exists security_prices (
  id uuid primary key default gen_random_uuid(),
  security_id uuid not null references securities(id) on delete cascade,
  price_date date not null,
  price numeric(18,6) not null,
  source text not null default 'market_api',
  volume bigint,
  currency text default 'USD',
  as_of timestamptz not null default now(),
  metadata jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists ux_security_prices_security_date on security_prices(security_id, price_date);

-- Investment accounts (observations only)
create table if not exists investment_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  plaid_item_id uuid references plaid_items(id) on delete set null,
  plaid_account_id text,
  provider text,
  provider_account_external_id text,
  account_name text,
  account_type text,
  currency text default 'USD',
  is_tax_advantaged boolean default false,
  status text default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_investment_accounts_user on investment_accounts(user_id);

-- Holdings & positions
create table if not exists holdings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  account_id uuid not null references investment_accounts(id) on delete cascade,
  security_id uuid not null references securities(id) on delete cascade,
  quantity numeric(24,10) not null default 0,
  settled_quantity numeric(24,10) not null default 0,
  average_cost numeric(18,6),
  cost_basis numeric(18,2),
  market_value numeric(18,2),
  last_price numeric(18,6),
  last_price_as_of timestamptz,
  last_updated timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ux_holdings_account_security on holdings(account_id, security_id);

-- Tax lots
create table if not exists tax_lots (
  id uuid primary key default gen_random_uuid(),
  holding_id uuid references holdings(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  account_id uuid not null references investment_accounts(id) on delete cascade,
  security_id uuid not null references securities(id) on delete cascade,
  lot_quantity numeric(24,10) not null,
  remaining_quantity numeric(24,10) not null,
  lot_price numeric(18,6) not null,
  acquired_date date not null,
  acquisition_type text default 'purchase',
  lot_id_external text,
  created_at timestamptz not null default now(),
  closed_at timestamptz null,
  metadata jsonb
);
create index if not exists idx_tax_lots_user on tax_lots(user_id);

-- Trades / execution records
create table if not exists trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  account_id uuid not null references investment_accounts(id) on delete cascade,
  security_id uuid not null references securities(id) on delete cascade,
  external_trade_id text,
  side text not null, -- buy/sell
  quantity numeric(24,10) not null,
  price numeric(18,6) not null,
  proceeds numeric(18,2) not null,
  fees_cents bigint default 0,
  proceeds_cents bigint,
  settled boolean default false,
  executed_at timestamptz not null,
  settled_at timestamptz null,
  created_at timestamptz not null default now(),
  metadata jsonb
);
create index if not exists idx_trades_account on trades(account_id);
create index if not exists idx_trades_user on trades(user_id);

-- Portfolio snapshots
create table if not exists portfolio_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  as_of timestamptz not null default now(),
  total_market_value numeric(18,2) not null default 0,
  total_cost_basis numeric(18,2) not null default 0,
  total_unrealized_pl numeric(18,2) not null default 0,
  total_realized_pl numeric(18,2) not null default 0,
  holdings_count integer not null default 0,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_portfolio_snapshots_user_as_of on portfolio_snapshots(user_id, as_of desc);

-- -------------------------
-- 7) Materialized valuation view (example)
-- -------------------------
-- This materialized view can be refreshed CONCURRENTLY by a worker for reporting.
create materialized view if not exists mv_portfolio_valuation as
select h.user_id,
       h.account_id,
       h.security_id,
       h.quantity,
       sp.price as last_price,
       (h.quantity * sp.price) as market_value
from holdings h
join lateral (
  select price
  from security_prices sp
  where sp.security_id = h.security_id
  order by sp.price_date desc, sp.as_of desc
  limit 1
) sp on true;

create index if not exists idx_mv_portfolio_valuation_user on mv_portfolio_valuation(user_id);

-- -------------------------
-- 8) Constraints, uniqueness and idempotency
-- -------------------------
-- Ensure transactions table has a uniqueness on plaid_transaction_id if column exists
do $$
begin
  if (select to_regclass('public.transactions')) is not null then
    begin
      execute 'alter table transactions add constraint ux_transactions_plaid_transaction unique (plaid_transaction_id)';
    exception when duplicate_table then
      -- constraint exists or conflict; ignore
      null;
    exception when others then
      -- ignore; DB-specific; do not fail migration
      null;
    end;
  end if;
end;
$$ language plpgsql;

-- -------------------------
-- 9) Attach audit triggers to important tables
-- -------------------------
-- Attach audit trigger to key tables for traceability
do $$
begin
  -- Only create triggers if table exists
  if (select to_regclass('public.roundup_line_items')) is not null then
    execute 'create or replace trigger audit_roundup_line_items after insert or update or delete on roundup_line_items for each row execute function ibag_audit_trigger_fn()';
  end if;

  if (select to_regclass('public.roundup_batches')) is not null then
    execute 'create or replace trigger audit_roundup_batches after insert or update or delete on roundup_batches for each row execute function ibag_audit_trigger_fn()';
  end if;

  if (select to_regclass('public.roundup_accumulators')) is not null then
    execute 'create or replace trigger audit_roundup_accumulators after insert or update or delete on roundup_accumulators for each row execute function ibag_audit_trigger_fn()';
  end if;

  if (select to_regclass('public.trades')) is not null then
    execute 'create or replace trigger audit_trades after insert or update or delete on trades for each row execute function ibag_audit_trigger_fn()';
  end if;

  if (select to_regclass('public.holdings')) is not null then
    execute 'create or replace trigger audit_holdings after insert or update or delete on holdings for each row execute function ibag_audit_trigger_fn()';
  end if;

end;
$$ language plpgsql;

-- -------------------------
-- 10) Operational helpers & notes
-- -------------------------
-- Example function to convert existing numeric balances to cents (one-time manual backfill).
-- IMPORTANT: Run after inspecting existing numeric values and only if you confirm no precision mismatch.
-- Example:
--   UPDATE accounts SET current_balance_cents = round(current_balance * 100)::bigint WHERE current_balance IS NOT NULL;
--   UPDATE transactions SET amount_cents = round(amount * 100)::bigint WHERE amount IS NOT NULL;
-- Do NOT run these automatically in this migration to avoid surprises.

-- -------------------------
-- 11) Security & housekeeping suggestions (not applied automatically)
-- -------------------------
-- - Add Row-Level Security (RLS) policies per-table in Supabase, restricting rows to owner (user_id).
-- - Use a KMS to encrypt Plaid access tokens rather than a static CRYPTO_KEY in ENV.
-- - Create scheduled jobs for:
--     * refreshing mv_portfolio_valuation concurrently nightly,
--     * reconciling roundup invariants and alerting if mismatch,
--     * purging or archiving old audit rows if retention required by policy.

-- -------------------------
-- End of migration
-- -------------------------
