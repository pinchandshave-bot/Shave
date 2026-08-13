'use strict';

const {
  EVIDENCE_TYPE
} = require('./types');

function sourceTransaction(transaction, reason = null) {
  return {
    type: EVIDENCE_TYPE.SOURCE_TRANSACTION,

    transactionId:
      transaction.id ||
      transaction.plaid_transaction_id ||
      transaction.transaction_id ||
      null,

    accountId:
      transaction.account_id ||
      null,

    reason
  };
}

function derivedCalculation({
  method,
  inputs,
  result
}) {
  return {
    type: EVIDENCE_TYPE.DERIVED_CALCULATION,
    method,
    inputs,
    result
  };
}

function relatedObservation(observationId, relationship) {
  return {
    type: EVIDENCE_TYPE.RELATED_OBSERVATION,
    observationId,
    relationship
  };
}

function createEvidence(items = []) {
  return items.filter(Boolean);
}

module.exports = {
  sourceTransaction,
  derivedCalculation,
  relatedObservation,
  createEvidence
};
