require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db');
const { plaidClient, PLAID_PRODUCTS } = require('./plaidClient');
const { encrypt, decrypt } = require('./crypto');
const { requireAuth, requireInternalSecret, signup, login } = require('./auth');
const { runSync, syncOneItem } = require('./sync');
const { getSummary, getAccounts, getTransactions, getInsights } = require('./me');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'shave-api', time: new Date().toISOString() });
});
app.get('/db-check', async (req, res) => {
  try {
    const result = await pool.query('select now() as db_time, count(*) as user_count from users');
    res.json({ status: 'ok', db_time: result.rows[0].db_time, user_count: result.rows[0].user_count });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/auth/signup', signup);
app.post('/auth/login', login);

app.get('/me/summary', requireAuth, getSummary);
app.get('/me/accounts', requireAuth, getAccounts);
app.get('/me/transactions', requireAuth, getTransactions);
app.get('/me/insights', requireAuth, getInsights);

app.post('/plaid/create-link-token', requireAuth, async (req, res) => {
  try {
    const activeCount = await pool.query("select count(*) from plaid_items where status = 'active'");
    const CAPACITY_LIMIT = 9; // stop at 9, not the hard 10, to leave headroom
    if (Number(activeCount.rows[0].count) >= CAPACITY_LIMIT) {
      return res.status(503).json({
        status: 'error',
        message: 'Shave is at capacity for new bank connections right now. Try again soon.',
      });
    }
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: req.user.id },
      client_name: 'shave',
      products: PLAID_PRODUCTS,
      country_codes: ['US'],
      language: 'en',
    });
    res.json({ status: 'ok', link_token: response.data.link_token });
  } catch (err) {
    const detail = err.response?.data || err.message;
    res.status(500).json({ status: 'error', detail });
  }
});

// Update mode: lets an already-linked account re-consent to products it
// didn't originally grant (e.g. your two existing test links, which only
// have auth+transactions). Same Item, same access_token — just new consent.
app.post('/plaid/create-update-link-token', requireAuth, async (req, res) => {
  try {
    const { plaid_item_id } = req.body;
    const itemRow = await pool.query(
      'select id, plaid_access_token_encrypted from plaid_items where plaid_item_id = $1 and user_id = $2',
      [plaid_item_id, req.user.id]
    );
    if (itemRow.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Item not found for this user' });
    }
    const accessToken = decrypt(itemRow.rows[0].plaid_access_token_encrypted);
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: req.user.id },
      client_name: 'shave',
      access_token: accessToken,
      additional_consented_products: ['liabilities', 'investments', 'identity'],
      country_codes: ['US'],
      language: 'en',
    });
    res.json({ status: 'ok', link_token: response.data.link_token });
  } catch (err) {
    const detail = err.response?.data || err.message;
    res.status(500).json({ status: 'error', detail });
  }
});

app.post('/plaid/exchange-public-token', requireAuth, async (req, res) => {
  try {
    const { public_token, institution_name } = req.body;
    if (!public_token) {
      return res.status(400).json({ status: 'error', message: 'public_token is required' });
    }
    const exchangeRes = await plaidClient.itemPublicTokenExchange({ public_token });
    const access_token = exchangeRes.data.access_token;
    const plaid_item_id = exchangeRes.data.item_id;
    const userId = req.user.id;
    const encryptedToken = encrypt(access_token);
    const itemInsert = await pool.query(
      `insert into plaid_items (user_id, plaid_item_id, plaid_access_token_encrypted, institution_name)
       values ($1, $2, $3, $4) returning id`,
      [userId, plaid_item_id, encryptedToken, institution_name || null]
    );
    const plaidItemDbId = itemInsert.rows[0].id;
    const accountsRes = await plaidClient.accountsGet({ access_token });
    for (const acct of accountsRes.data.accounts) {
      await pool.query(
        `insert into accounts (plaid_item_id, plaid_account_id, name, type, subtype, mask)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (plaid_account_id) do nothing`,
        [plaidItemDbId, acct.account_id, acct.name, acct.type, acct.subtype, acct.mask]
      );
    }

    let immediateSyncResult = null;
    try {
      const freshItem = await pool.query(
        'select id, plaid_item_id, plaid_access_token_encrypted, cursor from plaid_items where id = $1',
        [plaidItemDbId]
      );
      immediateSyncResult = await syncOneItem(freshItem.rows[0]);
    } catch (syncErr) {
      console.error('Immediate post-link sync failed (non-fatal):', syncErr.message);
    }

    res.json({
      status: 'ok',
      plaid_item_id,
      accounts_stored: accountsRes.data.accounts.length,
      immediate_sync: immediateSyncResult,
    });
  } catch (err) {
    const detail = err.response?.data || err.message;
    res.status(500).json({ status: 'error', detail });
  }
});

// Called after a successful update-mode Link session — no new public_token
// to exchange (access_token didn't change), just re-run sync so the newly
// consented products (Liabilities/Investments/Identity) populate immediately.
app.post('/plaid/resync-after-update', requireAuth, async (req, res) => {
  try {
    const { plaid_item_id } = req.body;
    const itemRow = await pool.query(
      'select id, plaid_item_id, plaid_access_token_encrypted, cursor from plaid_items where plaid_item_id = $1 and user_id = $2',
      [plaid_item_id, req.user.id]
    );
    if (itemRow.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Item not found for this user' });
    }
    const result = await syncOneItem(itemRow.rows[0]);
    res.json({ status: 'ok', result });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/internal/sync/run', requireInternalSecret, runSync);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`shave-api listening on port ${PORT}`);
});
