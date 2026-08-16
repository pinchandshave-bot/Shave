# WIRING_INSTRUCTIONS.md (updated)

This file describes the safe staging and migration steps to apply the iBag investor-rebuild branch changes.

Overview
- Branch: iBag (created)
- Files added: migration SQL, roundupProcessor, plaidsandbox helper, RLS policies, tests
- Goal: Add per-card roundup accumulators (threshold $2), idempotent syncs, investor domain tables, audit trail, and RLS policies.

Staging workflow (recommended)
1) Create staging Supabase project
   - From your Supabase dashboard, create a new project (iBag-staging).
   - Optionally, take a dump of production (pg_dump) and restore into staging to have representative data.

2) Run migration in staging
   - Navigate to the SQL editor in Supabase for the staging project.
   - Open db/migration_000_investor_rebuild.sql and run it.
   - Confirm tables were created: roundup_accumulators, roundup_line_items, roundup_batches, securities, security_prices, investment_accounts, holdings, trades, portfolio_snapshots, ibag_audit, processed_webhooks.

3) Configure environment for staging
   - Set environment variables for your staging deployment or local run:
     - PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV=sandbox
     - DATABASE_URL (pointing to staging project)
     - CRYPTO_KEY (or KMS config)
     - INTERNAL_SECRET
     - MIN_SOURCE_BALANCE_CENTS (optional)

4) Run server locally (apps/api)
   - From repo root: cd apps/api
   - npm install
   - npm run dev

5) Run Plaid sandbox script to seed transactions
   - Create a transactions JSON file, e.g., sample-txns.json:
     [
       { "amount": 1.12, "date": "2026-08-10", "name": "Coffee" },
       { "amount": 0.53, "date": "2026-08-11", "name": "Snack" },
       { "amount": 0.70, "date": "2026-08-12", "name": "Gum" },
       { "amount": 0.80, "date": "2026-08-13", "name": "Cookie" },
       { "amount": 0.16, "date": "2026-08-14", "name": "Candy" }
     ]
   - Run: node src/plaidsandbox.js --institution ins_109508 --txns ./sample-txns.json
   - The script will create a sandbox Item, seed transactions to one account, and fire a SYNC_UPDATES_AVAILABLE webhook.

6) Validate results
   - Check staging DB tables:
     - SELECT * FROM roundup_line_items WHERE user_id = '<test-user>';
     - SELECT * FROM roundup_accumulators WHERE account_id = '<source-account>';
     - SELECT * FROM roundup_batches WHERE status = 'ready_for_sweep';
   - Validate accumulator reached >= 200 cents only for the card that had enough roundups.
   - Verify processed_webhooks contains the webhook id.

7) Run tests
   - npm run test (if tests configured) or run the provided Jest integration test against staging DB.

8) Rollback plan
   - If migration causes unexpected issues, restore staging DB from backup snapshot.
   - For production migration, snapshot production DB and verify snapshot integrity before running migration.

Acceptance checklist for investors
- Deterministic cents handling: balances/transactions roundups stored as integer cents.
- Idempotency: replaying the same webhook or transaction does not duplicate roundup_line_items.
- Per-card logic: accumulator per source account only triggers batch when threshold reached and safety check passes.
- Provenance: roundup_line_items reference transactions(id) and plaid_transaction_id for traceability.
- Audit: ibag_audit contains entries for important writes to roundups/trades/holdings.

Contact
- If you want me to push additional changes or replace sync.js in the branch, respond and I will create a follow-up commit.
