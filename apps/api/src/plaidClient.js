require("dotenv").config();

const {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
} = require("plaid");

/*
 * ============================================================================
 * iBag PLAID CLIENT
 * ============================================================================
 *
 * This module is the application's single Plaid integration boundary.
 *
 * PRINCIPLES
 *
 * 1. Real authorized financial data only.
 * 2. No mock, fake, seeded, synthetic, or fabricated financial data.
 * 3. Phase 1 is information/intelligence only.
 * 4. No money movement.
 * 5. Product capability is never inferred from configuration alone.
 * 6. Plaid Item state is authoritative for actual product access.
 * 7. Specialized Plaid products use their required authorization lifecycle.
 * 8. Product-specific intelligence is evidence-gated.
 *
 * IMPORTANT:
 *
 * iBag may support many Plaid intelligence domains without initializing
 * every domain on every Item.
 *
 * The distinction is:
 *
 *   iBag capability
 *        !=
 *   Plaid product requested
 *        !=
 *   Plaid product initialized
 *        !=
 *   Plaid product consented
 *        !=
 *   usable evidence
 *
 * This distinction is fundamental to investor-grade financial intelligence.
 * ============================================================================
 */

const plaidEnv =
  process.env.PLAID_ENV === "production"
    ? PlaidEnvironments.production
    : PlaidEnvironments.sandbox;

const clientId =
  process.env.PLAID_CLIENT_ID;

const secret =
  process.env.PLAID_SECRET;

if (!clientId) {
  throw new Error(
    "Missing PLAID_CLIENT_ID"
  );
}

if (!secret) {
  throw new Error(
    "Missing PLAID_SECRET"
  );
}

const configuration =
  new Configuration({
    basePath: plaidEnv,

    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID":
          clientId,

        "PLAID-SECRET":
          secret,
      },
    },
  });

const plaidClient =
  new PlaidApi(configuration);


/* ============================================================================
 * ENVIRONMENT
 * ========================================================================== */

const PLAID_ENVIRONMENT =
  process.env.PLAID_ENV === "production"
    ? "production"
    : "sandbox";


/* ============================================================================
 * PRODUCT MODEL
 * ========================================================================== */

/*
 * Required initial product.
 *
 * Transactions is the Phase 1 core because it provides the primary
 * transaction observation stream used by iBag's initial intelligence layer.
 */
const PLAID_INITIAL_PRODUCTS =
  Object.freeze([
    "transactions",
  ]);


/*
 * Products that may be requested as optional products when appropriate.
 *
 * These are NOT claims that every Item supports them.
 */
const PLAID_OPTIONAL_PRODUCTS =
  Object.freeze([
    "auth",
    "identity",
    "investments",
    "liabilities",
  ]);


/*
 * Specialized products have their own Link/update-mode lifecycle.
 *
 * Statements and Assets must not simply be placed into
 * additional_consented_products.
 */
const PLAID_SPECIALIZED_PRODUCTS =
  Object.freeze([
    "assets",
    "statements",
  ]);


/*
 * Complete iBag capability registry.
 *
 * This is an iBag architecture map, not a declaration that every capability
 * is initialized for every user.
 */
const IBAG_PLAID_PRODUCTS =
  Object.freeze({
    transactions: {
      plaidProduct: "transactions",
      initialization:
        "initial",
      endpoint:
        "transactionsSync",
      intelligenceDomain:
        "transactions",
    },

    auth: {
      plaidProduct: "auth",
      initialization:
        "optional_or_update",
      endpoint:
        "authGet",
      intelligenceDomain:
        "account_access",
    },

    balance: {
      plaidProduct: null,
      initialization:
        "automatic",
      endpoint:
        "accountsBalanceGet",
      intelligenceDomain:
        "liquidity",
    },

    identity: {
      plaidProduct: "identity",
      initialization:
        "optional_or_update",
      endpoint:
        "identityGet",
      intelligenceDomain:
        "identity",
    },

    investments: {
      plaidProduct: "investments",
      initialization:
        "optional_or_update",
      endpoint:
        "investmentsHoldingsGet",
      intelligenceDomain:
        "investments",
    },

    liabilities: {
      plaidProduct: "liabilities",
      initialization:
        "optional_or_update",
      endpoint:
        "liabilitiesGet",
      intelligenceDomain:
        "liabilities",
    },

    assets: {
      plaidProduct: "assets",
      initialization:
        "specialized_update",
      endpoint:
        "assetReport",
      intelligenceDomain:
        "assets",
    },

    statements: {
      plaidProduct: "statements",
      initialization:
        "specialized_update",
      endpoint:
        "statementsList",
      intelligenceDomain:
        "statements",
    },
  });


