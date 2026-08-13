'use strict';

const {
  INTELLIGENCE_DOMAIN,
  INTELLIGENCE_STATUS,
  CONFIDENCE_LEVEL
} = require('../core/types');

const {
  sourceTransaction,
  relatedObservation,
  createEvidence
} = require('../core/evidence');

const {
  confidenceFromEvidence
} = require('../core/confidence');

const {
  createObservation
} = require('../core/observation');

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizedMerchant(transaction) {
  return String(transaction.merchantKey || '')
    .trim()
    .toLowerCase();
}

function amount(transaction) {
  return transaction.absoluteAmount === null
    ? null
    : Number(transaction.absoluteAmount.toFixed(2));
}

function transactionDate(transaction) {
  const value =
    transaction.postedDate ||
    transaction.authorizedDate;

  if (!value) return null;

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? null
    : date;
}

function daysBetween(a, b) {
  const first = transactionDate(a);
  const second = transactionDate(b);

  if (!first || !second) return null;

  return Math.abs(
    second.getTime() - first.getTime()
  ) / DAY_MS;
}

function oppositeFlow(a, b) {
  if (!a || !b) return false;

  /*
   * We deliberately do not infer financial direction solely from
   * positive/negative amount. The canonical transaction's normalized
   * flow metadata must establish the distinction.
   */

  return (
    a.flowType &&
    b.flowType &&
    a.flowType !== b.flowType
  );
}

function sameAccount(a, b) {
  return Boolean(
    a.accountId &&
    b.accountId &&
    a.accountId === b.accountId
  );
}

/* -------------------------------------------------------------------------- */
/* Same-merchant relationships                                                */
/* -------------------------------------------------------------------------- */

function findMerchantRelationships(transactions) {
  const results = [];

  for (let i = 0; i < transactions.length; i += 1) {
    for (let j = i + 1; j < transactions.length; j += 1) {
      const a = transactions[i];
      const b = transactions[j];

      if (!a.id || !b.id) continue;

      const merchantA = normalizedMerchant(a);
      const merchantB = normalizedMerchant(b);

      if (!merchantA || merchantA !== merchantB) {
        continue;
      }

      const interval = daysBetween(a, b);

      results.push({
        type: 'SAME_MERCHANT',
        sourceTransactionId: a.id,
        relatedTransactionId: b.id,

        relationship: {
          merchantMatch: true,
          sameAccount: sameAccount(a, b),
          daysApart: interval
        }
      });
    }
  }

  return results;
}

/* -------------------------------------------------------------------------- */
/* Possible reversal relationships                                             */
/* -------------------------------------------------------------------------- */

function findPossibleReversals(transactions) {
  const observations = [];

  for (let i = 0; i < transactions.length; i += 1) {
    const a = transactions[i];

    for (let j = i + 1; j < transactions.length; j += 1) {
      const b = transactions[j];

      if (!a.id || !b.id) continue;

      if (
        amount(a) === null ||
        amount(b) === null
      ) {
        continue;
      }

      if (amount(a) !== amount(b)) {
        continue;
      }

      if (
        normalizedMerchant(a) === '' ||
        normalizedMerchant(a) !== normalizedMerchant(b)
      ) {
        continue;
      }

      if (!oppositeFlow(a, b)) {
        continue;
      }

      const interval = daysBetween(a, b);

      if (interval === null || interval > 3) {
        continue;
      }

      const evidence = createEvidence([
        sourceTransaction(
          a,
          'First transaction in possible reversal relationship.'
        ),

        sourceTransaction(
          b,
          'Second transaction in possible reversal relationship.'
        )
      ]);

      const confidence = confidenceFromEvidence([
        {
          name: 'same merchant',
          strength: 'HIGH'
        },
        {
          name: 'same absolute amount',
          strength: 'HIGH'
        },
        {
          name: 'opposite transaction classifications',
          strength: 'HIGH'
        },
        {
          name: 'close temporal proximity',
          strength: 'MEDIUM'
        }
      ]);

      observations.push(
        createObservation({
          domain: INTELLIGENCE_DOMAIN.REVERSAL,

          status: INTELLIGENCE_STATUS.INFERRED,

          subject: {
            type: 'TRANSACTION_RELATIONSHIP',

            transactionIds: [
              a.id,
              b.id
            ]
          },

          claim:
            'These transactions may represent a reversal, refund, or offsetting financial event.',

          value: {
            merchant: a.merchantName,
            amount: amount(a),
            daysApart: Number(interval.toFixed(2))
          },

          unit: 'FINANCIAL_EVENT_RELATIONSHIP',

          confidence,

          evidence,

          reasoning: {
            method:
              'MERCHANT_AMOUNT_FLOW_TEMPORAL_MATCH',

            rules: [
              'merchant must match',
              'absolute amounts must match',
              'transaction classifications must differ',
              'transactions must occur within three days'
            ]
          },

          temporal: {
            state: 'ESTABLISHED',

            validFrom:
              transactionDate(a)?.toISOString() ||
              null,

            validTo:
              transactionDate(b)?.toISOString() ||
              null
          },

          dependencies: [],

          source: {
            type: 'AUTHORIZED_FINANCIAL_DATA'
          }
        })
      );
    }
  }

  return observations;
}

