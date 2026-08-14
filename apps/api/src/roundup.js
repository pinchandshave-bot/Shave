const {
  classifyTransaction,
  isEligiblePurchaseClassification,
} = require('./intelligence/classification');

const RENT_SIZED_THRESHOLD = 800;
const RULE_VERSION = 'ROUNDUP_STANDARD_V2';

function getRoundupEligibility(amount, transaction = null) {
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount)) {
    return {
      eligible: false,
      reason: 'INVALID_AMOUNT',
      ruleVersion: RULE_VERSION,
    };
  }

  if (numericAmount <= 0) {
    return {
      eligible: false,
      reason: 'NON_POSITIVE_TRANSACTION',
      ruleVersion: RULE_VERSION,
    };
  }

  if (numericAmount >= RENT_SIZED_THRESHOLD) {
    return {
      eligible: false,
      reason: 'ABOVE_ROUNDUP_THRESHOLD',
      ruleVersion: RULE_VERSION,
    };
  }

  if (transaction) {
    const classification =
      classifyTransaction(transaction);

    if (
      !isEligiblePurchaseClassification(
        classification
      )
    ) {
      return {
        eligible: false,
        reason:
          `NOT_ELIGIBLE_${classification.type}`,
        classification,
        ruleVersion: RULE_VERSION,
      };
    }
  }

  const roundup = Number(
    (
      Math.ceil(numericAmount) -
      numericAmount
    ).toFixed(2)
  );

  if (roundup <= 0) {
    return {
      eligible: false,
      reason: 'ALREADY_WHOLE_DOLLAR',
      ruleVersion: RULE_VERSION,
    };
  }

  if (roundup >= 1) {
    return {
      eligible: false,
      reason: 'INVALID_ROUNDUP_AMOUNT',
      ruleVersion: RULE_VERSION,
    };
  }

  return {
    eligible: true,
    reason: 'ELIGIBLE_PURCHASE',
    ruleVersion: RULE_VERSION,
  };
}

function calculateRoundup(
  amount,
  transaction = null
) {
  const numericAmount = Number(amount);

  const eligibility =
    getRoundupEligibility(
      numericAmount,
      transaction
    );

  if (!eligibility.eligible) {
    return 0;
  }

  return Number(
    (
      Math.ceil(numericAmount) -
      numericAmount
    ).toFixed(2)
  );
}

module.exports = {
  calculateRoundup,
  getRoundupEligibility,
  RENT_SIZED_THRESHOLD,
  RULE_VERSION,
};
