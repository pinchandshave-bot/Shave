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
 * Rules:
 * - Real authorized financial data only.
 * - Read-only intelligence.
 * - No money movement.
 * - No synthetic, mock, seeded, or fabricated financial data.
 * - Plaid product availability is never inferred from requested products.
 * - Configuration, consent, availability, and observed data are distinct states.
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
/* PLAID PRODUCT CONFIGURATION                                                */
/* -------------------------------------------------------------------------- */

/*
 * iBag's intelligence domains do not map one-to-one to Link products.
 *
 * iBag domains:
 *
 * 1. Transactions
 * 2. Identity
 * 3. Investments
 * 4. Liabilities
 * 5. Income
 * 6. Auth
 * 7. Assets
 * 8. Recurring Transactions
 *
 * Plaid implementation:
 *
 * Transactions
 *   -> transactions
 *
 * Identity
 *   -> identity
 *
 * Investments
 *   -> investments
 *
 * Liabilities
 *   -> liabilities
 *
 * Income
 *   -> income_verification / Income-specific flow
 *
 * Auth
 *   -> auth
 *
 * Assets
 *   -> assets / Asset Report workflow
 *
 * Recurring Transactions
 *   -> Transactions recurring endpoint
 *
 * Balance
 *   -> accountsBalanceGet
 *
 * Statements
 *   -> statementsList
 *
 * Balance and Recurring Transactions are NOT placed in the ordinary
 * Link products array.
 */

/*
 * Primary product.
 *
 * Plaid recommends Transactions as the primary product for personal
 * finance use cases when Liabilities and Investments are handled as
 * additional-consent products.
 *
 * We request 180 days because iBag's recurring-transaction intelligence
 * depends on sufficient transaction history.
 */
const PLAID_REQUIRED_PRODUCTS = [
  "transactions",
];

/*
 * Products that Plaid should attempt to initialize when supported,
 * without preventing the Item from being created when unsupported.
 *
 * Auth and Identity are deliberately optional here.
 *
 * This means iBag does NOT claim that either domain exists simply
 * because the product appears in this configuration.
 */
const PLAID_OPTIONAL_PRODUCTS = [
  "auth",
  "identity",
  "statements",
];

/*
 * Products for which iBag collects consent during Link but does not
 * initialize/bill until the corresponding product endpoint is actually
 * used.
 *
 * Plaid specifically recommends this pattern for personal-finance
 * applications using Transactions with Investments and Liabilities.
 */
const PLAID_ADDITIONAL_CONSENTED_PRODUCTS = [
  "investments",
  "liabilities",
];

/*
 * Assets uses the Asset Report workflow.
 *
 * It can be initialized separately through Link/update mode and then
 * produces an Asset Report rather than ordinary per-product rows.
 */
const PLAID_SPECIALIZED_PRODUCTS = [
  "assets",
];

/*
 * Income Verification is a separate Plaid flow.
 *
 * It is intentionally NOT inserted into the ordinary eight-domain
 * financial Link configuration above.
 *
 * The exact Income flow determines the required Link configuration,
 * including income_source_types and, for current Income APIs, the
 * appropriate user/token workflow.
 */
const PLAID_INCOME_PRODUCT = "income_verification";

/*
 * Recurring Transactions is a Transactions capability.
 *
 * It is retrieved through:
 *
 *   /transactions/recurring/get
 *
 * after Transactions has been initialized and transaction history
 * has been synchronized.
 */
const PLAID_RECURRING_TRANSACTIONS_PRODUCT =
  "recurring_transactions";

/*
 * Balance is automatically available when an applicable product
 * is initialized. It is not a Link product value.
 */
const PLAID_BALANCE_PRODUCT = null;

/*
 * Transaction history requested during Link initialization.
 *
 * Plaid recommends at least 180 days for Recurring Transactions.
 */
const PLAID_TRANSACTIONS_DAYS_REQUESTED = 180;

