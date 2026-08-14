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
 */
async function createLinkToken(userId) {
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
  getPlaidProducts,
};