/*
 * Additional-consent products that are actually valid in the current
 * Plaid Link API contract.
 *
 * Statements and Assets intentionally do NOT appear here.
 */
const PLAID_ADDITIONAL_CONSENT_PRODUCTS =
  Object.freeze([
    "auth",
    "identity",
    "investments",
    "liabilities",
  ]);


/* ============================================================================
 * LINK TOKEN — INITIAL
 * ========================================================================== */

async function createLinkToken({
  userId,
  webhookUrl = null,
} = {}) {
  if (!userId) {
    throw new Error(
      "createLinkToken requires userId"
    );
  }

  const request = {
    user: {
      client_user_id:
        String(userId),
    },

    client_name:
      "iBag",

    country_codes: [
      "US",
    ],

    language:
      "en",

    products:
      PLAID_INITIAL_PRODUCTS,
  };

  if (webhookUrl) {
    request.webhook =
      webhookUrl;
  }

  try {
    console.log(
      "Creating Plaid Link token",
      {
        environment:
          PLAID_ENVIRONMENT,

        userId:
          String(userId),

        products:
          request.products,
      }
    );

    const response =
      await plaidClient.linkTokenCreate(
        request
      );

    return {
      link_token:
        response.data.link_token,

      expiration:
        response.data.expiration,

      request_id:
        response.data.request_id,

      environment:
        PLAID_ENVIRONMENT,

      initial_products:
        [
          ...request.products,
        ],
    };
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_LINK_TOKEN_CREATE_FAILED"
    );
  }
}


/* ============================================================================
 * UPDATE MODE — EXISTING ITEM
 * ========================================================================== */

/*
 * Standard update mode.
 *
 * No products are supplied here.
 *
 * This is appropriate for:
 *
 * - credential repair
 * - account selection
 * - general Item updates
 *
 * Product-specific additions are handled separately below.
 */
async function createUpdateModeLinkToken({
  userId,
  accessToken,
  webhookUrl = null,
  accountSelectionEnabled = false,
} = {}) {
  if (!userId) {
    throw new Error(
      "createUpdateModeLinkToken requires userId"
    );
  }

  if (!accessToken) {
    throw new Error(
      "createUpdateModeLinkToken requires accessToken"
    );
  }

  const request = {
    user: {
      client_user_id:
        String(userId),
    },

    client_name:
      "iBag",

    access_token:
      accessToken,

    country_codes: [
      "US",
    ],

    language:
      "en",
  };

  if (accountSelectionEnabled) {
    request.update = {
      account_selection_enabled:
        true,
    };
  }

  if (webhookUrl) {
    request.webhook =
      webhookUrl;
  }

  try {
    const response =
      await plaidClient.linkTokenCreate(
        request
      );

    return {
      link_token:
        response.data.link_token,

      expiration:
        response.data.expiration,

      request_id:
        response.data.request_id,
    };
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_UPDATE_MODE_LINK_TOKEN_CREATE_FAILED"
    );
  }
}


/* ============================================================================
 * UPDATE MODE — ADD CONSENTED OPTIONAL PRODUCTS
 * ========================================================================== */

/*
 * Request additional consent for products such as:
 *
 * - auth
 * - identity
 * - investments
 * - liabilities
 *
 * Statements and Assets are deliberately rejected here because they use
 * specialized update-mode product initialization.
 */
async function createAdditionalConsentLinkToken({
  userId,
  accessToken,
  products = [],
  webhookUrl = null,
} = {}) {
  if (!userId) {
    throw new Error(
      "createAdditionalConsentLinkToken requires userId"
    );
  }

  if (!accessToken) {
    throw new Error(
      "createAdditionalConsentLinkToken requires accessToken"
    );
  }

  if (
    !Array.isArray(products) ||
    products.length === 0
  ) {
    throw new Error(
      "At least one additional consent product is required"
    );
  }

  const uniqueProducts =
    [
      ...new Set(products),
    ];

  const invalidProducts =
    uniqueProducts.filter(
      product =>
        !PLAID_ADDITIONAL_CONSENT_PRODUCTS.includes(
          product
        )
    );

  if (invalidProducts.length) {
    throw new Error(
      `Products cannot be requested through additional_consented_products: ${invalidProducts.join(", ")}`
    );
  }

  const request = {
    user: {
      client_user_id:
        String(userId),
    },

    client_name:
      "iBag",

    access_token:
      accessToken,

    country_codes: [
      "US",
    ],

    language:
      "en",

    additional_consented_products:
      uniqueProducts,
  };

  if (webhookUrl) {
    request.webhook =
      webhookUrl;
  }

  try {
    const response =
      await plaidClient.linkTokenCreate(
        request
      );

    return {
      link_token:
        response.data.link_token,

      expiration:
        response.data.expiration,

      request_id:
        response.data.request_id,

      requested_products:
        uniqueProducts,
    };
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_ADDITIONAL_CONSENT_LINK_TOKEN_CREATE_FAILED"
    );
  }
}


