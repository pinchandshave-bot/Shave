const pool = require('./db');

/*
 * iBag Financial Intelligence Engine
 *
 * PHASE 1 CONTRACT
 * ----------------
 * - Read-only
 * - Real authorized financial data only
 * - No money movement
 * - No fake/mock/seeded data
 * - No fabricated conclusions
 * - Evidence-gated intelligence
 *
 * The engine separates:
 *
 * OBSERVED
 *   Directly present in authorized financial records.
 *
 * CALCULATED
 *   Deterministically derived from observed records.
 *
 * INFERRED
 *   A pattern supported by sufficient evidence.
 *
 * INSUFFICIENT
 *   Not enough evidence to make the conclusion responsibly.
 */


/* -------------------------------------------------------------------------- */
/* NUMERIC HELPERS                                                            */
/* -------------------------------------------------------------------------- */

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value, decimals = 2) {
  const factor = Math.pow(10, decimals);
  return Math.round((numberValue(value) + Number.EPSILON) * factor) / factor;
}

function median(values) {
  if (!values.length) return null;

  const sorted = [...values]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!sorted.length) return null;

  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return sorted[middle];
}

function mean(values) {
  if (!values.length) return null;

  return (
    values.reduce((sum, value) => sum + value, 0) /
    values.length
  );
}

function standardDeviation(values) {
  if (values.length < 2) return 0;

  const avg = mean(values);

  if (avg === null) return 0;

  const variance =
    values.reduce(
      (sum, value) =>
        sum + Math.pow(value - avg, 2),
      0
    ) / values.length;

  return Math.sqrt(variance);
}

function daysBetween(a, b) {
  if (!a || !b) return null;

  const first = new Date(a);
  const second = new Date(b);

  const diff =
    second.getTime() - first.getTime();

  if (!Number.isFinite(diff)) return null;

  return diff / 86400000;
}

function dateOnly(value) {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}


/* -------------------------------------------------------------------------- */
/* TRANSACTION LOAD                                                           */
/* -------------------------------------------------------------------------- */

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


/* -------------------------------------------------------------------------- */
/* ACCOUNT LOAD                                                               */
/* -------------------------------------------------------------------------- */

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


