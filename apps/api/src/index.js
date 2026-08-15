require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const pool = require("./db");

const {
  PLAID_PRODUCTS,
  createLinkToken,
  createUpdateModeLinkToken,
  getProductCoverage,
  getBalances,
  getItem,
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
  getInsights,
  getNetWorth,
  getIncome,
  getCashFlow,
} = require("./me");

const app = express();

/*
 * --------------------------------------------------------------------------
 * RENDER / REVERSE PROXY
 * --------------------------------------------------------------------------
 */

app.set("trust proxy", 1);

/*
 * --------------------------------------------------------------------------
 * CORS
 * --------------------------------------------------------------------------
 */

app.use(
  cors({
    origin:
      process.env.FRONTEND_ORIGIN ||
      "https://shave.onrender.com",
  }),
);

app.use(express.json());
app.use(express.static("public"));

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
    status: "error",
    message:
      "Too many attempts. Try again later.",
  },
});

/*
 * --------------------------------------------------------------------------
 * SERVICE / HEALTH
 * --------------------------------------------------------------------------
 */

app.get("/", (req, res) => {
  return res.json({
    status: "ok",
    service: "ibag-api",
    message: "iBag API is running",
  });
});

app.get("/health", (req, res) => {
  return res.json({
    status: "ok",
    service: "ibag-api",
    time: new Date().toISOString(),
  });
});

