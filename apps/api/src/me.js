const pool = require('./db');

/*
 * iBag Dashboard Intelligence
 *
 * Principles:
 * - Real authenticated-user data only.
 * - No synthetic, mock, seeded, or fabricated financial data.
 * - Observed facts are separated from inferences.
 * - Every inference carries evidence and confidence.
 * - Intelligence is read-only.
 * - No money movement.
 */

/* -------------------------------------------------------------------------- */
/* GENERAL UTILITIES                                                          */
/* -------------------------------------------------------------------------- */

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value, decimals = 2) {
  const factor = Math.pow(10, decimals);
  return Math.round(number(value) * factor) / factor;
}

function dateOnly(value) {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function dateTime(value) {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function daysBetween(a, b) {
  const first = new Date(a);
  const second = new Date(b);

  if (
    Number.isNaN(first.getTime()) ||
    Number.isNaN(second.getTime())
  ) {
    return null;
  }

  return Math.abs(
    (second.getTime() - first.getTime()) /
      86400000
  );
}

function median(values) {
  if (!values.length) return null;

  const sorted = [...values].sort(
    (a, b) => a - b
  );

  const middle =
    Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (
      (sorted[middle - 1] +
        sorted[middle]) /
      2
    );
  }

  return sorted[middle];
}

function mean(values) {
  if (!values.length) return null;

  return (
    values.reduce(
      (sum, value) =>
        sum + number(value),
      0
    ) / values.length
  );
}

function standardDeviation(values) {
  if (values.length < 2) return 0;

  const average = mean(values);

  const variance =
    values.reduce(
      (sum, value) =>
        sum +
        Math.pow(
          number(value) - average,
          2
        ),
      0
    ) / values.length;

  return Math.sqrt(variance);
}

function coefficientOfVariation(values) {
  const average = mean(values);

  if (
    average === null ||
    average === 0
  ) {
    return null;
  }

  return (
    standardDeviation(values) /
    Math.abs(average)
  );
}

function classifyCadence(medianGapDays) {
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

function confidenceFromEvidence(score) {
  if (score >= 0.85) return 'high';
  if (score >= 0.65) return 'medium';
  return 'low';
}

function sourceTransaction(transaction) {
  return {
    id: transaction.id,
    plaid_transaction_id:
      transaction.plaid_transaction_id,
    merchant_name:
      transaction.merchant_name || null,
    amount: number(transaction.amount),
    iso_currency_code:
      transaction.iso_currency_code || 'USD',
    category:
      transaction.category || null,
    pending:
      Boolean(transaction.pending),
    authorized_date:
      transaction.authorized_date || null,
    posted_date:
      transaction.posted_date || null,
    account_id:
      transaction.account_id,
  };
}

/* -------------------------------------------------------------------------- */
/* TRANSACTION INTELLIGENCE                                                   */
/* -------------------------------------------------------------------------- */

function buildTransactionIntelligence(
  transactions
) {
  const observations = [];
  const relationships = [];
  const recurringPatterns = [];
  const anomalies = [];

  const usableTransactions =
    transactions.filter(
      (transaction) =>
        transaction.status === 'active'
    );

  /*
   * ------------------------------------------------------------------------
   * MERCHANT RECURRENCE
   * ------------------------------------------------------------------------
   */

  const merchantGroups = new Map();

  for (const transaction of usableTransactions) {
    const merchant =
      transaction.merchant_name
        ?.trim();

    if (!merchant) continue;

    if (!merchantGroups.has(merchant)) {
      merchantGroups.set(
        merchant,
        []
      );
    }

    merchantGroups
      .get(merchant)
      .push(transaction);
  }

  for (const [
    merchant,
    merchantTransactions,
  ] of merchantGroups.entries()) {
    const dated =
      merchantTransactions
        .filter(
          (transaction) =>
            transaction.posted_date ||
            transaction.authorized_date
        )
        .sort(
          (a, b) =>
            new Date(
              a.posted_date ||
                a.authorized_date
            ) -
            new Date(
              b.posted_date ||
                b.authorized_date
            )
        );

    if (dated.length < 3) {
      continue;
    }

    const gaps = [];

    for (
      let index = 1;
      index < dated.length;
      index++
    ) {
      const gap = daysBetween(
        dated[index - 1]
          .posted_date ||
          dated[index - 1]
            .authorized_date,
        dated[index].posted_date ||
          dated[index].authorized_date
      );

      if (
        gap !== null &&
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

    const cadence =
      classifyCadence(medianGap);

    if (cadence === 'irregular') {
      continue;
    }

    const amounts =
      dated.map((transaction) =>
        Math.abs(
          number(transaction.amount)
        )
      );

    const variation =
      coefficientOfVariation(
        amounts
      );

    const regularity =
      variation === null
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              1 - variation
            )
          );

    const recurrenceStrength =
      Math.min(
        1,
        0.55 +
          Math.min(
            0.25,
            dated.length * 0.05
          ) +
          regularity * 0.2
      );

    const confidence =
      confidenceFromEvidence(
        recurrenceStrength
      );

    recurringPatterns.push({
      type:
        'merchant_recurrence',
      merchant,
      cadence,
      occurrence_count:
        dated.length,
      median_interval_days:
        round(medianGap, 1),
      observed_amount:
        round(median(amounts)),
      amount_variability:
        variation === null
          ? null
          : round(variation, 3),
      confidence,
      confidence_score:
        round(
          recurrenceStrength,
          3
        ),
      evidence: {
        transaction_ids:
          dated.map(
            (transaction) =>
              transaction.id
          ),
        transaction_count:
          dated.length,
      },
      observed_from:
        dateOnly(
          dated[0].posted_date ||
            dated[0].authorized_date
        ),
      observed_through:
        dateOnly(
          dated[
            dated.length - 1
          ].posted_date ||
            dated[
              dated.length - 1
            ].authorized_date
        ),
    });
  }

  /*
   * ------------------------------------------------------------------------
   * POSSIBLE REVERSAL / MATCHED OPPOSING TRANSACTIONS
   * ------------------------------------------------------------------------
   *
   * We do not call this a confirmed refund/reversal.
   * We identify evidence supporting a possible relationship.
   */

  for (
    let i = 0;
    i < usableTransactions.length;
    i++
  ) {
    const first =
      usableTransactions[i];

    const firstAmount =
      number(first.amount);

    if (firstAmount === 0) {
      continue;
    }

    for (
      let j = i + 1;
      j < usableTransactions.length;
      j++
    ) {
      const second =
        usableTransactions[j];

      const secondAmount =
        number(second.amount);

      if (
        firstAmount +
          secondAmount !==
        0
      ) {
        continue;
      }

      if (
        first.iso_currency_code &&
        second.iso_currency_code &&
        first.iso_currency_code !==
          second.iso_currency_code
      ) {
        continue;
      }

      const firstMerchant =
        first.merchant_name
          ?.trim()
          .toLowerCase();

      const secondMerchant =
        second.merchant_name
          ?.trim()
          .toLowerCase();

      if (
        !firstMerchant ||
        !secondMerchant ||
        firstMerchant !==
          secondMerchant
      ) {
        continue;
      }

      const firstDate =
        first.posted_date ||
        first.authorized_date;

      const secondDate =
        second.posted_date ||
        second.authorized_date;

      const gap =
        daysBetween(
          firstDate,
          secondDate
        );

      if (
        gap === null ||
        gap > 7
      ) {
        continue;
      }

      const evidence = [
        'matching merchant',
        'matching absolute amount',
        'opposite transaction direction',
        'transactions occurred within 7 days',
      ];

      let score = 0.65;

      if (gap === 0) {
        score += 0.15;
      }

      if (
        first.posted_date &&
        second.posted_date
      ) {
        score += 0.05;
      }

      if (
        Math.abs(
          Math.abs(firstAmount) -
            Math.abs(secondAmount)
        ) < 0.01
      ) {
        score += 0.05;
      }

      const confidence =
        confidenceFromEvidence(
          Math.min(1, score)
        );

      relationships.push({
        type:
          'possible_transaction_reversal',
        status:
          'candidate',
        confidence,
        confidence_score:
          round(
            Math.min(1, score),
            3
          ),
        interpretation:
          'A possible reversal, refund, or offsetting transaction relationship was detected.',
        evidence,
        transaction_ids: [
          first.id,
          second.id,
        ],
        transactions: [
          sourceTransaction(first),
          sourceTransaction(second),
        ],
      });
    }
  }

  /*
   * ------------------------------------------------------------------------
   * LARGE MONEY MOVEMENTS
   * ------------------------------------------------------------------------
   *
   * This is an observed classification, not a claim about intent.
   */

  const absoluteAmounts =
    usableTransactions
      .map((transaction) =>
        Math.abs(
          number(transaction.amount)
        )
      )
      .filter(
        (amount) =>
          amount > 0
      );

  if (absoluteAmounts.length >= 3) {
    const medianAmount =
      median(absoluteAmounts);

    const largeThreshold =
      Math.max(
        500,
        medianAmount * 5
      );

    for (const transaction of usableTransactions) {
      const amount =
        Math.abs(
          number(transaction.amount)
        );

      if (
        amount < largeThreshold
      ) {
        continue;
      }

      observations.push({
        type:
          'large_transaction',
        classification:
          'large_money_movement',
        confidence:
          'high',
        confidence_score: 1,
        transaction:
          sourceTransaction(
            transaction
          ),
        evidence: {
          observed_amount:
            round(amount),
          user_history_median_transaction:
            round(medianAmount),
          detection_threshold:
            round(largeThreshold),
        },
        interpretation:
          'This transaction is materially larger than the typical transaction amount observed in the available history.',
        caution:
          'This does not determine whether the transaction represents spending, a transfer between accounts, a deposit, or another form of money movement.',
      });
    }
  }

  /*
   * ------------------------------------------------------------------------
   * CATEGORY BEHAVIOR
   * ------------------------------------------------------------------------
   */

  const categoryGroups =
    new Map();

  for (const transaction of usableTransactions) {
    const category =
      transaction.category?.trim() ||
      'Uncategorized';

    if (!categoryGroups.has(category)) {
      categoryGroups.set(
        category,
        []
      );
    }

    categoryGroups
      .get(category)
      .push(transaction);
  }

  for (const [
    category,
    categoryTransactions,
  ] of categoryGroups.entries()) {
    const purchases =
      categoryTransactions.filter(
        (transaction) =>
          number(transaction.amount) >
          0
      );

    if (
      purchases.length < 2
    ) {
      continue;
    }

    const total =
      purchases.reduce(
        (sum, transaction) =>
          sum +
          number(transaction.amount),
        0
      );

    observations.push({
      type:
        'category_activity',
      classification:
        'observed_category_behavior',
      category,
      confidence:
        'high',
      confidence_score: 1,
      evidence: {
        transaction_count:
          purchases.length,
        transaction_ids:
          purchases.map(
            (transaction) =>
              transaction.id
          ),
        observed_total:
          round(total),
        average_transaction:
          round(
            total /
              purchases.length
          ),
      },
      interpretation:
        `${category} activity was observed across multiple transactions in the available history.`,
    });
  }

  /*
   * ------------------------------------------------------------------------
   * ANOMALY CANDIDATES
   * ------------------------------------------------------------------------
   *
   * An anomaly is relative to the user's own observed merchant history.
   * We require enough historical observations before making the inference.
   */

  for (const [
    merchant,
    merchantTransactions,
  ] of merchantGroups.entries()) {
    const amounts =
      merchantTransactions
        .map((transaction) =>
          Math.abs(
            number(transaction.amount)
          )
        )
        .filter(
          (amount) =>
            amount > 0
        );

    if (
      amounts.length < 4
    ) {
      continue;
    }

    const average =
      mean(amounts);

    const deviation =
      standardDeviation(
        amounts
      );

    if (
      !deviation ||
      average === null
    ) {
      continue;
    }

    for (const transaction of merchantTransactions) {
      const amount =
        Math.abs(
          number(transaction.amount)
        );

      const zScore =
        Math.abs(
          (amount - average) /
            deviation
        );

      if (zScore < 2.5) {
        continue;
      }

      anomalies.push({
        type:
          'merchant_amount_anomaly',
        merchant,
        transaction_id:
          transaction.id,
        observed_amount:
          round(amount),
        merchant_average:
          round(average),
        merchant_standard_deviation:
          round(deviation),
        deviation_score:
          round(zScore, 2),
        confidence:
          'medium',
        confidence_score:
          0.72,
        interpretation:
          'This transaction amount is materially different from the historical amounts observed for this merchant.',
        evidence: {
          historical_transaction_count:
            amounts.length,
        },
      });
    }
  }

  /*
   * ------------------------------------------------------------------------
   * SUMMARY
   * ------------------------------------------------------------------------
   */

  const positiveTransactions =
    usableTransactions.filter(
      (transaction) =>
        number(transaction.amount) >
        0
    );

  const negativeTransactions =
    usableTransactions.filter(
      (transaction) =>
        number(transaction.amount) <
        0
    );

  const totalOut =
    positiveTransactions.reduce(
      (sum, transaction) =>
        sum +
        number(transaction.amount),
      0
    );

  const totalIn =
    negativeTransactions.reduce(
      (sum, transaction) =>
        sum +
        Math.abs(
          number(transaction.amount)
        ),
      0
    );

  return {
    version: '2.0.0',

    source: {
      type:
        'AUTHORIZED_FINANCIAL_DATA',
      transaction_count:
        usableTransactions.length,
      generated_at:
        new Date().toISOString(),
    },

    observed_financial_activity: {
      transaction_count:
        usableTransactions.length,
      money_out:
        round(totalOut),
      money_in:
        round(totalIn),
    },

    recurring_patterns:
      recurringPatterns,

    relationships,

    observations,

    anomalies,

    counts: {
      recurring_patterns:
        recurringPatterns.length,
      relationships:
        relationships.length,
      observations:
        observations.length,
      anomalies:
        anomalies.length,
    },

    integrity: {
      synthetic_data_used: false,
      mock_data_used: false,
      seeded_financial_data_used: false,
      read_only: true,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* REAL TRANSACTION FETCH                                                     */
/* -------------------------------------------------------------------------- */

async function getUserTransactions(
  userId
) {
  const result = await pool.query(
    `
      SELECT
        t.id,
        t.account_id,
        t.plaid_transaction_id,
        t.amount,
        t.iso_currency_code,
        t.merchant_name,
        t.category,
        t.pending,
        t.authorized_date,
        t.posted_date,
        t.status,
        t.created_at
      FROM transactions t
      INNER JOIN accounts a
        ON a.id = t.account_id
      INNER JOIN plaid_items p
        ON p.id = a.plaid_item_id
      WHERE p.user_id = $1
        AND p.status = 'active'
        AND t.status = 'active'
      ORDER BY
        COALESCE(
          t.posted_date,
          t.authorized_date
        ) ASC NULLS LAST,
        t.created_at ASC
    `,
    [userId]
  );

  return result.rows;
}

/* -------------------------------------------------------------------------- */
/* CURRENT USER                                                               */
/* -------------------------------------------------------------------------- */

async function getMe(req, res) {
  try {
    const userResult = await pool.query(
      `
        SELECT
          id,
          email,
          created_at
        FROM users
        WHERE id = $1
        LIMIT 1
      `,
      [req.user.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found',
      });
    }

    const user = userResult.rows[0];

    const ibagResult = await pool.query(
      `
        SELECT
          id,
          user_id,
          created_at
        FROM ibags
        WHERE user_id = $1
        LIMIT 1
      `,
      [user.id]
    );

    const accountsResult =
      await pool.query(
        `
          SELECT
            a.id,
            a.plaid_account_id,
            a.name,
            a.mask,
            a.type,
            a.subtype,
            a.current_balance,
            a.available_balance,
            a.balance_iso_currency_code,
            a.balance_updated_at,
            p.id AS plaid_item_db_id,
            p.plaid_item_id,
            p.institution_name
          FROM accounts a
          INNER JOIN plaid_items p
            ON p.id = a.plaid_item_id
          WHERE p.user_id = $1
            AND p.status = 'active'
          ORDER BY a.created_at ASC
        `,
        [user.id]
      );

    return res.json({
      status: 'ok',
      user,
      ibag:
        ibagResult.rows[0] ||
        null,
      accounts:
        accountsResult.rows,
    });
  } catch (err) {
    console.error(
      'Get current user failed:',
      err
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your iBag right now',
    });
  }
}

/* -------------------------------------------------------------------------- */
/* DASHBOARD                                                                  */
/* -------------------------------------------------------------------------- */

async function getDashboard(req, res) {
  const userId = req.user.id;

  try {
    /*
     * ACCOUNTS
     */

    const accountsResult =
      await pool.query(
        `
          SELECT
            a.id,
            a.plaid_account_id,
            a.name,
            a.mask,
            a.type,
            a.subtype,
            a.current_balance,
            a.available_balance,
            a.balance_iso_currency_code,
            a.balance_updated_at,
            p.institution_name
          FROM accounts a
          INNER JOIN plaid_items p
            ON p.id = a.plaid_item_id
          WHERE p.user_id = $1
            AND p.status = 'active'
          ORDER BY a.created_at ASC
        `,
        [userId]
      );

    /*
     * REAL TRANSACTIONS
     */

    const transactions =
      await getUserTransactions(
        userId
      );

    /*
     * TRANSACTION STATE
     */

    const transactionStateResult =
      await pool.query(
        `
          SELECT
            COUNT(*)::int AS transaction_count,

            COUNT(*) FILTER (
              WHERE t.pending = true
            )::int AS pending_transaction_count,

            COUNT(*) FILTER (
              WHERE t.pending = false
            )::int AS posted_transaction_count,

            MIN(
              COALESCE(
                t.posted_date,
                t.authorized_date
              )
            ) AS observation_start,

            MAX(
              COALESCE(
                t.posted_date,
                t.authorized_date
              )
            ) AS observation_end

          FROM transactions t

          INNER JOIN accounts a
            ON a.id = t.account_id

          INNER JOIN plaid_items p
            ON p.id = a.plaid_item_id

          WHERE p.user_id = $1
            AND p.status = 'active'
            AND t.status = 'active'
        `,
        [userId]
      );

    /*
     * ROUND-UP STATE
     */

    const roundupStateResult =
      await pool.query(
        `
          SELECT
            COUNT(*)::int AS eligible_purchase_count,

            COALESCE(
              SUM(r.roundup_amount),
              0
            ) AS roundup_opportunity,

            COALESCE(
              AVG(r.roundup_amount),
              0
            ) AS average_roundup,

            COALESCE(
              MIN(r.roundup_amount),
              0
            ) AS smallest_roundup,

            COALESCE(
              MAX(r.roundup_amount),
              0
            ) AS largest_roundup

          FROM roundup_events r

          INNER JOIN transactions t
            ON t.id = r.transaction_id

          INNER JOIN accounts a
            ON a.id = t.account_id

          INNER JOIN plaid_items p
            ON p.id = a.plaid_item_id

          WHERE r.user_id = $1
            AND p.user_id = $1
            AND p.status = 'active'
            AND r.status = 'active'
            AND r.eligible = true
            AND t.status = 'active'
        `,
        [userId]
      );

    /*
     * ROUND-UP BY CATEGORY
     */

    const roundupCategoryResult =
      await pool.query(
        `
          SELECT
            COALESCE(
              NULLIF(t.category, ''),
              'Uncategorized'
            ) AS category,

            COUNT(*)::int AS purchase_count,

            COALESCE(
              SUM(r.roundup_amount),
              0
            ) AS roundup_opportunity

          FROM roundup_events r

          INNER JOIN transactions t
            ON t.id = r.transaction_id

          INNER JOIN accounts a
            ON a.id = t.account_id

          INNER JOIN plaid_items p
            ON p.id = a.plaid_item_id

          WHERE r.user_id = $1
            AND p.user_id = $1
            AND p.status = 'active'
            AND r.status = 'active'
            AND r.eligible = true
            AND t.status = 'active'

          GROUP BY
            COALESCE(
              NULLIF(t.category, ''),
              'Uncategorized'
            )

          ORDER BY
            roundup_opportunity DESC
        `,
        [userId]
      );

    /*
     * ROUND-UP BY MERCHANT
     */

    const roundupMerchantResult =
      await pool.query(
        `
          SELECT
            COALESCE(
              NULLIF(t.merchant_name, ''),
              'Unknown merchant'
            ) AS merchant,

            COUNT(*)::int AS purchase_count,

            COALESCE(
              SUM(r.roundup_amount),
              0
            ) AS roundup_opportunity,

            COALESCE(
              AVG(r.roundup_amount),
              0
            ) AS average_roundup

          FROM roundup_events r

          INNER JOIN transactions t
            ON t.id = r.transaction_id

          INNER JOIN accounts a
            ON a.id = t.account_id

          INNER JOIN plaid_items p
            ON p.id = a.plaid_item_id

          WHERE r.user_id = $1
            AND p.user_id = $1
            AND p.status = 'active'
            AND r.status = 'active'
            AND r.eligible = true
            AND t.status = 'active'

          GROUP BY
            COALESCE(
              NULLIF(t.merchant_name, ''),
              'Unknown merchant'
            )

          ORDER BY
            roundup_opportunity DESC
        `,
        [userId]
      );

    /*
     * RECENT ROUND-UPS
     */

    const recentRoundupsResult =
      await pool.query(
        `
          SELECT
            r.id,
            r.transaction_id,
            r.roundup_amount,
            r.transaction_amount,
            r.eligibility_reason,
            r.rule_version,

            t.merchant_name,
            t.category,
            t.amount,
            t.iso_currency_code,
            t.pending,
            t.authorized_date,
            t.posted_date,

            a.name AS account_name,
            a.mask AS account_mask

          FROM roundup_events r

          INNER JOIN transactions t
            ON t.id = r.transaction_id

          INNER JOIN accounts a
            ON a.id = t.account_id

          INNER JOIN plaid_items p
            ON p.id = a.plaid_item_id

          WHERE r.user_id = $1
            AND p.user_id = $1
            AND p.status = 'active'
            AND r.status = 'active'
            AND r.eligible = true
            AND t.status = 'active'

          ORDER BY
            COALESCE(
              t.posted_date,
              t.authorized_date
            ) DESC NULLS LAST,

            t.created_at DESC

          LIMIT 10
        `,
        [userId]
      );

    /*
     * NORMALIZE STATES
     */

    const transactionState =
      transactionStateResult
        .rows[0] || {
        transaction_count: 0,
        pending_transaction_count: 0,
        posted_transaction_count: 0,
        observation_start: null,
        observation_end: null,
      };

    const roundupState =
      roundupStateResult
        .rows[0] || {
        eligible_purchase_count: 0,
        roundup_opportunity: 0,
        average_roundup: 0,
        smallest_roundup: 0,
        largest_roundup: 0,
      };

    /*
     * INTELLIGENCE
     *
     * Read-only computation over the exact transactions
     * already belonging to this authenticated user.
     */

    const intelligence =
      buildTransactionIntelligence(
        transactions
      );

    /*
     * RETURN DASHBOARD
     */

    return res.json({
      status: 'ok',

      user: null,

      observation: {
        earliest_transaction_date:
          transactionState.observation_start,

        latest_transaction_date:
          transactionState.observation_end,
      },

      data_state: {
        accounts_available:
          accountsResult.rows.length >
          0,

        transactions_available:
          Number(
            transactionState.transaction_count
          ) > 0,

        roundup_available:
          Number(
            roundupState.eligible_purchase_count
          ) > 0,

        intelligence_available:
          transactions.length > 0,
      },

      accounts:
        accountsResult.rows,

      summary: {
        transaction_count:
          Number(
            transactionState.transaction_count
          ),

        posted_transaction_count:
          Number(
            transactionState.posted_transaction_count
          ),

        pending_transaction_count:
          Number(
            transactionState.pending_transaction_count
          ),

        eligible_purchase_count:
          Number(
            roundupState.eligible_purchase_count
          ),

        roundup_opportunity:
          roundupState.roundup_opportunity,
      },

      categories:
        roundupCategoryResult.rows,

      merchants:
        roundupMerchantResult.rows,

      recent_roundups:
        recentRoundupsResult.rows,

      transaction_state:
        transactionState,

      roundup:
        roundupState,

      roundup_by_category:
        roundupCategoryResult.rows,

      roundup_by_merchant:
        roundupMerchantResult.rows,

      /*
       * NEW:
       *
       * The dashboard now receives actual explainable
       * financial intelligence derived from its real
       * transaction history.
       */
      intelligence,
    });
  } catch (err) {
    console.error(
      'Get dashboard failed:',
      err
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your financial dashboard',
      detail:
        process.env.NODE_ENV === 'production'
          ? undefined
          : err.message,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* SUMMARY                                                                    */
/* -------------------------------------------------------------------------- */

async function getSummary(req, res) {
  try {
    const result = await pool.query(
      `
        SELECT
          COUNT(*)::int AS transaction_count,
          COALESCE(
            SUM(amount),
            0
          ) AS transaction_total

        FROM transactions t

        INNER JOIN accounts a
          ON a.id = t.account_id

        INNER JOIN plaid_items p
          ON p.id = a.plaid_item_id

        WHERE p.user_id = $1
          AND p.status = 'active'
          AND t.status = 'active'
      `,
      [req.user.id]
    );

    return res.json({
      status: 'ok',
      summary: result.rows[0],
    });
  } catch (err) {
    console.error(
      'Get summary failed:',
      err
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your financial summary',
    });
  }
}

/* -------------------------------------------------------------------------- */
/* ACCOUNTS                                                                   */
/* -------------------------------------------------------------------------- */

async function getAccounts(req, res) {
  try {
    const result = await pool.query(
      `
        SELECT
          a.id,
          a.plaid_account_id,
          a.name,
          a.mask,
          a.type,
          a.subtype,
          a.current_balance,
          a.available_balance,
          a.balance_iso_currency_code,
          a.balance_updated_at,
          p.institution_name,
          p.plaid_item_id

        FROM accounts a

        INNER JOIN plaid_items p
          ON p.id = a.plaid_item_id

        WHERE p.user_id = $1
          AND p.status = 'active'

        ORDER BY a.created_at ASC
      `,
      [req.user.id]
    );

    return res.json({
      status: 'ok',
      accounts: result.rows,
    });
  } catch (err) {
    console.error(
      'Get accounts failed:',
      err
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your accounts',
    });
  }
}

/* -------------------------------------------------------------------------- */
/* TRANSACTIONS                                                               */
/* -------------------------------------------------------------------------- */

async function getTransactions(req, res) {
  try {
    const result =
      await pool.query(
        `
          SELECT
            t.id,
            t.account_id,
            t.plaid_transaction_id,
            t.amount,
            t.iso_currency_code,
            t.merchant_name,
            t.category,
            t.pending,
            t.authorized_date,
            t.posted_date,
            t.status

          FROM transactions t

          INNER JOIN accounts a
            ON a.id = t.account_id

          INNER JOIN plaid_items p
            ON p.id = a.plaid_item_id

          WHERE p.user_id = $1
            AND p.status = 'active'
            AND t.status = 'active'

          ORDER BY
            COALESCE(
              t.posted_date,
              t.authorized_date
            ) DESC NULLS LAST,

            t.created_at DESC
        `,
        [req.user.id]
      );

    return res.json({
      status: 'ok',
      transactions:
        result.rows,
    });
  } catch (err) {
    console.error(
      'Get transactions failed:',
      err
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your transactions',
    });
  }
}

/* -------------------------------------------------------------------------- */
/* INSIGHTS                                                                   */
/* -------------------------------------------------------------------------- */

async function getInsights(req, res) {
  try {
    const transactions =
      await getUserTransactions(
        req.user.id
      );

    const intelligence =
      buildTransactionIntelligence(
        transactions
      );

    return res.json({
      status: 'ok',
      intelligence,
      insights: [
        ...intelligence.recurring_patterns,
        ...intelligence.relationships,
        ...intelligence.observations,
        ...intelligence.anomalies,
      ],
    });
  } catch (err) {
    console.error(
      'Get insights failed:',
      err
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your insights',
    });
  }
}

/* -------------------------------------------------------------------------- */
/* NET WORTH                                                                  */
/* -------------------------------------------------------------------------- */

async function getNetWorth(req, res) {
  try {
    const result = await pool.query(
      `
        SELECT
          COALESCE(
            SUM(a.current_balance),
            0
          ) AS net_worth

        FROM accounts a

        INNER JOIN plaid_items p
          ON p.id = a.plaid_item_id

        WHERE p.user_id = $1
          AND p.status = 'active'
      `,
      [req.user.id]
    );

    return res.json({
      status: 'ok',
      net_worth:
        result.rows[0].net_worth,
    });
  } catch (err) {
    console.error(
      'Get net worth failed:',
      err
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your net worth',
    });
  }
}

/* -------------------------------------------------------------------------- */
/* INCOME                                                                     */
/* -------------------------------------------------------------------------- */

async function getIncome(req, res) {
  try {
    return res.json({
      status: 'ok',
      income: null,
      message:
        'Income analysis requires qualifying connected financial data.',
    });
  } catch (err) {
    console.error(
      'Get income failed:',
      err
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your income',
    });
  }
}

/* -------------------------------------------------------------------------- */
/* CASH FLOW                                                                  */
/* -------------------------------------------------------------------------- */

async function getCashFlow(req, res) {
  try {
    return res.json({
      status: 'ok',
      cash_flow: null,
      message:
        'Cash-flow analysis requires qualifying connected financial data.',
    });
  } catch (err) {
    console.error(
      'Get cash flow failed:',
      err
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your cash flow',
    });
  }
}

/* -------------------------------------------------------------------------- */
/* EXPORTS                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  getMe,
  getDashboard,
  getSummary,
  getAccounts,
  getTransactions,
  getInsights,
  getNetWorth,
  getIncome,
  getCashFlow,
};
