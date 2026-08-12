const pool = require('./db');

/**
 * --------------------------------------------------------------------------
 * AUTHENTICATED USER / iBAG READ MODEL
 * --------------------------------------------------------------------------
 *
 * All functions in this file are read-only.
 *
 * Financial ownership is ALWAYS derived from:
 *
 *     req.user.id
 *
 * No browser-supplied user ID is trusted.
 *
 * No function in this file:
 * - creates financial records
 * - modifies financial records
 * - synchronizes Plaid
 * - creates Round-Up events
 * - recalculates Round-Ups
 * - fabricates financial values
 */


/**
 * --------------------------------------------------------------------------
 * GET /me
 * --------------------------------------------------------------------------
 *
 * Return the authenticated user's core iBag state.
 */
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
      [req.user.id],
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
      [user.id],
    );

    const accountsResult = await pool.query(
      `
        SELECT
          a.id,
          a.plaid_account_id,
          a.name,
          a.official_name,
          a.mask,
          a.type,
          a.subtype
        FROM accounts a
        INNER JOIN plaid_items p
          ON p.id = a.plaid_item_id
        WHERE p.user_id = $1
          AND p.status = 'active'
        ORDER BY a.created_at ASC
      `,
      [user.id],
    );

    return res.json({
      status: 'ok',
      user,
      ibag: ibagResult.rows[0] || null,
      accounts: accountsResult.rows,
    });
  } catch (err) {
    console.error(
      'Get current user failed:',
      err,
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your iBag right now',
    });
  }
}


/**
 * --------------------------------------------------------------------------
 * GET /me/summary
 * --------------------------------------------------------------------------
 *
 * Existing endpoint preserved.
 */
async function getSummary(req, res) {
  try {
    const result = await pool.query(
      `
        SELECT
          COUNT(*)::int AS transaction_count,
          COALESCE(SUM(amount), 0) AS transaction_total
        FROM transactions t
        INNER JOIN accounts a
          ON a.id = t.account_id
        INNER JOIN plaid_items p
          ON p.id = a.plaid_item_id
        WHERE p.user_id = $1
          AND t.status = 'active'
      `,
      [req.user.id],
    );

    return res.json({
      status: 'ok',
      summary: result.rows[0],
    });
  } catch (err) {
    console.error(
      'Get summary failed:',
      err,
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your financial summary',
    });
  }
}


/**
 * --------------------------------------------------------------------------
 * GET /me/accounts
 * --------------------------------------------------------------------------
 */
async function getAccounts(req, res) {
  try {
    const result = await pool.query(
      `
        SELECT
          a.id,
          a.plaid_account_id,
          a.name,
          a.official_name,
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
      [req.user.id],
    );

    return res.json({
      status: 'ok',
      accounts: result.rows,
    });
  } catch (err) {
    console.error(
      'Get accounts failed:',
      err,
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your accounts',
    });
  }
}


/**
 * --------------------------------------------------------------------------
 * GET /me/transactions
 * --------------------------------------------------------------------------
 */
async function getTransactions(req, res) {
  try {
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
          t.status
        FROM transactions t
        INNER JOIN accounts a
          ON a.id = t.account_id
        INNER JOIN plaid_items p
          ON p.id = a.plaid_item_id
        WHERE p.user_id = $1
          AND t.status = 'active'
        ORDER BY
          COALESCE(
            t.posted_date,
            t.authorized_date
          ) DESC NULLS LAST,
          t.created_at DESC
      `,
      [req.user.id],
    );

    return res.json({
      status: 'ok',
      transactions: result.rows,
    });
  } catch (err) {
    console.error(
      'Get transactions failed:',
      err,
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your transactions',
    });
  }
}


/**
 * --------------------------------------------------------------------------
 * GET /me/insights
 * --------------------------------------------------------------------------
 *
 * No fabricated intelligence.
 */
async function getInsights(req, res) {
  try {
    return res.json({
      status: 'ok',
      insights: [],
    });
  } catch (err) {
    console.error(
      'Get insights failed:',
      err,
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your insights',
    });
  }
}


