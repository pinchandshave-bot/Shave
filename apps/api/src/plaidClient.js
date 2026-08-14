```js
require("dotenv").config();

const {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
} = require("plaid");

/*
 * iBag Plaid Client
 *
 * Phase 1:
 * - Real authorized financial data only.
 * - Read-only intelligence.
 * - No money movement.
 * - No synthetic/mock/seeded financial data.
 *
 * Plaid capabilities iBag is building around:
 *
 *   1. Auth
 *   2. Transactions
 *   3. Balance
 *   4. Identity
 *   5. Assets
 *   6. Liabilities
 *   7. Investments
 *   8. Statements
 *
 * IMPORTANT:
 *
 * Balance is NOT a valid value for Link's products array.
 * Plaid automatically initializes Balance when another product
 * is initialized and Balance is retrieved through:
 *
 *   /accounts/balance/get
 *
 * Assets and Statements have their own product workflows and
 * should not be treated as ordinary account-sync endpoints.
 */

/* -------------------------------------------------------------------------- */
/* ENVIRONMENT                                                                */
/* -------------------------------------------------------------------------- */

const plaidEnv =
  process.env.PLAID_ENV === "production"
    ? PlaidEnvironments.production
    : PlaidEnvironments.sandbox;

const clientId = process.env.PLAID_CLIENT_ID;
const secret = process.env.PLAID_SECRET;

if (!clientId) {
  throw new Error("Missing PLAID_CLIENT_ID");
}

if (!secret) {
  throw new Error("Missing PLAID_SECRET");
}

/* -------------------------------------------------------------------------- */
/* PLAID CLIENT                                                               */
/* -------------------------------------------------------------------------- */

const configuration = new Configuration({
  basePath: plaidEnv,

  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": clientId,
      "PLAID-SECRET": secret,
    },
  },
});

const plaidClient = new PlaidApi(configuration);

/* -------------------------------------------------------------------------- */
/* IBAG PRODUCT DEFINITIONS                                                   */
/* -------------------------------------------------------------------------- */

/*
 * PRIMARY PRODUCT
 *
 * Transactions is required because it is the foundation of:
 * - spending intelligence
 * - cash-flow intelligence
 * - Round-Up intelligence
 * - merchant intelligence
 * - behavioral intelligence
 *
 * Balance is automatically available through the Item and is
 * synchronized independently with accountsBalanceGet().
 */
const PLAID_REQUIRED_PRODUCTS = [
  "transactions",
];

/*
 * SECONDARY PRODUCTS
 *
 * These are requested when supported without unnecessarily
 * filtering out institutions/accounts that cannot provide them.
 *
 * Plaid supports these values in optional_products:
 * - auth
 * - identity
 * - investments
 * - liabilities
 * - statements
 *
 * Assets is intentionally handled through its Asset Report
 * workflow rather than being treated as ordinary account data.
 */
const PLAID_OPTIONAL_PRODUCTS = [
  "auth",
  "identity",
  "investments",
  "liabilities",
  "statements",
];

/*
 * Products for which iBag intends to obtain user consent/data
 * but which have specialized workflows.
 *
 * Assets can be added post-Link through the appropriate update
 * mode / Asset Report flow.
 *
 * We do NOT falsely claim that Assets is initialized merely
 * because this constant exists.
 */
const PLAID_SPECIALIZED_PRODUCTS = [
  "assets",
];

/*
 * Canonical iBag product registry.
 *
 * This is an internal product map, NOT a direct copy of Plaid's
 * Link products array.
 */
const IBAG_PLAID_PRODUCTS = Object.freeze({
  auth: {
    plaidProduct: "auth",
    linkMode: "optional",
    endpoint: "authGet",
    intelligenceDomain: "account_access",
  },

  transactions: {
    plaidProduct: "transactions",
    linkMode: "required",
    endpoint: "transactionsSync",
    intelligenceDomain: "transactions",
  },

  balance: {
    plaidProduct: null,
    linkMode: "automatic",
    endpoint: "accountsBalanceGet",
    intelligenceDomain: "liquidity",
  },

  identity: {
    plaidProduct: "identity",
    linkMode: "optional",
    endpoint: "identityGet",
    intelligenceDomain: "identity",
  },

  assets: {
    plaidProduct: "assets",
    linkMode: "specialized",
    endpoint: "assetReport",
    intelligenceDomain: "assets",
  },

  liabilities: {
    plaidProduct: "liabilities",
    linkMode: "optional",
    endpoint: "liabilitiesGet",
    intelligenceDomain: "liabilities",
  },

  investments: {
    plaidProduct: "investments",
    linkMode: "optional",
    endpoint: "investmentsHoldingsGet",
    intelligenceDomain: "investments",
  },

  statements: {
    plaidProduct: "statements",
    linkMode: "optional",
    endpoint: "statements",
    intelligenceDomain: "statements",
  },
});

/* -------------------------------------------------------------------------- */
/* LINK TOKEN                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Create the initial Link token.
 *
 * Transactions is required.
 *
 * Auth, Identity, Investments, Liabilities and Statements are
 * optional so unsupported institutions/accounts do not get
 * unnecessarily excluded from Link.
 *
 * Balance is automatically initialized by Plaid.
 *
 * Assets requires its specialized Asset Report workflow.
 */
async function createLinkToken({
  userId,
  webhookUrl = null,
} = {}) {
  if (!userId) {
    throw new Error("createLinkToken requires userId");
  }

  const request = {
    user: {
      client_user_id: String(userId),
    },

    client_name: "iBag",

    country_codes: ["US"],

    language: "en",

    products: PLAID_REQUIRED_PRODUCTS,

    optional_products: PLAID_OPTIONAL_PRODUCTS,
  };

  if (webhookUrl) {
    request.webhook = webhookUrl;
  }

  try {
    const response = await plaidClient.linkTokenCreate(request);

    return {
      link_token: response.data.link_token,
      expiration: response.data.expiration,
      request_id: response.data.request_id,

      initial_products: PLAID_REQUIRED_PRODUCTS,

      optional_products: PLAID_OPTIONAL_PRODUCTS,

      balance: {
        available: true,
        initialization: "automatic",
      },

      specialized_products: PLAID_SPECIALIZED_PRODUCTS,
    };
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_LINK_TOKEN_CREATE_FAILED"
    );
  }
}

/* -------------------------------------------------------------------------- */
/* UPDATE-MODE LINK TOKEN                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create an Update Mode Link token for an existing Item.
 *
 * This is important for products such as Assets and Statements
 * that may need to be added to an existing Item through the
 * appropriate Plaid update flow.
 */
async function createUpdateModeLinkToken({
  userId,
  accessToken,
  webhookUrl = null,
} = {}) {
  if (!userId) {
    throw new Error("createUpdateModeLinkToken requires userId");
  }

  if (!accessToken) {
    throw new Error(
      "createUpdateModeLinkToken requires accessToken"
    );
  }

  const request = {
    user: {
      client_user_id: String(userId),
    },

    client_name: "iBag",

    access_token: accessToken,

    country_codes: ["US"],

    language: "en",
  };

  if (webhookUrl) {
    request.webhook = webhookUrl;
  }

  try {
    const response =
      await plaidClient.linkTokenCreate(request);

    return {
      link_token: response.data.link_token,
      expiration: response.data.expiration,
      request_id: response.data.request_id,
    };
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_UPDATE_MODE_LINK_TOKEN_CREATE_FAILED"
    );
  }
}

/* -------------------------------------------------------------------------- */
/* ITEM / PRODUCT DISCOVERY                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Retrieve the authoritative Plaid Item state.
 *
 * This is what iBag should use to determine what Plaid actually
 * initialized on an Item instead of assuming that a requested
 * product became available.
 */
async function getItem(accessToken) {
  if (!accessToken) {
    throw new Error("getItem requires accessToken");
  }

  try {
    const response = await plaidClient.itemGet({
      access_token: accessToken,
    });

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_ITEM_GET_FAILED"
    );
  }
}

/**
 * Normalize the Item's product information into an explicit
 * evidence object for iBag.
 */
async function getProductCoverage(accessToken) {
  const itemData = await getItem(accessToken);

  const item = itemData.item || itemData;

  const products = Array.isArray(item.products)
    ? item.products
    : [];

  const billedProducts = Array.isArray(item.billed_products)
    ? item.billed_products
    : [];

  const availableProducts = Array.isArray(
    item.available_products
  )
    ? item.available_products
    : [];

  const consentedProducts = Array.isArray(
    item.consented_products
  )
    ? item.consented_products
    : [];

  return {
    requested: [
      ...PLAID_REQUIRED_PRODUCTS,
      ...PLAID_OPTIONAL_PRODUCTS,
    ],

    initialized: products,

    billed: billedProducts,

    available: availableProducts,

    consented: consentedProducts,

    balance: {
      available: true,
      reason:
        "Balance is automatically initialized and retrieved through accountsBalanceGet.",
    },

    specialized: PLAID_SPECIALIZED_PRODUCTS,
  };
}

/* -------------------------------------------------------------------------- */
/* AUTH                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Retrieve Auth data for an Item.
 */
async function getAuth(accessToken) {
  if (!accessToken) {
    throw new Error("getAuth requires accessToken");
  }

  try {
    const response = await plaidClient.authGet({
      access_token: accessToken,
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

/**
 * Retrieve current balances.
 *
 * Balance is intentionally represented as a first-class iBag
 * intelligence domain even though Plaid does not require
 * "balance" in Link's products array.
 */
async function getBalances(accessToken) {
  if (!accessToken) {
    throw new Error("getBalances requires accessToken");
  }

  try {
    const response =
      await plaidClient.accountsBalanceGet({
        access_token: accessToken,
      });

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

/**
 * Synchronize Transactions using Plaid's cursor-based API.
 */
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
    access_token: accessToken,
  };

  if (cursor) {
    request.cursor = cursor;
  }

  try {
    const response =
      await plaidClient.transactionsSync(request);

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

/**
 * Retrieve Identity data.
 */
async function getIdentity(accessToken) {
  if (!accessToken) {
    throw new Error("getIdentity requires accessToken");
  }

  try {
    const response =
      await plaidClient.identityGet({
        access_token: accessToken,
      });

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

/**
 * Retrieve liability data.
 */
async function getLiabilities(accessToken) {
  if (!accessToken) {
    throw new Error(
      "getLiabilities requires accessToken"
    );
  }

  try {
    const response =
      await plaidClient.liabilitiesGet({
        access_token: accessToken,
      });

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

/**
 * Retrieve investment holdings and securities.
 */
async function getInvestments(accessToken) {
  if (!accessToken) {
    throw new Error(
      "getInvestments requires accessToken"
    );
  }

  try {
    const response =
      await plaidClient.investmentsHoldingsGet({
        access_token: accessToken,
      });

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_INVESTMENTS_HOLDINGS_GET_FAILED"
    );
  }
}

/* -------------------------------------------------------------------------- */
/* ASSETS                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create an Asset Report.
 *
 * Asset Reports are not ordinary account endpoints.
 */
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
    access_tokens: [accessToken],
    days_requested: daysRequested,
  };

  if (options && typeof options === "object") {
    request.options = options;
  }

  try {
    const response =
      await plaidClient.assetReportCreate(request);

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_ASSET_REPORT_CREATE_FAILED"
    );
  }
}

/**
 * Retrieve an Asset Report.
 */
async function getAssetReport(assetReportToken) {
  if (!assetReportToken) {
    throw new Error(
      "getAssetReport requires assetReportToken"
    );
  }

  try {
    const response =
      await plaidClient.assetReportGet({
        asset_report_token: assetReportToken,
      });

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

/**
 * Retrieve available bank statements.
 */
async function getStatements(accessToken) {
  if (!accessToken) {
    throw new Error(
      "getStatements requires accessToken"
    );
  }

  try {
    const response =
      await plaidClient.statementsList({
        access_token: accessToken,
      });

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

/**
 * Convert Plaid SDK errors into a stable internal structure.
 *
 * We deliberately preserve Plaid's actual error information.
 * We never convert an error into "no data."
 */
function normalizePlaidError(error, fallbackCode) {
  const responseData =
    error?.response?.data || {};

  return Object.assign(
    new Error(
      responseData.error_message ||
        error?.message ||
        fallbackCode
    ),
    {
      code:
        responseData.error_code ||
        fallbackCode,

      type:
        responseData.error_type ||
        null,

      status:
        responseData.error_code ||
        fallbackCode,

      requestId:
        responseData.request_id ||
        error?.response?.headers?.["plaid-request-id"] ||
        null,

      displayMessage:
        responseData.display_message ||
        null,

      cause: error,
    }
  );
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
```
