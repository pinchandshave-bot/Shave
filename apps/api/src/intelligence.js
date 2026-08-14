const pool = require('./db');

/*
 * ============================================================================
 * iBag Financial Intelligence Engine
 * ============================================================================
 *
 * PHASE 1 CONTRACT
 * ----------------
 * - Read-only intelligence
 * - Real authorized financial data only
 * - No money movement
 * - No fake/mock/seeded financial data
 * - No fabricated conclusions
 * - Evidence-gated analysis
 *
 * AUTHORITY
 * ---------
 * This file is the authoritative financial-intelligence engine.
 *
 * Other modules must NOT independently calculate competing versions of:
 *
 * - income
 * - cash flow
 * - runway
 * - spending behavior
 * - roundup intelligence
 *
 * They may consume this engine through compatibility wrappers.
 *
 * EVIDENCE STATES
 * --------------
 * observed
 *     Directly present in authorized records.
 *
 * calculated
 *     Deterministically derived from observed records.
 *
 * inferred
 *     A pattern supported by sufficient evidence.
 *
 * limited
 *     Some evidence exists, but not enough for strong confidence.
 *
 * insufficient_evidence
 *     Not enough evidence to responsibly calculate the requested signal.
 */


/* ============================================================================
 * NUMERIC HELPERS
 * ========================================================================== */

function numberValue(value) {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : 0;
}


function nullableNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}


function round(value, decimals = 2) {
  if (value === null || value === undefined) {
    return null;
  }

  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  const factor = Math.pow(10, decimals);

  return Math.round(
    (numeric + Number.EPSILON) * factor
  ) / factor;
}


function median(values) {
  const valid = values
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!valid.length) {
    return null;
  }

  const middle =
    Math.floor(valid.length / 2);

  if (valid.length % 2 === 0) {
    return (
      valid[middle - 1] +
      valid[middle]
    ) / 2;
  }

  return valid[middle];
}


function mean(values) {
  const valid = values.filter(
    Number.isFinite
  );

  if (!valid.length) {
    return null;
  }

  return (
    valid.reduce(
      (sum, value) => sum + value,
      0
    ) / valid.length
  );
}


function standardDeviation(values) {
  const valid = values.filter(
    Number.isFinite
  );

  if (valid.length < 2) {
    return 0;
  }

  const average = mean(valid);

  if (average === null) {
    return 0;
  }

  const variance =
    valid.reduce(
      (sum, value) =>
        sum +
        Math.pow(
          value - average,
          2
        ),
      0
    ) / valid.length;

  return Math.sqrt(variance);
}


function daysBetween(first, second) {
  if (!first || !second) {
    return null;
  }

  const a = new Date(first);
  const b = new Date(second);

  const difference =
    b.getTime() -
    a.getTime();

  if (!Number.isFinite(difference)) {
    return null;
  }

  return difference / 86400000;
}


function dateOnly(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date
    .toISOString()
    .slice(0, 10);
}


/* ============================================================================
 * TRANSACTION LOAD
 * ========================================================================== */

async function loadTransactions(userId) {
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
        t.created_at,

        a.name AS account_name,
        a.mask AS account_mask,
        a.type AS account_type,
        a.subtype AS account_subtype,

        p.institution_name

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
        ) ASC,

        t.created_at ASC
    `,
    [userId]
  );

  return result.rows;
}


/* ============================================================================
 * ACCOUNT LOAD
 * ========================================================================== */

async function loadAccounts(userId) {
  const result = await pool.query(
    `
      SELECT
        a.id,
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

  return result.rows;
}


/* ============================================================================
 * ROUND-UP INTELLIGENCE
 * ========================================================================== */

