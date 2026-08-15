require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const pool = require('./db');

const {
  plaidClient,
  PLAID_REQUIRED_PRODUCTS,
  PLAID_OPTIONAL_PRODUCTS,
  PLAID_SPECIALIZED_PRODUCTS,
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
 * PLAID PRODUCT ORCHESTRATION
 * --------------------------------------------------------------------------
 *
 * iBag deliberately separates:
 *
 * 1. Products that must exist immediately.
 * 2. Products that are useful but should not restrict Link.
 * 3. Products for which consent can be collected without immediate
 *    extraction/billing.
 * 4. Specialized products that require their own lifecycle.
 *
 * This is an orchestration policy, not a claim that any Item actually
 * supports every product.
 *
 * Actual product availability is always determined from Plaid.
 */

/*
 * Transactions is the foundational Phase 1 product.
 */
const INITIAL_REQUIRED_PRODUCTS = [
  ...PLAID_REQUIRED_PRODUCTS,
];

/*
 * Auth is useful to iBag when account-access intelligence requires it,
 * but it should not unnecessarily restrict institutions/account types.
 *
 * Identity is handled as required-if-supported because iBag's intelligence
 * architecture benefits from obtaining it where the connected institution
 * supports it.
 */
const INITIAL_OPTIONAL_PRODUCTS = [
  ...PLAID_OPTIONAL_PRODUCTS.filter(
    (product) =>
      product === 'auth',
  ),
];

/*
 * These products can be consented to without forcing immediate extraction.
 *
 * iBag can then activate the appropriate intelligence domain only when:
 *
 * - the Item supports the product,
 * - the user's connected accounts make the domain relevant,
 * - and the required Plaid authorization exists.
 *
 * This is especially important for Investments and Liabilities.
 */
const INITIAL_ADDITIONAL_CONSENTED_PRODUCTS = [
  'liabilities',
  'investments',
  'statements',
];

/*
 * Assets has a specialized lifecycle and is deliberately not initialized
 * as a normal Phase 1 product.
 *
 * It can be added through the appropriate update-mode flow when iBag has
 * sufficient evidence/reason to request an Asset Report.
 */
const SPECIALIZED_PRODUCTS =
  PLAID_SPECIALIZED_PRODUCTS.filter(
    (product) =>
      product === 'assets',
  );

/*
 * Identity is intentionally represented separately from optional products.
 *
 * Plaid's Required If Supported mechanism allows iBag to request Identity
 * where supported without filtering out institutions that cannot provide it.
 */
const REQUIRED_IF_SUPPORTED_PRODUCTS = [
  'identity',
];

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
 * PLAID INITIAL LINK
 * --------------------------------------------------------------------------
 *
 * The initial Link session is intentionally optimized for iBag's primary
 * intelligence foundation.
 *
 * products:
 *   Transactions — required.
 *
 * optional_products:
 *   Auth — useful but must not unnecessarily restrict Link.
 *
 * required_if_supported_products:
 *   Identity — obtain it where supported without eliminating unsupported
 *   institutions.
 *
 * additional_consented_products:
 *   Liabilities, Investments, Statements — collect consent without
 *   unnecessarily initializing all of them immediately.
 *
 * IMPORTANT:
 *
 * iBag never assumes that inclusion in one of these arrays means the
 * product is actually available on the resulting Item.
 *
 * The Item must be inspected through Plaid.
 */

app.post(
  '/plaid/create-link-token',
  requireAuth,
  async (req, res) => {
    try {
      const activeCount =
        await pool.query(
          `
            SELECT count(*)
            FROM plaid_items
            WHERE user_id = $1
              AND status = 'active'
          `,
          [req.user.id],
        );

      /*
       * Capacity is per user, not global.
       *
       * This prevents one user's Items from consuming another user's
       * connection capacity.
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
            'iBag is at the connection limit for this account right now.',
        });
      }

      const request = {
        user: {
          client_user_id:
            String(req.user.id),
        },

        client_name: 'iBag',

        products:
          INITIAL_REQUIRED_PRODUCTS,

        optional_products:
          INITIAL_OPTIONAL_PRODUCTS,

        required_if_supported_products:
          REQUIRED_IF_SUPPORTED_PRODUCTS,

        additional_consented_products:
          INITIAL_ADDITIONAL_CONSENTED_PRODUCTS,

        country_codes: ['US'],

        language: 'en',
      };

      console.log(
        'Creating iBag Plaid Link token',
        {
          user_id:
            String(req.user.id),

          products:
            request.products,

          optional_products:
            request.optional_products,

          required_if_supported_products:
            request.required_if_supported_products,

          additional_consented_products:
            request.additional_consented_products,
        },
      );

      const response =
        await plaidClient.linkTokenCreate(
          request,
        );

      return res.json({
        status: 'ok',

        link_token:
          response.data.link_token,

        expiration:
          response.data.expiration,

        request_id:
          response.data.request_id,

        product_configuration: {
          required:
            INITIAL_REQUIRED_PRODUCTS,

          optional:
            INITIAL_OPTIONAL_PRODUCTS,

          required_if_supported:
            REQUIRED_IF_SUPPORTED_PRODUCTS,

          additional_consented:
            INITIAL_ADDITIONAL_CONSENTED_PRODUCTS,

          specialized:
            SPECIALIZED_PRODUCTS,

          balance:
            'automatic through accountsBalanceGet',
        },
      });
    } catch (err) {
      console.error(
        'Plaid create link token failed:',
        err,
      );

      const detail =
        err.response?.data ||
        err.message;

      return res.status(
        err.response?.status || 500,
      ).json({
        status: 'error',
        detail,
      });
    }
  },
);

/*
 * --------------------------------------------------------------------------
 * PLAID UPDATE MODE
 * --------------------------------------------------------------------------
 *
 * Existing Item product consent.
 *
 * The caller supplies a list of desired products.
 *
 * iBag validates the requested products against its supported orchestration
 * boundary before sending anything to Plaid.
 *
 * No product is treated as available merely because it was requested.
 */

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

      const itemRow =
        await pool.query(
          `
            SELECT
              id,
              plaid_item_id,
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

      /*
       * Default update-mode consent set.
       *
       * These products can be requested later without forcing every
       * intelligence domain onto every user.
       */
      const requestedProducts =
        Array.isArray(products) &&
        products.length > 0
          ? products
          : [
              'liabilities',
              'investments',
              'statements',
            ];

      const allowedProducts =
        new Set([
          'auth',
          'identity',
          'liabilities',
          'investments',
          'statements',
          'signal',
        ]);

      const invalidProducts =
        requestedProducts.filter(
          (product) =>
            !allowedProducts.has(
              product,
            ),
        );

      if (
        invalidProducts.length > 0
      ) {
        return res.status(400).json({
          status: 'error',
          message:
            'One or more requested products are not supported by this iBag update flow.',
          invalid_products:
            invalidProducts,
        });
      }

      /*
       * Update mode for additional consent uses
       * additional_consented_products.
       *
       * This deliberately does NOT put ordinary consented products into
       * products, because that would change the lifecycle semantics.
       */
      const request = {
        user: {
          client_user_id:
            String(req.user.id),
        },

        client_name: 'iBag',

        access_token:
          accessToken,

        additional_consented_products:
          requestedProducts,

        country_codes: ['US'],

        language: 'en',
      };

      const response =
        await plaidClient.linkTokenCreate(
          request,
        );

      return res.json({
        status: 'ok',

        link_token:
          response.data.link_token,

        expiration:
          response.data.expiration,

        request_id:
          response.data.request_id,

        requested_products:
          requestedProducts,
      });
    } catch (err) {
      console.error(
        'Plaid update link token failed:',
        err,
      );

      const detail =
        err.response?.data ||
        err.message;

      return res.status(
        err.response?.status || 500,
      ).json({
        status: 'error',
        detail,
      });
    }
  },
);

/*
 * --------------------------------------------------------------------------
 * PLAID ASSET REPORT UPDATE FLOW
 * --------------------------------------------------------------------------
 *
 * Assets has a specialized lifecycle.
 *
 * This endpoint explicitly creates an update-mode Link token for Assets.
 *
 * No Asset Report is fabricated or assumed to exist.
 */

app.post(
  '/plaid/create-assets-update-link-token',
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

      const response =
        await plaidClient.linkTokenCreate({
          user: {
            client_user_id:
              String(req.user.id),
          },

          client_name: 'iBag',

          access_token:
            accessToken,

          products: [
            'assets',
          ],

          country_codes: ['US'],

          language: 'en',
        });

      return res.json({
        status: 'ok',

        link_token:
          response.data.link_token,

        expiration:
          response.data.expiration,

        request_id:
          response.data.request_id,

        product: 'assets',
      });
    } catch (err) {
      console.error(
        'Plaid Assets update Link token failed:',
        err,
      );

      const detail =
        err.response?.data ||
        err.message;

      return res.status(
        err.response?.status || 500,
      ).json({
        status: 'error',
        detail,
      });
    }
  },
);

/*
 * --------------------------------------------------------------------------
 * PLAID STATEMENTS UPDATE FLOW
 * --------------------------------------------------------------------------
 *
 * Statements also has a specialized update-mode lifecycle.
 */

app.post(
  '/plaid/create-statements-update-link-token',
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

      const request = {
        user: {
          client_user_id:
            String(req.user.id),
        },

        client_name: 'iBag',

        access_token:
          accessToken,

        products: [
          'statements',
        ],

        country_codes: ['US'],

        language: 'en',
      };

      const response =
        await plaidClient.linkTokenCreate(
          request,
        );

      return res.json({
        status: 'ok',

        link_token:
          response.data.link_token,

        expiration:
          response.data.expiration,

        request_id:
          response.data.request_id,

        product: 'statements',
      });
    } catch (err) {
      console.error(
        'Plaid Statements update Link token failed:',
        err,
      );

      const detail =
        err.response?.data ||
        err.message;

      return res.status(
        err.response?.status || 500,
      ).json({
        status: 'error',
        detail,
      });
    }
  },
);

/*
 * --------------------------------------------------------------------------
 * PLAID PUBLIC TOKEN EXCHANGE
 * --------------------------------------------------------------------------
 */

app.post(
  '/plaid/exchange-public-token',
  requireAuth,
  async (req, res) => {
    const client =
      await pool.connect();

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

      const accessToken =
        exchangeRes.data
          .access_token;

      const plaidItemId =
        exchangeRes.data.item_id;

      const userId =
        req.user.id;

      const encryptedToken =
        encrypt(accessToken);

      /*
       * Prevent accidental duplicate ownership records.
       *
       * The unique constraint at the database level should remain the
       * ultimate enforcement mechanism.
       */
      const existingItem =
        await client.query(
          `
            SELECT
              id,
              user_id
            FROM plaid_items
            WHERE plaid_item_id = $1
            LIMIT 1
          `,
          [plaidItemId],
        );

      if (
        existingItem.rows.length > 0
      ) {
        if (
          String(
            existingItem.rows[0]
              .user_id,
          ) !== String(userId)
        ) {
          return res.status(409).json({
            status: 'error',
            message:
              'This Plaid Item is already associated with another user.',
          });
        }

        return res.status(409).json({
          status: 'error',
          message:
            'This financial connection is already connected to your iBag.',
          plaid_item_id:
            plaidItemId,
        });
      }

      await client.query(
        'BEGIN',
      );

      const itemInsert =
        await client.query(
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
            plaidItemId,
            encryptedToken,
            institution_name ||
              null,
          ],
        );

      const plaidItemDbId =
        itemInsert.rows[0].id;

      /*
       * Accounts are sourced directly from Plaid.
       *
       * No account metadata is invented.
       */
      const accountsRes =
        await plaidClient.accountsGet({
          access_token:
            accessToken,
        });

      for (
        const acct of
        accountsRes.data.accounts
      ) {
        await client.query(
          `
            INSERT INTO accounts
            (
              plaid_item_id,
              plaid_account_id,
              name,
              official_name,
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
              $10,
              now()
            )
            ON CONFLICT
              (plaid_account_id)
            DO UPDATE SET
              plaid_item_id =
                EXCLUDED.plaid_item_id,

              name =
                EXCLUDED.name,

              official_name =
                EXCLUDED.official_name,

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

            acct.name ||
              null,

            acct.official_name ||
              null,

            acct.type ||
              null,

            acct.subtype ||
              null,

            acct.mask ||
              null,

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

      await client.query(
        'COMMIT',
      );

      let immediateSyncResult =
        null;

      /*
       * Transaction synchronization happens after the Item and accounts
       * have been committed.
       *
       * This avoids creating a sync that references uncommitted state.
       */
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
                AND user_id = $2
                AND status = 'active'
            `,
            [
              plaidItemDbId,
              userId,
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
        /*
         * The connection itself remains valid.
         *
         * Sync failure is surfaced as data-state failure rather than
         * pretending the transaction data exists.
         */
        console.error(
          'Immediate post-link sync failed:',
          syncErr,
        );
      }

      return res.json({
        status: 'ok',

        plaid_item_id:
          plaidItemId,

        accounts_stored:
          accountsRes.data.accounts
            .length,

        immediate_sync:
          immediateSyncResult,
      });
    } catch (err) {
      try {
        await client.query(
          'ROLLBACK',
        );
      } catch (
        rollbackError
      ) {
        console.error(
          'Plaid exchange rollback failed:',
          rollbackError,
        );
      }

      console.error(
        'Plaid public token exchange failed:',
        err,
      );

      const detail =
        err.response?.data ||
        err.message;

      return res.status(
        err.response?.status || 500,
      ).json({
        status: 'error',
        detail,
      });
    } finally {
      client.release();
    }
  },
);

/*
 * --------------------------------------------------------------------------
 * RESYNC AFTER UPDATE MODE
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
          itemRow.rows[0],
        );

      return res.json({
        status:
          result.error
            ? 'partial'
            : 'ok',

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

app.use(
  (req, res) => {
    res.status(404).json({
      status: 'error',
      message: 'Not found',
    });
  },
);

/*
 * --------------------------------------------------------------------------
 * GLOBAL ERROR HANDLER
 * --------------------------------------------------------------------------
 */

app.use(
  (
    err,
    req,
    res,
    next,
  ) => {
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

app.listen(
  PORT,
  () => {
    console.log(
      `iBag API listening on port ${PORT}`,
    );

    console.log(
      'Plaid product configuration:',
      {
        required:
          INITIAL_REQUIRED_PRODUCTS,

        optional:
          INITIAL_OPTIONAL_PRODUCTS,

        required_if_supported:
          REQUIRED_IF_SUPPORTED_PRODUCTS,

        additional_consented:
          INITIAL_ADDITIONAL_CONSENTED_PRODUCTS,

        specialized:
          SPECIALIZED_PRODUCTS,
      },
    );
  },
);