/* ============================================================================
 * UPDATE MODE — SPECIALIZED PRODUCT
 * ========================================================================== */

/*
 * Assets / Statements require specialized update-mode handling.
 *
 * Plaid's current Link contract requires the specialized product to appear
 * in the products array for this flow.
 */
async function createSpecializedProductLinkToken({
  userId,
  accessToken,
  product,
  webhookUrl = null,
  productConfiguration = null,
} = {}) {
  if (!userId) {
    throw new Error(
      "createSpecializedProductLinkToken requires userId"
    );
  }

  if (!accessToken) {
    throw new Error(
      "createSpecializedProductLinkToken requires accessToken"
    );
  }

  if (
    !PLAID_SPECIALIZED_PRODUCTS.includes(
      product
    )
  ) {
    throw new Error(
      `Unsupported specialized Plaid product: ${product}`
    );
  }

  const request = {
    user: {
      client_user_id:
        String(userId),
    },

    client_name:
      "iBag",

    access_token:
      accessToken,

    country_codes: [
      "US",
    ],

    language:
      "en",

    products: [
      product,
    ],
  };

  if (
    productConfiguration &&
    typeof productConfiguration ===
      "object"
  ) {
    request[product] =
      productConfiguration;
  }

  if (webhookUrl) {
    request.webhook =
      webhookUrl;
  }

  try {
    const response =
      await plaidClient.linkTokenCreate(
        request
      );

    return {
      link_token:
        response.data.link_token,

      expiration:
        response.data.expiration,

      request_id:
        response.data.request_id,

      product,
    };
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_SPECIALIZED_PRODUCT_LINK_TOKEN_CREATE_FAILED"
    );
  }
}


/* ============================================================================
 * ITEM
 * ========================================================================== */

async function getItem(
  accessToken
) {
  if (!accessToken) {
    throw new Error(
      "getItem requires accessToken"
    );
  }

  try {
    const response =
      await plaidClient.itemGet({
        access_token:
          accessToken,
      });

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_ITEM_GET_FAILED"
    );
  }
}


/* ============================================================================
 * PRODUCT COVERAGE
 * ========================================================================== */

async function getProductCoverage(
  accessToken
) {
  const itemData =
    await getItem(
      accessToken
    );

  const item =
    itemData.item ||
    itemData;

  const products =
    Array.isArray(
      item.products
    )
      ? item.products
      : [];

  const billedProducts =
    Array.isArray(
      item.billed_products
    )
      ? item.billed_products
      : [];

  const availableProducts =
    Array.isArray(
      item.available_products
    )
      ? item.available_products
      : [];

  const consentedProducts =
    Array.isArray(
      item.consented_products
    )
      ? item.consented_products
      : [];

  return {
    environment:
      PLAID_ENVIRONMENT,

    requested:
      [
        ...PLAID_INITIAL_PRODUCTS,
        ...PLAID_OPTIONAL_PRODUCTS,
        ...PLAID_SPECIALIZED_PRODUCTS,
      ],

    initialized:
      products,

    billed:
      billedProducts,

    available:
      availableProducts,

    consented:
      consentedProducts,

    balance: {
      available: true,

      reason:
        "Balance is retrieved through accountsBalanceGet and does not require explicit Link initialization.",
    },

    specialized:
      [
        ...PLAID_SPECIALIZED_PRODUCTS,
      ],
  };
}


/* ============================================================================
 * AUTH
 * ========================================================================== */

async function getAuth(
  accessToken
) {
  if (!accessToken) {
    throw new Error(
      "getAuth requires accessToken"
    );
  }

  try {
    const response =
      await plaidClient.authGet({
        access_token:
          accessToken,
      });

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_AUTH_GET_FAILED"
    );
  }
}


/* ============================================================================
 * BALANCE
 * ========================================================================== */

async function getBalances(
  accessToken
) {
  if (!accessToken) {
    throw new Error(
      "getBalances requires accessToken"
    );
  }

  try {
    const response =
      await plaidClient.accountsBalanceGet({
        access_token:
          accessToken,
      });

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_BALANCE_GET_FAILED"
    );
  }
}


/* ============================================================================
 * TRANSACTIONS
 * ========================================================================== */

