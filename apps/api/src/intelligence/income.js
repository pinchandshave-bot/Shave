const {
  CLASSIFICATIONS,
  classifyTransaction,
} = require('./classification');

function numberValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value, decimals = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  return Number(n.toFixed(decimals));
}

function median(values) {
  const sorted =
    values
      .filter(Number.isFinite)
      .slice()
      .sort((a, b) => a - b);

  if (!sorted.length) return null;

  const middle =
    Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (
      sorted[middle - 1] +
      sorted[middle]
    ) / 2;
  }

  return sorted[middle];
}

function mean(values) {
  const valid =
    values.filter(Number.isFinite);

  if (!valid.length) return null;

  return (
    valid.reduce(
      (sum, value) => sum + value,
      0
    ) / valid.length
  );
}

function standardDeviation(values) {
  const valid =
    values.filter(Number.isFinite);

  if (valid.length < 2) return 0;

  const average = mean(valid);

  return Math.sqrt(
    valid.reduce(
      (sum, value) =>
        sum +
        Math.pow(
          value - average,
          2
        ),
      0
    ) / valid.length
  );
}

function cadenceFromGap(gap) {
  if (gap >= 5 && gap <= 9) {
    return 'weekly';
  }

  if (gap >= 12 && gap <= 17) {
    return 'biweekly';
  }

  if (gap >= 27 && gap <= 33) {
    return 'monthly';
  }

  return 'irregular';
}

function confidence({
  occurrences,
  reliability,
  amountConsistency,
}) {
  if (occurrences < 3) {
    return 'insufficient';
  }

  if (
    occurrences >= 6 &&
    reliability >= 0.75 &&
    amountConsistency >= 0.75
  ) {
    return 'high';
  }

  if (
    occurrences >= 4 &&
    reliability >= 0.5
  ) {
    return 'medium';
  }

  return 'low';
}

function buildIncomeIntelligence(transactions) {
  /*
   * IMPORTANT:
   *
   * Only transactions explicitly classified as INCOME
   * participate in actual income intelligence.
   *
   * Unknown incoming money remains unknown.
   */
  const income =
    transactions.filter(transaction => {
      if (
        transaction.pending !== false ||
        !transaction.posted_date
      ) {
        return false;
      }

      const result =
        classifyTransaction(transaction);

      return (
        result.classification ===
        CLASSIFICATIONS.INCOME
      );
    });

  if (income.length < 3) {
    return {
      evidence_state: 'insufficient_evidence',
      classified_income_count: income.length,
      signal: null,
      candidates: [],
    };
  }

  const groups = new Map();

  for (const transaction of income) {
    const merchant =
      String(
        transaction.merchant_name || ''
      ).trim();

    /*
     * We only create recurrence groups when
     * a merchant/source is actually available.
     *
     * Amount-only grouping is intentionally
     * excluded from "income" classification.
     */
    if (!merchant) continue;

    if (!groups.has(merchant)) {
      groups.set(merchant, []);
    }

    groups.get(merchant).push(
      transaction
    );
  }

  const candidates = [];

  for (const [source, group] of groups) {
    if (group.length < 3) continue;

    const dates =
      group
        .map(t =>
          new Date(
            t.posted_date
          ).getTime()
        )
        .filter(Number.isFinite)
        .sort((a, b) => a - b);

    if (dates.length < 3) continue;

    const gaps = [];

    for (let i = 1; i < dates.length; i += 1) {
      const gap =
        (dates[i] - dates[i - 1]) /
        86400000;

      if (gap > 0) {
        gaps.push(gap);
      }
    }

    if (gaps.length < 2) continue;

    const medianGap = median(gaps);
    const averageGap = mean(gaps);
    const gapStddev =
      standardDeviation(gaps);

    const reliability =
      averageGap > 0
        ? Math.max(
            0,
            Math.min(
              1,
              1 -
                gapStddev /
                  averageGap
            )
          )
        : 0;

    const cadence =
      cadenceFromGap(medianGap);

    if (cadence === 'irregular') {
      continue;
    }

    const amounts =
      group.map(t =>
        Math.abs(
          numberValue(t.amount)
        )
      );

    const typicalAmount =
      median(amounts);

    const amountMean =
      mean(amounts);

    const amountStddev =
      standardDeviation(amounts);

    const amountConsistency =
      amountMean > 0
        ? Math.max(
            0,
            Math.min(
              1,
              1 -
                amountStddev /
                  amountMean
            )
          )
        : 0;

    const confidenceLevel =
      confidence({
        occurrences: group.length,
        reliability,
        amountConsistency,
      });

    const lastTimestamp =
      dates[dates.length - 1];

    const nextExpected =
      new Date(
        lastTimestamp +
          medianGap * 86400000
      );

    candidates.push({
      source,
      classification:
        CLASSIFICATIONS.INCOME,
      cadence,
      typical_amount:
        round(typicalAmount),
      occurrences: group.length,
      reliability:
        round(reliability, 2),
      amount_consistency:
        round(amountConsistency, 2),
      confidence:
        confidenceLevel,
      last_detected_date:
        new Date(lastTimestamp)
          .toISOString()
          .slice(0, 10),
      next_expected_date:
        nextExpected
          .toISOString()
          .slice(0, 10),
    });
  }

  candidates.sort(
    (a, b) =>
      b.occurrences -
      a.occurrences
  );

  if (!candidates.length) {
    return {
      evidence_state: 'insufficient_evidence',
      classified_income_count: income.length,
      signal: null,
      candidates: [],
    };
  }

  const signal = candidates[0];

  return {
    evidence_state:
      signal.confidence === 'insufficient'
        ? 'insufficient_evidence'
        : 'supported',

    classified_income_count:
      income.length,

    signal,

    candidates,
  };
}

module.exports = {
  buildIncomeIntelligence,
};
