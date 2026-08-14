const {
  getFinancialIntelligence,
} = require('./intelligence');


/*
 * ============================================================================
 * iBag Income Compatibility Layer
 * ============================================================================
 *
 * intelligence.js is the authoritative financial-intelligence engine.
 *
 * This module exists only so existing routes/imports that reference
 * income.js continue to work while the application transitions to the
 * unified intelligence architecture.
 *
 * It does NOT independently analyze transactions.
 */


/**
 * Compatibility wrapper for existing income callers.
 */
async function computeIncomeSignals(userId) {
  const intelligence =
    await getFinancialIntelligence(
      userId
    );

  return (
    intelligence.income || {
      evidence_state:
        'insufficient_evidence',

      signal: null,

      candidates: [],
    }
  );
}


/**
 * Compatibility wrapper for existing cash-flow/runway callers.
 *
 * The authoritative calculations come from:
 *
 * intelligence.cash_flow
 * intelligence.balance
 */
async function computeCashflowRunway(userId) {
  const intelligence =
    await getFinancialIntelligence(
      userId
    );

  const cashFlow =
    intelligence.cash_flow;

  const balance =
    intelligence.balance;

  return {
    evidence_state:
      balance &&
      balance.evidence_state
        ? balance.evidence_state
        : 'insufficient_evidence',

    total_cash:
      balance
        ? balance.total_cash
        : null,

    total_in:
      cashFlow
        ? cashFlow.inflow
        : null,

    total_out:
      cashFlow
        ? cashFlow.outflow
        : null,

    net_daily_change:
      cashFlow
        ? cashFlow.daily_net_change
        : null,

    runway_days:
      balance
        ? balance.runway_days
        : null,

    runway_months:
      balance
        ? balance.runway_months
        : null,

    status:
      balance
        ? balance.status
        : 'insufficient_data',

    based_on_days:
      cashFlow
        ? cashFlow.observation_days
        : 0,
  };
}


module.exports = {
  computeIncomeSignals,
  computeCashflowRunway,
};