/* -------------------------------------------------------------------------- */
/* ROUND-UP INTELLIGENCE                                                      */
/* -------------------------------------------------------------------------- */

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
      evidence_state: 'insufficient_evidence',
      eligible_purchase_count: 0,
      opportunity: 0,
      average: 0,
      median: 0,
      smallest: 0,
      largest: 0,
      concentration: [],
      recent: [],
    };
  }

  const values = rows.map(
    row => numberValue(row.roundup_amount)
  );

  const opportunity = values.reduce(
    (sum, value) => sum + value,
    0
  );

  const categories = {};
  const merchants = {};

  for (const row of rows) {
    const category =
      row.category && row.category.trim()
        ? row.category
        : 'Uncategorized';

    const merchant =
      row.merchant_name &&
      row.merchant_name.trim()
        ? row.merchant_name
        : 'Unknown merchant';

    if (!categories[category]) {
      categories[category] = {
        name: category,
        purchases: 0,
        opportunity: 0,
      };
    }

    categories[category].purchases += 1;
    categories[category].opportunity +=
      numberValue(row.roundup_amount);

    if (!merchants[merchant]) {
      merchants[merchant] = {
        name: merchant,
        purchases: 0,
        opportunity: 0,
      };
    }

    merchants[merchant].purchases += 1;
    merchants[merchant].opportunity +=
      numberValue(row.roundup_amount);
  }

  const categoryConcentration =
    Object.values(categories)
      .map(item => ({
        ...item,
        opportunity: round(item.opportunity),
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
        ...item,
        opportunity: round(item.opportunity),
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
    evidence_state: 'supported',
    eligible_purchase_count: rows.length,
    opportunity: round(opportunity),
    average: round(mean(values)),
    median: round(median(values)),
    smallest: round(Math.min(...values)),
    largest: round(Math.max(...values)),

    category_concentration:
      categoryConcentration,

    merchant_concentration:
      merchantConcentration,

    recent: rows.slice(0, 20),
  };
}


/* -------------------------------------------------------------------------- */
/* CASH-FLOW INTELLIGENCE                                                     */
/* -------------------------------------------------------------------------- */

async function computeCashFlowIntelligence(
  userId,
  transactions = null
) {
  const rows =
    transactions ||
    await loadTransactions(userId);

  const dated = rows.filter(
    transaction =>
      !transaction.pending &&
      transaction.posted_date
  );

  if (!dated.length) {
    return {
      evidence_state: 'insufficient_evidence',
      observation_days: 0,
      inflow: 0,
      outflow: 0,
      net_change: null,
      daily_inflow: null,
      daily_outflow: null,
      daily_net_change: null,
      direction: 'unknown',
    };
  }

  const dates = dated
    .map(row => row.posted_date)
    .sort();

  const earliest = dates[0];
  const latest =
    dates[dates.length - 1];

  const observationDays = Math.max(
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

  for (const transaction of dated) {
    const amount =
      numberValue(transaction.amount);

    /*
     * iBag's transaction convention:
     *
     * Positive = money leaving the account
     * Negative = money entering the account
     */

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
    netChange / observationDays;

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

    inflow: round(inflow),
    outflow: round(outflow),
    net_change: round(netChange),

    daily_inflow:
      round(dailyInflow),

    daily_outflow:
      round(dailyOutflow),

    daily_net_change:
      round(dailyNet),

    direction,
  };
}


/* -------------------------------------------------------------------------- */
/* BALANCE / RUNWAY INTELLIGENCE                                              */
/* -------------------------------------------------------------------------- */

async function computeBalanceIntelligence(
  userId,
  accounts,
  cashFlow
) {
  const depositoryAccounts =
    accounts.filter(
      account =>
        account.type === 'depository'
    );

  if (!depositoryAccounts.length) {
    return {
      evidence_state:
        'insufficient_evidence',
      total_cash: null,
      runway_days: null,
      runway_months: null,
      status: 'unavailable',
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

  if (
    cashFlow.daily_net_change === null ||
    cashFlow.daily_net_change >= 0
  ) {
    return {
      evidence_state:
        cashFlow.evidence_state,

      total_cash:
        round(totalCash),

      runway_days: null,
      runway_months: null,

      status:
        cashFlow.daily_net_change === null
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

      status: 'insufficient_data',
    };
  }

  const runwayDays =
    Math.max(
      0,
      Math.round(
        totalCash / dailyBurn
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
        runwayDays / 30.4375,
        1
      ),

    daily_burn:
      round(dailyBurn),

    status: 'declining',
  };
}


/* -------------------------------------------------------------------------- */
/* BEHAVIORAL / SPENDING CONCENTRATION                                       */
/* -------------------------------------------------------------------------- */

function computeBehavioralIntelligence(
  transactions
) {
  const posted =
    transactions.filter(
      transaction =>
        !transaction.pending &&
        transaction.posted_date
    );

  if (!posted.length) {
    return {
      evidence_state:
        'insufficient_evidence',
      top_categories: [],
      top_merchants: [],
      recurring_patterns: [],
    };
  }

  const categories = {};
  const merchants = {};

  for (const transaction of posted) {
    const amount =
      numberValue(transaction.amount);

    if (amount <= 0) continue;

    const category =
      transaction.category &&
      transaction.category.trim()
        ? transaction.category
        : 'Uncategorized';

    const merchant =
      transaction.merchant_name &&
      transaction.merchant_name.trim()
        ? transaction.merchant_name
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
        spend: round(item.spend),
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
        spend: round(item.spend),
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


/* -------------------------------------------------------------------------- */
/* FINANCIAL INTELLIGENCE SUMMARY                                             */
/* -------------------------------------------------------------------------- */

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

  const cashFlow =
    await computeCashFlowIntelligence(
      userId,
      transactions
    );

  const balance =
    await computeBalanceIntelligence(
      userId,
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
      count: accounts.length,
      depository_count:
        accounts.filter(
          account =>
            account.type ===
            'depository'
        ).length,
    },

    roundup,

    cash_flow: cashFlow,

    balance,

    behavior,
  };
}


/* -------------------------------------------------------------------------- */
/* EXPLAINABLE INSIGHTS                                                       */
/* -------------------------------------------------------------------------- */

function buildExplainableInsights(
  intelligence
) {
  const insights = [];

  const roundup =
    intelligence.roundup;

  if (
    roundup.evidence_state ===
      'supported' &&
    roundup.eligible_purchase_count > 0
  ) {
    insights.push({
      id: 'roundup_opportunity',
      type: 'roundup',
      evidence_type: 'calculated',
      confidence: 'high',
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

  const cashFlow =
    intelligence.cash_flow;

  if (
    cashFlow.evidence_state ===
      'supported' &&
    cashFlow.direction !==
      'unknown'
  ) {
    const direction =
      cashFlow.direction ===
      'positive'
        ? 'inflows exceeded outflows'
        : cashFlow.direction ===
          'negative'
        ? 'outflows exceeded inflows'
        : 'inflows and outflows were broadly balanced';

    insights.push({
      id: 'cash_flow_direction',
      type: 'cash_flow',
      evidence_type: 'calculated',
      confidence: 'medium',
      title:
        'Cash-flow direction observed',
      statement:
        `Across the observed transaction window, ${direction}.`,
      evidence: {
        observation_days:
          cashFlow.observation_days,
        inflow:
          cashFlow.inflow,
        outflow:
          cashFlow.outflow,
        net_change:
          cashFlow.net_change,
      },
    });
  }

  const balance =
    intelligence.balance;

  if (
    balance.status ===
      'declining' &&
    balance.runway_days !== null
  ) {
    insights.push({
      id: 'cash_runway',
      type: 'liquidity',
      evidence_type: 'calculated',
      confidence: 'medium',
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
      },
      qualification:
        'This is a mathematical projection from the observed transaction window, not a forecast of future income or expenses.',
    });
  }

  const behavior =
    intelligence.behavior;

  if (
    behavior.evidence_state ===
      'supported' &&
    behavior.top_categories.length > 0
  ) {
    const top =
      behavior.top_categories[0];

    insights.push({
      id: 'spending_concentration',
      type: 'behavior',
      evidence_type: 'calculated',
      confidence: 'medium',
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


/* -------------------------------------------------------------------------- */
/* PUBLIC API                                                                 */
/* -------------------------------------------------------------------------- */

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

  return {
    ...intelligence,
    insights,
  };
}


module.exports = {
  loadTransactions,
  loadAccounts,
  computeRoundupIntelligence,
  computeCashFlowIntelligence,
  computeBalanceIntelligence,
  computeBehavioralIntelligence,
  computeFinancialIntelligence,
  buildExplainableInsights,
  getFinancialIntelligence,
};
