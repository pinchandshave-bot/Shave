const {
  CLASSIFICATIONS,
  ECONOMIC_ROLES,
  classifyTransaction,
} = require('./classification');

function numberValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value) {
  return Number(
    numberValue(value).toFixed(2)
  );
}

function dateOnly(value) {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function computeCashFlow(transactions) {
  const posted =
    transactions.filter(
      transaction =>
        transaction.pending === false &&
        transaction.posted_date
    );

  if (!posted.length) {
    return {
      evidence_state: 'insufficient_evidence',

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

      classified_transaction_count: 0,
      unknown_transaction_count: 0,
    };
  }

  let grossInflow = 0;
  let grossOutflow = 0;

  let economicInflow = 0;
  let economicOutflow = 0;

  let transferIn = 0;
  let transferOut = 0;

  let classifiedCount = 0;
  let unknownCount = 0;

  for (const transaction of posted) {
    const amount =
      numberValue(transaction.amount);

    const absolute =
      Math.abs(amount);

    /*
     * Gross account movement preserves everything.
     */
    if (amount < 0) {
      grossInflow += absolute;
    } else if (amount > 0) {
      grossOutflow += absolute;
    }

    const classification =
      classifyTransaction(transaction);

    if (
      classification.classification ===
      CLASSIFICATIONS.UNKNOWN
    ) {
      unknownCount += 1;
    } else {
      classifiedCount += 1;
    }

    if (
      classification.classification ===
      CLASSIFICATIONS.TRANSFER_IN
    ) {
      transferIn += absolute;
      continue;
    }

    if (
      classification.classification ===
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
      ECONOMIC_ROLES.INCOME
    ) {
      economicInflow += absolute;
      continue;
    }

    /*
     * Refunds increase economic cash flow.
     */
    if (
      classification.economic_role ===
      ECONOMIC_ROLES.REFUND
    ) {
      economicInflow += absolute;
      continue;
    }

    /*
     * Economic outflow.
     */
    if (
      classification.economic_role ===
        ECONOMIC_ROLES.SPENDING ||
      classification.economic_role ===
        ECONOMIC_ROLES.FEE ||
      classification.economic_role ===
        ECONOMIC_ROLES.LOAN_PAYMENT ||
      classification.economic_role ===
        ECONOMIC_ROLES.WITHDRAWAL
    ) {
      economicOutflow += absolute;
    }
  }

  const grossNet =
    grossInflow - grossOutflow;

  const economicNet =
    economicInflow - economicOutflow;

  const dates =
    posted
      .map(t => new Date(t.posted_date).getTime())
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

  const earliest =
    dates.length
      ? new Date(dates[0])
      : null;

  const latest =
    dates.length
      ? new Date(dates[dates.length - 1])
      : null;

  const observationDays =
    earliest && latest
      ? Math.max(
          1,
          Math.ceil(
            (latest.getTime() -
              earliest.getTime()) /
              86400000
          )
        )
      : 1;

  const coverageRatio =
    posted.length > 0
      ? classifiedCount / posted.length
      : 0;

  /*
   * Economic cash flow is only authoritative when
   * enough transactions are classified.
   */
  const economicSupported =
    coverageRatio >= 0.75 &&
    classifiedCount >= 3;

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

    gross_movement: {
      inflow: round(grossInflow),
      outflow: round(grossOutflow),
      net_change: round(grossNet),
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
      inflow: round(transferIn),
      outflow: round(transferOut),
      net: round(
        transferIn - transferOut
      ),
    },

    classified_transaction_count:
      classifiedCount,

    unknown_transaction_count:
      unknownCount,

    classification_coverage:
      Number(
        coverageRatio.toFixed(4)
      ),
  };
}

module.exports = {
  computeCashFlow,
};
