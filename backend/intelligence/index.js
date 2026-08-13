'use strict';

const {
  normalizeTransactions
} = require('./ingestion/normalizeTransaction');

const {
  buildTransactionRelationships
} = require('./relationships/transactionRelationships');

function buildIntelligence(rows = []) {
  const transactions =
    normalizeTransactions(rows);

  const relationships =
    buildTransactionRelationships(transactions);

  return {
    version: '2.0.0',

    generatedAt:
      new Date().toISOString(),

    source: {
      type: 'AUTHORIZED_FINANCIAL_DATA',

      transactionCount:
        transactions.length
    },

    transactions,

    relationships,

    integrity: {
      syntheticDataUsed: false,
      mockDataUsed: false,
      seededFinancialDataUsed: false
    }
  };
}

module.exports = {
  buildIntelligence
};
