require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit =
  require("express-rate-limit");

const pool = require("./db");

const {
  createLinkToken,
  createUpdateModeLinkToken,
  createAdditionalConsentLinkToken,
  createSpecializedProductLinkToken,
  normalizePlaidError,
  plaidClient,
} = require("./plaidClient");

const {
  encrypt,
  decrypt,
} = require("./crypto");

const {
  requireAuth,
  requireInternalSecret,
  signup,
  login,
} = require("./auth");

const {
  runSync,
  syncOneItem,
} = require("./sync");

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
} = require("./me");

const app =
  express();


/* ============================================================================
 * PROXY
 * ========================================================================== */

app.set(
  "trust proxy",
  1
);


/* ============================================================================
 * CORS
 * ========================================================================== */

app.use(
  cors({
    origin:
      process.env.FRONTEND_ORIGIN ||
      "https://shave.onrender.com",
  })
);

app.use(
  express.json({
    limit: "1mb",
  })
);

app.use(
  express.static("public")
);


/* ============================================================================
 * RATE LIMITING
 * ========================================================================== */

const authLimiter =
  rateLimit({
    windowMs:
      15 * 60 * 1000,

    max:
      8,

    standardHeaders:
      true,

    legacyHeaders:
      false,

    message: {
      status:
        "error",

      message:
        "Too many attempts. Try again later.",
    },
  });


/* ============================================================================
 * HEALTH
 * ========================================================================== */

app.get(
  "/",
  (req, res) => {
    return res.json({
      status:
        "ok",

      service:
        "ibag-api",

      message:
        "iBag API is running",
    });
  }
);


app.get(
  "/health",
  (req, res) => {
    return res.json({
      status:
        "ok",

      service:
        "ibag-api",

      time:
        new Date().toISOString(),
    });
  }
);


