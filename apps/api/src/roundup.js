const RENT_SIZED_THRESHOLD = 800;
const RULE_VERSION = 'ROUNDUP_STANDARD_V1';

/**
 * Determines whether a transaction is eligible for Round-Up
 * intelligence.
 *
 * This function contains no randomness, external state, or fabricated
 * assumptions. The same transaction amount always produces the same
 * result.
 */
function getRoundupEligibility(amount) {
  if (!Number.isFinite(amount)) {
    return {
      eligible: false,
      reason: 'INVALID_AMOUNT',
      ruleVersion: RULE_VERSION,
    };
  }

  if (amount <= 0) {
    return {
      eligible: false,
      reason: 'NON_POSITIVE_TRANSACTION',
      ruleVersion: RULE_VERSION,
    };
  }

  if (amount >= RENT_SIZED_THRESHOLD) {
    return {
      eligible: false,
      reason: 'ABOVE_ROUNDUP_THRESHOLD',
      ruleVersion: RULE_VERSION,
    };
  }

  const roundedUp = Math.ceil(amount);
  const roundup = Number(
    (roundedUp - amount).toFixed(2)
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
 * Returns 0 for transactions that cannot generate a Round-Up.
 */
function calculateRoundup(amount) {
  const eligibility = getRoundupEligibility(amount);

  if (!eligibility.eligible) {
    return 0;
  }

  return Number(
    (Math.ceil(amount) - amount).toFixed(2)
  );
}


module.exports = {
  calculateRoundup,
  getRoundupEligibility,
  RENT_SIZED_THRESHOLD,
  RULE_VERSION,
};
