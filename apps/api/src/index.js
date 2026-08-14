require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const pool = require('./db');

const {
  plaidClient,
  PLAID_PRODUCTS,
} = require('./plaidClient');

const {
  encrypt,
  decrypt,
} = require('./crypto');

const {
  requireAuth,
  requireInternalSecret,
  signup,
  login,
} = require('./auth');

const {
  runSync,
  syncOneItem,
} = require('./sync');

const {
  getMe,
  getDashboard,
  getSummary,
  getAccounts,
  getTransactions,
  getInsights,
  getNetWorth,
  getIncome,
  getCashFlow,
} = require('./me');

const app = express();

/*
 * --------------------------------------------------------------------------
 * RENDER / REVERSE PROXY
 * --------------------------------------------------------------------------
 *
 * Render places the application behind a reverse proxy and forwards the
 * original client address through X-Forwarded-For.
 *
 * express-rate-limit requires Express proxy trust to be configured so that
 * client identification works correctly in this environment.
 */

app.set('trust proxy', 1);

/*
 * --------------------------------------------------------------------------
 * CORS
 * --------------------------------------------------------------------------
 */

app.use(
  cors({
    origin:
      process.env.FRONTEND_ORIGIN ||
      'https://shave.onrender.com',
  }),
);

app.use(express.json());
app.use(express.static('public'));

/*
 * --------------------------------------------------------------------------
 * AUTHENTICATION RATE LIMITER
 * --------------------------------------------------------------------------
 */

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'error',
    message: 'Too many attempts. Try again later.',
  },
});

/*
 * --------------------------------------------------------------------------
 * SERVICE / HEALTH
 * --------------------------------------------------------------------------
 */

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'shave-api',
    message: 'Shave API is running',
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ibag-api',
    time: new Date().toISOString(),
  });
});

