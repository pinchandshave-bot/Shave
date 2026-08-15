require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const pool = require('./db');

const {
  createLinkToken,
  createUpdateModeLinkToken,
  getProductCoverage,
  getItem,
  plaidClient,
  PLAID_ENVIRONMENT,
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

app.set('trust proxy', 1);

app.use(
  cors({
    origin:
      process.env.FRONTEND_ORIGIN ||
      'https://shave.onrender.com',
  }),
);

app.use(express.json());
app.use(express.static('public'));


/* ============================================================================
 * AUTH RATE LIMITER
 * ========================================================================== */

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'error',
    message:
      'Too many attempts. Try again later.',
  },
});


/* ============================================================================
 * SERVICE / HEALTH
 * ========================================================================== */

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ibag-api',
    environment:
      PLAID_ENVIRONMENT,
    message:
      'iBag API is running',
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ibag-api',
    environment:
      PLAID_ENVIRONMENT,
    time:
      new Date().toISOString(),
  });
});


app.get('/db-check', async (req, res) => {
  try {
    const result =
      await pool.query(`
        SELECT
          now() AS db_time,
          count(*) AS user_count
        FROM users
      `);

    return res.json({
      status: 'ok',
      db_time:
        result.rows[0].db_time,
      user_count:
        result.rows[0].user_count,
    });
  } catch (err) {
    console.error(
      'Database check failed:',
      err,
    );

    return res.status(500).json({
      status: 'error',
      message:
        err.message,
    });
  }
});


/* ============================================================================
 * AUTHENTICATION
 * ========================================================================== */

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


/* ============================================================================
 * AUTHENTICATED USER / DASHBOARD
 * ========================================================================== */

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


/* ============================================================================
 * PLAID — CREATE INITIAL LINK TOKEN
 * ========================================================================== */

app.post(
  '/plaid/create-link-token',
  requireAuth,
  async (req, res) => {
    try {
      /*
       * Capacity is deliberately based on actual Plaid Items,
       * not accounts.
       */
      const activeCount =
        await pool.query(`
          SELECT count(*)
          FROM plaid_items
          WHERE status = 'active'
        `);

      const CAPACITY_LIMIT = 9;

      if (
        Number(
          activeCount.rows[0].count
        ) >= CAPACITY_LIMIT
      ) {
        return res.status(503).json({
          status: 'error',
          message:
            'iBag is at capacity for new bank connections right now. Try again soon.',
        });
      }

      const result =
        await createLinkToken({
          userId:
            req.user.id,
        });

      return res.json({
        status: 'ok',
        ...result,
      });
    } catch (err) {
      console.error(
        'Plaid create link token failed:',
        err,
      );

      return res.status(500).json({
        status: 'error',
        code:
          err.code ||
          'PLAID_LINK_TOKEN_CREATE_FAILED',
        message:
          err.message,
        request_id:
          err.requestId ||
          null,
      });
    }
  },
);


/* ============================================================================
 * PLAID — UPDATE MODE
 * ========================================================================== */