app.get(
  "/db-check",
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
            SELECT
              now() AS db_time,
              count(*) AS user_count
            FROM users
          `
        );

      return res.json({
        status:
          "ok",

        db_time:
          result.rows[0]
            .db_time,

        user_count:
          result.rows[0]
            .user_count,
      });
    } catch (err) {
      console.error(
        "Database check failed:",
        err
      );

      return res.status(500).json({
        status:
          "error",

        message:
          err.message,
      });
    }
  }
);


/* ============================================================================
 * AUTHENTICATION
 * ========================================================================== */

app.post(
  "/auth/signup",
  authLimiter,
  signup
);

app.post(
  "/auth/login",
  authLimiter,
  login
);


/* ============================================================================
 * USER / DASHBOARD
 * ========================================================================== */

app.get(
  "/me",
  requireAuth,
  getMe
);

app.get(
  "/me/dashboard",
  requireAuth,
  getDashboard
);

app.get(
  "/me/summary",
  requireAuth,
  getSummary
);

app.get(
  "/me/accounts",
  requireAuth,
  getAccounts
);

app.get(
  "/me/transactions",
  requireAuth,
  getTransactions
);

app.get(
  "/me/roundups",
  requireAuth,
  getRoundups
);

app.get(
  "/me/insights",
  requireAuth,
  getInsights
);

app.get(
  "/me/net-worth",
  requireAuth,
  getNetWorth
);

app.get(
  "/me/income",
  requireAuth,
  getIncome
);

app.get(
  "/me/cash-flow",
  requireAuth,
  getCashFlow
);


/* ============================================================================
 * PLAID — INITIAL LINK
 * ========================================================================== */

app.post(
  "/plaid/create-link-token",
  requireAuth,
  async (req, res) => {
    try {
      /*
       * Capacity applies to active Items only.
       *
       * The database is authoritative.
       */
      const activeCount =
        await pool.query(
          `
            SELECT
              COUNT(*)::int AS count
            FROM plaid_items
            WHERE user_id = $1
              AND status = 'active'
          `,
          [
            req.user.id,
          ]
        );

      const CAPACITY_LIMIT =
        Number(
          process.env.PLAID_ITEM_CAPACITY_LIMIT ||
          25
        );

      if (
        Number(
          activeCount.rows[0].count
        ) >=
        CAPACITY_LIMIT
      ) {
        return res.status(503).json({
          status:
            "error",

          message:
            "iBag is temporarily unable to add another financial connection.",
        });
      }

      const result =
        await createLinkToken({
          userId:
            req.user.id,
        });

      return res.json({
        status:
          "ok",

        link_token:
          result.link_token,

        expiration:
          result.expiration,

        request_id:
          result.request_id,
      });
    } catch (err) {
      console.error(
        "Plaid create link token failed:",
        err
      );

      const normalized =
        err?.code
          ? err
          : normalizePlaidError(
              err,
              "PLAID_LINK_TOKEN_CREATE_FAILED"
            );

      return res.status(
        normalized.status >= 400 &&
          normalized.status < 600
          ? normalized.status
          : 500
      ).json({
        status:
          "error",

        code:
          normalized.code,

        message:
          normalized.message,

        display_message:
          normalized.displayMessage ||
          null,

        request_id:
          normalized.requestId ||
          null,
      });
    }
  }
);


/* ============================================================================
 * PLAID — STANDARD UPDATE MODE
 * ========================================================================== */

app.post(
  "/plaid/create-update-link-token",
  requireAuth,
  async (req, res) => {
    try {
      const {
        plaid_item_id,
        account_selection_enabled,
      } =
        req.body || {};

      if (!plaid_item_id) {
        return res.status(400).json({
          status:
            "error",

          message:
            "plaid_item_id is required",
        });
      }

      const itemResult =
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
          ]
        );

      if (
        itemResult.rows.length === 0
      ) {
        return res.status(404).json({
          status:
            "error",

          message:
            "Active Plaid Item not found for this user",
        });
      }

      const accessToken =
        decrypt(
          itemResult.rows[0]
            .plaid_access_token_encrypted
        );

      const result =
        await createUpdateModeLinkToken({
          userId:
            req.user.id,

          accessToken,

          accountSelectionEnabled:
            account_selection_enabled ===
            true,
        });

      return res.json({
        status:
          "ok",

        link_token:
          result.link_token,

        expiration:
          result.expiration,

        request_id:
          result.request_id,
      });
    } catch (err) {
      console.error(
        "Plaid update Link token failed:",
        err
      );

      const normalized =
        err?.code
          ? err
          : normalizePlaidError(
              err,
              "PLAID_UPDATE_MODE_LINK_TOKEN_CREATE_FAILED"
            );

      return res.status(
        normalized.status >= 400 &&
          normalized.status < 600
          ? normalized.status
          : 500
      ).json({
        status:
          "error",

        code:
          normalized.code,

        message:
          normalized.message,

        display_message:
          normalized.displayMessage ||
          null,

        request_id:
          normalized.requestId ||
          null,
      });
    }
  }
);


/* ============================================================================
 * PLAID — ADDITIONAL CONSENT
 * ========================================================================== */

app.post(
  "/plaid/create-additional-consent-link-token",
  requireAuth,
  async (req, res) => {
    try {
      const {
        plaid_item_id,
        products,
      } =
        req.body || {};

      if (!plaid_item_id) {
        return res.status(400).json({
          status:
            "error",

          message:
            "plaid_item_id is required",
        });
      }

      if (
        !Array.isArray(products) ||
        products.length === 0
      ) {
        return res.status(400).json({
          status:
            "error",

          message:
            "products must contain at least one requested product",
        });
      }

      const itemResult =
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
          ]
        );

      if (
        itemResult.rows.length === 0
      ) {
        return res.status(404).json({
          status:
            "error",

          message:
            "Active Plaid Item not found for this user",
        });
      }

      const accessToken =
        decrypt(
          itemResult.rows[0]
            .plaid_access_token_encrypted
        );

      const result =
        await createAdditionalConsentLinkToken({
          userId:
            req.user.id,

          accessToken,

          products,
        });

      return res.json({
        status:
          "ok",

        link_token:
          result.link_token,

        expiration:
          result.expiration,

        request_id:
          result.request_id,

        requested_products:
          result.requested_products,
      });
    } catch (err) {
      console.error(
        "Plaid additional consent Link token failed:",
        err
      );

      const normalized =
        err?.code
          ? err
          : normalizePlaidError(
              err,
              "PLAID_ADDITIONAL_CONSENT_LINK_TOKEN_CREATE_FAILED"
            );

      return res.status(
        normalized.status >= 400 &&
          normalized.status < 600
          ? normalized.status
          : 500
      ).json({
        status:
          "error",

        code:
          normalized.code,

        message:
          normalized.message,

        display_message:
          normalized.displayMessage ||
          null,

        request_id:
          normalized.requestId ||
          null,
      });
    }
  }
);


/* ============================================================================
 * PLAID — SPECIALIZED PRODUCT UPDATE
 * ========================================================================== */

app.post(
  "/plaid/create-specialized-product-link-token",
  requireAuth,
  async (req, res) => {
    try {
      const {
        plaid_item_id,
        product,
        product_configuration,
      } =
        req.body || {};

      if (!plaid_item_id) {
        return res.status(400).json({
          status:
            "error",

          message:
            "plaid_item_id is required",
        });
      }

      if (!product) {
        return res.status(400).json({
          status:
            "error",

          message:
            "product is required",
        });
      }

      const itemResult =
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
          ]
        );

      if (
        itemResult.rows.length === 0
      ) {
        return res.status(404).json({
          status:
            "error",

          message:
            "Active Plaid Item not found for this user",
        });
      }

      const accessToken =
        decrypt(
          itemResult.rows[0]
            .plaid_access_token_encrypted
        );

      const result =
        await createSpecializedProductLinkToken({
          userId:
            req.user.id,

          accessToken,

          product,

          productConfiguration:
            product_configuration ||
            null,
        });

      return res.json({
        status:
          "ok",

        link_token:
          result.link_token,

        expiration:
          result.expiration,

        request_id:
          result.request_id,

        product:
          result.product,
      });
    } catch (err) {
      console.error(
        "Plaid specialized product Link token failed:",
        err
      );

      const normalized =
        err?.code
          ? err
          : normalizePlaidError(
              err,
              "PLAID_SPECIALIZED_PRODUCT_LINK_TOKEN_CREATE_FAILED"
            );

      return res.status(
        normalized.status >= 400 &&
          normalized.status < 600
          ? normalized.status
          : 500
      ).json({
        status:
          "error",

        code:
          normalized.code,

        message:
          normalized.message,

        display_message:
          normalized.displayMessage ||
          null,

        request_id:
          normalized.requestId ||
          null,
      });
    }
  }
);


/* ============================================================================
 * PLAID — EXCHANGE PUBLIC TOKEN
 * ========================================================================== */

app.post(
  "/plaid/exchange-public-token",
  requireAuth,
  async (req, res) => {
    try {
      const {
        public_token,
        institution_name,
      } =
        req.body || {};

      if (!public_token) {
        return res.status(400).json({
          status:
            "error",

          message:
            "public_token is required",
        });
      }

      const exchangeRes =
        await plaidClient.itemPublicTokenExchange({
          public_token,
        });

      const accessToken =
        exchangeRes.data.access_token;

      const plaidItemId =
        exchangeRes.data.item_id;

      const userId =
        req.user.id;

      const encryptedToken =
        encrypt(
          accessToken
        );

      /*
       * Prevent accidental duplicate ownership of the same Item.
       */
      const existing =
        await pool.query(
          `
            SELECT
              id,
              user_id
            FROM plaid_items
            WHERE plaid_item_id = $1
            LIMIT 1
          `,
          [
            plaidItemId,
          ]
        );

      if (
        existing.rows.length > 0
      ) {
        if (
          existing.rows[0].user_id !==
          userId
        ) {
          return res.status(409).json({
            status:
              "error",

            message:
              "This Plaid Item is already associated with another iBag user.",
          });
        }

        return res.status(409).json({
          status:
            "error",

          message:
            "This Plaid Item is already connected to your iBag.",
        });
      }

      const itemInsert =
        await pool.query(
          `
            INSERT INTO plaid_items (
              user_id,
              plaid_item_id,
              plaid_access_token_encrypted,
              institution_name,
              status
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              'active'
            )
            RETURNING id
          `,
          [
            userId,
            plaidItemId,
            encryptedToken,
            institution_name ||
              null,
          ]
        );

      const plaidItemDbId =
        itemInsert.rows[0].id;

      const accountsRes =
        await plaidClient.accountsGet({
          access_token:
            accessToken,
        });

      for (
        const account
        of accountsRes.data.accounts
      ) {
        await pool.query(
          `
            INSERT INTO accounts (
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
            VALUES (
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
            account.account_id,
            account.name,
            account.type,
            account.subtype,
            account.mask,
            account.balances?.current ??
              null,
            account.balances?.available ??
              null,
            account.balances?.iso_currency_code ||
              "USD",
          ]
        );
      }

      /*
       * Immediately establish the initial transaction observation state.
       */
      let immediateSync =
        null;

      try {
        const itemResult =
          await pool.query(
            `
              SELECT
                id,
                plaid_item_id,
                plaid_access_token_encrypted,
                cursor
              FROM plaid_items
              WHERE id = $1
              LIMIT 1
            `,
            [
              plaidItemDbId,
            ]
          );

        if (
          itemResult.rows.length > 0
        ) {
          immediateSync =
            await syncOneItem(
              itemResult.rows[0]
            );
        }
      } catch (syncError) {
        console.error(
          "Immediate post-link sync failed:",
          syncError
        );

        /*
         * Connection itself remains valid.
         *
         * The synchronization failure is returned explicitly so the
         * frontend can distinguish connection from observation availability.
         */
        immediateSync = {
          status:
            "error",

          message:
            syncError.message,
        };
      }

      return res.json({
        status:
          "ok",

        plaid_item_id:
          plaidItemId,

        accounts_stored:
          accountsRes.data.accounts.length,

        immediate_sync:
          immediateSync,
      });
    } catch (err) {
      console.error(
        "Plaid public token exchange failed:",
        err
      );

      const normalized =
        err?.code
          ? err
          : normalizePlaidError(
              err,
              "PLAID_PUBLIC_TOKEN_EXCHANGE_FAILED"
            );

      return res.status(
        normalized.status >= 400 &&
          normalized.status < 600
          ? normalized.status
          : 500
      ).json({
        status:
          "error",

        code:
          normalized.code,

        message:
          normalized.message,

        display_message:
          normalized.displayMessage ||
          null,

        request_id:
          normalized.requestId ||
          null,
      });
    }
  }
);


