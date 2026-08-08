const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const env = process.env.PLAID_ENV || 'sandbox';
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

// Single source of truth for which products we request. Balance isn't listed
// here deliberately — it's not a Link-time product, it's a per-request call
// (/accounts/balance/get) made after an Item already exists.
const PLAID_PRODUCTS = ['auth', 'transactions', 'liabilities', 'investments', 'identity'];

module.exports = { plaidClient, PLAID_PRODUCTS };
