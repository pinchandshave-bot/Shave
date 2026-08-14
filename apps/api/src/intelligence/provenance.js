const {
  classifyTransaction,
} = require('./classification');

function buildTransactionProvenance(transaction) {
  const classification =
    classifyTransaction(transaction);

  return {
    plaid_transaction_id:
      transaction.plaid_transaction_id,

    canonical_transaction_id:
      transaction.id,

    transaction: {
      amount: transaction.amount,
      merchant_name:
        transaction.merchant_name,
      category:
        transaction.category,
      pending:
        transaction.pending,
      authorized_date:
        transaction.authorized_date,
      posted_date:
        transaction.posted_date,
    },

    classification: {
      type:
        classification.classification,

      economic_role:
        classification.economic_role,

      confidence:
        classification.confidence,

      reason:
        classification.reason,

      evidence:
        classification.evidence,
    },
  };
}

function buildIntelligenceProvenance({
  domain,
  transactionIds = [],
  calculation,
  evidenceState,
}) {
  return {
    domain,

    source: {
      type: 'plaid_transaction',
      transaction_count:
        transactionIds.length,
      transaction_ids:
        transactionIds,
    },

    pipeline: [
      'plaid_transaction',
      'canonical_transaction',
      'classification',
      'eligibility_or_state',
      'deterministic_calculation',
      'aggregate',
      'intelligence_statement',
    ],

    calculation:
      calculation || null,

    evidence_state:
      evidenceState,
  };
}

module.exports = {
  buildTransactionProvenance,
  buildIntelligenceProvenance,
};
