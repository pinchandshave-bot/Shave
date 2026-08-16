-- =============================================================================
-- iBag Phase 1: Financial Intelligence & Multi-Card Shadow Engine
-- Complete Database Schema Migration
-- =============================================================================

-- Enable Cryptographic Extensions
create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

-- -----------------------------------------------------------------------------
-- 1. USER & IDENTITY LAYER
-- -----------------------------------------------------------------------------
create table if not exists users (
    id uuid primary key default gen_random_uuid(),
    email text unique not null,
    full_name text,
    phone_number text,
    status text not null default 'active',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 2. PLAID INTEGRATION & ACCOUNT PROVENANCE
-- -----------------------------------------------------------------------------
create table if not exists plaid_items (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    plaid_item_id text unique not null,
    plaid_access_token_encrypted text not null,
    institution_id text,
    institution_name text not null,
    status text not null default 'active',
    error_code text,
    cursor text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists accounts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    plaid_item_id uuid not null references plaid_items(id) on delete cascade,
    plaid_account_id text unique not null,
    name text not null,
    official_name text,
    type text not null, -- 'credit', 'depository', 'loan', 'investment'
    subtype text,       -- 'checking', 'savings', 'credit card', etc.
    mask text,
    iso_currency_code text default 'USD',
    current_balance numeric(12, 2),
    available_balance numeric(12, 2),
    credit_limit numeric(12, 2),
    is_source_card boolean not null default true, -- Eligible for round-up tracking
    is_destination_target boolean not null default false, -- Virtual target for aggregated sweep
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 3. TRANSACTIONS LAYER (Normalized Stream)
-- -----------------------------------------------------------------------------
create table if not exists transactions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    account_id uuid not null references accounts(id) on delete cascade,
    plaid_transaction_id text unique not null,
    amount numeric(12, 2) not null, -- Positive = spend, Negative = credit/income
    iso_currency_code text default 'USD',
    merchant_name text,
    name text not null,
    primary_category text,
    detailed_category text,
    pending boolean not null default false,
    payment_channel text, -- 'in store', 'online', 'other'
    authorized_date date,
    date date not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 4. MULTI-CARD ROUND-UP ENGINE (Settlement-Only Lineage)
-- -----------------------------------------------------------------------------
create table if not exists roundups (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    account_id uuid not null references accounts(id) on delete cascade,
    transaction_id uuid unique not null references transactions(id) on delete cascade,
    transaction_amount numeric(12, 2) not null,
    roundup_amount numeric(12, 2) not null, -- Calculated delta: ceil(amount) - amount
    status text not null default 'calculated', -- 'calculated', 'batched', 'archived'
    batch_id uuid, -- Associated Virtual Batch once threshold is crossed
    created_at timestamptz not null default now()
);

create table if not exists roundup_batches (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    batch_threshold numeric(12, 2) not null default 5.00,
    total_amount numeric(12, 2) not null,
    item_count integer not null,
    status text not null default 'threshold_reached', -- Virtual notification state in Phase 1
    created_at timestamptz not null default now()
);

alter table roundups 
    add constraint fk_roundups_batch 
    foreign key (batch_id) references roundup_batches(id) on delete set null;

-- -----------------------------------------------------------------------------
-- 5. RELATIONAL LIFE STATE & EVIDENCE ENGINE
-- -----------------------------------------------------------------------------
create table if not exists observations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    domain text not null, -- 'cash_flow', 'subscriptions', 'liabilities', 'income'
    observation_type text not null,
    observed_data jsonb not null,
    confidence_score numeric(3, 2) not null default 1.00, -- 0.00 to 1.00
    created_at timestamptz not null default now()
);

create table if not exists evidence_links (
    id uuid primary key default gen_random_uuid(),
    observation_id uuid not null references observations(id) on delete cascade,
    transaction_id uuid references transactions(id) on delete cascade,
    account_id uuid references accounts(id) on delete cascade,
    created_at timestamptz not null default now()
);

create table if not exists life_state_insights (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    category text not null, -- 'subscription_creep', 'high_apr_leak', 'runway_alert', 'savings_potential'
    headline text not null,
    detail_body text not null,
    impact_amount numeric(12, 2),
    action_prompt text,
    created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 6. PERFORMANCE INDEXES
-- -----------------------------------------------------------------------------
create index if not exists idx_plaid_items_user_id on plaid_items(user_id);
create index if not exists idx_accounts_user_id on accounts(user_id);
create index if not exists idx_accounts_plaid_item_id on accounts(plaid_item_id);
create index if not exists idx_transactions_user_id on transactions(user_id);
create index if not exists idx_transactions_account_id on transactions(account_id);
create index if not exists idx_transactions_date on transactions(date desc);
create index if not exists idx_transactions_pending on transactions(pending) where pending = false;
create index if not exists idx_roundups_user_id on roundups(user_id);
create index if not exists idx_roundups_account_id on roundups(account_id);
create index if not exists idx_roundups_status on roundups(status);
create index if not exists idx_observations_user_domain on observations(user_id, domain);
create index if not exists idx_evidence_links_observation on evidence_links(observation_id);
create index if not exists idx_life_state_insights_user on life_state_insights(user_id);

-- -----------------------------------------------------------------------------
-- 7. TRIGGER FOR UPDATED_AT TIMESTAMPS
-- -----------------------------------------------------------------------------
create or replace function update_updated_at_column()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create or replace trigger update_users_updated_at before update on users for each row execute function update_updated_at_column();
create or replace trigger update_plaid_items_updated_at before update on plaid_items for each row execute function update_updated_at_column();
create or replace trigger update_accounts_updated_at before update on accounts for each row execute function update_updated_at_column();
create or replace trigger update_transactions_updated_at before update on transactions for each row execute function update_updated_at_column();
