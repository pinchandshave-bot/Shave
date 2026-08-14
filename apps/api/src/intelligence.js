const pool = require('./db');

const {
  classifyTransaction,
} = require('./intelligence/classification');

const {
  calculateRoundup,
  getRoundupEligibility,
} = require('./roundup');

const {
  aggregateRoundupEvents,
  reconcileRoundupAggregate,
} = require('./intelligence/reconciliation');

const {
  computeCashFlow,
} = require('./intelligence/cashFlow');

const {
  buildIncomeIntelligence,
} = require('./intelligence/income');

const {
  calculateRunway,
} = require('./intelligence/runway');

const {
  buildTransactionProvenance,
  buildIntelligenceProvenance,
} = require('./intelligence/provenance');

const {
  validateFinancialIntelligence,
} = require('./intelligence/contracts');

function numberValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value, decimals = 2) {
  if (value === null || value === undefined) {
    return null;
  }

  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  return Number(
    n.toFixed(decimals)
  );
}

function median(values) {
  const valid =
    values
      .filter(Number.isFinite)
      .slice()
      .sort((a, b) => a - b);

  if (!valid.length) return null;

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
        t.raw,
        t.pending_transaction_id,
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

async function loadRoundupEvents(userId) {
  const result = await pool.query(
    `
      SELECT
        r.id,
        r.transaction_id,
        r.roundup_amount,
        r.transaction_amount,
        r.eligibility_reason,
        r.rule_version,

        t.plaid_transaction_id,
        t.amount,
        t.merchant_name,
        t.category,
        t.pending,
        t.authorized_date,
        t.posted_date,
        t.iso_currency_code,
        t.raw,

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

  return result.rows;
}

function buildRoundup(events) {
  /*
   * Re-classify the exact event population.
   *
   * This prevents a stale or incorrectly created
   * roundup_event from becoming financial truth.
   */
  const eligibleEvents =
    events.filter(event => {
      const transaction = {
        ...event,
        id: event.transaction_id,
      };

      const eligibility =
        getRoundupEligibility(
          transaction
        );

      return eligibility.eligible;
    });

  const values =
    eligibleEvents
      .map(event =>
        calculateRoundup(event)
      )
      .filter(value => value > 0);

  const opportunity =
    values.reduce(
      (sum, value) => sum + value,
      0
    );

  const categoryMap = new Map();
  const merchantMap = new Map();

  for (const event of eligibleEvents) {
    const amount =
      calculateRoundup(event);

    const category =
      String(
        event.category ||
        'Uncategorized'
      ).trim() ||
      'Uncategorized';

    const merchant =
      String(
        event.merchant_name ||
        'Unknown merchant'
      ).trim() ||
      'Unknown merchant';

    if (!categoryMap.has(category)) {
      categoryMap.set(category, {
        name: category,
        purchases: 0,
        opportunity: 0,
      });
    }

    const categoryEntry =
      categoryMap.get(category);

    categoryEntry.purchases += 1;
    categoryEntry.opportunity += amount;

    if (!merchantMap.has(merchant)) {
      merchantMap.set(merchant, {
        name: merchant,
        purchases: 0,
        opportunity: 0,
      });
    }

    const merchantEntry =
      merchantMap.get(merchant);

    merchantEntry.purchases += 1;
    merchantEntry.opportunity += amount;
  }

  const categories =
    Array.from(categoryMap.values())
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

  const merchants =
    Array.from(merchantMap.values())
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

  const reconciliation =
    reconcileRoundupAggregate({
      eligiblePurchaseCount:
        eligibleEvents.length,

      opportunity:
        round(opportunity),

      categories,

      merchants,
    });

  if (!reconciliation.valid) {
    throw new Error(
      `ROUNDUP_RECONCILIATION_FAILED: ${JSON.stringify(
        reconciliation
      )}`
    );
  }

  return {
    evidence_state:
      eligibleEvents.length > 0
        ? 'supported'
        : 'insufficient_evidence',

    eligible_purchase_count:
      eligibleEvents.length,

    opportunity:
      round(opportunity),

    average:
      values.length
        ? round(
            values.reduce(
              (sum, value) =>
                sum + value,
              0
            ) / values.length,
            4
          )
        : 0,

    median:
      values.length
        ? round(
            median(values),
            2
          )
        : 0,

    smallest:
      values.length
        ? round(
            Math.min(...values)
          )
        : 0,

    largest:
      values.length
        ? round(
            Math.max(...values)
          )
        : 0,

    category_concentration:
      categories,

    merchant_concentration:
      merchants,

    reconciliation,

    recent:
      eligibleEvents.slice(0, 20),

    provenance:
      buildIntelligenceProvenance({
        domain: 'roundup',
        transactionIds:
          eligibleEvents.map(
            event =>
              event.transaction_id
          ),
        calculation:
          'Deterministic next-dollar calculation over classified purchase events.',
        evidenceState:
          eligibleEvents.length > 0
            ? 'supported'
            : 'insufficient_evidence',
      }),
  };
}

function buildBalance(accounts) {
  const depository =
    accounts.filter(
      account =>
        account.type ===
        'depository'
    );

  if (!depository.length) {
    return {
      evidence_state:
        'insufficient_evidence',

      total_cash: null,

      runway_days: null,
      runway_months: null,
      daily_burn: null,

      status:
        'insufficient_data',
    };
  }

  const totalCash =
    depository.reduce(
      (sum, account) =>
        sum +
        numberValue(
          account.current_balance
        ),
      0
    );

  return {
    evidence_state:
      'observed',

    total_cash:
      round(totalCash),

    runway_days: null,
    runway_months: null,
    daily_burn: null,

    status:
      'awaiting_economic_cash_flow',
  };
}

function buildClassificationSummary(
  transactions
) {
  const counts = {};

  for (const transaction of transactions) {
    const result =
      classifyTransaction(transaction);

    counts[result.classification] =
      (counts[result.classification] || 0) + 1;
  }

  return counts;
}

function buildInsights({
  roundup,
  income,
  cashFlow,
  balance,
}) {
  const insights = [];

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
        `${roundup.eligible_purchase_count} eligible purchases currently produce $${roundup.opportunity.toFixed(2)} of analytical Round-Up opportunity.`,

      evidence: {
        eligible_purchase_count:
          roundup.eligible_purchase_count,
        opportunity:
          roundup.opportunity,
        average:
          roundup.average,
        median:
          roundup.median,
        smallest:
          roundup.smallest,
        largest:
          roundup.largest,
      },
    });
  }

  if (
    income.evidence_state ===
      'supported' &&
    income.signal
  ) {
    insights.push({
      id: 'recurring_income_pattern',
      type: 'income',
      evidence_type: 'inferred',
      confidence:
        income.signal.confidence,

      title:
        'Recurring income pattern detected',

      statement:
        `A ${income.signal.cadence} classified income pattern was observed from ${income.signal.source}.`,

      evidence:
        income.signal,

      qualification:
        'Pattern evidence does not establish the underlying source of employment or guarantee future income.',
    });
  }

  if (
    cashFlow.evidence_state ===
    'supported'
  ) {
    insights.push({
      id: 'economic_cash_flow',
      type: 'cash_flow',
      evidence_type: 'calculated',
      confidence: 'medium',

      title:
        'Economic cash flow calculated',

      statement:
        'Economic cash flow has been separated from gross account movement using transaction classifications.',

      evidence:
        cashFlow.economic_cash_flow,

      qualification:
        'Transfers are preserved as account movement but are not automatically treated as economic spending.',
    });
  }

  if (
    balance.evidence_state ===
    'insufficient'
  ) {
    insights.push({
      id: 'runway_insufficient_evidence',
      type: 'liquidity',
      evidence_type: 'limited',
      confidence: 'insufficient',

      title:
        'Runway cannot yet be responsibly calculated',

      statement:
        'Available classified cash-flow evidence is insufficient to produce a defensible runway estimate.',

      evidence: {
        runway_days: null,
        evidence_state:
          'insufficient',
      },
    });
  }

  return insights;
}

async function computeFinancialIntelligence(
  userId
) {
  const [
    accounts,
    transactions,
    roundupEvents,
  ] = await Promise.all([
    loadAccounts(userId),
    loadTransactions(userId),
    loadRoundupEvents(userId),
  ]);

  const roundup =
    buildRoundup(roundupEvents);

  const cashFlow =
    computeCashFlow(
      transactions
    );

  const income =
    buildIncomeIntelligence(
      transactions
    );

  let balance =
    buildBalance(accounts);

  const depositoryCash =
    balance.total_cash;

  const runway =
    calculateRunway({
      totalCash:
        depositoryCash,
      cashFlow,
    });

  balance = {
    ...balance,
    ...runway,
  };

  /*
   * A runway number is only valid when the
   * runway engine itself says the evidence supports it.
   */
  if (
    runway.evidence_state !==
    'supported'
  ) {
    balance.runway_days = null;
    balance.runway_months = null;
    balance.daily_burn = null;
    balance.evidence_state =
      runway.evidence_state;
  }

  const observationDates =
    transactions
      .map(
        transaction =>
          transaction.posted_date ||
          transaction.authorized_date
      )
      .filter(Boolean)
      .sort();

  const contract = {
    status: 'ok',

    generated_at:
      new Date().toISOString(),

    evidence: {
      accounts:
        accounts.length
          ? 'observed'
          : 'insufficient',

      transactions:
        transactions.length
          ? 'observed'
          : 'insufficient',

      roundup:
        roundup.evidence_state,

      cash_flow:
        cashFlow.evidence_state,

      income:
        income.evidence_state,

      balance:
        balance.evidence_state,
    },

    observation: {
      earliest_transaction_date:
        observationDates.length
          ? observationDates[0]
          : null,

      latest_transaction_date:
        observationDates.length
          ? observationDates[
              observationDates.length - 1
            ]
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

    classification:
      buildClassificationSummary(
        transactions
      ),

    roundup,

    income,

    cash_flow:
      cashFlow,

    balance,

    provenance: {
      classification_sample:
        transactions
          .slice(0, 50)
          .map(
            buildTransactionProvenance
          ),
    },

    insights: [],
  };

  contract.insights =
    buildInsights({
      roundup,
      income,
      cashFlow,
      balance,
    });

  validateFinancialIntelligence(
    contract
  );

  return contract;
}

async function getFinancialIntelligence(
  userId
) {
  return computeFinancialIntelligence(
    userId
  );
}

module.exports = {
  loadTransactions,
  loadAccounts,
  loadRoundupEvents,

  computeFinancialIntelligence,
  getFinancialIntelligence,
};