async function syncTransactions(
  accessToken,
  cursor = null
) {
  if (!accessToken) {
    throw new Error(
      "syncTransactions requires accessToken"
    );
  }

  const request = {
    access_token:
      accessToken,
  };

  if (cursor) {
    request.cursor =
      cursor;
  }

  try {
    const response =
      await plaidClient.transactionsSync(
        request
      );

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_TRANSACTIONS_SYNC_FAILED"
    );
  }
}


/* ============================================================================
 * IDENTITY
 * ========================================================================== */

async function getIdentity(
  accessToken
) {
  if (!accessToken) {
    throw new Error(
      "getIdentity requires accessToken"
    );
  }

  try {
    const response =
      await plaidClient.identityGet({
        access_token:
          accessToken,
      });

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_IDENTITY_GET_FAILED"
    );
  }
}


/* ============================================================================
 * LIABILITIES
 * ========================================================================== */

async function getLiabilities(
  accessToken
) {
  if (!accessToken) {
    throw new Error(
      "getLiabilities requires accessToken"
    );
  }

  try {
    const response =
      await plaidClient.liabilitiesGet({
        access_token:
          accessToken,
      });

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_LIABILITIES_GET_FAILED"
    );
  }
}


/* ============================================================================
 * INVESTMENTS
 * ========================================================================== */

async function getInvestments(
  accessToken
) {
  if (!accessToken) {
    throw new Error(
      "getInvestments requires accessToken"
    );
  }

  try {
    const response =
      await plaidClient.investmentsHoldingsGet({
        access_token:
          accessToken,
      });

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_INVESTMENTS_HOLDINGS_GET_FAILED"
    );
  }
}


/* ============================================================================
 * ASSET REPORT
 * ========================================================================== */

async function createAssetReport({
  accessToken,
  daysRequested = 90,
  options = {},
} = {}) {
  if (!accessToken) {
    throw new Error(
      "createAssetReport requires accessToken"
    );
  }

  const request = {
    access_tokens: [
      accessToken,
    ],

    days_requested:
      daysRequested,
  };

  if (
    options &&
    typeof options === "object" &&
    !Array.isArray(options)
  ) {
    request.options =
      options;
  }

  try {
    const response =
      await plaidClient.assetReportCreate(
        request
      );

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_ASSET_REPORT_CREATE_FAILED"
    );
  }
}


async function getAssetReport(
  assetReportToken
) {
  if (!assetReportToken) {
    throw new Error(
      "getAssetReport requires assetReportToken"
    );
  }

  try {
    const response =
      await plaidClient.assetReportGet({
        asset_report_token:
          assetReportToken,
      });

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_ASSET_REPORT_GET_FAILED"
    );
  }
}


/* ============================================================================
 * STATEMENTS
 * ========================================================================== */

async function getStatements(
  accessToken
) {
  if (!accessToken) {
    throw new Error(
      "getStatements requires accessToken"
    );
  }

  try {
    const response =
      await plaidClient.statementsList({
        access_token:
          accessToken,
      });

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_STATEMENTS_LIST_FAILED"
    );
  }
}


/* ============================================================================
 * ERROR NORMALIZATION
 * ========================================================================== */

function normalizePlaidError(
  error,
  fallbackCode
) {
  const responseData =
    error?.response?.data ||
    {};

  const normalized =
    new Error(
      responseData.error_message ||
        error?.message ||
        fallbackCode
    );

  normalized.code =
    responseData.error_code ||
    fallbackCode;

  normalized.type =
    responseData.error_type ||
    null;

  normalized.status =
    error?.response?.status ||
    null;

  normalized.requestId =
    responseData.request_id ||
    error?.response?.headers?.[
      "plaid-request-id"
    ] ||
    null;

  normalized.displayMessage =
    responseData.display_message ||
    null;

  normalized.environment =
    PLAID_ENVIRONMENT;

  normalized.cause =
    error;

  return normalized;
}


/* ============================================================================
 * EXPORTS
 * ========================================================================== */

module.exports = {
  plaidClient,

  PLAID_ENVIRONMENT,

  PLAID_INITIAL_PRODUCTS,

  PLAID_OPTIONAL_PRODUCTS,

  PLAID_SPECIALIZED_PRODUCTS,

  PLAID_ADDITIONAL_CONSENT_PRODUCTS,

  IBAG_PLAID_PRODUCTS,

  createLinkToken,

  createUpdateModeLinkToken,

  createAdditionalConsentLinkToken,

  createSpecializedProductLinkToken,

  getItem,

  getProductCoverage,

  getAuth,

  getBalances,

  syncTransactions,

  getIdentity,

  getLiabilities,

  getInvestments,

  createAssetReport,

  getAssetReport,

  getStatements,

  normalizePlaidError,
};
