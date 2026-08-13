const pool = require('./db');


function median(values) {
  if (!values.length) return null;

  const sorted = [...values]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!sorted.length) return null;

  const middle =
    Math.floor(sorted.length / 2);

  return sorted.length % 2 !== 0
    ? sorted[middle]
    : (
        sorted[middle - 1] +
        sorted[middle]
      ) / 2;
}


function standardDeviation(values) {
  if (values.length < 2) return 0;

  const mean =
    values.reduce(
      (sum, value) =>
        sum + value,
      0
    ) / values.length;

  const variance =
    values.reduce(
      (sum, value) =>
        sum +
        Math.pow(
          value - mean,
          2
        ),
      0
    ) / values.length;

  return Math.sqrt(variance);
}


function classifyCadence(
  medianGapDays
) {
  if (
    medianGapDays >= 5 &&
    medianGapDays <= 9
  ) {
    return 'weekly';
  }

  if (
    medianGapDays >= 12 &&
    medianGapDays <= 17
  ) {
    return 'biweekly';
  }

  if (
    medianGapDays >= 27 &&
    medianGapDays <= 33
  ) {
    return 'monthly';
  }

  return 'irregular';
}


function confidenceFromEvidence({
  occurrences,
  reliability,
  cadence,
}) {
  if (
    cadence === 'irregular' ||
    occurrences < 3
  ) {
    return 'insufficient';
  }

  if (
    occurrences >= 6 &&
    reliability >= 0.75
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


async function computeIncomeSignals(
  userId
) {
  const result =
    await pool.query(
      `
        SELECT
          t.id,
          t.merchant_name,
          t.amount,
          t.posted_date,
          t.iso_currency_code

        FROM transactions t

        INNER JOIN accounts a
          ON a.id = t.account_id

        INNER JOIN plaid_items p
          ON p.id = a.plaid_item_id

        WHERE p.user_id = $1
          AND p.status = 'active'
          AND t.status = 'active'
          AND t.pending = false
          AND t.amount < 0
          AND t.posted_date IS NOT NULL

        ORDER BY
          t.posted_date ASC
      `,
      [userId]
    );

  /*
   * Negative transactions represent
   * money entering the account under
   * the established iBag transaction
   * convention.
   */

  const groups = {};

  for (const transaction of result.rows) {
    const amount =
      Math.abs(
        Number(transaction.amount)
      );

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      continue;
    }

    /*
     * Prefer merchant grouping.
     *
     * Where merchant information is absent,
     * amount grouping is retained as a
     * candidate signal but receives lower
     * confidence because multiple income
     * sources can share similar amounts.
     */

    const merchant =
      transaction.merchant_name &&
      transaction.merchant_name.trim()
        ? transaction.merchant_name.trim()
        : null;

    const key =
      merchant ||
      `amount:${Math.round(
        amount
      )}`;

    if (!groups[key]) {
      groups[key] = {
        label: merchant,
        amount_based: !merchant,
        transactions: [],
      };
    }

    groups[key].transactions.push(
      transaction
    );
  }

  let candidates = [];

  for (const group of Object.values(groups)) {
    const transactions =
      group.transactions;

    if (transactions.length < 3) {
      continue;
    }

    const dates =
      transactions
        .map(
          transaction =>
            new Date(
              transaction.posted_date
            ).getTime()
        )
        .filter(Number.isFinite);

    if (dates.length < 3) {
      continue;
    }

    const gaps = [];

    for (
      let index = 1;
      index < dates.length;
      index++
    ) {
      const gap =
        (
          dates[index] -
          dates[index - 1]
        ) /
        86400000;

      if (
        Number.isFinite(gap) &&
        gap > 0
      ) {
        gaps.push(gap);
      }
    }

    if (gaps.length < 2) {
      continue;
    }

    const medianGap =
      median(gaps);

    const averageGap =
      gaps.reduce(
        (sum, gap) =>
          sum + gap,
        0
      ) / gaps.length;

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
      classifyCadence(
        medianGap
      );

    if (
      cadence === 'irregular'
    ) {
      continue;
    }

    const amounts =
      transactions.map(
        transaction =>
          Math.abs(
            Number(
              transaction.amount
            )
          )
      );

    const typicalAmount =
      median(amounts);

    const lastDate =
      new Date(
        dates[dates.length - 1]
      );

    const nextExpectedDate =
      new Date(
        lastDate.getTime() +
          medianGap *
            86400000
      );

    const confidence =
      confidenceFromEvidence({
        occurrences:
          transactions.length,
        reliability,
        cadence,
      });

    /*
     * Score the candidate using:
     *
     * - recurrence
     * - cadence consistency
     * - amount consistency
     * - source identification
     *
     * This is not a probability of employment
     * or guaranteed future income.
     */

    const amountMean =
      amounts.reduce(
        (sum, value) =>
          sum + value,
        0
      ) / amounts.length;

    const amountStddev =
      standardDeviation(
        amounts
      );

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

    const recurrenceScore =
      Math.min(
        1,
        transactions.length /
          8
      );

    const sourceScore =
      group.amount_based
        ? 0.5
        : 1;

    const score =
      (
        recurrenceScore *
        0.35
      ) +
      (
        reliability *
        0.35
      ) +
      (
        amountConsistency *
        0.2
      ) +
      (
        sourceScore *
        0.1
      );

    candidates.push({
      sourceLabel:
        group.label ||
        null,

      grouping:
        group.amount_based
          ? 'amount'
          : 'merchant',

      cadence,

      typicalAmount,

      reliability,

      amountConsistency,

      occurrences:
        transactions.length,

      lastDetectedDate:
        lastDate,

      nextExpectedDate,

      confidence,

      score,
    });
  }

  candidates =
    candidates.sort(
      (a, b) =>
        b.score -
        a.score
    );

  const best =
    candidates.length
      ? candidates[0]
      : null;

  if (!best) {
    return {
      evidence_state:
        'insufficient_evidence',

      signal: null,

      candidates: [],
    };
  }

  /*
   * Persist the detected signal.
   *
   * This is an analytical record derived
   * from real financial data. It does not
   * move money.
   */

  await pool.query(
    `
      INSERT INTO income_signals
      (
        user_id,
        detected_cadence,
        average_amount,
        reliability_score,
        source_merchant,
        last_detected_date,
        next_expected_date
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7
      )
    `,
    [
      userId,

      best.cadence,

      Math.round(
        best.typicalAmount *
          100
      ) / 100,

      Math.round(
        best.reliability *
          100
      ) / 100,

      best.sourceLabel,

      best.lastDetectedDate
        .toISOString()
        .slice(0, 10),

      best.nextExpectedDate
        .toISOString()
        .slice(0, 10),
    ]
  );

  return {
    evidence_state:
      best.confidence ===
      'insufficient'
        ? 'insufficient_evidence'
        : 'supported',

    signal: {
      source:
        best.sourceLabel,

      grouping:
        best.grouping,

      cadence:
        best.cadence,

      typical_amount:
        Math.round(
          best.typicalAmount *
            100
        ) / 100,

      occurrences:
        best.occurrences,

      reliability:
        Math.round(
          best.reliability *
            100
        ) / 100,

      amount_consistency:
        Math.round(
          best.amountConsistency *
            100
        ) / 100,

      confidence:
        best.confidence,

      last_detected_date:
        best.lastDetectedDate
          .toISOString()
          .slice(0, 10),

      next_expected_date:
        best.nextExpectedDate
          .toISOString()
          .slice(0, 10),
    },

    candidates:
      candidates.map(
        candidate => ({
          source:
            candidate.sourceLabel,

          grouping:
            candidate.grouping,

          cadence:
            candidate.cadence,

          typical_amount:
            Math.round(
              candidate.typicalAmount *
                100
            ) / 100,

          occurrences:
            candidate.occurrences,

          reliability:
            Math.round(
              candidate.reliability *
                100
            ) / 100,

          confidence:
            candidate.confidence,
        })
      ),
  };
}


async function computeCashflowRunway(
  userId
) {
  const cashResult =
    await pool.query(
      `
        SELECT
          COALESCE(
            SUM(
              a.current_balance
            ),
            0
          ) AS total_cash

        FROM accounts a

        INNER JOIN plaid_items p
          ON p.id = a.plaid_item_id

        WHERE p.user_id = $1
          AND p.status = 'active'
          AND a.type = 'depository'
      `,
      [userId]
    );

  const totalCash =
    Number(
      cashResult.rows[0]
        .total_cash
    ) || 0;

  const flowResult =
    await pool.query(
      `
        SELECT
          COALESCE(
            SUM(
              CASE
                WHEN t.amount > 0
                THEN t.amount
                ELSE 0
              END
            ),
            0
          ) AS total_out,

          COALESCE(
            SUM(
              CASE
                WHEN t.amount < 0
                THEN -t.amount
                ELSE 0
              END
            ),
            0
          ) AS total_in,

          MIN(t.posted_date)
            AS earliest,

          MAX(t.posted_date)
            AS latest

        FROM transactions t

        INNER JOIN accounts a
          ON a.id = t.account_id

        INNER JOIN plaid_items p
          ON p.id = a.plaid_item_id

        WHERE p.user_id = $1
          AND p.status = 'active'
          AND t.status = 'active'
          AND t.pending = false
          AND t.posted_date >=
            CURRENT_DATE - INTERVAL '30 days'
      `,
      [userId]
    );

  const row =
    flowResult.rows[0];

  if (
    !row.earliest ||
    !row.latest
  ) {
    return {
      evidence_state:
        'insufficient_evidence',

      total_cash:
        Math.round(
          totalCash * 100
        ) / 100,

      net_daily_change:
        null,

      runway_days:
        null,

      status:
        'insufficient_data',
    };
  }

  const windowDays =
    Math.max(
      1,
      Math.ceil(
        (
          new Date(
            row.latest
          ) -
          new Date(
            row.earliest
          )
        ) /
          86400000
      )
    );

  const totalOut =
    Number(
      row.total_out
    ) || 0;

  const totalIn =
    Number(
      row.total_in
    ) || 0;

  const netDailyChange =
    (
      totalIn -
      totalOut
    ) / windowDays;

  /*
   * Negative means observed cash
   * is declining.
   */

  const runwayDays =
    netDailyChange < 0
      ? Math.max(
          0,
          Math.round(
            totalCash /
              Math.abs(
                netDailyChange
              )
          )
        )
      : null;

  return {
    evidence_state:
      'supported',

    total_cash:
      Math.round(
        totalCash * 100
      ) / 100,

    total_in:
      Math.round(
        totalIn * 100
      ) / 100,

    total_out:
      Math.round(
        totalOut * 100
      ) / 100,

    net_daily_change:
      Math.round(
        netDailyChange * 100
      ) / 100,

    runway_days:
      runwayDays,

    status:
      netDailyChange < 0
        ? 'declining'
        : 'stable_or_growing',

    based_on_days:
      windowDays,
  };
}


module.exports = {
  computeIncomeSignals,
  computeCashflowRunway,
};