async function computeRoundupIntelligence(userId) {
  const result = await pool.query(
    `
      SELECT
        r.id,
        r.roundup_amount,
        r.transaction_amount,
        r.eligibility_reason,
        r.rule_version,

        t.id AS transaction_id,
        t.amount,
        t.merchant_name,
        t.category,
        t.pending,
        t.authorized_date,
        t.posted_date,
        t.iso_currency_code,

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
    `,
    [userId]
  );

  const rows = result.rows;

  if (!rows.length) {
    return {
      evidence_state:
        'insufficient_evidence',

      eligible_purchase_count: 0,

      opportunity: 0,
      average: 0,
      median: 0,
      smallest: 0,
      largest: 0,

      category_concentration: [],
      merchant_concentration: [],

      recent: [],
    };
  }

  const values = rows
    .map(row =>
      numberValue(
        row.roundup_amount
      )
    )
    .filter(value => value >= 0);

  if (!values.length) {
    return {
      evidence_state:
        'insufficient_evidence',

      eligible_purchase_count: 0,

      opportunity: 0,
      average: 0,
      median: 0,
      smallest: 0,
      largest: 0,

      category_concentration: [],
      merchant_concentration: [],

      recent: [],
    };
  }

  const opportunity =
    values.reduce(
      (sum, value) =>
        sum + value,
      0
    );

  const categories = {};
  const merchants = {};

  for (const row of rows) {
    const category =
      row.category &&
      row.category.trim()
        ? row.category.trim()
        : 'Uncategorized';

    const merchant =
      row.merchant_name &&
      row.merchant_name.trim()
        ? row.merchant_name.trim()
        : 'Unknown merchant';

    const roundupAmount =
      numberValue(
        row.roundup_amount
      );

    if (!categories[category]) {
      categories[category] = {
        name: category,
        purchases: 0,
        opportunity: 0,
      };
    }

    categories[category].purchases += 1;
    categories[category].opportunity +=
      roundupAmount;

    if (!merchants[merchant]) {
      merchants[merchant] = {
        name: merchant,
        purchases: 0,
        opportunity: 0,
      };
    }

    merchants[merchant].purchases += 1;
    merchants[merchant].opportunity +=
      roundupAmount;
  }

  const categoryConcentration =
    Object.values(categories)
      .map(item => ({
        name: item.name,
        purchases: item.purchases,
        opportunity:
          round(item.opportunity),

        share:
          opportunity > 0
            ? round(
                item.opportunity /
                  opportunity,
                4
              )
            : 0,
      }))
      .sort(
        (a, b) =>
          b.opportunity -
          a.opportunity
      );

  const merchantConcentration =
    Object.values(merchants)
      .map(item => ({
        name: item.name,
        purchases: item.purchases,
        opportunity:
          round(item.opportunity),

        share:
          opportunity > 0
            ? round(
                item.opportunity /
                  opportunity,
                4
              )
            : 0,
      }))
      .sort(
        (a, b) =>
          b.opportunity -
          a.opportunity
      );

  return {
    evidence_state:
      'supported',

    eligible_purchase_count:
      rows.length,

    opportunity:
      round(opportunity),

    average:
      round(mean(values)),

    median:
      round(median(values)),

    smallest:
      round(Math.min(...values)),

    largest:
      round(Math.max(...values)),

    category_concentration:
      categoryConcentration,

    merchant_concentration:
      merchantConcentration,

    recent:
      rows.slice(0, 20),
  };
}


/* ============================================================================
 * INCOME INTELLIGENCE
 * ========================================================================== */