app.get("/db-check", async (req, res) => {
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
      status: "ok",
      db_time:
        result.rows[0].db_time,
      user_count:
        result.rows[0].user_count,
    });
  } catch (err) {
    console.error(
      "Database check failed:",
      err,
    );

    return res.status(500).json({
      status: "error",
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
  "/auth/signup",
  authLimiter,
  signup,
);

app.post(
  "/auth/login",
  authLimiter,
  login,
);

/*
 * --------------------------------------------------------------------------
 * AUTHENTICATED USER / DASHBOARD
 * --------------------------------------------------------------------------
 */

app.get(
  "/me",
  requireAuth,
  getMe,
);

app.get(
  "/me/dashboard",
  requireAuth,
  getDashboard,
);

app.get(
  "/me/summary",
  requireAuth,
  getSummary,
);

app.get(
  "/me/accounts",
  requireAuth,
  getAccounts,
);

app.get(
  "/me/transactions",
  requireAuth,
  getTransactions,
);

app.get(
  "/me/insights",
  requireAuth,
  getInsights,
);

app.get(
  "/me/net-worth",
  requireAuth,
  getNetWorth,
);

app.get(
  "/me/income",
  requireAuth,
  getIncome,
);

app.get(
  "/me/cash-flow",
  requireAuth,
  getCashFlow,
);

/*
 * --------------------------------------------------------------------------
 * PLAID
 * --------------------------------------------------------------------------
 *
 * iBag Plaid integration rules:
 *
 * 1. The centralized plaidClient owns Plaid API construction.
 * 2. index.js owns HTTP/authentication/database orchestration.
 * 3. Product support is NOT product availability.
 * 4. No product is assumed to exist merely because iBag supports it.
 * 5. No fake financial data is ever created.
 */

/*
 * --------------------------------------------------------------------------
 * CREATE INITIAL LINK TOKEN
 * --------------------------------------------------------------------------
 */

app.post(
  "/plaid/create-link-token",
  requireAuth,
  async (req, res) => {
    try {
      /*
       * Capacity is per authenticated user.
       *
       * We do not let one user consume another user's connection capacity.
       */
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

      const CAPACITY_LIMIT = 9;

      if (
        Number(
          activeCount.rows[0].count,
        ) >= CAPACITY_LIMIT
      ) {
        return res.status(503).json({
          status: "error",
          code:
            "PLAID_CONNECTION_CAPACITY_REACHED",
          message:
            "iBag is at the connection limit for this account.",
        });
      }

      const result =
        await createLinkToken({
          userId:
            req.user.id,

          webhookUrl:
            process.env.PLAID_WEBHOOK_URL ||
            null,
        });

      return res.json({
        status: "ok",
        link_token:
          result.link_token,

        expiration:
          result.expiration,

        request_id:
          result.request_id,

        products:
          result.initial_products ||
          PLAID_PRODUCTS,
      });
    } catch (err) {
      console.error(
        "Plaid create link token failed:",
        err,
      );

      return res.status(500).json({
        status: "error",
        code:
          err.code ||
          "PLAID_LINK_TOKEN_CREATE_FAILED",

        message:
          err.message,

        display_message:
          err.displayMessage ||
          null,

        request_id:
          err.requestId ||
          null,
      });
    }
  },
);

/*
 * --------------------------------------------------------------------------
 * PRODUCT COVERAGE
 * --------------------------------------------------------------------------
 *
 * Returns what Plaid actually reports for an Item.
 *
 * This endpoint does NOT claim that iBag has data merely because a product
 * is supported by the application.
 */

app.get(
  "/plaid/product-coverage",
  requireAuth,
  async (req, res) => {
    try {
      const {
        plaid_item_id,
      } = req.query;

      if (!plaid_item_id) {
        return res.status(400).json({
          status: "error",
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
          ],
        );

      if (
        itemResult.rows.length === 0
      ) {
        return res.status(404).json({
          status: "error",
          message:
            "Active Plaid Item not found for this user.",
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
        status: "ok",
        plaid_item_id,
        coverage,
      });
    } catch (err) {
      console.error(
        "Plaid product coverage failed:",
        err,
      );

      return res.status(500).json({
        status: "error",
        code:
          err.code ||
          "PLAID_PRODUCT_COVERAGE_FAILED",

        message:
          err.message,

        display_message:
          err.displayMessage ||
          null,

        request_id:
          err.requestId ||
          null,
      });
    }
  },
);

/*
 * --------------------------------------------------------------------------
 * CREATE UPDATE-MODE LINK TOKEN
 * --------------------------------------------------------------------------
 *
 * IMPORTANT:
 *
 * This endpoint handles products that can be requested through
 * additional_consented_products.
 *
 * Assets and Statements are deliberately NOT placed in this array.
 *
 * Plaid documents specialized handling for Assets and Statements in
 * update mode. They require their own product initialization/configuration
 * rather than being blindly added to additional_consented_products.
 *
 * This prevents the exact class of error we just encountered.
 */

const ADDITIONAL_CONSENT_PRODUCTS =
  new Set([
    "auth",
    "identity",
    "investments",
    "liabilities",
  ]);

const SPECIALIZED_UPDATE_PRODUCTS =
  new Set([
    "assets",
    "statements",
  ]);

app.post(
  "/plaid/create-update-link-token",
  requireAuth,
  async (req, res) => {
    try {
      const {
        plaid_item_id,
        products,
      } = req.body;

      if (!plaid_item_id) {
        return res.status(400).json({
          status: "error",
          message:
            "plaid_item_id is required",
        });
      }

      /*
       * Normalize requested products.
       *
       * We accept either:
       *
       * products: ["identity"]
       *
       * or:
       *
       * product: "identity"
       *
       * The frontend should use products.
       */
      let requestedProducts =
        products;

      if (
        typeof requestedProducts ===
        "string"
      ) {
        requestedProducts = [
          requestedProducts,
        ];
      }

      if (
        requestedProducts ===
        undefined
      ) {
        /*
         * No product means no additional consent request.
         *
         * This remains a valid update-mode Link flow for credential
         * remediation and similar Item updates.
         */
        requestedProducts = [];
      }

      if (
        !Array.isArray(
          requestedProducts,
        )
      ) {
        return res.status(400).json({
          status: "error",
          code:
            "INVALID_PRODUCT_REQUEST",

          message:
            "products must be an array of Plaid product names.",
        });
      }

      requestedProducts =
        [
          ...new Set(
            requestedProducts.map(
              product =>
                String(product)
                  .trim()
                  .toLowerCase(),
            ),
          ),
        ];

      const unsupported =
        requestedProducts.filter(
          product =>
            !ADDITIONAL_CONSENT_PRODUCTS.has(
              product,
            ) &&
            !SPECIALIZED_UPDATE_PRODUCTS.has(
              product,
            ),
        );

      if (
        unsupported.length > 0
      ) {
        return res.status(400).json({
          status: "error",
          code:
            "UNSUPPORTED_PLAID_UPDATE_PRODUCT",

          message:
            "The requested Plaid product is not supported by this update flow.",

          products:
            unsupported,
        });
      }

      /*
       * Assets and Statements require specialized update-mode handling.
       *
       * Do not send them through additional_consented_products.
       */
      const specialized =
        requestedProducts.filter(
          product =>
            SPECIALIZED_UPDATE_PRODUCTS.has(
              product,
            ),
        );

      if (
        specialized.length > 0
      ) {
        return res.status(400).json({
          status: "error",

          code:
            "SPECIALIZED_PLAID_PRODUCT_FLOW_REQUIRED",

          message:
            "Assets and Statements require their specialized Plaid update-mode flow and cannot be requested through this consent-only endpoint.",

          products:
            specialized,
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
          status: "error",
          message:
            "Active Plaid Item not found for this user.",
        });
      }

      const accessToken =
        decrypt(
          itemRow.rows[0]
            .plaid_access_token_encrypted,
        );

      /*
       * Verify the Item before requesting additional product consent.
       *
       * This gives iBag the actual Plaid Item state rather than relying on
       * assumptions.
       */
      const itemData =
        await getItem(
          accessToken,
        );

      const item =
        itemData.item ||
        itemData;

      const consented =
        Array.isArray(
          item.consented_products,
        )
          ? item.consented_products
          : [];

      const initialized =
        Array.isArray(
          item.products,
        )
          ? item.products
          : [];

      /*
       * Do not request consent that is already represented by the Item.
       */
      const productsToRequest =
        requestedProducts.filter(
          product =>
            !consented.includes(
              product,
            ) &&
            !initialized.includes(
              product,
            ),
        );

      const result =
        await createUpdateModeLinkToken({
          userId:
            req.user.id,

          accessToken,

          additionalConsentedProducts:
            productsToRequest,

          webhookUrl:
            process.env.PLAID_WEBHOOK_URL ||
            null,
        });

      return res.json({
        status: "ok",

        link_token:
          result.link_token,

        expiration:
          result.expiration,

        request_id:
          result.request_id,

        requested_products:
          productsToRequest,

        already_consented:
          requestedProducts.filter(
            product =>
              consented.includes(
                product,
              ) ||
              initialized.includes(
                product,
              ),
          ),
      });
    } catch (err) {
      console.error(
        "Plaid update link token failed:",
        err,
      );

      return res.status(500).json({
        status: "error",

        code:
          err.code ||
          "PLAID_UPDATE_LINK_TOKEN_CREATE_FAILED",

        message:
          err.message,

        display_message:
          err.displayMessage ||
          null,

        request_id:
          err.requestId ||
          null,
      });
    }
  },
);

/*
 * --------------------------------------------------------------------------
 * EXCHANGE PUBLIC TOKEN
 * --------------------------------------------------------------------------
 */

app.post(
  "/plaid/exchange-public-token",
  requireAuth,
  async (req, res) => {
    try {
      const {
        public_token,
        institution_name,
      } = req.body;

      if (!public_token) {
        return res.status(400).json({
          status: "error",
          message:
            "public_token is required",
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

      /*
       * Do not silently create duplicate records for the same Item.
       */
      const existing =
        await pool.query(
          `
            SELECT
              id,
              status
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
        existing.rows.length > 0
      ) {
        const updated =
          await pool.query(
            `
              UPDATE plaid_items
              SET
                plaid_access_token_encrypted = $1,
                institution_name = $2,
                status = 'active'
              WHERE id = $3
              RETURNING id
            `,
            [
              encryptedToken,

              institution_name ||
                null,

              existing.rows[0].id,
            ],
          );

        plaidItemDbId =
          updated.rows[0].id;
      } else {
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

        plaidItemDbId =
          itemInsert.rows[0].id;
      }

      /*
       * Accounts are real Plaid observations.
       *
       * No account is fabricated if Plaid does not return it.
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
              "USD",
          ],
        );
      }

      /*
       * Immediately attempt the transaction delta.
       *
       * This does not fabricate anything.
       *
       * If Plaid returns zero transactions, zero is retained.
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
          freshItem.rows.length > 0
        ) {
          immediateSyncResult =
            await syncOneItem(
              freshItem.rows[0],
            );
        }
      } catch (syncErr) {
        console.error(
          "Immediate post-link sync failed (non-fatal):",
          syncErr,
        );
      }

      return res.json({
        status: "ok",

        plaid_item_id,

        accounts_stored:
          accountsRes.data.accounts
            .length,

        immediate_sync:
          immediateSyncResult,
      });
    } catch (err) {
      console.error(
        "Plaid public token exchange failed:",
        err,
      );

      return res.status(500).json({
        status: "error",

        code:
          err.code ||
          "PLAID_PUBLIC_TOKEN_EXCHANGE_FAILED",

        message:
          err.message,

        display_message:
          err.displayMessage ||
          null,

        request_id:
          err.requestId ||
          null,
      });
    }
  },
);

/*
 * --------------------------------------------------------------------------
 * RESYNC AFTER UPDATE
 * --------------------------------------------------------------------------
 */

app.post(
  "/plaid/resync-after-update",
  requireAuth,
  async (req, res) => {
    try {
      const {
        plaid_item_id,
      } = req.body;

      if (!plaid_item_id) {
        return res.status(400).json({
          status: "error",
          message:
            "plaid_item_id is required",
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
          status: "error",
          message:
            "Active Plaid Item not found for this user.",
        });
      }

      const result =
        await syncOneItem(
          itemRow.rows[0],
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
        err,
      );

      return res.status(500).json({
        status: "error",

        code:
          err.code ||
          "PLAID_RESYNC_FAILED",

        message:
          err.message,
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
  "/internal/sync/run",
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
    return res.status(404).json({
      status: "error",
      message: "Not found",
    });
  },
);

/*
 * --------------------------------------------------------------------------
 * GLOBAL ERROR HANDLER
 * --------------------------------------------------------------------------
 */

app.use(
  (err, req, res, next) => {
    console.error(
      "Unhandled error:",
      err,
    );

    return res.status(500).json({
      status: "error",
      message:
        "Internal server error",
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
      `ibag-api listening on port ${PORT}`,
    );
  },
);
