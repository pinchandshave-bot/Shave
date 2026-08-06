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

module.exports = plaidClient;
