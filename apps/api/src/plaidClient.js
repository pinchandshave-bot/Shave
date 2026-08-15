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
 * Production integration boundary for Plaid.
 *
 * CORE PRINCIPLES
 * ----------------------------------------------------------------------------
 * 1. Real authorized financial data only.
 * 2. No mock, fake, seeded, synthetic, or fabricated financial data.
 * 3. Phase 1 is information/intelligence only.
 * 4. No money movement.
 * 5. Plaid is authoritative for actual Item/product availability.
 * 6. Requested != initialized != consented != billed != available.
 * 7. Product endpoints are called only when the Item actually supports them.
 * 8. Product lifecycle follows Plaid's Link initialization/update rules.
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
 * iBAG PRODUCT DEFINITIONS
 * ========================================================================== */

/*
 * Products that form the primary financial-data foundation.
 *
 * Transactions is the core Phase 1 intelligence domain.
 */
const PLAID_REQUIRED_PRODUCTS =
  Object.freeze([
    "transactions",
  ]);


/*
 * Products that can enhance the initial connection without being required
 * for iBag to function.
 */
const PLAID_OPTIONAL_PRODUCTS =
  Object.freeze([
    "auth",
  ]);


/*
 * Products that should be requested only when the connected institution /
 * account supports them.
 *
 * Identity is intentionally handled as required_if_supported rather than
 * blindly requiring every institution to support it.
 */
const PLAID_REQUIRED_IF_SUPPORTED_PRODUCTS =
  Object.freeze([
    "identity",
  ]);


/*
 * Products for which iBag should obtain consent during the primary Link
 * experience but should not initialize/bill until iBag actually uses the
 * corresponding product endpoint.
 *
 * Plaid explicitly supports this pattern for personal-finance use cases.
 */
const PLAID_ADDITIONAL_CONSENTED_PRODUCTS =
  Object.freeze([
    "investments",
    "liabilities",
  ]);


/*
 * Products that require specialized acquisition/update-mode handling.
 *
 * These MUST NOT be placed into additional_consented_products.
 *
 * Assets and Statements are added through update-mode products.
 */
const PLAID_SPECIALIZED_PRODUCTS =
  Object.freeze([
    "assets",
    "statements",
  ]);


/*
 * Compatibility export for existing code that expects PLAID_PRODUCTS.
 *
 * This is intentionally the actual initial `products` array only.
 *
 * Do NOT put every iBag-supported product here.
 */
const PLAID_PRODUCTS =
  Object.freeze([
    "transactions",
  ]);


/* ============================================================================
 * iBAG INTELLIGENCE DOMAIN MAP
 * ========================================================================== */

const IBAG_PLAID_PRODUCTS =
  Object.freeze({
    auth: {
      plaidProduct: "auth",
      lifecycle:
        "optional_products",
      endpoint:
        "authGet",
      intelligenceDomain:
        "account_access",
    },

    transactions: {
      plaidProduct:
        "transactions",
      lifecycle:
        "products",
      endpoint:
        "transactionsSync",
      intelligenceDomain:
        "transactions",
    },

    balance: {
      plaidProduct: null,
      lifecycle:
        "automatic",
      endpoint:
        "accountsBalanceGet",
      intelligenceDomain:
        "liquidity",
    },

    identity: {
      plaidProduct:
        "identity",
      lifecycle:
        "required_if_supported_products",
      endpoint:
        "identityGet",
      intelligenceDomain:
        "identity",
    },

    investments: {
      plaidProduct:
        "investments",
      lifecycle:
        "additional_consented_products",
      endpoint:
        "investmentsHoldingsGet",
      intelligenceDomain:
        "investments",
    },

    liabilities: {
      plaidProduct:
        "liabilities",
      lifecycle:
        "additional_consented_products",
      endpoint:
        "liabilitiesGet",
      intelligenceDomain:
        "liabilities",
    },

    assets: {
      plaidProduct:
        "assets",
      lifecycle:
        "specialized_update_mode",
      endpoint:
        "assetReportCreate",
      intelligenceDomain:
        "assets",
    },

    statements: {
      plaidProduct:
        "statements",
      lifecycle:
        "specialized_update_mode",
      endpoint:
        "statementsList",
      intelligenceDomain:
        "statements",
    },
  });


/* ============================================================================
 * INITIAL LINK TOKEN
 * ========================================================================== */

