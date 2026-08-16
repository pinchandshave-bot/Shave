-- db/rls_and_policies.sql
-- Recommended Supabase RLS policies for iBag tables.
-- Adapt these to your Supabase project's authenticated role and service role names.

-- NOTE: In Supabase, auth.uid() is available in RLS policies. Adjust if you use a different claim.

-- Example: enable RLS on tables and allow owners to CRUD their rows.

-- Enable RLS on key tables (run as supabase admin)
ALTER TABLE IF EXISTS accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS roundup_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS roundup_accumulators ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS roundup_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS investment_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS holdings ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS trades ENABLE ROW LEVEL SECURITY;

-- Generic policy: authenticated users can SELECT/INSERT/UPDATE on rows where user_id = auth.uid()
-- Accounts
CREATE POLICY IF NOT EXISTS "accounts_owner_policy" ON accounts
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Transactions
CREATE POLICY IF NOT EXISTS "transactions_owner_policy" ON transactions
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Roundup line items
CREATE POLICY IF NOT EXISTS "roundup_line_items_owner_policy" ON roundup_line_items
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Roundup accumulators
CREATE POLICY IF NOT EXISTS "roundup_accumulators_owner_policy" ON roundup_accumulators
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Roundup batches
CREATE POLICY IF NOT EXISTS "roundup_batches_owner_policy" ON roundup_batches
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Investment accounts & holdings
CREATE POLICY IF NOT EXISTS "investment_accounts_owner_policy" ON investment_accounts
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY IF NOT EXISTS "holdings_owner_policy" ON holdings
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY IF NOT EXISTS "trades_owner_policy" ON trades
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Note: Service role (server-side) usually needs to bypass RLS for background workers.
-- In Supabase, the service_role key can bypass RLS. Ensure background jobs run with elevated role.

-- End of RLS policies