function classifyIncomeCadence(
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


function confidenceFromIncomeEvidence({
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


function buildIncomeCandidates(
  transactions
) {
  /*
   * Negative transaction amounts represent
   * money entering the account under iBag's
   * established transaction convention.
   */

  const incomeTransactions =
    transactions.filter(
      transaction =>
        transaction.pending === false &&
        transaction.posted_date &&
        numberValue(
          transaction.amount
        ) < 0
    );

  const groups = {};

  for (const transaction of incomeTransactions) {
    const amount =
      Math.abs(
        numberValue(
          transaction.amount
        )
      );

    if (amount <= 0) {
      continue;
    }

    const merchant =
      transaction.merchant_name &&
      transaction.merchant_name.trim()
        ? transaction.merchant_name.trim()
        : null;

    /*
     * Merchant is preferred.
     *
     * If merchant information is absent,
     * group by rounded amount as a weaker
     * candidate signal.
     */

    const key =
      merchant ||
      `amount:${Math.round(amount)}`;

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

  const candidates = [];

  for (const group of Object.values(groups)) {
    const groupTransactions =
      group.transactions;

    if (groupTransactions.length < 3) {
      continue;
    }

    const dates =
      groupTransactions
        .map(transaction =>
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
      index += 1
    ) {
      const gap =
        (
          dates[index] -
          dates[index - 1]
        ) / 86400000;

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
      mean(gaps);

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
      classifyIncomeCadence(
        medianGap
      );

    if (cadence === 'irregular') {
      continue;
    }

    const amounts =
      groupTransactions.map(
        transaction =>
          Math.abs(
            numberValue(
              transaction.amount
            )
          )
      );

    const typicalAmount =
      median(amounts);

    const amountMean =
      mean(amounts);

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
        groupTransactions.length /
          8
      );

    /*
     * Merchant identified = stronger source
     * evidence than amount-only grouping.
     */

    const sourceScore =
      group.amount_based
        ? 0.5
        : 1;

    const score =
      recurrenceScore * 0.35 +
      reliability * 0.35 +
      amountConsistency * 0.20 +
      sourceScore * 0.10;

    const confidence =
      confidenceFromIncomeEvidence({
        occurrences:
          groupTransactions.length,
        reliability,
        cadence,
      });

    const lastDate =
      new Date(
        dates[dates.length - 1]
      );

    const nextExpectedDate =
      medianGap !== null
        ? new Date(
            lastDate.getTime() +
              medianGap *
                86400000
          )
        : null;

    candidates.push({
      sourceLabel:
        group.label,

      grouping:
        group.amount_based
          ? 'amount'
          : 'merchant',

      cadence,

      typicalAmount,

      reliability,

      amountConsistency,

      occurrences:
        groupTransactions.length,

      lastDetectedDate:
        lastDate,

      nextExpectedDate,

      confidence,

      score,
    });
  }

  return candidates.sort(
    (a, b) =>
      b.score -
      a.score
  );
}


function computeIncomeIntelligence(
  transactions
) {
  const candidates =
    buildIncomeCandidates(
      transactions
    );

  if (!candidates.length) {
    return {
      evidence_state:
        'insufficient_evidence',

      signal: null,

      candidates: [],
    };
  }

  const best =
    candidates[0];

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
        round(
          best.typicalAmount
        ),

      occurrences:
        best.occurrences,

      reliability:
        round(
          best.reliability,
          2
        ),

      amount_consistency:
        round(
          best.amountConsistency,
          2
        ),

      confidence:
        best.confidence,

      last_detected_date:
        dateOnly(
          best.lastDetectedDate
        ),

      next_expected_date:
        dateOnly(
          best.nextExpectedDate
        ),
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
            round(
              candidate.typicalAmount
            ),

          occurrences:
            candidate.occurrences,

          reliability:
            round(
              candidate.reliability,
              2
            ),

          amount_consistency:
            round(
              candidate.amountConsistency,
              2
            ),

          confidence:
            candidate.confidence,

          last_detected_date:
            dateOnly(
              candidate.lastDetectedDate
            ),

          next_expected_date:
            dateOnly(
              candidate.nextExpectedDate
            ),
        })
      ),
  };
}


/* ============================================================================
 * CASH-FLOW INTELLIGENCE
 * ========================================================================== */

function computeCashFlowIntelligence(
  transactions
) {
  const dated =
    transactions.filter(
      transaction =>
        transaction.pending === false &&
        transaction.posted_date
    );

  if (!dated.length) {
    return {
      evidence_state:
        'insufficient_evidence',

      observation_days: 0,

      earliest_date: null,
      latest_date: null,

      transaction_count: 0,

      inflow: 0,
      outflow: 0,
      net_change: null,

      daily_inflow: null,
      daily_outflow: null,
      daily_net_change: null,

      direction: 'unknown',
    };
  }

  const dates =
    dated
      .map(
        transaction =>
          transaction.posted_date
      )
      .sort();

  const earliest =
    dates[0];

  const latest =
    dates[dates.length - 1];

  const observationDays =
    Math.max(
      1,
      Math.ceil(
        daysBetween(
          earliest,
          latest
        ) || 1
      )
    );

  let inflow = 0;
  let outflow = 0;

  /*
   * iBag transaction convention:
   *
   * Positive = money leaving account
   * Negative = money entering account
   */

  for (const transaction of dated) {
    const amount =
      numberValue(
        transaction.amount
      );

    if (amount > 0) {
      outflow += amount;
    } else if (amount < 0) {
      inflow += Math.abs(amount);
    }
  }

  const netChange =
    inflow - outflow;

  const dailyInflow =
    inflow / observationDays;

  const dailyOutflow =
    outflow / observationDays;

  const dailyNet =
    netChange /
    observationDays;

  let direction = 'stable';

  if (dailyNet > 0.01) {
    direction = 'positive';
  } else if (dailyNet < -0.01) {
    direction = 'negative';
  }

  return {
    evidence_state:
      dated.length >= 3
        ? 'supported'
        : 'limited',

    observation_days:
      observationDays,

    earliest_date:
      dateOnly(earliest),

    latest_date:
      dateOnly(latest),

    transaction_count:
      dated.length,

    inflow:
      round(inflow),

    outflow:
      round(outflow),

    net_change:
      round(netChange),

    daily_inflow:
      round(dailyInflow),

    daily_outflow:
      round(dailyOutflow),

    daily_net_change:
      round(dailyNet),

    direction,
  };
}