/*
 * Primary iBag financial connection.
 *
 * This deliberately uses Plaid's product-combination architecture instead
 * of putting every product into `products`.
 *
 * Transactions:
 *   Primary required financial-data product.
 *
 * Auth:
 *   Optional enhancement.
 *
 * Identity:
 *   Required if supported by the institution/account.
 *
 * Investments / Liabilities:
 *   Consent collected now, but the products are not initialized/billed until
 *   iBag actually invokes their endpoints.
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

    client_name:
      "iBag",

    country_codes: [
      "US",
    ],

    language:
      "en",

    products:
      PLAID_PRODUCTS,

    optional_products:
      PLAID_OPTIONAL_PRODUCTS,

    required_if_supported_products:
      PLAID_REQUIRED_IF_SUPPORTED_PRODUCTS,

    additional_consented_products:
      PLAID_ADDITIONAL_CONSENTED_PRODUCTS,
  };

  if (webhookUrl) {
    request.webhook =
      webhookUrl;
  }

  try {
    console.log(
      "Creating iBag Plaid Link token",
      {
        environment:
          PLAID_ENVIRONMENT,

        userId:
          String(userId),

        products:
          request.products,

        optional_products:
          request.optional_products,

        required_if_supported_products:
          request.required_if_supported_products,

        additional_consented_products:
          request.additional_consented_products,
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
        request.products,

      optional_products:
        request.optional_products,

      required_if_supported_products:
        request.required_if_supported_products,

      additional_consented_products:
        request.additional_consented_products,
    };
  } catch (error) {
    console.error(
      "Plaid Link token creation failed",
      {
        environment:
          PLAID_ENVIRONMENT,

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


/* ============================================================================
 * UPDATE-MODE LINK TOKEN
 * ========================================================================== */

/*
 * Creates update-mode Link for an existing Item.
 *
 * IMPORTANT:
 *
 * Plaid has two materially different update-mode patterns.
 *
 * A) Additional consent:
 *      auth
 *      identity
 *      investments
 *      liabilities
 *
 * B) Product initialization:
 *      assets
 *      statements
 *
 * Statements MUST NOT be placed inside additional_consented_products.
 */
async function createUpdateModeLinkToken({
  userId,
  accessToken,
  products = [],
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

  if (
    !Array.isArray(products) ||
    products.length === 0
  ) {
    throw new Error(
      "createUpdateModeLinkToken requires at least one product"
    );
  }

  const supportedProducts =
    new Set([
      "auth",
      "identity",
      "investments",
      "liabilities",
      "assets",
      "statements",
    ]);

  for (const product of products) {
    if (
      !supportedProducts.has(
        product
      )
    ) {
      throw new Error(
        `Unsupported update-mode product: ${product}`
      );
    }
  }

  const additionalConsentProducts =
    products.filter(
      product =>
        [
          "auth",
          "identity",
          "investments",
          "liabilities",
        ].includes(product)
    );

  const specializedProducts =
    products.filter(
      product =>
        [
          "assets",
          "statements",
        ].includes(product)
    );

  /*
   * Plaid's update-mode rules require specialized products such as Assets
   * and Statements to be supplied in `products`, while additional consent
   * products are supplied through `additional_consented_products`.
   *
   * We therefore handle them separately.
   */

  let request;

  if (
    specializedProducts.length > 0
  ) {
    request = {
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

      products:
        specializedProducts,
    };
  } else {
    request = {
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
        additionalConsentProducts,
    };
  }

  if (webhookUrl) {
    request.webhook =
      webhookUrl;
  }

  try {
    console.log(
      "Creating iBag Plaid update-mode Link token",
      {
        environment:
          PLAID_ENVIRONMENT,

        userId:
          String(userId),

        requestedProducts:
          products,

        requestProducts:
          request.products || [],

        additionalConsentProducts:
          request.additional_consented_products ||
          [],
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

      requested_products:
        products,
    };
  } catch (error) {
    throw normalizePlaidError(
      error,
      "PLAID_UPDATE_MODE_LINK_TOKEN_CREATE_FAILED"
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

/*
 * Never infer product availability from iBag's own configuration.
 *
 * Plaid's Item response is the source of truth.
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
    environment:
      PLAID_ENVIRONMENT,

    requested: [
      ...PLAID_REQUIRED_PRODUCTS,
      ...PLAID_OPTIONAL_PRODUCTS,
      ...PLAID_REQUIRED_IF_SUPPORTED_PRODUCTS,
      ...PLAID_ADDITIONAL_CONSENTED_PRODUCTS,
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
      available:
        true,

      reason:
        "Balance is retrieved through accountsBalanceGet and does not require explicit Link product initialization.",
    },

    specialized:
      PLAID_SPECIALIZED_PRODUCTS,
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
    error?.response?.headers
      ?.["plaid-request-id"] ||
    null;

  normalized.displayMessage =
    responseData.display_message ||
    null;

  normalized.cause =
    error;

  normalized.plaidEnvironment =
    PLAID_ENVIRONMENT;

  return normalized;
}


/* ============================================================================
 * EXPORTS
 * ========================================================================== */

module.exports = {
  plaidClient,

  PLAID_ENVIRONMENT,

  PLAID_REQUIRED_PRODUCTS,

  PLAID_OPTIONAL_PRODUCTS,

  PLAID_REQUIRED_IF_SUPPORTED_PRODUCTS,

  PLAID_ADDITIONAL_CONSENTED_PRODUCTS,

  PLAID_SPECIALIZED_PRODUCTS,

  PLAID_PRODUCTS,

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