/* -------------------------------------------------------------------------- */
/* iBAG PRODUCT DOMAIN MAP                                                    */
/* -------------------------------------------------------------------------- */

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
    plaidProduct: PLAID_BALANCE_PRODUCT,
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
    linkMode: "additional_consented",
    endpoint: "liabilitiesGet",
    intelligenceDomain: "liabilities",
  },

  investments: {
    plaidProduct: "investments",
    linkMode: "additional_consented",
    endpoint: "investmentsHoldingsGet",
    intelligenceDomain: "investments",
  },

  income: {
    plaidProduct: PLAID_INCOME_PRODUCT,
    linkMode: "specialized",
    endpoint: "incomeVerification",
    intelligenceDomain: "income",
  },

  recurring_transactions: {
    plaidProduct: PLAID_RECURRING_TRANSACTIONS_PRODUCT,
    linkMode: "transactions_capability",
    endpoint: "recurringTransactionsGet",
    intelligenceDomain: "recurring_transactions",
  },

  statements: {
    plaidProduct: "statements",
    linkMode: "optional",
    endpoint: "statementsList",
    intelligenceDomain: "statements",
  },
});

/* -------------------------------------------------------------------------- */
/* LINK TOKEN                                                                 */
/* -------------------------------------------------------------------------- */

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

    additional_consented_products:
      PLAID_ADDITIONAL_CONSENTED_PRODUCTS,

    transactions: {
      days_requested:
        PLAID_TRANSACTIONS_DAYS_REQUESTED,
    },
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

      initial_products: [
        ...PLAID_REQUIRED_PRODUCTS,
      ],

      optional_products: [
        ...PLAID_OPTIONAL_PRODUCTS,
      ],

      additional_consented_products: [
        ...PLAID_ADDITIONAL_CONSENTED_PRODUCTS,
      ],

      transactions: {
        days_requested:
          PLAID_TRANSACTIONS_DAYS_REQUESTED,
      },

      balance: {
        available: true,
        initialization: "automatic",
      },

      specialized_products: [
        ...PLAID_SPECIALIZED_PRODUCTS,
      ],

      income: {
        product: PLAID_INCOME_PRODUCT,
        initialization: "specialized_flow_required",
      },

      recurring_transactions: {
        product:
          PLAID_RECURRING_TRANSACTIONS_PRODUCT,
        initialization:
          "transactions_capability",
      },
    };
  } catch (error) {
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
 * Creates a Link token for an existing Item.
 *
 * This is required when iBag needs to add a product to an existing
 * Item through Plaid's Update Mode flow.
 *
 * Example specialized additions include Assets and Statements.
 */
async function createUpdateModeLinkToken({
  userId,
  accessToken,
  products = [],
  additionalConsentedProducts = [],
  webhookUrl = null,
  statements = null,
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

  if (!Array.isArray(products)) {
    throw new Error(
      "createUpdateModeLinkToken products must be an array"
    );
  }

  if (!Array.isArray(additionalConsentedProducts)) {
    throw new Error(
      "createUpdateModeLinkToken additionalConsentedProducts must be an array"
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

  if (products.length > 0) {
    request.products = [
      ...new Set(products.map(String)),
    ];
  }

  if (additionalConsentedProducts.length > 0) {
    request.additional_consented_products = [
      ...new Set(
        additionalConsentedProducts.map(String)
      ),
    ];
  }

  if (
    statements &&
    typeof statements === "object" &&
    !Array.isArray(statements)
  ) {
    request.statements = statements;
  }

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

      products: request.products || [],

      additional_consented_products:
        request.additional_consented_products || [],
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

async function getItem(accessToken) {
  if (!accessToken) {
    throw new Error("getItem requires accessToken");
  }

  try {
    const response =
      await plaidClient.itemGet({
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

/* -------------------------------------------------------------------------- */
/* PRODUCT COVERAGE                                                           */
/* -------------------------------------------------------------------------- */

/*
 * Reads the Item's actual product state.
 *
 * IMPORTANT:
 *
 * requested != initialized
 * initialized != billed
 * available != initialized
 * consented != observed
 *
 * iBag must use the actual Item response rather than infer availability
 * from its own configuration.
 */
async function getProductCoverage(accessToken) {
  const itemData = await getItem(accessToken);

  const item =
    itemData.item || itemData;

  const products =
    Array.isArray(item.products)
      ? item.products
      : [];

  const billedProducts =
    Array.isArray(item.billed_products)
      ? item.billed_products
      : [];

  const availableProducts =
    Array.isArray(item.available_products)
      ? item.available_products
      : [];

  const consentedProducts =
    Array.isArray(item.consented_products)
      ? item.consented_products
      : [];

  return {
    requested: [
      ...new Set([
        ...PLAID_REQUIRED_PRODUCTS,
        ...PLAID_OPTIONAL_PRODUCTS,
        ...PLAID_ADDITIONAL_CONSENTED_PRODUCTS,
      ]),
    ],

    initialized: products,

    billed: billedProducts,

    available: availableProducts,

    consented: consentedProducts,

    balance: {
      available: true,
      reason:
        "Balance is retrieved through accountsBalanceGet.",
    },

    specialized: [
      ...PLAID_SPECIALIZED_PRODUCTS,
    ],

    income: {
      product: PLAID_INCOME_PRODUCT,
      status: "specialized_flow_required",
    },

    recurring_transactions: {
      product:
        PLAID_RECURRING_TRANSACTIONS_PRODUCT,
      status: "transactions_capability",
    },
  };
}

/* -------------------------------------------------------------------------- */
/* AUTH                                                                       */
/* -------------------------------------------------------------------------- */

async function getAuth(accessToken) {
  if (!accessToken) {
    throw new Error("getAuth requires accessToken");
  }

  try {
    const response =
      await plaidClient.authGet({
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

async function getBalances(accessToken) {
  if (!accessToken) {
    throw new Error(
      "getBalances requires accessToken"
    );
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

/*
 * Performs one Transactions Sync request.
 *
 * The caller remains responsible for:
 * - processing added transactions
 * - processing modified transactions
 * - processing removed transactions
 * - advancing the cursor
 * - continuing until has_more is false
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
/* RECURRING TRANSACTIONS                                                     */
/* -------------------------------------------------------------------------- */

/*
 * Recurring Transactions is retrieved through the Transactions product.
 *
 * It is NOT initialized as a separate Link product.
 */
async function getRecurringTransactions(
  accessToken,
  options = {}
) {
  if (!accessToken) {
    throw new Error(
      "getRecurringTransactions requires accessToken"
    );
  }

  const request = {
    access_token: accessToken,
  };

  if (
    options &&
    typeof options === "object" &&
    !Array.isArray(options)
  ) {
    if (options.accountIds) {
      request.account_ids =
        options.accountIds;
    }

    if (options.categoryIds) {
      request.category_ids =
        options.categoryIds;
    }

    if (options.includePersonalFinanceCategory) {
      request.include_personal_finance_category =
        options.includePersonalFinanceCategory;
    }
  }

  try {
    const response =
      await plaidClient.transactionsRecurringGet(
        request
      );

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_RECURRING_TRANSACTIONS_GET_FAILED"
    );
  }
}

/* -------------------------------------------------------------------------- */
/* IDENTITY                                                                   */
/* -------------------------------------------------------------------------- */

async function getIdentity(accessToken) {
  if (!accessToken) {
    throw new Error(
      "getIdentity requires accessToken"
    );
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
/* INVESTMENT TRANSACTIONS                                                    */
/* -------------------------------------------------------------------------- */

async function getInvestmentTransactions(
  accessToken,
  options = {}
) {
  if (!accessToken) {
    throw new Error(
      "getInvestmentTransactions requires accessToken"
    );
  }

  const request = {
    access_token: accessToken,
  };

  if (
    options &&
    typeof options === "object" &&
    !Array.isArray(options)
  ) {
    if (options.startDate) {
      request.start_date =
        options.startDate;
    }

    if (options.endDate) {
      request.end_date =
        options.endDate;
    }

    if (options.count != null) {
      request.count = options.count;
    }

    if (options.offset != null) {
      request.offset = options.offset;
    }

    if (options.accountIds) {
      request.account_id =
        options.accountIds;
    }
  }

  try {
    const response =
      await plaidClient.investmentsTransactionsGet(
        request
      );

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_INVESTMENTS_TRANSACTIONS_GET_FAILED"
    );
  }
}

/* -------------------------------------------------------------------------- */
/* ASSET REPORT                                                               */
/* -------------------------------------------------------------------------- */

/*
 * Creates a real Plaid Asset Report.
 *
 * This does not create synthetic asset rows.
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

  if (
    !Number.isInteger(daysRequested) ||
    daysRequested < 1 ||
    daysRequested > 731
  ) {
    throw new Error(
      "createAssetReport daysRequested must be an integer between 1 and 731"
    );
  }

  const request = {
    access_tokens: [accessToken],

    days_requested: daysRequested,
  };

  if (
    options &&
    typeof options === "object" &&
    !Array.isArray(options)
  ) {
    request.options = options;
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

/* -------------------------------------------------------------------------- */
/* ASSET REPORT REFRESH                                                       */
/* -------------------------------------------------------------------------- */

async function refreshAssetReport(
  assetReportToken,
  options = {}
) {
  if (!assetReportToken) {
    throw new Error(
      "refreshAssetReport requires assetReportToken"
    );
  }

  const request = {
    asset_report_token:
      assetReportToken,
  };

  if (
    options &&
    typeof options === "object" &&
    !Array.isArray(options)
  ) {
    request.options = options;
  }

  try {
    const response =
      await plaidClient.assetReportRefresh(
        request
      );

    return response.data;
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_ASSET_REPORT_REFRESH_FAILED"
    );
  }
}

/* -------------------------------------------------------------------------- */
/* STATEMENTS                                                                 */
/* -------------------------------------------------------------------------- */

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
/* PRODUCT CONFIGURATION                                                      */
/* -------------------------------------------------------------------------- */

function getPlaidProductConfiguration() {
  return {
    required: [
      ...PLAID_REQUIRED_PRODUCTS,
    ],

    optional: [
      ...PLAID_OPTIONAL_PRODUCTS,
    ],

    additional_consented: [
      ...PLAID_ADDITIONAL_CONSENTED_PRODUCTS,
    ],

    specialized: [
      ...PLAID_SPECIALIZED_PRODUCTS,
    ],

    income: PLAID_INCOME_PRODUCT,

    recurring_transactions:
      PLAID_RECURRING_TRANSACTIONS_PRODUCT,

    balance: {
      plaidProduct: PLAID_BALANCE_PRODUCT,
      initialization: "automatic",
    },

    transactions: {
      days_requested:
        PLAID_TRANSACTIONS_DAYS_REQUESTED,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* INTELLIGENCE DOMAINS                                                       */
/* -------------------------------------------------------------------------- */

function getPlaidProducts() {
  return [
    "transactions",
    "identity",
    "investments",
    "liabilities",
    "income",
    "auth",
    "assets",
    "recurring_transactions",
  ];
}

/* -------------------------------------------------------------------------- */
/* ERROR NORMALIZATION                                                        */
/* -------------------------------------------------------------------------- */

function normalizePlaidError(
  error,
  fallbackCode
) {
  const responseData =
    error?.response?.data || {};

  const headers =
    error?.response?.headers || {};

  const requestId =
    responseData.request_id ||
    headers["plaid-request-id"] ||
    headers["Plaid-Request-ID"] ||
    null;

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

      requestId,

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

  PLAID_ADDITIONAL_CONSENTED_PRODUCTS,

  PLAID_SPECIALIZED_PRODUCTS,

  PLAID_INCOME_PRODUCT,

  PLAID_RECURRING_TRANSACTIONS_PRODUCT,

  PLAID_BALANCE_PRODUCT,

  PLAID_TRANSACTIONS_DAYS_REQUESTED,

  IBAG_PLAID_PRODUCTS,

  createLinkToken,

  createUpdateModeLinkToken,

  getItem,

  getProductCoverage,

  getAuth,

  getBalances,

  syncTransactions,

  getRecurringTransactions,

  getIdentity,

  getLiabilities,

  getInvestments,

  getInvestmentTransactions,

  createAssetReport,

  getAssetReport,

  refreshAssetReport,

  getStatements,

  getPlaidProducts,

  getPlaidProductConfiguration,

  normalizePlaidError,
};
