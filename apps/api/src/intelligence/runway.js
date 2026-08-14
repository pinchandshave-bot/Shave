function numberValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value) {
  if (value === null) return null;

  return Number(
    Number(value).toFixed(2)
  );
}

function calculateRunway({
  totalCash,
  cashFlow,
}) {
  /*
   * RUNWAY IS EVIDENCE-GATED.
   *
   * Never use gross movement.
   * Never use unclassified net change.
   */

  if (
    !cashFlow ||
    cashFlow.evidence_state !==
      'supported'
  ) {
    return {
      runway_days: null,
      runway_months: null,
      daily_burn: null,
      evidence_state: 'insufficient',
      status: 'insufficient_evidence',
    };
  }

  const balance =
    numberValue(totalCash);

  const economicNet =
    numberValue(
      cashFlow.economic_cash_flow
        ?.net_change
    );

  const observationDays =
    Number(
      cashFlow.observation_days
    );

  if (
    balance === null ||
    economicNet === null ||
    !Number.isFinite(observationDays) ||
    observationDays < 7
  ) {
    return {
      runway_days: null,
      runway_months: null,
      daily_burn: null,
      evidence_state: 'insufficient',
      status: 'insufficient_evidence',
    };
  }

  if (economicNet >= 0) {
    return {
      runway_days: null,
      runway_months: null,
      daily_burn: null,
      evidence_state: 'supported',
      status: 'stable_or_growing',
    };
  }

  const dailyBurn =
    Math.abs(economicNet) /
    observationDays;

  if (
    !Number.isFinite(dailyBurn) ||
    dailyBurn <= 0
  ) {
    return {
      runway_days: null,
      runway_months: null,
      daily_burn: null,
      evidence_state: 'insufficient',
      status: 'insufficient_evidence',
    };
  }

  const runwayDays =
    Math.max(
      0,
      Math.floor(
        balance /
          dailyBurn
      )
    );

  return {
    runway_days: runwayDays,

    runway_months:
      round(
        runwayDays / 30.4375
      ),

    daily_burn:
      round(dailyBurn),

    evidence_state: 'supported',

    status: 'declining',
  };
}

module.exports = {
  calculateRunway,
};
