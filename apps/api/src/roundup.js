const RENT_SIZED_THRESHOLD = 800;
const RULE_VERSION = 'ROUNDUP_STANDARD_V1';

/**
 * Determine whether a transaction is eligible for Round-Up intelligence.
 *
 * Rules:
 * - Amount must be finite.
 * - Amount must be positive.
 * - Amount must be below $800.
 * - Transaction must have a non-zero next-dollar difference.
 */
function getRoundupEligibility(amount) {
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

  const roundup = Number(
    (Math.ceil(numericAmount) - numericAmount).toFixed(2)
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

/**
 * Calculate the exact Round-Up amount.
 *
 * Returns 0 when the transaction is not eligible.
 */
function calculateRoundup(amount) {
  const numericAmount = Number(amount);
  const eligibility = getRoundupEligibility(numericAmount);

  if (!eligibility.eligible) {
    return 0;
  }

  return Number(
    (Math.ceil(numericAmount) - numericAmount).toFixed(2)
  );
}

module.exports = {
  calculateRoundup,
  getRoundupEligibility,
  RENT_SIZED_THRESHOLD,
  RULE_VERSION,
};
