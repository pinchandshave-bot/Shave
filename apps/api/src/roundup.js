const {
  classifyTransaction,
  CLASSIFICATIONS,
} = require('./intelligence/classification');

const RENT_SIZED_THRESHOLD = 800;
const RULE_VERSION = 'ROUNDUP_STANDARD_V2';

function getRoundupEligibility(transactionOrAmount) {
  /*
   * Backward-compatible numeric handling.
   * Financial intelligence should preferably pass the
   * complete transaction so classification can occur first.
   */
  const transaction =
    typeof transactionOrAmount === 'object'
      ? transactionOrAmount
      : {
          amount: transactionOrAmount,
        };

  const numericAmount = Number(transaction.amount);

  if (!Number.isFinite(numericAmount)) {
    return {
      eligible: false,
      reason: 'INVALID_AMOUNT',
      ruleVersion: RULE_VERSION,
      classification: CLASSIFICATIONS.UNKNOWN,
    };
  }

  const classification =
    classifyTransaction(transaction);

  if (
    classification.classification !==
    CLASSIFICATIONS.PURCHASE
  ) {
    return {
      eligible: false,
      reason: `NOT_PURCHASE:${classification.classification}`,
      ruleVersion: RULE_VERSION,
      classification:
        classification.classification,
      economicRole:
        classification.economic_role,
    };
  }

  if (numericAmount <= 0) {
    return {
      eligible: false,
      reason: 'NON_POSITIVE_TRANSACTION',
      ruleVersion: RULE_VERSION,
      classification:
        classification.classification,
    };
  }

  if (numericAmount >= RENT_SIZED_THRESHOLD) {
    return {
      eligible: false,
      reason: 'ABOVE_ROUNDUP_THRESHOLD',
      ruleVersion: RULE_VERSION,
      classification:
        classification.classification,
    };
  }

  const roundup = Number(
    (Math.ceil(numericAmount) - numericAmount)
      .toFixed(2)
  );

  if (roundup <= 0) {
    return {
      eligible: false,
      reason: 'ALREADY_WHOLE_DOLLAR',
      ruleVersion: RULE_VERSION,
      classification:
        classification.classification,
    };
  }

  if (roundup >= 1) {
    return {
      eligible: false,
      reason: 'INVALID_ROUNDUP_AMOUNT',
      ruleVersion: RULE_VERSION,
      classification:
        classification.classification,
    };
  }

  return {
    eligible: true,
    reason: 'ELIGIBLE_PURCHASE',
    ruleVersion: RULE_VERSION,
    classification:
      classification.classification,
    economicRole:
      classification.economic_role,
  };
}

function calculateRoundup(transactionOrAmount) {
  const transaction =
    typeof transactionOrAmount === 'object'
      ? transactionOrAmount
      : {
          amount: transactionOrAmount,
        };

  const eligibility =
    getRoundupEligibility(transaction);

  if (!eligibility.eligible) {
    return 0;
  }

  const numericAmount =
    Number(transaction.amount);

  return Number(
    (Math.ceil(numericAmount) - numericAmount)
      .toFixed(2)
  );
}

module.exports = {
  calculateRoundup,
  getRoundupEligibility,
  RENT_SIZED_THRESHOLD,
  RULE_VERSION,
};