/**
 * --------------------------------------------------------------------------
 * GET /me/net-worth
 * --------------------------------------------------------------------------
 *
 * IMPORTANT:
 *
 * The current database query represents the sum of connected account
 * balances. It is intentionally retained for compatibility with the
 * existing endpoint.
 *
 * It should NOT be interpreted as authoritative net worth until liabilities
 * are incorporated into the financial model.
 */
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
      [req.user.id],
    );

    return res.json({
      status: 'ok',
      net_worth: result.rows[0].net_worth,
    });
  } catch (err) {
    console.error(
      'Get net worth failed:',
      err,
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your net worth',
    });
  }
}


/**
 * --------------------------------------------------------------------------
 * GET /me/income
 * --------------------------------------------------------------------------
 */
async function getIncome(req, res) {
  try {
    return res.json({
      status: 'ok',
      income: null,
      message:
        'Income analysis requires connected financial data.',
    });
  } catch (err) {
    console.error(
      'Get income failed:',
      err,
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your income',
    });
  }
}


/**
 * --------------------------------------------------------------------------
 * GET /me/cash-flow
 * --------------------------------------------------------------------------
 */
async function getCashFlow(req, res) {
  try {
    return res.json({
      status: 'ok',
      cash_flow: null,
      message:
        'Cash-flow analysis requires connected financial data.',
    });
  } catch (err) {
    console.error(
      'Get cash flow failed:',
      err,
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your cash flow',
    });
  }
}


/**
 * --------------------------------------------------------------------------
 * GET /me/dashboard
 * --------------------------------------------------------------------------
 *
 * Dashboard read model.
 *
 * This is deliberately a READ MODEL rather than another financial engine.
 *
 * Source hierarchy:
 *
 *   users
 *      ↓
 *   plaid_items
 *      ↓
 *   accounts
 *      ↓
 *   transactions
 *      ↓
 *   roundup_events
 *
 * The Round-Up amount displayed here comes ONLY from persisted
 * roundup_events.
 *
 * This function does NOT:
 *
 * - calculate a Round-Up
 * - create a Round-Up event
 * - update a transaction
 * - update an account
 * - synchronize Plaid
 * - move money
 */
