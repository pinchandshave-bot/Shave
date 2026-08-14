require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit =
  require('express-rate-limit');

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
  plaidWebhook,
} = require('./plaidWebhook');

const me =
  require('./me');

const {
  getFinancialIntelligence,
} = require('./intelligence');


/*
 * --------------------------------------------------------------------------
 * STARTUP
 * --------------------------------------------------------------------------
 */

console.log(
  'Booting iBag API...'
);

console.log(
  'Running file:',
  __filename
);

console.log(
  'NODE_ENV:',
  process.env.NODE_ENV
);

console.log(
  'PORT (env):',
  process.env.PORT
);


/*
 * --------------------------------------------------------------------------
 * REQUIRED HANDLERS
 * --------------------------------------------------------------------------
 */

const requiredHandlers = {
  requireAuth,
  requireInternalSecret,
  signup,
  login,
  runSync,
  syncOneItem,
  plaidWebhook,

  getDashboard:
    me.getDashboard,

  getFinancialIntelligence,
};


for (
  const [
    name,
    handler,
  ] of Object.entries(
    requiredHandlers
  )
) {
  if (
    typeof handler !==
    'function'
  ) {
    throw new Error(
      'Startup configuration error: "' +
        name +
        '" is not exported as a function.'
    );
  }
}


/*
 * --------------------------------------------------------------------------
 * OPTIONAL READ HANDLERS
 * --------------------------------------------------------------------------
 */

const optionalHandlers = {
  getMe:
    me.getMe,

  getSummary:
    me.getSummary,

  getAccounts:
    me.getAccounts,

  getTransactions:
    me.getTransactions,

  getRoundups:
    me.getRoundups,

  getInsights:
    me.getInsights,

  getNetWorth:
    me.getNetWorth,

  getIncome:
    me.getIncome,

  getCashFlow:
    me.getCashFlow,
};


for (
  const [
    name,
    handler,
  ] of Object.entries(
    optionalHandlers
  )
) {
  console.log(
    name + ':',
    typeof handler ===
      'function'
      ? 'available'
      : 'not exported'
  );
}


/*
 * --------------------------------------------------------------------------
 * EXPRESS APP
 * --------------------------------------------------------------------------
 */

const app =
  express();


/*
 * --------------------------------------------------------------------------
 * TRUST PROXY
 * --------------------------------------------------------------------------
 *
 * iBag is deployed behind Render's reverse proxy.
 *
 * Render forwards the original client address through
 * X-Forwarded-For. Express must therefore trust the first
 * proxy hop so middleware such as express-rate-limit can
 * correctly determine the originating client.
 *
 * This MUST be configured before rate-limit middleware is
 * created/used.
 * --------------------------------------------------------------------------
 */

app.set(
  'trust proxy',
  1
);


/*
 * --------------------------------------------------------------------------
 * CORS
 * --------------------------------------------------------------------------
 */

app.use(
  cors({
    origin:
      process.env
        .FRONTEND_ORIGIN ||
      'https://shave.onrender.com',
  })
);


/*
 * --------------------------------------------------------------------------
 * JSON BODY PARSER
 * --------------------------------------------------------------------------
 *
 * Plaid webhook verification requires the exact raw request body.
 *
 * Capture the raw body before Express transforms it into an object.
 */
app.use(
  express.json({
    verify: (
      req,
      res,
      buffer
    ) => {
      if (
        req.path ===
        '/plaid/webhook'
      ) {
        req.rawBody =
          Buffer.from(
            buffer
          );
      }
    },
  })
);


/*
 * --------------------------------------------------------------------------
 * STATIC FRONTEND
 * --------------------------------------------------------------------------
 */

app.use(
  express.static(
    'public'
  )
);


/*
 * --------------------------------------------------------------------------
 * AUTH RATE LIMITER
 * --------------------------------------------------------------------------
 */

const authLimiter =
  rateLimit({
    windowMs:
      15 * 60 * 1000,

    max: 8,

    standardHeaders:
      true,

    legacyHeaders:
      false,

    message: {
      status: 'error',

      message:
        'Too many attempts. Try again later.',
    },
  });


/*
 * --------------------------------------------------------------------------
 * OPTIONAL GET REGISTRATION
 * --------------------------------------------------------------------------
 */

function registerOptionalGet(
  path,
  handler
) {
  if (
    typeof handler ===
    'function'
  ) {
    app.get(
      path,
      requireAuth,
      handler
    );

    return;
  }

  app.get(
    path,
    requireAuth,
    (
      req,
      res
    ) => {
      res.status(501).json({
        status: 'error',

        message:
          'The endpoint ' +
          path +
          ' is not implemented by the current API read module.',
      });
    }
  );
}


/*
 * --------------------------------------------------------------------------
 * SERVICE
 * --------------------------------------------------------------------------
 */

