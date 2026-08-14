const {
  CLASSIFICATIONS,
  ECONOMIC_ROLES,
  classifyTransaction,
} = require('./classification');


function computeCashFlowIntelligence(
  transactions
) {
  const posted =
    transactions.filter(
      transaction =>
        transaction.pending === false &&
        transaction.posted_date
    );

  if (!posted.length) {
    return {
      evidence_state:
        'insufficient_evidence',

      observation_days: 0,

      earliest_date: null,
      latest_date: null,

      transaction_count: 0,

      gross_movement: {
        inflow: 0,
        outflow: 0,
        net_change: null,
      },

      economic_cash_flow: {
        inflow: null,
        outflow: null,
        net_change: null,
      },

      transfers: {
        inflow: 0,
        outflow: 0,
        net: 0,
      },

      daily_economic_inflow: null,
      daily_economic_outflow: null,
      daily_economic_net_change: null,

      classified_transaction_count: 0,
      unknown_transaction_count: 0,

      classification_coverage: 0,

      direction: 'unknown',
    };
  }


  /* --------------------------------------------------------------------------
   * OBSERVATION WINDOW
   * ------------------------------------------------------------------------ */

  const timestamps =
    posted
      .map(
        transaction =>
          new Date(
            transaction.posted_date
          ).getTime()
      )
      .filter(Number.isFinite)
      .sort(
        (a, b) => a - b
      );

  const earliest =
    timestamps.length
      ? new Date(timestamps[0])
      : null;

  const latest =
    timestamps.length
      ? new Date(
          timestamps[
            timestamps.length - 1
          ]
        )
      : null;

  const observationDays =
    earliest && latest
      ? Math.max(
          1,
          Math.ceil(
            (
              latest.getTime() -
              earliest.getTime()
            ) / 86400000
          )
        )
      : 1;


  /* --------------------------------------------------------------------------
   * AGGREGATES
   * ------------------------------------------------------------------------ */

  let grossInflow = 0;
  let grossOutflow = 0;

  let economicInflow = 0;
  let economicOutflow = 0;

  let transferIn = 0;
  let transferOut = 0;

  let classifiedCount = 0;
  let unknownCount = 0;


  /* --------------------------------------------------------------------------
   * CLASSIFICATION-AWARE PROCESSING
   * ------------------------------------------------------------------------ */

  for (const transaction of posted) {
    const amount =
      Number(transaction.amount);

    if (!Number.isFinite(amount)) {
      unknownCount += 1;
      continue;
    }

    const absolute =
      Math.abs(amount);


    /*
     * Gross movement preserves the
     * account-level reality.
     */
    if (amount < 0) {
      grossInflow += absolute;
    } else if (amount > 0) {
      grossOutflow += absolute;
    }


    const classification =
      classifyTransaction(
        transaction
      );


    if (
      classification.type ===
        CLASSIFICATIONS.UNKNOWN
    ) {
      unknownCount += 1;
    } else {
      classifiedCount += 1;
    }


    /*
     * Transfers are account movement,
     * not economic cash flow.
     */
    if (
      classification.type ===
      CLASSIFICATIONS.TRANSFER_IN
    ) {
      transferIn += absolute;
      continue;
    }


    if (
      classification.type ===
      CLASSIFICATIONS.TRANSFER_OUT
    ) {
      transferOut += absolute;
      continue;
    }


    /*
     * Economic inflow.
     */
    if (
      classification.economic_role ===
      ECONOMIC_ROLES.ECONOMIC_INFLOW
    ) {
      economicInflow += absolute;
      continue;
    }


    /*
     * Economic outflow.
     */
    if (
      classification.economic_role ===
      ECONOMIC_ROLES.ECONOMIC_OUTFLOW
    ) {
      economicOutflow += absolute;
      continue;
    }

    /*
     * ACCOUNT_MOVEMENT_ONLY and UNKNOWN
     * do not enter economic cash flow.
     */
  }


  /* --------------------------------------------------------------------------
   * ECONOMIC EVIDENCE
   * ------------------------------------------------------------------------ */

  const coverage =
    posted.length > 0
      ? classifiedCount /
        posted.length
      : 0;

  const economicSupported =
    coverage >= 0.75 &&
    classifiedCount >= 3;


  const grossNet =
    grossInflow -
    grossOutflow;

  const economicNet =
    economicInflow -
    economicOutflow;


  const dailyEconomicInflow =
    economicSupported
      ? economicInflow /
        observationDays
      : null;

  const dailyEconomicOutflow =
    economicSupported
      ? economicOutflow /
        observationDays
      : null;

  const dailyEconomicNet =
    economicSupported
      ? economicNet /
        observationDays
      : null;


  let direction =
    'unknown';

  if (
    economicSupported
  ) {
    if (
      dailyEconomicNet > 0.01
    ) {
      direction = 'positive';
    } else if (
      dailyEconomicNet < -0.01
    ) {
      direction = 'negative';
    } else {
      direction = 'stable';
    }
  }


  return {
    evidence_state:
      economicSupported
        ? 'supported'
        : 'insufficient_evidence',

    observation_days:
      observationDays,

    earliest_date:
      dateOnly(earliest),

    latest_date:
      dateOnly(latest),

    transaction_count:
      posted.length,


    gross_movement: {
      inflow:
        round(grossInflow),

      outflow:
        round(grossOutflow),

      net_change:
        round(grossNet),
    },


    economic_cash_flow: {
      inflow:
        economicSupported
          ? round(economicInflow)
          : null,

      outflow:
        economicSupported
          ? round(economicOutflow)
          : null,

      net_change:
        economicSupported
          ? round(economicNet)
          : null,
    },


    transfers: {
      inflow:
        round(transferIn),

      outflow:
        round(transferOut),

      net:
        round(
          transferIn -
          transferOut
        ),
    },


    daily_economic_inflow:
      dailyEconomicInflow === null
        ? null
        : round(
            dailyEconomicInflow
          ),

    daily_economic_outflow:
      dailyEconomicOutflow === null
        ? null
        : round(
            dailyEconomicOutflow
          ),

    daily_economic_net_change:
      dailyEconomicNet === null
        ? null
        : round(
            dailyEconomicNet
          ),


    classified_transaction_count:
      classifiedCount,

    unknown_transaction_count:
      unknownCount,

    classification_coverage:
      Number(
        coverage.toFixed(4)
      ),

    direction,
  };
}
