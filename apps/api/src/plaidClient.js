const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
/*
 * iBag Plaid Product Configuration
 *
 * IMPORTANT:
 * - Phase 1 is intelligence/read-only.
 * - No money movement.
 * - No synthetic, mock, seeded, or fabricated financial data.
 * - Every enabled Plaid product must produce real user-authorized data
 *   before iBag treats that domain as observed.
 *
 * Balance and Round-Ups are intentionally NOT counted as part of the
 * eight intelligence products.
 *
 * The eight intelligence products:
 *
 * 1. Transactions
 * 2. Identity
 * 3. Investments
 * 4. Liabilities
 * 5. Income
 * 6. Auth
 * 7. Assets
 * 8. Recurring Transactions
 */
const PLAID_PRODUCTS = [
  "transactions",
  "identity",
  "investments",
  "liabilities",
  "income",
  "auth",
  "assets",
  "recurring_transactions",
];
const PLAID_COUNTRY_CODES = ["US"];
const PLAID_LANGUAGE = "en";
function createPlaidClient() {
  const configuration = new Configuration({
    basePath:
      process.env.PLAID_ENV === "production"
        ? PlaidEnvironments.production
        : PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
        "PLAID-SECRET": process.env.PLAID_SECRET,
      },
    },
  });
  return new PlaidApi(configuration);
}
const plaidClient = createPlaidClient();
/**
 * Create a Link token that explicitly requests all eight
 * iBag intelligence products.
 *
 * Balance is intentionally added separately because iBag uses it
 * operationally for account state, but it is NOT one of the eight
 * intelligence products.
 *
 * FIX: index.js calls this as createLinkToken({ userId, webhookUrl }) —
 * an object — but this used to take a bare userId string, so
 * String(userId) became the literal text "[object Object]". Signature is
 * now an options object. Also, webhookUrl is now actually passed through
 * to Plaid — previously no webhook was ever registered, so Plaid had
 * nothing to call your webhook handler with.
 */
async function createLinkToken({ userId, webhookUrl } = {}) {
  if (!userId) {
    throw new Error("userId is required");
  }
  const response = await plaidClient.linkTokenCreate({
    user: {
      client_user_id: String(userId),
    },
    client_name: "iBag",
    products: PLAID_PRODUCTS,
    country_codes: PLAID_COUNTRY_CODES,
    language: PLAID_LANGUAGE,
    /*
     * Balance is required operationally by iBag but is not counted
     * toward the eight intelligence products.
     */
    optional_products: ["balance"],
    /*
     * FIX: previously omitted entirely, so Plaid had no webhook URL to
     * call. Falls back to undefined (Plaid treats this as "no webhook")
     * if webhookUrl isn't provided, rather than sending an empty string.
     */
    webhook: webhookUrl || undefined,
    /*
     * iBag is information/intelligence-only in Phase 1.
     * Do NOT request transfer/payment products here.
     */
  });
  return {
    link_token: response.data.link_token,
    expiration: response.data.expiration,
    request_id: response.data.request_id,
    products: PLAID_PRODUCTS,
  };
}

/**
 * FIX: did not exist. index.js's /plaid/create-update-link-token route
 * imports and calls this — without it, that route would throw
 * "createUpdateModeLinkToken is not a function" on every call.
 *
 * Used for both credential-remediation update mode (no product request)
 * and requesting additional product consent (additionalConsentedProducts)
 * on an existing Item.
 */
async function createUpdateModeLinkToken({
  userId,
  accessToken,
  additionalConsentedProducts,
  webhookUrl,
} = {}) {
  if (!userId) {
    throw new Error("userId is required");
  }
  if (!accessToken) {
    throw new Error("accessToken is required");
  }

  const request = {
    user: {
      client_user_id: String(userId),
    },
    client_name: "iBag",
    access_token: accessToken,
    country_codes: PLAID_COUNTRY_CODES,
    language: PLAID_LANGUAGE,
    webhook: webhookUrl || undefined,
  };

  if (
    Array.isArray(additionalConsentedProducts) &&
    additionalConsentedProducts.length > 0
  ) {
    request.additional_consented_products = additionalConsentedProducts;
  }

  const response = await plaidClient.linkTokenCreate(request);

  return {
    link_token: response.data.link_token,
    expiration: response.data.expiration,
    request_id: response.data.request_id,
  };
}

