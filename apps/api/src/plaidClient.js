require("dotenv").config();

const {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
} = require("plaid");

/*
 * iBag Plaid Client
 *
 * Production integration boundary for Plaid.
 *
 * Core rules:
 * - Real authorized financial data only.
 * - No synthetic, mock, seeded, or fabricated financial data.
 * - Phase 1 is read-only intelligence.
 * - No money movement.
 * - Requested products are never treated as available products.
 * - Product availability must be verified from Plaid.
 * - Product-specific evidence is independently gated.
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

/* -------------------------------------------------------------------------- */
/* PRODUCT DEFINITIONS                                                        */
/* -------------------------------------------------------------------------- */

/*
 * Transactions is the initial required Link product.
 *
 * We intentionally establish a known-good Link boundary first.
 *
 * Additional products are orchestrated through the appropriate Plaid
 * authorization/update flows rather than assuming that declaring every
 * possible product in one request makes every domain available.
 */

const PLAID_REQUIRED_PRODUCTS =
  Object.freeze([
    "transactions",
  ]);

const PLAID_OPTIONAL_PRODUCTS =
  Object.freeze([
    "auth",
    "identity",
    "investments",
    "liabilities",
  ]);

const PLAID_SPECIALIZED_PRODUCTS =
  Object.freeze([
    "assets",
    "statements",
  ]);

const IBAG_PLAID_PRODUCTS =
  Object.freeze({
    auth: {
      plaidProduct: "auth",
      linkMode: "optional",
      endpoint: "authGet",
      intelligenceDomain:
        "account_access",
    },

    transactions: {
      plaidProduct:
        "transactions",
      linkMode: "required",
      endpoint:
        "transactionsSync",
      intelligenceDomain:
        "transactions",
    },

    balance: {
      plaidProduct: null,
      linkMode: "automatic",
      endpoint:
        "accountsBalanceGet",
      intelligenceDomain:
        "liquidity",
    },

    identity: {
      plaidProduct: "identity",
      linkMode: "optional",
      endpoint: "identityGet",
      intelligenceDomain:
        "identity",
    },

    assets: {
      plaidProduct: "assets",
      linkMode: "specialized",
      endpoint: "assetReport",
      intelligenceDomain:
        "assets",
    },

    liabilities: {
      plaidProduct:
        "liabilities",
      linkMode: "optional",
      endpoint:
        "liabilitiesGet",
      intelligenceDomain:
        "liabilities",
    },

    investments: {
      plaidProduct:
        "investments",
      linkMode: "optional",
      endpoint:
        "investmentsHoldingsGet",
      intelligenceDomain:
        "investments",
    },

    statements: {
      plaidProduct:
        "statements",
      linkMode: "specialized",
      endpoint:
        "statementsList",
      intelligenceDomain:
        "statements",
    },
  });

/* -------------------------------------------------------------------------- */
/* LINK TOKEN                                                                 */
/* -------------------------------------------------------------------------- */

/*
 * Creates the initial iBag Link token.
 *
 * IMPORTANT:
 *
 * This deliberately starts with Transactions as the required product.
 *
 * We do not represent optional/specialized products as initialized merely
 * because iBag supports those intelligence domains.
 *
 * The resulting Item must subsequently be inspected to determine its real
 * product state.
 */

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

    client_name: "iBag",

    country_codes: [
      "US",
    ],

    language: "en",

    products: [
      "transactions",
    ],
  };

  if (webhookUrl) {
    request.webhook =
      webhookUrl;
  }

  try {
    console.log(
      "Creating Plaid Link token",
      {
        userId:
          String(userId),

        products:
          request.products,

        country_codes:
          request.country_codes,
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

      initial_products:
        request.products,
    };
  } catch (error) {
    console.error(
      "Plaid Link token creation failed",
      {
        code:
          error?.response?.data
            ?.error_code,

        message:
          error?.response?.data
            ?.error_message,

        display_message:
          error?.response?.data
            ?.display_message,

        request_id:
          error?.response?.data
            ?.request_id,

        status:
          error?.response?.status,
      }
    );

    throw normalizePlaidError(
      error,
      "PLAID_LINK_TOKEN_CREATE_FAILED"
    );
  }
}