/* -------------------------------------------------------------------------- */
/* Pending → posted relationship candidates                                   */
/* -------------------------------------------------------------------------- */

function findPendingPostedCandidates(transactions) {
  const observations = [];

  const pending = transactions.filter(
    transaction => transaction.pending
  );

  const posted = transactions.filter(
    transaction => !transaction.pending
  );

  for (const pendingTransaction of pending) {
    for (const postedTransaction of posted) {
      if (
        !pendingTransaction.id ||
        !postedTransaction.id ||
        pendingTransaction.id === postedTransaction.id
      ) {
        continue;
      }

      if (
        !sameAccount(
          pendingTransaction,
          postedTransaction
        )
      ) {
        continue;
      }

      if (
        normalizedMerchant(pendingTransaction) !==
        normalizedMerchant(postedTransaction)
      ) {
        continue;
      }

      const pendingAmount = amount(pendingTransaction);
      const postedAmount = amount(postedTransaction);

      if (
        pendingAmount === null ||
        postedAmount === null
      ) {
        continue;
      }

      /*
       * Exact matching is deliberately required here.
       * We do not silently assume that a near amount represents
       * the same transaction.
       */

      if (pendingAmount !== postedAmount) {
        continue;
      }

      const interval = daysBetween(
        pendingTransaction,
        postedTransaction
      );

      if (
        interval === null ||
        interval > 7
      ) {
        continue;
      }

      const confidence = confidenceFromEvidence([
        {
          name: 'same account',
          strength: 'VERY_HIGH'
        },
        {
          name: 'same merchant',
          strength: 'HIGH'
        },
        {
          name: 'same amount',
          strength: 'HIGH'
        },
        {
          name: 'pending-to-posted lifecycle',
          strength: 'VERY_HIGH'
        }
      ]);

      observations.push(
        createObservation({
          domain: INTELLIGENCE_DOMAIN.TRANSACTION,

          status: INTELLIGENCE_STATUS.INFERRED,

          subject: {
            type: 'TRANSACTION_LIFECYCLE',

            transactionIds: [
              pendingTransaction.id,
              postedTransaction.id
            ]
          },

          claim:
            'These records may represent the pending-to-posted lifecycle of the same financial transaction.',

          value: {
            merchant:
              pendingTransaction.merchantName,

            amount: pendingAmount,

            daysApart:
              Number(interval.toFixed(2))
          },

          unit: 'FINANCIAL_EVENT_RELATIONSHIP',

          confidence,

          evidence: createEvidence([
            sourceTransaction(
              pendingTransaction,
              'Pending transaction candidate.'
            ),

            sourceTransaction(
              postedTransaction,
              'Posted transaction candidate.'
            )
          ]),

          reasoning: {
            method:
              'ACCOUNT_MERCHANT_AMOUNT_LIFECYCLE_MATCH'
          },

          temporal: {
            state: 'CURRENT',

            validFrom:
              transactionDate(
                pendingTransaction
              )?.toISOString() || null,

            validTo:
              transactionDate(
                postedTransaction
              )?.toISOString() || null
          },

          dependencies: [],

          source: {
            type: 'AUTHORIZED_FINANCIAL_DATA'
          }
        })
      );
    }
  }

  return observations;
}

/* -------------------------------------------------------------------------- */
/* Public relationship contract                                               */
/* -------------------------------------------------------------------------- */

function buildTransactionRelationships(transactions = []) {
  if (!Array.isArray(transactions)) {
    throw new TypeError(
      'buildTransactionRelationships expects an array.'
    );
  }

  const merchantRelationships =
    findMerchantRelationships(transactions);

  const reversalObservations =
    findPossibleReversals(transactions);

  const pendingPostedObservations =
    findPendingPostedCandidates(transactions);

  return {
    relationships: merchantRelationships,

    observations: [
      ...reversalObservations,
      ...pendingPostedObservations
    ],

    counts: {
      merchantRelationships:
        merchantRelationships.length,

      reversalCandidates:
        reversalObservations.length,

      pendingPostedCandidates:
        pendingPostedObservations.length
    }
  };
}

module.exports = {
  buildTransactionRelationships,
  findMerchantRelationships,
  findPossibleReversals,
  findPendingPostedCandidates
};