app.get(
  '/',
  (
    req,
    res
  ) => {
    res.json({
      status: 'ok',

      service:
        'ibag-api',

      message:
        'iBag financial intelligence API is running',
    });
  }
);


app.get(
  '/health',
  (
    req,
    res
  ) => {
    res.json({
      status: 'ok',

      service:
        'ibag-api',

      time:
        new Date()
          .toISOString(),
    });
  }
);


app.get(
  '/db-check',
  async (
    req,
    res
  ) => {
    try {
      const result =
        await pool.query(
          `
            SELECT
              now()
                AS db_time,
              count(*)
                AS user_count
            FROM users
          `
        );

      return res.json({
        status: 'ok',

        db_time:
          result.rows[0]
            .db_time,

        user_count:
          result.rows[0]
            .user_count,
      });

    } catch (err) {
      console.error(
        'Database check failed:',
        err
      );

      return res.status(500).json({
        status: 'error',

        message:
          err.message,
      });
    }
  }
);


/*
 * --------------------------------------------------------------------------
 * PLAID WEBHOOK
 * --------------------------------------------------------------------------
 */

app.post(
  '/plaid/webhook',
  plaidWebhook
);


/*
 * --------------------------------------------------------------------------
 * AUTH
 * --------------------------------------------------------------------------
 */

app.post(
  '/auth/signup',
  authLimiter,
  signup
);


app.post(
  '/auth/login',
  authLimiter,
  login
);


/*
 * --------------------------------------------------------------------------
 * USER / INTELLIGENCE
 * --------------------------------------------------------------------------
 */

registerOptionalGet(
  '/me',
  optionalHandlers.getMe
);


app.get(
  '/me/dashboard',
  requireAuth,
  me.getDashboard
);


app.get(
  '/me/intelligence',
  requireAuth,
  async (
    req,
    res
  ) => {
    try {
      const result =
        await getFinancialIntelligence(
          req.user.id
        );

      return res.json({
        status: 'ok',

        intelligence:
          result,
      });

    } catch (err) {
      console.error(
        'Financial intelligence failed:',
        err
      );

      return res.status(500).json({
        status: 'error',

        message:
          'Unable to calculate financial intelligence',
      });
    }
  }
);


registerOptionalGet(
  '/me/summary',
  optionalHandlers.getSummary
);

registerOptionalGet(
  '/me/accounts',
  optionalHandlers.getAccounts
);

registerOptionalGet(
  '/me/transactions',
  optionalHandlers.getTransactions
);

registerOptionalGet(
  '/me/roundups',
  optionalHandlers.getRoundups
);

registerOptionalGet(
  '/me/insights',
  optionalHandlers.getInsights
);

registerOptionalGet(
  '/me/net-worth',
  optionalHandlers.getNetWorth
);

registerOptionalGet(
  '/me/income',
  optionalHandlers.getIncome
);

registerOptionalGet(
  '/me/cash-flow',
  optionalHandlers.getCashFlow
);


/*
 * --------------------------------------------------------------------------
 * PLAID LINK TOKEN
 * --------------------------------------------------------------------------
 */

app.post(
  '/plaid/create-link-token',
  requireAuth,
  async (
    req,
    res
  ) => {
    try {

      const activeCount =
        await pool.query(
          `
            SELECT
              count(*)
            FROM plaid_items
            WHERE status = 'active'
          `
        );


      const CAPACITY_LIMIT =
        9;


      if (
        Number(
          activeCount
            .rows[0]
            .count
        ) >=
        CAPACITY_LIMIT
      ) {
        return res.status(503).json({
          status: 'error',

          message:
            'iBag is at capacity for new bank connections right now. Try again soon.',
        });
      }


      const webhookUrl =
        process.env
          .PLAID_WEBHOOK_URL;


      if (!webhookUrl) {
        throw new Error(
          'PLAID_WEBHOOK_URL is not configured'
        );
      }


      if (
        !/^https?:\/\/.+/.test(
          webhookUrl
        )
      ) {
        throw new Error(
          'PLAID_WEBHOOK_URL must be a valid HTTP or HTTPS URL'
        );
      }


      const response =
        await plaidClient
          .linkTokenCreate({
            user: {
              client_user_id:
                String(
                  req.user.id
                ),
            },

            client_name:
              'iBag',

            products:
              PLAID_PRODUCTS,

            country_codes:
              ['US'],

            language:
              'en',

            webhook:
              webhookUrl,
          });


      const linkToken =
        response?.data
          ?.link_token;


      if (!linkToken) {
        throw new Error(
          'Plaid did not return a link_token'
        );
      }


      return res.json({
        status: 'ok',

        link_token:
          linkToken,

        expiration:
          response.data
            .expiration,
      });

    } catch (err) {
      console.error(
        'Plaid create link token failed:',
        err
      );

      return res.status(502).json({
        status: 'error',

        message:
          'Unable to create a Plaid Link session.',

        detail:
          process.env.NODE_ENV ===
          'production'
            ? undefined
            : (
                err.response
                  ?.data ||
                err.message
              ),
      });
    }
  }
);