/* ============================================================================
 * BALANCE / RUNWAY INTELLIGENCE
 * ========================================================================== */

function computeBalanceIntelligence(
  accounts,
  cashFlow
) {
  const depositoryAccounts =
    accounts.filter(
      account =>
        account.type ===
        'depository'
    );

  if (!depositoryAccounts.length) {
    return {
      evidence_state:
        'insufficient_evidence',

      total_cash: null,

      runway_days: null,
      runway_months: null,

      daily_burn: null,

      status:
        'unavailable',
    };
  }

  const totalCash =
    depositoryAccounts.reduce(
      (sum, account) =>
        sum +
        numberValue(
          account.current_balance
        ),
      0
    );

  /*
   * A non-negative daily net change does
   * not support a finite depletion runway.
   */

  if (
    cashFlow.daily_net_change ===
      null ||
    cashFlow.daily_net_change >= 0
  ) {
    return {
      evidence_state:
        cashFlow.evidence_state,

      total_cash:
        round(totalCash),

      runway_days: null,
      runway_months: null,

      daily_burn: null,

      status:
        cashFlow.daily_net_change ===
          null
          ? 'insufficient_data'
          : 'stable_or_growing',
    };
  }

  const dailyBurn =
    Math.abs(
      cashFlow.daily_net_change
    );

  if (dailyBurn <= 0) {
    return {
      evidence_state:
        'insufficient_evidence',

      total_cash:
        round(totalCash),

      runway_days: null,
      runway_months: null,

      daily_burn: null,

      status:
        'insufficient_data',
    };
  }

  const runwayDays =
    Math.max(
      0,
      Math.round(
        totalCash /
          dailyBurn
      )
    );

  return {
    evidence_state:
      cashFlow.evidence_state,

    total_cash:
      round(totalCash),

    runway_days:
      runwayDays,

    runway_months:
      round(
        runwayDays /
          30.4375,
        1
      ),

    daily_burn:
      round(dailyBurn),

    status:
      'declining',
  };
}


/* ============================================================================
 * BEHAVIORAL / SPENDING INTELLIGENCE
 * ========================================================================== */

function computeBehavioralIntelligence(
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

      posted_transaction_count: 0,

      total_observed_spend: 0,

      top_categories: [],
      top_merchants: [],
    };
  }

  const categories = {};
  const merchants = {};

  for (const transaction of posted) {
    const amount =
      numberValue(
        transaction.amount
      );

    /*
     * Positive = spending/outflow.
     */

    if (amount <= 0) {
      continue;
    }

    const category =
      transaction.category &&
      transaction.category.trim()
        ? transaction.category.trim()
        : 'Uncategorized';

    const merchant =
      transaction.merchant_name &&
      transaction.merchant_name.trim()
        ? transaction.merchant_name.trim()
        : 'Unknown merchant';

    if (!categories[category]) {
      categories[category] = {
        name: category,
        transactions: 0,
        spend: 0,
      };
    }

    categories[category].transactions += 1;
    categories[category].spend += amount;

    if (!merchants[merchant]) {
      merchants[merchant] = {
        name: merchant,
        transactions: 0,
        spend: 0,
      };
    }

    merchants[merchant].transactions += 1;
    merchants[merchant].spend += amount;
  }

  const totalSpend =
    Object.values(categories)
      .reduce(
        (sum, item) =>
          sum + item.spend,
        0
      );

  const topCategories =
    Object.values(categories)
      .map(item => ({
        name: item.name,

        transactions:
          item.transactions,

        spend:
          round(item.spend),

        share:
          totalSpend > 0
            ? round(
                item.spend /
                  totalSpend,
                4
              )
            : 0,
      }))
      .sort(
        (a, b) =>
          b.spend -
          a.spend
      )
      .slice(0, 10);

  const topMerchants =
    Object.values(merchants)
      .map(item => ({
        name: item.name,

        transactions:
          item.transactions,

        spend:
          round(item.spend),

        share:
          totalSpend > 0
            ? round(
                item.spend /
                  totalSpend,
                4
              )
            : 0,
      }))
      .sort(
        (a, b) =>
          b.spend -
          a.spend
      )
      .slice(0, 10);

  return {
    evidence_state:
      posted.length >= 5
        ? 'supported'
        : 'limited',

    posted_transaction_count:
      posted.length,

    total_observed_spend:
      round(totalSpend),

    top_categories:
      topCategories,

    top_merchants:
      topMerchants,
  };
}