async function getDashboard(req, res) {
  const userId = req.user.id;

  try {
    /*
     * ----------------------------------------------------------------------
     * USER
     * ----------------------------------------------------------------------
     */
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
      [userId],
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found',
      });
    }

    const user = userResult.rows[0];

    /*
     * ----------------------------------------------------------------------
     * ACCOUNTS
     * ----------------------------------------------------------------------
     */
    const accountsResult = await pool.query(
      `
        SELECT
          a.id,
          a.name,
          a.official_name,
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
      [userId],
    );

    /*
     * ----------------------------------------------------------------------
     * TRANSACTION SUMMARY
     * ----------------------------------------------------------------------
     *
     * Only active transactions are considered current financial activity.
     *
     * Round-Up opportunity is deliberately calculated from roundup_events,
     * not from transaction.amount.
     */
    const summaryResult = await pool.query(
      `
        SELECT
          COUNT(DISTINCT t.id)::int
            AS transaction_count,

          COUNT(
            DISTINCT CASE
              WHEN t.pending = false
              THEN t.id
            END
          )::int
            AS posted_transaction_count,

          COUNT(
            DISTINCT CASE
              WHEN t.pending = true
              THEN t.id
            END
          )::int
            AS pending_transaction_count,

          COUNT(
            DISTINCT CASE
              WHEN re.eligible = true
               AND re.status = 'active'
              THEN t.id
            END
          )::int
            AS eligible_purchase_count,

          COALESCE(
            SUM(
              CASE
                WHEN re.eligible = true
                 AND re.status = 'active'
                THEN re.roundup_amount
                ELSE 0
              END
            ),
            0
          ) AS roundup_opportunity,

          MIN(
            COALESCE(
              t.posted_date,
              t.authorized_date
            )
          ) AS earliest_transaction_date,

          MAX(
            COALESCE(
              t.posted_date,
              t.authorized_date
            )
          ) AS latest_transaction_date

        FROM transactions t

        INNER JOIN accounts a
          ON a.id = t.account_id

        INNER JOIN plaid_items p
          ON p.id = a.plaid_item_id

        LEFT JOIN roundup_events re
          ON re.transaction_id = t.id

        WHERE p.user_id = $1
          AND p.status = 'active'
          AND t.status = 'active'
      `,
      [userId],
    );

    /*
     * ----------------------------------------------------------------------
     * CATEGORY OBSERVATION
     * ----------------------------------------------------------------------
     */
    const categoryResult = await pool.query(
      `
        SELECT
          COALESCE(
            NULLIF(t.category, ''),
            'Uncategorized'
          ) AS category,

          COUNT(*)::int AS purchase_count,

          COALESCE(
            SUM(re.roundup_amount),
            0
          ) AS roundup_opportunity

        FROM roundup_events re

        INNER JOIN transactions t
          ON t.id = re.transaction_id

        INNER JOIN accounts a
          ON a.id = t.account_id

        INNER JOIN plaid_items p
          ON p.id = a.plaid_item_id

        WHERE p.user_id = $1
          AND p.status = 'active'
          AND t.status = 'active'
          AND re.status = 'active'
          AND re.eligible = true

        GROUP BY
          COALESCE(
            NULLIF(t.category, ''),
            'Uncategorized'
          )

        ORDER BY
          roundup_opportunity DESC,
          purchase_count DESC
      `,
      [userId],
    );

    /*
     * ----------------------------------------------------------------------
     * MERCHANT OBSERVATION
     * ----------------------------------------------------------------------
     */
    const merchantResult = await pool.query(
      `
        SELECT
          COALESCE(
            NULLIF(t.merchant_name, ''),
            'Unknown merchant'
          ) AS merchant,

          COUNT(*)::int AS purchase_count,

          COALESCE(
            SUM(re.roundup_amount),
            0
          ) AS roundup_opportunity,

          COALESCE(
            AVG(re.roundup_amount),
            0
          ) AS average_roundup

        FROM roundup_events re

        INNER JOIN transactions t
          ON t.id = re.transaction_id

        INNER JOIN accounts a
          ON a.id = t.account_id

        INNER JOIN plaid_items p
          ON p.id = a.plaid_item_id

        WHERE p.user_id = $1
          AND p.status = 'active'
          AND t.status = 'active'
          AND re.status = 'active'
          AND re.eligible = true

        GROUP BY
          COALESCE(
            NULLIF(t.merchant_name, ''),
            'Unknown merchant'
          )

        ORDER BY
          roundup_opportunity DESC,
          purchase_count DESC

        LIMIT 10
      `,
      [userId],
    );

    /*
     * ----------------------------------------------------------------------
     * RECENT ROUND-UP EVIDENCE
     * ----------------------------------------------------------------------
     *
     * These are actual persisted Round-Up events joined back to their
     * underlying transactions.
     */
    const recentResult = await pool.query(
      `
        SELECT
          re.id,
          t.merchant_name,
          t.amount,
          t.iso_currency_code,
          t.category,
          t.pending,
          t.authorized_date,
          t.posted_date,
          re.roundup_amount,
          re.rule_version

        FROM roundup_events re

        INNER JOIN transactions t
          ON t.id = re.transaction_id

        INNER JOIN accounts a
          ON a.id = t.account_id

        INNER JOIN plaid_items p
          ON p.id = a.plaid_item_id

        WHERE p.user_id = $1
          AND p.status = 'active'
          AND t.status = 'active'
          AND re.status = 'active'
          AND re.eligible = true

        ORDER BY
          COALESCE(
            t.posted_date,
            t.authorized_date
          ) DESC NULLS LAST,
          t.created_at DESC

        LIMIT 10
      `,
      [userId],
    );

    const summary = summaryResult.rows[0];

    return res.json({
      status: 'ok',

      user,

      observation: {
        earliest_transaction_date:
          summary.earliest_transaction_date,

        latest_transaction_date:
          summary.latest_transaction_date,
      },

      accounts:
        accountsResult.rows,

      summary: {
        transaction_count:
          summary.transaction_count,

        posted_transaction_count:
          summary.posted_transaction_count,

        pending_transaction_count:
          summary.pending_transaction_count,

        eligible_purchase_count:
          summary.eligible_purchase_count,

        roundup_opportunity:
          summary.roundup_opportunity,
      },

      categories:
        categoryResult.rows,

      merchants:
        merchantResult.rows,

      recent_roundups:
        recentResult.rows,
    });
  } catch (err) {
    console.error(
      'Get dashboard failed:',
      err,
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your financial dashboard',
    });
  }
}


module.exports = {
  getMe,
  getSummary,
  getAccounts,
  getTransactions,
  getInsights,
  getNetWorth,
  getIncome,
  getCashFlow,
  getDashboard,
};
