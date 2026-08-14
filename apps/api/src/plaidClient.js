const {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
} = require('plaid');

const env = process.env.PLAID_ENV || 'sandbox';

if (!PlaidEnvironments[env]) {
  throw new Error(
    `Invalid PLAID_ENV "${env}". Expected one of: ${Object.keys(
      PlaidEnvironments
    ).join(', ')}`
  );
}

if (!process.env.PLAID_CLIENT_ID) {
  throw new Error('PLAID_CLIENT_ID is required');
}

if (!process.env.PLAID_SECRET) {
  throw new Error('PLAID_SECRET is required');
}

const configuration = new Configuration({
  basePath: PlaidEnvironments[env],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(configuration);

/*
 * --------------------------------------------------------------------------
 * iBag / PLAID TRIAL PRODUCT BUNDLE
 * --------------------------------------------------------------------------
 *
 * Plaid's current US/Canada Trial plan provides these eight bundled
 * products:
 *
 * 1. Auth
 * 2. Transactions
 * 3. Balance
 * 4. Identity
 * 5. Assets
 * 6. Liabilities
 * 7. Investments
 * 8. Statements
 *
 * Round-Ups are NOT a Plaid product.
 * Round-Ups are iBag intelligence derived from financial data.
 *
 * Balance is a Plaid financial-data product. It is not an iBag
 * monetization product.
 */

const PLAID_PRODUCTS = [
  'auth',
  'transactions',
  'balance',
  'identity',
  'assets',
  'liabilities',
  'investments',
  'statements',
];

/*
 * Canonical iBag product registry.
 *
 * Keeping this separate from PLAID_PRODUCTS lets the intelligence layer
 * reason about every supported domain without hard-coding product logic
 * throughout the application.
 */

const IBAG_PLAID_PRODUCTS = [
  {
    key: 'auth',
    name: 'Auth',
    intelligence_domain: 'account_access',
  },
  {
    key: 'transactions',
    name: 'Transactions',
    intelligence_domain: 'transaction_behavior',
  },
  {
    key: 'balance',
    name: 'Balance',
    intelligence_domain: 'liquidity',
  },
  {
    key: 'identity',
    name: 'Identity',
    intelligence_domain: 'financial_identity',
  },
  {
    key: 'assets',
    name: 'Assets',
    intelligence_domain: 'assets',
  },
  {
    key: 'liabilities',
    name: 'Liabilities',
    intelligence_domain: 'debt_and_obligations',
  },
  {
    key: 'investments',
    name: 'Investments',
    intelligence_domain: 'investment_position',
  },
  {
    key: 'statements',
    name: 'Statements',
    intelligence_domain: 'documentary_financial_history',
  },
];

const PLAID_PRODUCT_KEYS = IBAG_PLAID_PRODUCTS.map(
  (product) => product.key
);

module.exports = {
  plaidClient,
  PLAID_PRODUCTS,
  PLAID_PRODUCT_KEYS,
  IBAG_PLAID_PRODUCTS,
  PLAID_ENV: env,
};