/* ============================================================================
 * PLAID — RESYNC AFTER UPDATE
 * ========================================================================== */

app.post(
  "/plaid/resync-after-update",
  requireAuth,
  async (req, res) => {
    try {
      const {
        plaid_item_id,
      } =
        req.body || {};

      if (!plaid_item_id) {
        return res.status(400).json({
          status:
            "error",

          message:
            "plaid_item_id is required",
        });
      }

      const itemResult =
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
          ]
        );

      if (
        itemResult.rows.length === 0
      ) {
        return res.status(404).json({
          status:
            "error",

          message:
            "Active Plaid Item not found for this user",
        });
      }

      const result =
        await syncOneItem(
          itemResult.rows[0]
        );

      return res.json({
        status:
          result.error
            ? "partial"
            : "ok",

        result,
      });
    } catch (err) {
      console.error(
        "Plaid resync failed:",
        err
      );

      return res.status(500).json({
        status:
          "error",

        message:
          err.message,
      });
    }
  }
);


/* ============================================================================
 * INTERNAL SYNCHRONIZATION
 * ========================================================================== */

app.post(
  "/internal/sync/run",
  requireInternalSecret,
  runSync
);


/* ============================================================================
 * 404
 * ========================================================================== */

app.use(
  (req, res) => {
    return res.status(404).json({
      status:
        "error",

      message:
        "Not found",
    });
  }
);


/* ============================================================================
 * GLOBAL ERROR HANDLER
 * ========================================================================== */

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    console.error(
      "Unhandled error:",
      err
    );

    return res.status(500).json({
      status:
        "error",

      message:
        "Internal server error",
    });
  }
);


/* ============================================================================
 * SERVER
 * ========================================================================== */

const PORT =
  process.env.PORT ||
  3000;

app.listen(
  PORT,
  () => {
    console.log(
      `iBag API listening on port ${PORT}`
    );
  }
);