app.post(
  '/plaid/create-update-link-token',
  requireAuth,
  async (req, res) => {
    try {
      const {
        plaid_item_id,
        products,
      } = req.body;

      if (!plaid_item_id) {
        return res.status(400).json({
          status: 'error',
          message:
            'plaid_item_id is required',
        });
      }

      if (
        !Array.isArray(products) ||
        products.length === 0
      ) {
        return res.status(400).json({
          status: 'error',
          message:
            'products must contain at least one requested Plaid product',
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

      if (
        itemRow.rows.length === 0
      ) {
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

      const result =
        await createUpdateModeLinkToken({
          userId:
            req.user.id,

          accessToken,

          products,
        });

      return res.json({
        status: 'ok',
        ...result,
      });
    } catch (err) {
      console.error(
        'Plaid update link token failed:',
        err,
      );

      return res.status(500).json({
        status: 'error',
        code:
          err.code ||
          'PLAID_UPDATE_MODE_LINK_TOKEN_CREATE_FAILED',
        message:
          err.message,
        request_id:
          err.requestId ||
          null,
      });
    }
  },
);


/* ============================================================================
 * PLAID — ITEM PRODUCT COVERAGE
 * ========================================================================== */

app.get(
  '/plaid/item/:plaidItemId/products',
  requireAuth,
  async (req, res) => {
    try {
      const {
        plaidItemId,
      } = req.params;

      const itemRow =
        await pool.query(
          `
            SELECT
              plaid_access_token_encrypted
            FROM plaid_items
            WHERE plaid_item_id = $1
              AND user_id = $2
              AND status = 'active'
            LIMIT 1
          `,
          [
            plaidItemId,
            req.user.id,
          ],
        );

      if (
        itemRow.rows.length === 0
      ) {
        return res.status(404).json({
          status: 'error',
          message:
            'Active Plaid Item not found',
        });
      }

      const accessToken =
        decrypt(
          itemRow.rows[0]
            .plaid_access_token_encrypted,
        );

      const coverage =
        await getProductCoverage(
          accessToken
        );

      return res.json({
        status: 'ok',
        plaid_item_id:
          plaidItemId,
        ...coverage,
      });
    } catch (err) {
      console.error(
        'Plaid product coverage failed:',
        err,
      );

      return res.status(500).json({
        status: 'error',
        code:
          err.code ||
          'PLAID_PRODUCT_COVERAGE_FAILED',
        message:
          err.message,
        request_id:
          err.requestId ||
          null,
      });
    }
  },
);


/* ============================================================================
 * PLAID — EXCHANGE PUBLIC TOKEN
 * ========================================================================== */

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
        encrypt(
          access_token
        );

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
              plaid_item_id =
                EXCLUDED.plaid_item_id,

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
            acct.balances?.current ??
              null,
            acct.balances?.available ??
              null,
            acct.balances
              ?.iso_currency_code ||
              'USD',
          ],
        );
      }

      let immediateSyncResult =
        null;

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
            [
              plaidItemDbId,
            ],
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
          'Immediate post-link sync failed:',
          syncErr.message,
        );
      }

      return res.json({
        status: 'ok',

        plaid_item_id,

        accounts_stored:
          accountsRes.data.accounts
            .length,

        immediate_sync:
          immediateSyncResult,
      });
    } catch (err) {
      console.error(
        'Plaid public token exchange failed:',
        err,
      );

      return res.status(500).json({
        status: 'error',
        code:
          err.code ||
          'PLAID_PUBLIC_TOKEN_EXCHANGE_FAILED',
        message:
          err.message,
        request_id:
          err.requestId ||
          null,
      });
    }
  },
);


/* ============================================================================
 * PLAID — RESYNC AFTER UPDATE
 * ========================================================================== */

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
              AND status = 'active'
            LIMIT 1
          `,
          [
            plaid_item_id,
            req.user.id,
          ],
        );

      if (
        itemRow.rows.length === 0
      ) {
        return res.status(404).json({
          status: 'error',
          message:
            'Item not found for this user',
        });
      }

      const result =
        await syncOneItem(
          itemRow.rows[0]
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
        code:
          err.code ||
          'PLAID_RESYNC_FAILED',
        message:
          err.message,
        request_id:
          err.requestId ||
          null,
      });
    }
  },
);


/* ============================================================================
 * INTERNAL SYNCHRONIZATION
 * ========================================================================== */

app.post(
  '/internal/sync/run',
  requireInternalSecret,
  runSync,
);


/* ============================================================================
 * 404
 * ========================================================================== */

app.use(
  (req, res) => {
    res.status(404).json({
      status: 'error',
      message:
        'Not found',
    });
  }
);


/* ============================================================================
 * GLOBAL ERROR HANDLER
 * ========================================================================== */

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
  }
);


/* ============================================================================
 * SERVER
 * ========================================================================== */

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  () => {
    console.log(
      `iBag API listening on port ${PORT} (${PLAID_ENVIRONMENT})`
    );
  }
);
