const pool = require('./db');

const {
  getFinancialIntelligence,
} = require('./intelligence');


/* ============================================================================
 * CURRENT USER
 * ========================================================================== */

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

    const user =
      userResult.rows[0];

    const ibagResult =
      await pool.query(
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


/* ============================================================================
 * DASHBOARD
 * ========================================================================== */

async function getDashboard(req, res) {
  try {
    const userId =
      req.user.id;

    /*
     * The dashboard now gets its financial intelligence
     * from ONE authoritative engine.
     */

    const intelligence =
      await getFinancialIntelligence(
        userId
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

    const roundup =
      intelligence.roundup;

    const transactionState =
      transactionStateResult.rows[0] || {
        transaction_count: 0,
        pending_transaction_count: 0,
        posted_transaction_count: 0,
        observation_start: null,
        observation_end: null,
      };

    /*
     * Preserve the existing dashboard contract while
     * exposing the richer unified intelligence contract.
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
            roundup.eligible_purchase_count
          ) > 0,

        income_available:
          intelligence.income
            .evidence_state ===
          'supported',

        cash_flow_available:
          intelligence.cash_flow
            .evidence_state !==
          'insufficient_evidence',
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
            roundup.eligible_purchase_count
          ),

        roundup_opportunity:
          roundup.opportunity,

        total_cash:
          intelligence.balance
            .total_cash,

        net_daily_change:
          intelligence.cash_flow
            .daily_net_change,

        runway_days:
          intelligence.balance
            .runway_days,
      },

      /*
       * Existing Round-Up structures.
       */

      categories:
        roundup.category_concentration,

      merchants:
        roundup.merchant_concentration,

      recent_roundups:
        roundup.recent,

      /*
       * Unified intelligence.
       */

      intelligence,

      /*
       * Compatibility aliases.
       */

      transaction_state:
        transactionState,

      roundup,

      roundup_by_category:
        roundup.category_concentration,

      roundup_by_merchant:
        roundup.merchant_concentration,

      cash_flow:
        intelligence.cash_flow,

      income:
        intelligence.income,

      balance:
        intelligence.balance,

      behavior:
        intelligence.behavior,

      insights:
        intelligence.insights,
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
        process.env.NODE_ENV ===
        'production'
          ? undefined
          : err.message,
    });
  }
}


/* ============================================================================
 * SUMMARY
 * ========================================================================== */

async function getSummary(req, res) {
  try {
    const result =
      await pool.query(
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

      summary:
        result.rows[0],
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


/* ============================================================================
 * ACCOUNTS
 * ========================================================================== */

async function getAccounts(req, res) {
  try {
    const result =
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

      accounts:
        result.rows,
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


/* ============================================================================
 * TRANSACTIONS
 * ========================================================================== */

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


/* ============================================================================
 * INSIGHTS
 * ========================================================================== */

async function getInsights(req, res) {
  try {
    const intelligence =
      await getFinancialIntelligence(
        req.user.id
      );

    return res.json({
      status: 'ok',

      insights:
        intelligence.insights,

      evidence:
        intelligence.evidence,
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


/* ============================================================================
 * NET WORTH / BALANCE COMPATIBILITY
 * ========================================================================== */

async function getNetWorth(req, res) {
  try {
    const result =
      await pool.query(
        `
          SELECT
            COALESCE(
              SUM(
                a.current_balance
              ),
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
        result.rows[0]
          .net_worth,
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


/* ============================================================================
 * INCOME
 * ========================================================================== */

async function getIncome(req, res) {
  try {
    const intelligence =
      await getFinancialIntelligence(
        req.user.id
      );

    return res.json({
      status: 'ok',

      income:
        intelligence.income,
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


/* ============================================================================
 * CASH FLOW
 * ========================================================================== */

async function getCashFlow(req, res) {
  try {
    const intelligence =
      await getFinancialIntelligence(
        req.user.id
      );

    return res.json({
      status: 'ok',

      cash_flow:
        intelligence.cash_flow,

      balance:
        intelligence.balance,
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


/* ============================================================================
 * EXPORTS
 * ========================================================================== */

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