app.get('/db-check', async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          now() AS db_time,
          count(*) AS user_count
        FROM users
      `,
    );

    return res.json({
      status: 'ok',
      db_time: result.rows[0].db_time,
      user_count: result.rows[0].user_count,
    });
  } catch (err) {
    console.error('Database check failed:', err);

    return res.status(500).json({
      status: 'error',
      message: err.message,
    });
  }
});

/*
 * --------------------------------------------------------------------------
 * AUTHENTICATION
 * --------------------------------------------------------------------------
 */

app.post(
  '/auth/signup',
  authLimiter,
  signup,
);

app.post(
  '/auth/login',
  authLimiter,
  login,
);

/*
 * --------------------------------------------------------------------------
 * AUTHENTICATED USER / DASHBOARD
 * --------------------------------------------------------------------------
 */

app.get(
  '/me',
  requireAuth,
  getMe,
);

app.get(
  '/me/dashboard',
  requireAuth,
  getDashboard,
);

app.get(
  '/me/summary',
  requireAuth,
  getSummary,
);

app.get(
  '/me/accounts',
  requireAuth,
  getAccounts,
);

app.get(
  '/me/transactions',
  requireAuth,
  getTransactions,
);

app.get(
  '/me/insights',
  requireAuth,
  getInsights,
);

app.get(
  '/me/net-worth',
  requireAuth,
  getNetWorth,
);

app.get(
  '/me/income',
  requireAuth,
  getIncome,
);

app.get(
  '/me/cash-flow',
  requireAuth,
  getCashFlow,
);

/*
 * --------------------------------------------------------------------------
 * PLAID
 * --------------------------------------------------------------------------
 */

/*
 * Create a new Plaid Link token.
 */

app.post(
  '/plaid/create-link-token',
  requireAuth,
  async (req, res) => {
    try {
      const activeCount = await pool.query(
        `
          SELECT count(*)
          FROM plaid_items
          WHERE status = 'active'
        `,
      );

      const CAPACITY_LIMIT = 9;

      if (
        Number(activeCount.rows[0].count) >=
        CAPACITY_LIMIT
      ) {
        return res.status(503).json({
          status: 'error',
          message:
            'Shave is at capacity for new bank connections right now. Try again soon.',
        });
      }

      const response =
        await plaidClient.linkTokenCreate({
          user: {
            client_user_id: req.user.id,
          },
          client_name: 'iBag',
          products: PLAID_PRODUCTS,
          country_codes: ['US'],
          language: 'en',
        });

      return res.json({
        status: 'ok',
        link_token:
          response.data.link_token,
      });
    } catch (err) {
      console.error(
        'Plaid create link token failed:',
        err,
      );

      const detail =
        err.response?.data ||
        err.message;

      return res.status(500).json({
        status: 'error',
        detail,
      });
    }
  },
);

/*
 * Create a Plaid update-mode Link token
 * for an existing Item.
 */

app.post(
  '/plaid/create-update-link-token',
  requireAuth,
  async (req, res) => {
    try {
      const {
        plaid_item_id,
      } = req.body;

      if (!plaid_item_id) {
        return res.status(400).json({
          status: 'error',
          message:
            'plaid_item_id is required',
        });
      }

      const itemRow =
        await pool.query(
          `
            SELECT
              id,
              plaid_access_token_encrypted
            FROM plaid_items
            WHERE plaid_item_id = $1
              AND user_id = $2
            LIMIT 1
          `,
          [
            plaid_item_id,
            req.user.id,
          ],
        );

      if (itemRow.rows.length === 0) {
        return res.status(404).json({
          status: 'error',
          message:
            'Item not found for this user',
        });
      }

      const accessToken =
        decrypt(
          itemRow.rows[0]
            .plaid_access_token_encrypted,
        );

      const response =
        await plaidClient.linkTokenCreate({
          user: {
            client_user_id:
              req.user.id,
          },
          client_name: 'iBag',
          access_token:
            accessToken,
          additional_consented_products: [
            'liabilities',
            'investments',
            'identity',
          ],
          country_codes: ['US'],
          language: 'en',
        });

      return res.json({
        status: 'ok',
        link_token:
          response.data.link_token,
      });
    } catch (err) {
      console.error(
        'Plaid update link token failed:',
        err,
      );

      const detail =
        err.response?.data ||
        err.message;

      return res.status(500).json({
        status: 'error',
        detail,
      });
    }
  },
);

/*
 * Exchange Plaid public token for access token.
 */

app.post(
  '/plaid/exchange-public-token',
  requireAuth,
  async (req, res) => {
    try {
      const {
        public_token,
        institution_name,
      } = req.body;

      if (!public_token) {
        return res.status(400).json({
          status: 'error',
          message:
            'public_token is required',
        });
      }

      const exchangeRes =
        await plaidClient.itemPublicTokenExchange({
          public_token,
        });

      const access_token =
        exchangeRes.data.access_token;

      const plaid_item_id =
        exchangeRes.data.item_id;

      const userId =
        req.user.id;

      const encryptedToken =
        encrypt(access_token);

      const itemInsert =
        await pool.query(
          `
            INSERT INTO plaid_items
            (
              user_id,
              plaid_item_id,
              plaid_access_token_encrypted,
              institution_name
            )
            VALUES
            ($1, $2, $3, $4)
            RETURNING id
          `,
          [
            userId,
            plaid_item_id,
            encryptedToken,
            institution_name ||
              null,
          ],
        );

      const plaidItemDbId =
        itemInsert.rows[0].id;

      const accountsRes =
        await plaidClient.accountsGet({
          access_token,
        });

      for (
        const acct of
        accountsRes.data.accounts
      ) {
        await pool.query(
          `
            INSERT INTO accounts
            (
              plaid_item_id,
              plaid_account_id,
              name,
              type,
              subtype,
              mask,
              current_balance,
              available_balance,
              balance_iso_currency_code,
              balance_updated_at
            )
            VALUES
            (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9,
              now()
            )
            ON CONFLICT
              (plaid_account_id)
            DO UPDATE SET
              name =
                EXCLUDED.name,
              type =
                EXCLUDED.type,
              subtype =
                EXCLUDED.subtype,
              mask =
                EXCLUDED.mask,
              current_balance =
                EXCLUDED.current_balance,
              available_balance =
                EXCLUDED.available_balance,
              balance_iso_currency_code =
                EXCLUDED.balance_iso_currency_code,
              balance_updated_at =
                now()
          `,
          [
            plaidItemDbId,
            acct.account_id,
            acct.name,
            acct.type,
            acct.subtype,
            acct.mask,
            acct.balances?.current ?? null,
            acct.balances?.available ?? null,
            acct.balances?.iso_currency_code ||
              'USD',
          ],
        );
      }

      let immediateSyncResult = null;

      try {
        const freshItem =
          await pool.query(
            `
              SELECT
                id,
                plaid_item_id,
                plaid_access_token_encrypted,
                cursor
              FROM plaid_items
              WHERE id = $1
            `,
            [plaidItemDbId],
          );

        if (
          freshItem.rows.length > 0
        ) {
          immediateSyncResult =
            await syncOneItem(
              freshItem.rows[0],
            );
        }
      } catch (syncErr) {
        console.error(
          'Immediate post-link sync failed (non-fatal):',
          syncErr.message,
        );
      }

      return res.json({
        status: 'ok',
        plaid_item_id,
        accounts_stored:
          accountsRes.data.accounts.length,
        immediate_sync:
          immediateSyncResult,
      });
    } catch (err) {
      console.error(
        'Plaid public token exchange failed:',
        err,
      );

      const detail =
        err.response?.data ||
        err.message;

      return res.status(500).json({
        status: 'error',
        detail,
      });
    }
  },
);

/*
 * Re-sync an existing Plaid Item after
 * an update-mode Link flow.
 */

app.post(
  '/plaid/resync-after-update',
  requireAuth,
  async (req, res) => {
    try {
      const {
        plaid_item_id,
      } = req.body;

      if (!plaid_item_id) {
        return res.status(400).json({
          status: 'error',
          message:
            'plaid_item_id is required',
        });
      }

      const itemRow =
        await pool.query(
          `
            SELECT
              id,
              plaid_item_id,
              plaid_access_token_encrypted,
              cursor
            FROM plaid_items
            WHERE plaid_item_id = $1
              AND user_id = $2
            LIMIT 1
          `,
          [
            plaid_item_id,
            req.user.id,
          ],
        );

      if (itemRow.rows.length === 0) {
        return res.status(404).json({
          status: 'error',
          message:
            'Item not found for this user',
        });
      }

      const result =
        await syncOneItem(
          itemRow.rows[0],
        );

      return res.json({
        status: 'ok',
        result,
      });
    } catch (err) {
      console.error(
        'Plaid resync failed:',
        err,
      );

      return res.status(500).json({
        status: 'error',
        message: err.message,
      });
    }
  },
);

/*
 * --------------------------------------------------------------------------
 * INTERNAL SYNCHRONIZATION
 * --------------------------------------------------------------------------
 */

app.post(
  '/internal/sync/run',
  requireInternalSecret,
  runSync,
);

/*
 * --------------------------------------------------------------------------
 * 404
 * --------------------------------------------------------------------------
 */

app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    message: 'Not found',
  });
});

/*
 * --------------------------------------------------------------------------
 * GLOBAL ERROR HANDLER
 * --------------------------------------------------------------------------
 */

app.use(
  (err, req, res, next) => {
    console.error(
      'Unhandled error:',
      err,
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Internal server error',
    });
  },
);

/*
 * --------------------------------------------------------------------------
 * SERVER
 * --------------------------------------------------------------------------
 */

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `shave-api listening on port ${PORT}`,
  );
});
