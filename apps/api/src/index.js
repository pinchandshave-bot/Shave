require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const pool = require('./db');

const {
  createLinkToken,
  createUpdateModeLinkToken,
  getProductCoverage,
  plaidClient,
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
  getRoundups,
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
    message:
      'Too many attempts. Try again later.',
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
    service: 'ibag-api',
    message: 'iBag API is running',
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
    const result =
      await pool.query(
        `
          SELECT
            now() AS db_time,
            count(*) AS user_count
          FROM users
        `,
      );

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
  '/me/roundups',
  requireAuth,
  getRoundups,
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
 * PLAID - INITIAL LINK
 * --------------------------------------------------------------------------
 *
 * iBag intentionally starts with the smallest required initialization set.
 *
 * Transactions is the core Phase 1 data foundation.
 *
 * Auth and Identity are optional so institutions are not unnecessarily
 * excluded from the connection experience.
 *
 * Liabilities and Investments are handled through consent/update flows
 * rather than forcing every institution to support every product.
 */

app.post(
  '/plaid/create-link-token',
  requireAuth,
  async (req, res) => {
    try {
      const activeCount =
        await pool.query(
          `
            SELECT
              count(*)
            FROM plaid_items
            WHERE status = 'active'
          `,
        );

      /*
       * Preserve the existing deployment capacity boundary.
       *
       * This is an application capacity rule, not a Plaid product rule.
       */
      const CAPACITY_LIMIT = 9;

      if (
        Number(
          activeCount.rows[0].count,
        ) >= CAPACITY_LIMIT
      ) {
        return res.status(503).json({
          status: 'error',
          message:
            'iBag is at capacity for new bank connections right now. Try again soon.',
        });
      }

      const response =
        await createLinkToken({
          userId:
            req.user.id,

          webhookUrl:
            process.env.PLAID_WEBHOOK_URL ||
            null,
        });

      return res.json({
        status: 'ok',

        link_token:
          response.link_token,

        expiration:
          response.expiration,

        request_id:
          response.request_id,

        initial_products:
          response.initial_products,
      });
    } catch (err) {
      console.error(
        'Plaid create link token failed:',
        err,
      );

      return res.status(500).json({
        status: 'error',

        message:
          'Unable to prepare the secure Plaid connection.',

        code:
          err.code || null,

        detail:
          process.env.NODE_ENV ===
          'production'
            ? undefined
            : err.message,

        request_id:
          err.requestId || null,
      });
    }
  },
);

/*
 * --------------------------------------------------------------------------
 * PLAID - PRODUCT COVERAGE
 * --------------------------------------------------------------------------
 *
 * This endpoint exposes observed Plaid product state.
 *
 * It does NOT manufacture availability.
 */

app.get(
  '/plaid/items/:plaid_item_id/products',
  requireAuth,
  async (req, res) => {
    try {
      const {
        plaid_item_id,
      } = req.params;

      const itemResult =
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
            plaid_item_id,
            req.user.id,
          ],
        );

      if (
        itemResult.rows.length ===
        0
      ) {
        return res.status(404).json({
          status: 'error',
          message:
            'Plaid Item not found for this user',
        });
      }

      const accessToken =
        decrypt(
          itemResult.rows[0]
            .plaid_access_token_encrypted,
        );

      const coverage =
        await getProductCoverage(
          accessToken,
        );

      return res.json({
        status: 'ok',
        plaid_item_id,
        coverage,
      });
    } catch (err) {
      console.error(
        'Plaid product coverage failed:',
        err,
      );

      return res.status(500).json({
        status: 'error',
        message:
          'Unable to determine Plaid product coverage.',
        code:
          err.code || null,
        request_id:
          err.requestId || null,
      });
    }
  },
);

/*
 * --------------------------------------------------------------------------
 * PLAID - UPDATE MODE
 * --------------------------------------------------------------------------
 *
 * Supports three distinct update-mode strategies:
 *
 * 1. Additional consent:
 *    Auth / Identity / Investments / Liabilities
 *
 * 2. Specialized credit products:
 *    Assets / Statements
 *
 * 3. Normal update mode:
 *    Repair credentials, permissions, account access, etc.
 *
 * Specialized products MUST NOT be placed into
 * additional_consented_products.
 */

