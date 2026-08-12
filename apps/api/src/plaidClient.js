const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

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
 * Products requested during Link.
 *
 * Balance is intentionally excluded because balances are retrieved
 * separately through /accounts/balance/get after an Item exists.
 */
const PLAID_PRODUCTS = [
  'auth',
  'transactions',
  'liabilities',
  'investments',
  'identity',
];

module.exports = {
  plaidClient,
  PLAID_PRODUCTS,
  PLAID_ENV: env,
};