/* ============================================================================
 * FINANCIAL INTELLIGENCE SUMMARY
 * ========================================================================== */

async function computeFinancialIntelligence(
  userId
) {
  const [
    accounts,
    transactions,
    roundup,
  ] = await Promise.all([
    loadAccounts(userId),
    loadTransactions(userId),
    computeRoundupIntelligence(userId),
  ]);

  const income =
    computeIncomeIntelligence(
      transactions
    );

  const cashFlow =
    computeCashFlowIntelligence(
      transactions
    );

  const balance =
    computeBalanceIntelligence(
      accounts,
      cashFlow
    );

  const behavior =
    computeBehavioralIntelligence(
      transactions
    );

  const observationDates =
    transactions
      .map(
        transaction =>
          transaction.posted_date ||
          transaction.authorized_date
      )
      .filter(Boolean)
      .sort();

  return {
    generated_at:
      new Date().toISOString(),

    evidence: {
      accounts:
        accounts.length > 0
          ? 'observed'
          : 'insufficient',

      transactions:
        transactions.length > 0
          ? 'observed'
          : 'insufficient',

      roundup:
        roundup.evidence_state,

      income:
        income.evidence_state,

      cash_flow:
        cashFlow.evidence_state,

      balance:
        balance.evidence_state,

      behavior:
        behavior.evidence_state,
    },

    observation: {
      earliest_transaction_date:
        observationDates.length
          ? dateOnly(
              observationDates[0]
            )
          : null,

      latest_transaction_date:
        observationDates.length
          ? dateOnly(
              observationDates[
                observationDates.length - 1
              ]
            )
          : null,

      transaction_count:
        transactions.length,
    },

    accounts: {
      count:
        accounts.length,

      depository_count:
        accounts.filter(
          account =>
            account.type ===
            'depository'
        ).length,
    },

    roundup,

    income,

    cash_flow:
      cashFlow,

    balance,

    behavior,
  };
}


/* ============================================================================
 * EXPLAINABLE INSIGHTS
 * ========================================================================== */

