require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db');
const plaidClient = require('./plaidClient');
const { encrypt } = require('./crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

function requireInternalSecret(req, res, next) {
  const provided = req.headers['x-internal-secret'];
  if (!provided || provided !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  next();
}

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

app.post('/plaid/create-link-token', requireInternalSecret, async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'test-user-' + Date.now() },
      client_name: 'shave',
      products: ['auth', 'transactions'],
      country_codes: ['US'],
      language: 'en',
    });
    res.json({ status: 'ok', link_token: response.data.link_token });
  } catch (err) {
    const detail = err.response?.data || err.message;
    res.status(500).json({ status: 'error', detail });
  }
});

app.post('/plaid/exchange-public-token', requireInternalSecret, async (req, res) => {
  try {
    const { public_token, institution_name } = req.body;
    if (!public_token) {
      return res.status(400).json({ status: 'error', message: 'public_token is required' });
    }

    const exchangeRes = await plaidClient.itemPublicTokenExchange({ public_token });
    const access_token = exchangeRes.data.access_token;
    const plaid_item_id = exchangeRes.data.item_id;

    // No auth system yet, so we use one fixed test user for now.
    // This gets replaced once real signup/login exists.
    let userResult = await pool.query("select id from users where email = 'test@shave.dev' limit 1");
    let userId;
    if (userResult.rows.length === 0) {
      const insertUser = await pool.query("insert into users (email) values ('test@shave.dev') returning id");
      userId = insertUser.rows[0].id;
    } else {
      userId = userResult.rows[0].id;
    }

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

    res.json({ status: 'ok', plaid_item_id, accounts_stored: accountsRes.data.accounts.length });
  } catch (err) {
    const detail = err.response?.data || err.message;
    res.status(500).json({ status: 'error', detail });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`shave-api listening on port ${PORT}`);
});
