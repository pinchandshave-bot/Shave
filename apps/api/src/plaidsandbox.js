#!/usr/bin/env node
/**
 * apps/api/src/plaidsandbox.js
 * Simple Plaid sandbox helper to create an Item, seed transactions for a specific
 * account, and fire a SYNC_UPDATES_AVAILABLE webhook so iBag's webhook handler
 * and sync engine can process them.
 *
 * Usage (from apps/api):
 *   node src/plaidsandbox.js --create --institution ins_109508 --txns ./txns.json
 *
 * Requirements:
 * - PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV set in env (sandbox recommended)
 * - The project uses the same plaidClient wrapper as the main app (apps/api/src/plaidClient.js)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { plaidClient } = require('./plaidClient');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function createSandboxPublicToken(institution_id = 'ins_109508', products = ['transactions','auth']) {
  // SDK method names vary; Plaid JS v45 exposes sandboxPublicTokenCreate
  const res = await plaidClient.sandboxPublicTokenCreate({
    institution_id,
    initial_products: products,
  });
  return res.data.public_token;
}

async function exchangePublicToken(public_token) {
  const res = await plaidClient.itemPublicTokenExchange({ public_token });
  return {
    access_token: res.data.access_token,
    item_id: res.data.item_id,
  };
}

async function getAccounts(access_token) {
  const res = await plaidClient.accountsGet({ access_token });
  return res.data.accounts;
}

async function seedTransactions(access_token, transactions, start_date, end_date) {
  // transactions array must contain account_id as Plaid's account ids
  const res = await plaidClient.sandboxItemSetTransactions({
    access_token,
    transactions,
    start_date,
    end_date,
  });
  return res.data;
}

async function fireWebhook(access_token, webhook_type = 'TRANSACTIONS', webhook_code = 'SYNC_UPDATES_AVAILABLE') {
  const res = await plaidClient.sandboxItemFireWebhook({
    access_token,
    webhook_type,
    webhook_code,
  });
  return res.data;
}

async function main() {
  try {
    const argv = require('yargs/yargs')(process.argv.slice(2)).argv;
    const institution = argv.institution || 'ins_109508';
    const txFile = argv.txns || argv.txn || null;

    console.log('Plaid sandbox helper starting...');

    const public_token = await createSandboxPublicToken(institution, ['transactions','auth']);
    console.log('Created sandbox public_token');

    const exchanged = await exchangePublicToken(public_token);
    console.log('Exchanged public_token:', exchanged.item_id);

    // Optionally fetch accounts
    const accounts = await getAccounts(exchanged.access_token);
    console.log('Accounts on Item:');
    accounts.forEach((a) => console.log(' -', a.account_id, a.name, a.mask));

    // If a txn file was supplied, prepare transactions and seed them on the first account
    if (txFile) {
      const txPath = path.resolve(txFile);
      const payload = JSON.parse(fs.readFileSync(txPath, 'utf8'));
      // payload should be an array of { amount, date, name, account_index (optional), transaction_id (optional) }
      const targetAccount = accounts[(payload[0].account_index) || 0];
      const plaidAccountId = targetAccount.account_id;

      const txns = payload.map((t, i) => ({
        account_id: plaidAccountId,
        amount: t.amount,
        date: t.date,
        name: t.name || `Sandbox TX ${i+1}`,
        transaction_id: t.transaction_id || `sandbox-txn-${Date.now()}-${i}`,
      }));

      const start_date = payload[0].start_date || payload[0].date || new Date().toISOString().slice(0,10);
      const end_date = payload[0].end_date || payload[payload.length-1].date || start_date;

      console.log('Seeding transactions to account', plaidAccountId);
      await seedTransactions(exchanged.access_token, txns, start_date, end_date);
      console.log('Transactions seeded');

      // Fire webhook
      console.log('Firing sandbox webhook to trigger sync...');
      await fireWebhook(exchanged.access_token, 'TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE');
      console.log('Webhook fired. Wait a few seconds for sync worker to process.');
      await sleep(5000);
      console.log('Done. Check your /plaid/webhook logs and db tables for roundups.');

    } else {
      console.log('No transactions file provided; created Item only. Use --txns <file.json> to seed txns and fire webhook');
    }
  } catch (err) {
    console.error('Sandbox helper failed:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