function buildExplainableInsights(
  intelligence
) {
  const insights = [];

  /*
   * --------------------------------------------------------------------------
   * ROUND-UP
   * --------------------------------------------------------------------------
   */

  const roundup =
    intelligence.roundup;

  if (
    roundup &&
    roundup.evidence_state ===
      'supported' &&
    roundup.eligible_purchase_count > 0
  ) {
    insights.push({
      id:
        'roundup_opportunity',

      type:
        'roundup',

      evidence_type:
        'calculated',

      confidence:
        'high',

      title:
        'Round-Up opportunity detected',

      statement:
        `${roundup.eligible_purchase_count} eligible purchases currently produce ${roundup.opportunity.toFixed(2)} of analytical Round-Up opportunity.`,

      evidence: {
        eligible_purchases:
          roundup.eligible_purchase_count,

        opportunity:
          roundup.opportunity,

        average:
          roundup.average,

        median:
          roundup.median,
      },
    });
  }


  /*
   * --------------------------------------------------------------------------
   * INCOME
   * --------------------------------------------------------------------------
   */

  const income =
    intelligence.income;

  if (
    income &&
    income.evidence_state ===
      'supported' &&
    income.signal
  ) {
    const signal =
      income.signal;

    insights.push({
      id:
        'recurring_income_signal',

      type:
        'income',

      evidence_type:
        'inferred',

      confidence:
        signal.confidence,

      title:
        'Recurring income pattern detected',

      statement:
        `A ${signal.cadence} incoming-money pattern was observed${signal.source ? ` from ${signal.source}` : ''}, with a typical amount of ${signal.typical_amount.toFixed(2)}.`,

      evidence: {
        source:
          signal.source,

        cadence:
          signal.cadence,

        typical_amount:
          signal.typical_amount,

        occurrences:
          signal.occurrences,

        reliability:
          signal.reliability,

        amount_consistency:
          signal.amount_consistency,

        last_detected_date:
          signal.last_detected_date,

        next_expected_date:
          signal.next_expected_date,
      },

      qualification:
        'This is a transaction-pattern inference and is not a guarantee of future income.',
    });
  }


  /*
   * --------------------------------------------------------------------------
   * CASH FLOW
   * --------------------------------------------------------------------------
   */

  const cashFlow =
    intelligence.cash_flow;

  if (
    cashFlow &&
    cashFlow.evidence_state ===
      'supported' &&
    cashFlow.direction !==
      'unknown'
  ) {
    let directionText =
      'inflows and outflows were broadly balanced';

    if (
      cashFlow.direction ===
      'positive'
    ) {
      directionText =
        'inflows exceeded outflows';
    }

    if (
      cashFlow.direction ===
      'negative'
    ) {
      directionText =
        'outflows exceeded inflows';
    }

    insights.push({
      id:
        'cash_flow_direction',

      type:
        'cash_flow',

      evidence_type:
        'calculated',

      confidence:
        'medium',

      title:
        'Cash-flow direction observed',

      statement:
        `Across the observed transaction window, ${directionText}.`,

      evidence: {
        observation_days:
          cashFlow.observation_days,

        inflow:
          cashFlow.inflow,

        outflow:
          cashFlow.outflow,

        net_change:
          cashFlow.net_change,

        daily_net_change:
          cashFlow.daily_net_change,
      },
    });
  }


  /*
   * --------------------------------------------------------------------------
   * RUNWAY
   * --------------------------------------------------------------------------
   */

  const balance =
    intelligence.balance;

  if (
    balance &&
    balance.status ===
      'declining' &&
    balance.runway_days !== null
  ) {
    insights.push({
      id:
        'cash_runway',

      type:
        'liquidity',

      evidence_type:
        'calculated',

      confidence:
        'medium',

      title:
        'Observed cash runway',

      statement:
        `At the observed rate of net cash decline, current depository balances correspond to approximately ${balance.runway_days} days of runway.`,

      evidence: {
        total_cash:
          balance.total_cash,

        daily_burn:
          balance.daily_burn,

        runway_days:
          balance.runway_days,

        runway_months:
          balance.runway_months,
      },

      qualification:
        'This is a mathematical projection from the observed transaction window, not a forecast of future income or expenses.',
    });
  }


  /*
   * --------------------------------------------------------------------------
   * SPENDING CONCENTRATION
   * --------------------------------------------------------------------------
   */

  const behavior =
    intelligence.behavior;

  if (
    behavior &&
    behavior.evidence_state ===
      'supported' &&
    behavior.top_categories.length > 0
  ) {
    const top =
      behavior.top_categories[0];

    insights.push({
      id:
        'spending_concentration',

      type:
        'behavior',

      evidence_type:
        'calculated',

      confidence:
        'medium',

      title:
        'Spending concentration observed',

      statement:
        `${top.name} represents the largest observed spending category in the available transaction history.`,

      evidence: {
        category:
          top.name,

        spend:
          top.spend,

        share:
          top.share,

        transactions:
          top.transactions,
      },

      qualification:
        'This describes the observed transaction history and does not by itself establish that the spending is unnecessary or problematic.',
    });
  }

  return insights;
}


/* ============================================================================
 * PUBLIC API
 * ========================================================================== */

async function getFinancialIntelligence(
  userId
) {
  const intelligence =
    await computeFinancialIntelligence(
      userId
    );

  const insights =
    buildExplainableInsights(
      intelligence
    );

  /*
   * Explicitly construct the public contract.
   *
   * This guarantees the major intelligence
   * domains exist even when evidence is absent.
   */

  return {
    status:
      'ok',

    generated_at:
      intelligence.generated_at,

    evidence:
      intelligence.evidence,

    observation:
      intelligence.observation,

    accounts:
      intelligence.accounts,

    roundup:
      intelligence.roundup,

    income:
      intelligence.income,

    cash_flow:
      intelligence.cash_flow,

    balance:
      intelligence.balance,

    behavior:
      intelligence.behavior,

    insights,
  };
}


module.exports = {
  loadTransactions,
  loadAccounts,

  computeRoundupIntelligence,
  computeIncomeIntelligence,
  computeCashFlowIntelligence,
  computeBalanceIntelligence,
  computeBehavioralIntelligence,

  computeFinancialIntelligence,

  buildExplainableInsights,

  getFinancialIntelligence,
};
