const pool = require('./db');

async function getSummary(req, res) {
  const result = await pool.query(
    `select
       count(distinct pi.id) as institutions_linked,
       count(distinct a.id) as accounts_linked,
       count(t.id) as transactions_synced,
       coalesce(sum(r.roundup_amount), 0) as total_roundup
     from plaid_items pi
     join accounts a on a.plaid_item_id = pi.id
     left join transactions t on t.account_id = a.id
     left join roundup_events r on r.transaction_id = t.id
     where pi.user_id = $1`,
    [req.user.id]
  );
  res.json({ status: 'ok', summary: result.rows[0] });
}

async function getAccounts(req, res) {
  const result = await pool.query(
    `select a.id, a.name, a.type, a.subtype, a.mask, pi.institution_name
     from accounts a
     join plaid_items pi on pi.id = a.plaid_item_id
     where pi.user_id = $1
     order by a.created_at desc`,
    [req.user.id]
  );
  res.json({ status: 'ok', accounts: result.rows });
}

async function getTransactions(req, res) {
  const result = await pool.query(
    `select t.id, t.merchant_name, t.amount, t.category, t.posted_date, t.pending,
            coalesce(r.roundup_amount, 0) as roundup_amount
     from transactions t
     join accounts a on a.id = t.account_id
     join plaid_items pi on pi.id = a.plaid_item_id
     where pi.user_id = $1
     order by t.posted_date desc nulls last, t.created_at desc
     limit 20`,
    [req.user.id]
  );
  res.json({ status: 'ok', transactions: result.rows });
}

async function getInsights(req, res) {
  const userId = req.user.id;

  const monthly = await pool.query(
    `select to_char(date_trunc('month', t.posted_date), 'YYYY-MM') as month,
            coalesce(sum(r.roundup_amount), 0) as total
     from transactions t
     join accounts a on a.id = t.account_id
     join plaid_items pi on pi.id = a.plaid_item_id
     left join roundup_events r on r.transaction_id = t.id
     where pi.user_id = $1 and t.posted_date >= now() - interval '6 months'
     group by 1 order by 1`,
    [userId]
  );

  const categories = await pool.query(
    `select coalesce(t.category, 'Other') as category,
            sum(r.roundup_amount) as total, count(*) as tx_count
     from transactions t
     join roundup_events r on r.transaction_id = t.id
     join accounts a on a.id = t.account_id
     join plaid_items pi on pi.id = a.plaid_item_id
     where pi.user_id = $1
     group by 1 order by total desc limit 5`,
    [userId]
  );

  // FIX: pull total and count from the same unfiltered query, so the average
  // isn't silently computed over only the top-5-category subset.
  const overall = await pool.query(
    `select coalesce(sum(r.roundup_amount), 0) as total,
            count(*) as txn_count,
            min(t.posted_date) as first_date
     from transactions t
     join roundup_events r on r.transaction_id = t.id
     join accounts a on a.id = t.account_id
     join plaid_items pi on pi.id = a.plaid_item_id
     where pi.user_id = $1`,
    [userId]
  );

  const { total, txn_count, first_date } = overall.rows[0];
  const daysActive = first_date ? Math.max(1, Math.ceil((Date.now() - new Date(first_date)) / 86400000)) : 0;

  // FIX: don't project a full year from a handful of days of data — a single
  // big early month would wildly overstate the annual number.
  const MIN_DAYS_FOR_PROJECTION = 30;
  const projected_annual = daysActive >= MIN_DAYS_FOR_PROJECTION
    ? Math.round((Number(total) / daysActive) * 365 * 100) / 100
    : null;

  res.json({
    status: 'ok',
    monthly_trend: monthly.rows,
    top_categories: categories.rows,
    projected_annual,
    projection_available_in_days: projected_annual === null ? Math.max(0, MIN_DAYS_FOR_PROJECTION - daysActive) : 0,
    avg_per_transaction: txn_count > 0 ? Math.round((Number(total) / Number(txn_count)) * 100) / 100 : 0,
    days_active: daysActive,
  });
}

module.exports = { getSummary, getAccounts, getTransactions, getInsights };