/**
 * FIX: did not exist. sync.js's discoverItemCapabilities() calls this as
 * the first step inside every syncOneItem() DB transaction — without it,
 * every single sync threw immediately and rolled back before ever
 * reaching transaction data.
 *
 * Returns the raw Plaid Item object (item_id, institution_id, products,
 * billed_products, available_products, consented_products,
 * consent_expiration_time, etc.) as a thin passthrough. Deliberately does
 * NOT map that into iBag's domain/evidence-state model — that logic
 * already exists in sync.js and stays defined there, in one place, so it
 * can't drift out of sync with itself.
 */
async function getItem(accessToken) {
  const response = await plaidClient.itemGet({
    access_token: accessToken,
  });
  return response.data;
}

/**
 * FIX: did not exist. index.js's /plaid/product-coverage route imports
 * and calls this directly.
 */
async function getProductCoverage(accessToken) {
  const data = await getItem(accessToken);
  const item = data.item || data;

  return {
    item_id: item.item_id || null,
    institution_id: item.institution_id || null,
    products: item.products || [],
    billed_products: item.billed_products || [],
    available_products: item.available_products || [],
    consented_products: item.consented_products || [],
    consent_expiration_time: item.consent_expiration_time || null,
  };
}

/**
 * FIX: did not exist. index.js imports this (currently unused in the
 * routes shown, but importing an undefined name still breaks the
 * require() at module load).
 */
async function getBalances(accessToken) {
  const response = await plaidClient.accountsBalanceGet({
    access_token: accessToken,
  });
  return response.data;
}

/**
 * FIX: did not exist. sync.js's observeDomain() calls this for the
 * 'auth' domain.
 */
async function getAuth(accessToken) {
  const response = await plaidClient.authGet({
    access_token: accessToken,
  });
  return response.data;
}

/**
 * FIX: did not exist. sync.js's observeDomain() calls this for the
 * 'identity' domain.
 */
async function getIdentity(accessToken) {
  const response = await plaidClient.identityGet({
    access_token: accessToken,
  });
  return response.data;
}

/**
 * FIX: did not exist. sync.js's observeDomain() calls this for the
 * 'liabilities' domain.
 */
async function getLiabilities(accessToken) {
  const response = await plaidClient.liabilitiesGet({
    access_token: accessToken,
  });
  return response.data;
}

/**
 * FIX: did not exist. sync.js's observeDomain() calls this for the
 * 'investments' domain. Returns holdings only (investments/holdings/get)
 * — investment TRANSACTIONS is a separate, separately-paginated Plaid
 * endpoint not wired up yet (Phase F item), so this is not silently
 * folded in here.
 */
async function getInvestments(accessToken) {
  const response = await plaidClient.investmentsHoldingsGet({
    access_token: accessToken,
  });
  return response.data;
}

/**
 * FIX: did not exist. sync.js's observeDomain() calls this for the
 * 'statements' domain.
 */
async function getStatements(accessToken) {
  const response = await plaidClient.statementsList({
    access_token: accessToken,
  });
  return response.data;
}

/**
 * Returns the authoritative eight-product configuration.
 *
 * This is useful for backend diagnostics and the dashboard's
 * product-coverage intelligence.
 */
function getPlaidProducts() {
  return [...PLAID_PRODUCTS];
}
module.exports = {
  plaidClient,
  PLAID_PRODUCTS,
  PLAID_COUNTRY_CODES,
  createLinkToken,
  createUpdateModeLinkToken,
  getProductCoverage,
  getItem,
  getBalances,
  getAuth,
  getIdentity,
  getLiabilities,
  getInvestments,
  getStatements,
  getPlaidProducts,
};
