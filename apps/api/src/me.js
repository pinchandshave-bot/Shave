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

module.exports = { getSummary, getAccounts, getTransactions };
