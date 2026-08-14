const pool = require('./db');

/**
 * Return the authenticated user's core iBag state.
 *
 * Read-only.
 * No financial data is created, modified, fabricated, or seeded.
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
      [user.id],
    );

    return res.json({
      status: 'ok',
      user,
      ibag: ibagResult.rows[0] || null,
      accounts: accountsResult.rows,
    });
  } catch (err) {
    console.error('Get current user failed:', err);

    return res.status(500).json({
      status: 'error',
      message: 'Unable to load your iBag right now',
    });
  }
}


/**
 * Dashboard financial state.
 *
 * The response shape intentionally matches the current
 * iBag dashboard frontend contract.
 *
 * All financial values come from real authenticated-user
 * database records. Nothing is fabricated or seeded.
 */
async function getDashboard(req, res) {
  const userId = req.user.id;

  try {
    /*
     * USER
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

    /*
     * ACCOUNTS
     */
    const accountsResult = await pool.query(
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
      [userId],
    );

    /*
     * TRANSACTION SUMMARY
     */
    const transactionStateResult = await pool.query(
      `
        SELECT
          COUNT(*)::int AS transaction_count,

          COUNT(*) FILTER (
            WHERE t.pending = false
          )::int AS posted_transaction_count,

          COUNT(*) FILTER (
            WHERE t.pending = true
          )::int AS pending_transaction_count,

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

        WHERE p.user_id = $1
          AND p.status = 'active'
          AND t.status = 'active'
      `,
      [userId],
    );

    /*
     * ROUND-UP SUMMARY
     */
    const roundupStateResult = await pool.query(
      `
        SELECT
          COUNT(*)::int AS eligible_purchase_count,

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
      `,
      [userId],
    );

    /*
     * ROUND-UP BY CATEGORY
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
          SUM(r.roundup_amount) DESC
      `,
      [userId],
    );

    /*
     * ROUND-UP BY MERCHANT
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
          SUM(r.roundup_amount) DESC
      `,
      [userId],
    );

    /*
     * RECENT ROUND-UP EVENTS
     *
     * Include the transaction fields expected by
     * the dashboard frontend.
     */
    const recentRoundupsResult = await pool.query(
      `
        SELECT
          r.id,
          r.roundup_amount,
          r.rule_version,

          t.amount,
          t.iso_currency_code,
          t.merchant_name,
          t.category,
          t.pending,
          t.authorized_date,
          t.posted_date

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
      [userId],
    );

    const transactionState =
      transactionStateResult.rows[0] || {
        transaction_count: 0,
        posted_transaction_count: 0,
        pending_transaction_count: 0,
        earliest_transaction_date: null,
        latest_transaction_date: null,
      };

    const roundupState =
      roundupStateResult.rows[0] || {
        eligible_purchase_count: 0,
        roundup_opportunity: 0,
      };

    /*
     * RETURN EXACTLY WHAT THE DASHBOARD EXPECTS.
     */
    return res.json({
      status: 'ok',

      user: userResult.rows[0],

      observation: {
        earliest_transaction_date:
          transactionState.earliest_transaction_date,

        latest_transaction_date:
          transactionState.latest_transaction_date,
      },

      accounts:
        accountsResult.rows,

      summary: {
        transaction_count:
          Number(
            transactionState.transaction_count,
          ),

        posted_transaction_count:
          Number(
            transactionState.posted_transaction_count,
          ),

        pending_transaction_count:
          Number(
            transactionState.pending_transaction_count,
          ),

        eligible_purchase_count:
          Number(
            roundupState.eligible_purchase_count,
          ),

        roundup_opportunity:
          roundupState.roundup_opportunity,
      },

      categories:
        categoryResult.rows,

      merchants:
        merchantResult.rows,

      recent_roundups:
        recentRoundupsResult.rows,
    });
  } catch (err) {
    console.error(
      'Get dashboard failed:',
      err,
    );

    return res.status(500).json({
      status: 'error',
      message:
        'The API encountered an internal error while loading your financial picture.',
    });
  }
}


/**
 * Existing financial summary.
 */
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
 * Connected financial accounts.
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
 * Real transactions belonging to the authenticated user.
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
          AND p.status = 'active'
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
 * Round-Up events belonging to the authenticated user.
 */
async function getRoundups(req, res) {
  try {
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
          t.iso_currency_code,
          t.merchant_name,
          t.category,
          t.pending,
          t.authorized_date,
          t.posted_date

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
      roundups: result.rows,
    });
  } catch (err) {
    console.error(
      'Get roundups failed:',
      err,
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your Round-Up activity',
    });
  }
}


/**
 * Insights remain evidence-gated.
 *
 * No insight is fabricated until the intelligence engine
 * produces qualifying evidence.
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
 * Net worth.
 *
 * This name is retained for compatibility.
 * Underlying value is the sum of connected account
 * current balances.
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
      net_worth:
        result.rows[0].net_worth,
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
 * Income remains unavailable until a real
 * income-analysis data path exists.
 */
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
 * Cash flow remains unavailable until the
 * corresponding real analysis path exists.
 */
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
      err,
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your cash flow',
    });
  }
}


module.exports = {
  getMe,
  getDashboard,
  getSummary,
  getAccounts,
  getTransactions,
  getRoundups,
  getInsights,
  getNetWorth,
  getIncome,
  getCashFlow,
};