/* -------------------------------------------------------------------------- */
/* UPDATE MODE LINK TOKEN                                                     */
/* -------------------------------------------------------------------------- */

/*
 * Update-mode Link is used to add or modify product access on an existing
 * Plaid Item when Plaid supports that lifecycle for the product.
 *
 * We intentionally do not claim that update mode guarantees a product.
 * The Item must always be inspected afterward.
 */

async function createUpdateModeLinkToken({
  userId,
  accessToken,
  webhookUrl = null,
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

    client_name: "iBag",

    access_token:
      accessToken,

    country_codes: [
      "US",
    ],

    language: "en",
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
    };
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_UPDATE_MODE_LINK_TOKEN_CREATE_FAILED"
    );
  }
}

/* -------------------------------------------------------------------------- */
/* ITEM                                                                       */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* PRODUCT COVERAGE                                                           */
/* -------------------------------------------------------------------------- */

/*
 * Product coverage is observational.
 *
 * requested:
 *   What iBag knows how to request.
 *
 * initialized:
 *   Products Plaid reports as initialized on the Item.
 *
 * billed:
 *   Products Plaid reports as billed.
 *
 * available:
 *   Products Plaid reports as available.
 *
 * consented:
 *   Products Plaid reports as consented when provided by the API.
 *
 * None of these states are fabricated.
 */

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
    requested: [
      ...PLAID_REQUIRED_PRODUCTS,
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
        "Balance is retrieved through accountsBalanceGet.",
    },

    specialized:
      PLAID_SPECIALIZED_PRODUCTS,
  };
}

/* -------------------------------------------------------------------------- */
/* AUTH                                                                       */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* BALANCE                                                                    */
/* -------------------------------------------------------------------------- */

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
      await plaidClient.accountsBalanceGet(
        {
          access_token:
            accessToken,
        }
      );

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_BALANCE_GET_FAILED"
    );
  }
}

/* -------------------------------------------------------------------------- */
/* TRANSACTIONS                                                               */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* IDENTITY                                                                   */
/* -------------------------------------------------------------------------- */

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
      await plaidClient.identityGet(
        {
          access_token:
            accessToken,
        }
      );

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_IDENTITY_GET_FAILED"
    );
  }
}

/* -------------------------------------------------------------------------- */
/* LIABILITIES                                                                */
/* -------------------------------------------------------------------------- */

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
      await plaidClient.liabilitiesGet(
        {
          access_token:
            accessToken,
        }
      );

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_LIABILITIES_GET_FAILED"
    );
  }
}

/* -------------------------------------------------------------------------- */
/* INVESTMENTS                                                                */
/* -------------------------------------------------------------------------- */

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
      await plaidClient.investmentsHoldingsGet(
        {
          access_token:
            accessToken,
        }
      );

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_INVESTMENTS_HOLDINGS_GET_FAILED"
    );
  }
}

/* -------------------------------------------------------------------------- */
/* ASSET REPORT                                                               */
/* -------------------------------------------------------------------------- */

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
      await plaidClient.assetReportGet(
        {
          asset_report_token:
            assetReportToken,
        }
      );

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_ASSET_REPORT_GET_FAILED"
    );
  }
}

/* -------------------------------------------------------------------------- */
/* STATEMENTS                                                                 */
/* -------------------------------------------------------------------------- */

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
      await plaidClient.statementsList(
        {
          access_token:
            accessToken,
        }
      );

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_STATEMENTS_LIST_FAILED"
    );
  }
}

/* -------------------------------------------------------------------------- */
/* ERROR NORMALIZATION                                                        */
/* -------------------------------------------------------------------------- */

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
    responseData.error_code ||
    fallbackCode;

  normalized.requestId =
    responseData.request_id ||
    error?.response?.headers
      ?.["plaid-request-id"] ||
    null;

  normalized.displayMessage =
    responseData.display_message ||
    null;

  normalized.cause =
    error;

  return normalized;
}

/* -------------------------------------------------------------------------- */
/* EXPORTS                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  plaidClient,

  PLAID_REQUIRED_PRODUCTS,

  PLAID_OPTIONAL_PRODUCTS,

  PLAID_SPECIALIZED_PRODUCTS,

  IBAG_PLAID_PRODUCTS,

  createLinkToken,

  createUpdateModeLinkToken,

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