app.post(
  '/plaid/create-update-link-token',
  requireAuth,
  async (req, res) => {
    try {
      const {
        plaid_item_id,
        products,
        additional_consented_products,
        statements,
        asset_report,
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
              AND status = 'active'
            LIMIT 1
          `,
          [
            plaid_item_id,
            req.user.id,
          ],
        );

      if (
        itemRow.rows.length ===
        0
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

      /*
       * Normalize caller input.
       */
      const requestedProducts =
        Array.isArray(products)
          ? products
          : [];

      const requestedConsent =
        Array.isArray(
          additional_consented_products,
        )
          ? additional_consented_products
          : [];

      /*
       * Specialized credit products.
       *
       * These belong in products, not additional_consented_products.
       */
      const specializedProducts =
        requestedProducts.filter(
          product =>
            product === 'assets' ||
            product === 'statements',
        );

      /*
       * Products that may be requested through
       * additional consent.
       */
      const consentProducts =
        requestedConsent.filter(
          product =>
            product === 'auth' ||
            product === 'identity' ||
            product === 'investments' ||
            product === 'investments_auth' ||
            product === 'liabilities' ||
            product === 'transactions' ||
            product === 'signal' ||
            product === 'balance_plus',
        );

      /*
       * Do not allow Assets or Statements to enter
       * additional_consented_products.
       */
      const invalidConsentProducts =
        requestedConsent.filter(
          product =>
            product === 'assets' ||
            product === 'statements',
        );

      if (
        invalidConsentProducts.length >
        0
      ) {
        return res.status(400).json({
          status: 'error',

          message:
            'Assets and Statements must be requested through the specialized update-mode product flow, not additional_consented_products.',

          invalid_products:
            invalidConsentProducts,
        });
      }

      /*
       * Specialized product request.
       */
      if (
        specializedProducts.length >
        0
      ) {
        /*
         * Plaid requires the specialized product
         * to be placed in products during update mode.
         *
         * We intentionally permit one specialized
         * credit product per update session.
         */
        if (
          specializedProducts.length >
          1
        ) {
          return res.status(400).json({
            status: 'error',
            message:
              'Request Assets and Statements through separate specialized update-mode sessions.',
          });
        }

        const specializedProduct =
          specializedProducts[0];

        const request = {
          user: {
            client_user_id:
              String(req.user.id),
          },

          client_name:
            'iBag',

          access_token:
            accessToken,

          country_codes: [
            'US',
          ],

          language: 'en',

          products: [
            specializedProduct,
          ],
        };

        /*
         * Statements requires its configuration
         * object when requested.
         */
        if (
          specializedProduct ===
          'statements'
        ) {
          if (
            !statements ||
            typeof statements !==
              'object'
          ) {
            return res.status(400).json({
              status: 'error',
              message:
                'statements configuration is required when adding Statements.',
            });
          }

          request.statements =
            statements;
        }

        /*
         * Assets may require asset-specific
         * configuration depending on the
         * application's selected Plaid flow.
         */
        if (
          specializedProduct ===
            'assets' &&
          asset_report &&
          typeof asset_report ===
            'object'
        ) {
          request.asset_report =
            asset_report;
        }

        const response =
          await plaidClient.linkTokenCreate(
            request,
          );

        return res.json({
          status: 'ok',

          mode:
            'specialized_product',

          product:
            specializedProduct,

          link_token:
            response.data.link_token,

          expiration:
            response.data.expiration,

          request_id:
            response.data.request_id,
        });
      }

      /*
       * Normal update mode / additional consent.
       *
       * No products array is supplied here.
       */
      const response =
        await createUpdateModeLinkToken({
          userId:
            req.user.id,

          accessToken,

          webhookUrl:
            process.env.PLAID_WEBHOOK_URL ||
            null,

          additionalConsentedProducts:
            consentProducts,
        });

      return res.json({
        status: 'ok',

        mode:
          consentProducts.length >
          0
            ? 'additional_consent'
            : 'update',

        products:
          consentProducts,

        link_token:
          response.link_token,

        expiration:
          response.expiration,

        request_id:
          response.request_id,
      });
    } catch (err) {
      console.error(
        'Plaid update link token failed:',
        err,
      );

      return res.status(500).json({
        status: 'error',

        message:
          'Unable to prepare the secure Plaid update connection.',

        code:
          err.code || null,

        detail:
          process.env.NODE_ENV ===
          'production'
            ? undefined
            : err.message,

        request_id:
          err.requestId || null,
      });
    }
  },
);

/*
 * --------------------------------------------------------------------------
 * PLAID - EXCHANGE PUBLIC TOKEN
 * --------------------------------------------------------------------------
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
        await plaidClient.itemPublicTokenExchange(
          {
            public_token,
          },
        );

      const access_token =
        exchangeRes.data
          .access_token;

      const plaid_item_id =
        exchangeRes.data.item_id;

      const userId =
        req.user.id;

      const encryptedToken =
        encrypt(access_token);

      /*
       * Prevent accidental duplicate storage
       * of the same Plaid Item for the same user.
       */
      const existingItem =
        await pool.query(
          `
            SELECT
              id
            FROM plaid_items
            WHERE plaid_item_id = $1
              AND user_id = $2
            LIMIT 1
          `,
          [
            plaid_item_id,
            userId,
          ],
        );

      let plaidItemDbId;

      if (
        existingItem.rows.length >
        0
      ) {
        const updatedItem =
          await pool.query(
            `
              UPDATE plaid_items
              SET
                plaid_access_token_encrypted = $1,
                institution_name =
                  COALESCE(
                    $2,
                    institution_name
                  ),
                status = 'active',
                updated_at = now()
              WHERE id = $3
              RETURNING id
            `,
            [
              encryptedToken,
              institution_name ||
                null,
              existingItem
                .rows[0].id,
            ],
          );

        plaidItemDbId =
          updatedItem.rows[0].id;
      } else {
        const itemInsert =
          await pool.query(
            `
              INSERT INTO plaid_items
              (
                user_id,
                plaid_item_id,
                plaid_access_token_encrypted,
                institution_name,
                status
              )
              VALUES
              ($1, $2, $3, $4, 'active')
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

        plaidItemDbId =
          itemInsert.rows[0].id;
      }

      /*
       * Retrieve authoritative account state
       * from Plaid.
       */
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

      /*
       * Immediately synchronize the authoritative
       * transaction delta.
       */
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
            [plaidItemDbId],
          );

        if (
          freshItem.rows.length >
          0
        ) {
          immediateSyncResult =
            await syncOneItem(
              freshItem.rows[0],
            );
        }
      } catch (syncErr) {
        /*
         * The Item itself remains stored even if
         * the immediate transaction synchronization
         * has a temporary failure.
         */
        console.error(
          'Immediate post-link sync failed:',
          syncErr,
        );
      }

      return res.json({
        status: 'ok',

        plaid_item_id,

        accounts_stored:
          accountsRes.data
            .accounts.length,

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

        message:
          'Unable to complete the secure financial connection.',

        code:
          err.code || null,

        detail:
          process.env.NODE_ENV ===
          'production'
            ? undefined
            : err.message,

        request_id:
          err.requestId || null,
      });
    }
  },
);

/*
 * --------------------------------------------------------------------------
 * PLAID - RESYNC AFTER UPDATE
 * --------------------------------------------------------------------------
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
              AND status = 'active'
            LIMIT 1
          `,
          [
            plaid_item_id,
            req.user.id,
          ],
        );

      if (
        itemRow.rows.length ===
        0
      ) {
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
        message:
          'Unable to synchronize the financial connection.',
        code:
          err.code || null,
        request_id:
          err.requestId || null,
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
    `iBag API listening on port ${PORT}`,
  );
});
