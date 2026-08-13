const pool = require('./db');

const {
  getFinancialIntelligence,
} = require('./intelligence');

const {
  computeIncomeSignals,
  computeCashflowRunway,
} = require('./income');


async function getMe(req, res) {
  try {
    const userResult =
      await pool.query(
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

    if (
      userResult.rows.length === 0
    ) {
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


async function getDashboard(req, res) {
  const userId =
    req.user.id;

  try {
    /*
     * Core intelligence engine.
     */

    const intelligence =
      await getFinancialIntelligence(
        userId
      );

    /*
     * Income is independently evidence-gated.
     */

    let income = null;

    try {
      income =
        await computeIncomeSignals(
          userId
        );
    } catch (incomeError) {
      console.error(
        'Income intelligence failed:',
        incomeError
      );

      income = {
        evidence_state:
          'unavailable',
        signal: null,
        candidates: [],
      };
    }

    /*
     * Runway is independently evidence-gated.
     */

    let runway = null;

    try {
      runway =
        await computeCashflowRunway(
          userId
        );
    } catch (runwayError) {
      console.error(
        'Runway intelligence failed:',
        runwayError
      );

      runway = {
        evidence_state:
          'unavailable',
        status:
          'unavailable',
        total_cash: null,
        runway_days: null,
      };
    }

    /*
     * Base transaction state.
     */

    const transactionStateResult =
      await pool.query(
        `
          SELECT
            COUNT(*)::int
              AS transaction_count,

            COUNT(*) FILTER (
              WHERE t.pending = true
            )::int
              AS pending_transaction_count,

            COUNT(*) FILTER (
              WHERE t.pending = false
            )::int
              AS posted_transaction_count,

            MIN(
              COALESCE(
                t.posted_date,
                t.authorized_date
              )
            )
              AS observation_start,

            MAX(
              COALESCE(
                t.posted_date,
                t.authorized_date
              )
            )
              AS observation_end

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

    const transactionState =
      transactionStateResult.rows[0] ||
      {
        transaction_count: 0,
        pending_transaction_count: 0,
        posted_transaction_count: 0,
        observation_start: null,
        observation_end: null,
      };

    /*
     * Account state.
     */

    const accountsResult =
      await pool.query(
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
     * Round-Up category/merchant data.
     */

    const categoryResult =
      await pool.query(
        `
          SELECT
            COALESCE(
              NULLIF(
                t.category,
                ''
              ),
              'Uncategorized'
            ) AS category,

            COUNT(*)::int
              AS purchase_count,

            COALESCE(
              SUM(
                r.roundup_amount
              ),
              0
            ) AS roundup_opportunity,

            COALESCE(
              AVG(
                r.roundup_amount
              ),
              0
            ) AS average_roundup

          FROM roundup_events r

          INNER JOIN transactions t
            ON t.id =
              r.transaction_id

          INNER JOIN accounts a
            ON a.id =
              t.account_id

          INNER JOIN plaid_items p
            ON p.id =
              a.plaid_item_id

          WHERE r.user_id = $1
            AND p.user_id = $1
            AND p.status = 'active'
            AND r.status = 'active'
            AND r.eligible = true
            AND t.status = 'active'

          GROUP BY
            COALESCE(
              NULLIF(
                t.category,
                ''
              ),
              'Uncategorized'
            )

          ORDER BY
            roundup_opportunity DESC
        `,
        [userId]
      );

    const merchantResult =
      await pool.query(
        `
          SELECT
            COALESCE(
              NULLIF(
                t.merchant_name,
                ''
              ),
              'Unknown merchant'
            ) AS merchant,

            COUNT(*)::int
              AS purchase_count,

            COALESCE(
              SUM(
                r.roundup_amount
              ),
              0
            ) AS roundup_opportunity,

            COALESCE(
              AVG(
                r.roundup_amount
              ),
              0
            ) AS average_roundup

          FROM roundup_events r

          INNER JOIN transactions t
            ON t.id =
              r.transaction_id

          INNER JOIN accounts a
            ON a.id =
              t.account_id

          INNER JOIN plaid_items p
            ON p.id =
              a.plaid_item_id

          WHERE r.user_id = $1
            AND p.user_id = $1
            AND p.status = 'active'
            AND r.status = 'active'
            AND r.eligible = true
            AND t.status = 'active'

          GROUP BY
            COALESCE(
              NULLIF(
                t.merchant_name,
                ''
              ),
              'Unknown merchant'
            )

          ORDER BY
            roundup_opportunity DESC
        `,
        [userId]
      );

    /*
     * Recent Round-Up events.
     */

    const recentResult =
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
            ON t.id =
              r.transaction_id

          INNER JOIN accounts a
            ON a.id =
              t.account_id

          INNER JOIN plaid_items p
            ON p.id =
              a.plaid_item_id

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

          LIMIT 20
        `,
        [userId]
      );

    const roundup =
      intelligence.roundup;

    return res.json({
      status: 'ok',

      user: null,

      observation: {
        earliest_transaction_date:
          transactionState
            .observation_start,

        latest_transaction_date:
          transactionState
            .observation_end,
      },

      data_state: {
        accounts_available:
          accountsResult.rows
            .length > 0,

        transactions_available:
          Number(
            transactionState
              .transaction_count
          ) > 0,

        roundup_available:
          Number(
            roundup
              .eligible_purchase_count
          ) > 0,

        income_available:
          income &&
          income.evidence_state ===
            'supported',

        cash_flow_available:
          intelligence.cash_flow &&
          (
            intelligence.cash_flow
              .evidence_state ===
            'supported'
          ),
      },

      accounts:
        accountsResult.rows,

      summary: {
        transaction_count:
          Number(
            transactionState
              .transaction_count
          ),

        posted_transaction_count:
          Number(
            transactionState
              .posted_transaction_count
          ),

        pending_transaction_count:
          Number(
            transactionState
              .pending_transaction_count
          ),

        eligible_purchase_count:
          Number(
            roundup
              .eligible_purchase_count
          ),

        roundup_opportunity:
          roundup.opportunity,

        average_roundup:
          roundup.average,

        median_roundup:
          roundup.median,

        smallest_roundup:
          roundup.smallest,

        largest_roundup:
          roundup.largest,
      },

      categories:
        categoryResult.rows,

      merchants:
        merchantResult.rows,

      recent_roundups:
        recentResult.rows,

      intelligence,

      income,

      runway,

      /*
       * Explicit evidence contract.
       *
       * This makes it possible for the frontend
       * to distinguish facts from conclusions.
       */

      evidence: intelligence.evidence,

      insights:
        intelligence.insights,

      transaction_state:
        transactionState,

      roundup: {
        ...roundup,
      },
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


async function getSummary(
  req,
  res
) {
  try {
    const result =
      await pool.query(
        `
          SELECT
            COUNT(*)::int
              AS transaction_count,

            COALESCE(
              SUM(amount),
              0
            ) AS transaction_total

          FROM transactions t

          INNER JOIN accounts a
            ON a.id =
              t.account_id

          INNER JOIN plaid_items p
            ON p.id =
              a.plaid_item_id

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


async function getAccounts(
  req,
  res
) {
  try {
    const result =
      await pool.query(
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
            ON p.id =
              a.plaid_item_id

          WHERE p.user_id = $1
            AND p.status = 'active'

          ORDER BY
            a.created_at ASC
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


async function getTransactions(
  req,
  res
) {
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
            ON a.id =
              t.account_id

          INNER JOIN plaid_items p
            ON p.id =
              a.plaid_item_id

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


async function getRoundups(
  req,
  res
) {
  try {
    const result =
      await pool.query(
        `
          SELECT
            r.*,
            t.merchant_name,
            t.category,
            t.amount,
            t.iso_currency_code,
            t.pending,
            t.authorized_date,
            t.posted_date

          FROM roundup_events r

          INNER JOIN transactions t
            ON t.id =
              r.transaction_id

          INNER JOIN accounts a
            ON a.id =
              t.account_id

          INNER JOIN plaid_items p
            ON p.id =
              a.plaid_item_id

          WHERE r.user_id = $1
            AND p.user_id = $1
            AND p.status = 'active'
            AND r.status = 'active'
            AND t.status = 'active'

          ORDER BY
            COALESCE(
              t.posted_date,
              t.authorized_date
            ) DESC NULLS LAST
        `,
        [req.user.id]
      );

    return res.json({
      status: 'ok',
      roundups:
        result.rows,
    });
  } catch (err) {
    console.error(
      'Get roundups failed:',
      err
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your Round-Ups',
    });
  }
}


async function getInsights(
  req,
  res
) {
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


async function getNetWorth(
  req,
  res
) {
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
            ON p.id =
              a.plaid_item_id

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


async function getIncome(
  req,
  res
) {
  try {
    const income =
      await computeIncomeSignals(
        req.user.id
      );

    return res.json({
      status: 'ok',
      income,
    });
  } catch (err) {
    console.error(
      'Get income failed:',
      err
    );

    return res.status(500).json({
      status: 'error',
      message:
        'Unable to load your income intelligence',
    });
  }
}


async function getCashFlow(
  req,
  res
) {
  try {
    const intelligence =
      await getFinancialIntelligence(
        req.user.id
      );

    return res.json({
      status: 'ok',

      cash_flow:
        intelligence.cash_flow,

      runway:
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
        'Unable to load your cash flow intelligence',
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
