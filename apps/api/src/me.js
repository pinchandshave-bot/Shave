const pool = require('./db');
const { computeCashflowRunway } = require('./intelligence');

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
    `select a.id, a.name, a.type, a.subtype, a.mask, pi.institution_name,
            a.current_balance, a.available_balance, a.balance_iso_currency_code, a.balance_updated_at
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

async function getNetWorth(req, res) {
  const userId = req.user.id;

  const accounts = await pool.query(
    `select a.id, a.name, a.type, a.subtype, a.current_balance, a.available_balance, a.balance_updated_at
     from accounts a
     join plaid_items pi on pi.id = a.plaid_item_id
     where pi.user_id = $1`,
    [userId]
  );

  const creditLiabilities = await pool.query(
    `select lc.account_id, lc.aprs, lc.is_overdue, lc.minimum_payment_amount,
            lc.next_payment_due_date, a.current_balance, a.name
     from liabilities_credit lc
     join accounts a on a.id = lc.account_id
     join plaid_items pi on pi.id = a.plaid_item_id
     where pi.user_id = $1`,
    [userId]
  );

  const studentLiabilities = await pool.query(
    `select ls.account_id, ls.interest_rate_percentage, ls.is_overdue,
            ls.minimum_payment_amount, ls.next_payment_due_date, a.current_balance, a.name
     from liabilities_student ls
     join accounts a on a.id = ls.account_id
     join plaid_items pi on pi.id = a.plaid_item_id
     where pi.user_id = $1`,
    [userId]
  );

  const mortgageLiabilities = await pool.query(
    `select lm.account_id, lm.interest_rate_percentage, lm.next_payment_due_date,
            lm.next_monthly_payment, a.current_balance, a.name
     from liabilities_mortgage lm
     join accounts a on a.id = lm.account_id
     join plaid_items pi on pi.id = a.plaid_item_id
     where pi.user_id = $1`,
    [userId]
  );

  const investments = await pool.query(
    `select ih.account_id, a.name, sum(ih.institution_value) as account_value
     from investment_holdings ih
     join accounts a on a.id = ih.account_id
     join plaid_items pi on pi.id = a.plaid_item_id
     where pi.user_id = $1
     group by ih.account_id, a.name`,
    [userId]
  );

  let totalCash = 0, totalDebt = 0, totalInvestments = 0;
  for (const a of accounts.rows) {
    const bal = Number(a.current_balance) || 0;
    if (a.type === 'depository') totalCash += bal;
    if (a.type === 'credit' || a.type === 'loan') totalDebt += bal;
  }
  for (const inv of investments.rows) totalInvestments += Number(inv.account_value) || 0;

  const debtItems = [];
  for (const c of creditLiabilities.rows) {
    const aprs = c.aprs || [];
    const purchaseApr = aprs.find(a => a.apr_type === 'purchase_apr');
    debtItems.push({
      name: c.name, kind: 'credit_card', balance: Number(c.current_balance) || 0,
      rate: purchaseApr ? Number(purchaseApr.apr_percentage) : null,
      is_overdue: c.is_overdue, minimum_payment: c.minimum_payment_amount,
      next_payment_due_date: c.next_payment_due_date,
    });
  }
  for (const s of studentLiabilities.rows) {
    debtItems.push({
      name: s.name, kind: 'student_loan', balance: Number(s.current_balance) || 0,
      rate: s.interest_rate_percentage !== null ? Number(s.interest_rate_percentage) : null,
      is_overdue: s.is_overdue, minimum_payment: s.minimum_payment_amount,
      next_payment_due_date: s.next_payment_due_date,
    });
  }
  for (const m of mortgageLiabilities.rows) {
    debtItems.push({
      name: m.name, kind: 'mortgage', balance: Number(m.current_balance) || 0,
      rate: m.interest_rate_percentage !== null ? Number(m.interest_rate_percentage) : null,
      is_overdue: null, minimum_payment: m.next_monthly_payment,
      next_payment_due_date: m.next_payment_due_date,
    });
  }

  let weightedRateSum = 0, rateWeightBalance = 0;
  for (const d of debtItems) {
    if (d.rate !== null && d.balance > 0) {
      weightedRateSum += d.rate * d.balance;
      rateWeightBalance += d.balance;
    }
  }
  const blendedApr = rateWeightBalance > 0 ? Math.round((weightedRateSum / rateWeightBalance) * 100) / 100 : null;

  const highestRateDebt = debtItems
    .filter(d => d.rate !== null && d.balance > 0)
    .sort((a, b) => b.rate - a.rate)[0] || null;

  res.json({
    status: 'ok',
    total_cash: Math.round(totalCash * 100) / 100,
    total_debt: Math.round(totalDebt * 100) / 100,
    total_investments: Math.round(totalInvestments * 100) / 100,
    net_worth: Math.round((totalCash + totalInvestments - totalDebt) * 100) / 100,
    blended_debt_rate: blendedApr,
    highest_rate_debt: highestRateDebt,
    debt_items: debtItems,
    investment_accounts: investments.rows.map(i => ({
      account_id: i.account_id, name: i.name, value: Math.round(Number(i.account_value) * 100) / 100,
    })),
    data_completeness: {
      has_any_liability_data: debtItems.length > 0,
      has_any_investment_data: investments.rows.length > 0,
    },
  });
}

async function getIncome(req, res) {
  const userId = req.user.id;

  const signalResult = await pool.query(
    `select detected_cadence, average_amount, reliability_score, computed_at
     from income_signals
     where user_id = $1
     order by computed_at desc
     limit 1`,
    [userId]
  );

  const runway = await computeCashflowRunway(userId);

  res.json({
    status: 'ok',
    income_signal: signalResult.rows[0] || null,
    cashflow: runway,
  });
}

module.exports = { getSummary, getAccounts, getTransactions, getInsights, getNetWorth, getIncome };
