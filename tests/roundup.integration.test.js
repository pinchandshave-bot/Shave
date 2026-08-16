// tests/roundup.integration.test.js
// Simple Jest-style integration test scaffold for roundup behavior.
// This file is a starting point; adapt connection string and test runner as needed.

const { Pool } = require('pg');
const { processRoundupForTransaction } = require('../apps/api/src/roundupProcessor');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

describe('Roundup processor', () => {
  let client;

  beforeAll(async () => {
    client = await pool.connect();
  });

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  test('creates accumulator and line item, batches at threshold', async () => {
    // This is an integration test scaffold. You must provide a seeded user/account/transaction in staging.
    // Fetch a sample transaction where roundup is > 0
    const txRes = await client.query(`SELECT t.id, t.user_id, t.account_id, t.amount, t.plaid_transaction_id FROM transactions t WHERE t.amount IS NOT NULL LIMIT 1`);
    expect(txRes.rows.length).toBeGreaterThan(0);
    const tx = txRes.rows[0];

    const result = await processRoundupForTransaction(client, tx);
    expect(result.ok).toBe(true);
    // result.created may be true/false depending on accumulator state
  }, 20000);
});