/*
 * --------------------------------------------------------------------------
 * PLAID UPDATE LINK TOKEN
 * --------------------------------------------------------------------------
 */

app.post(
  '/plaid/create-update-link-token',
  requireAuth,
  async (
    req,
    res
  ) => {
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
          ]
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
            .plaid_access_token_encrypted
        );


      const response =
        await plaidClient
          .linkTokenCreate({
            user: {
              client_user_id:
                String(
                  req.user.id
                ),
            },

            client_name:
              'iBag',

            access_token:
              accessToken,

            additional_consented_products:
              [
                'liabilities',
                'investments',
                'identity',
              ],

            country_codes:
              ['US'],

            language:
              'en',
          });


      return res.json({
        status: 'ok',

        link_token:
          response.data
            .link_token,

        expiration:
          response.data
            .expiration,
      });

    } catch (err) {
      console.error(
        'Plaid update link token failed:',
        err
      );

      return res.status(502).json({
        status: 'error',

        message:
          'Unable to create a Plaid update Link session.',

        detail:
          process.env.NODE_ENV ===
          'production'
            ? undefined
            : (
                err.response
                  ?.data ||
                err.message
              ),
      });
    }
  }
);


/*
 * --------------------------------------------------------------------------
 * PLAID PUBLIC TOKEN EXCHANGE
 * --------------------------------------------------------------------------
 */

app.post(
  '/plaid/exchange-public-token',
  requireAuth,
  async (
    req,
    res
  ) => {
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
        await plaidClient
          .itemPublicTokenExchange({
            public_token,
          });


      const access_token =
        exchangeRes.data
          .access_token;


      const plaid_item_id =
        exchangeRes.data
          .item_id;


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
            req.user.id,
            plaid_item_id,
            encryptedToken,
            institution_name ||
              null,
          ]
        );


      const plaidItemDbId =
        itemInsert.rows[0]
          .id;


      const accountsRes =
        await plaidClient
          .accountsGet({
            access_token,
          });


      for (
        const acct of
          accountsRes.data
            .accounts
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
            ON CONFLICT (
              plaid_account_id
            )
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

            acct.balances?.current ??
              null,

            acct.balances?.available ??
              null,

            acct.balances
              ?.iso_currency_code ||
              'USD',
          ]
        );
      }


      /*
       * Immediately synchronize the newly connected Item.
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
            [plaidItemDbId]
          );


        if (
          freshItem.rows.length >
          0
        ) {
          immediateSyncResult =
            await syncOneItem(
              freshItem.rows[0]
            );
        }

      } catch (
        syncErr
      ) {

        console.error(
          'Immediate post-link sync failed:',
          syncErr
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
        err
      );

      return res.status(502).json({
        status: 'error',

        message:
          'Unable to complete the Plaid Item connection.',

        detail:
          process.env.NODE_ENV ===
          'production'
            ? undefined
            : (
                err.response
                  ?.data ||
                err.message
              ),
      });
    }
  }
);


/*
 * --------------------------------------------------------------------------
 * RESYNC AFTER PLAID UPDATE
 * --------------------------------------------------------------------------
 */

app.post(
  '/plaid/resync-after-update',
  requireAuth,
  async (
    req,
    res
  ) => {
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
          ]
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
          itemRow.rows[0]
        );


      return res.json({
        status: 'ok',

        result,
      });

    } catch (err) {

      console.error(
        'Plaid resync failed:',
        err
      );

      return res.status(500).json({
        status: 'error',

        message:
          err.message,
      });
    }
  }
);


/*
 * --------------------------------------------------------------------------
 * INTERNAL SYNC
 * --------------------------------------------------------------------------
 */

app.post(
  '/internal/sync/run',
  requireInternalSecret,
  runSync
);


/*
 * --------------------------------------------------------------------------
 * 404
 * --------------------------------------------------------------------------
 */

app.use(
  (
    req,
    res
  ) => {
    res.status(404).json({
      status: 'error',

      message:
        'Not found',
    });
  }
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
    next
  ) => {

    console.error(
      'Unhandled error:',
      err
    );

    res.status(500).json({
      status: 'error',

      message:
        'Internal server error',
    });
  }
);


/*
 * --------------------------------------------------------------------------
 * SERVER
 * --------------------------------------------------------------------------
 */

const PORT =
  process.env.PORT ||
  3000;


app.listen(
  PORT,
  () => {
    console.log(
      `iBag API listening on port ${PORT}`
    );

    console.log(
      'Express trust proxy:',
      app.get('trust proxy')
    );
  }
);
