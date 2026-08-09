const pool = require('./db');

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(arr, mean) {
  if (arr.length < 2) return 0;
  const variance = arr.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / arr.length;
  return Math.sqrt(variance);
}

// Deliberately coarse: weekly, biweekly (also covers true semimonthly —
// distinguishing "every 14 days" from "1st and 15th of the month" reliably
// needs day-of-month analysis, not just gap length, and this simpler
// classifier doesn't attempt that distinction rather than fake precision
// it can't back up), monthly, or irregular.
function classifyCadence(medianGapDays) {
  if (medianGapDays >= 5 && medianGapDays <= 9) return 'weekly';
  if (medianGapDays >= 12 && medianGapDays <= 17) return 'biweekly';
  if (medianGapDays >= 27 && medianGapDays <= 33) return 'monthly';
  return 'irregular';
}

// Groups the user's deposits (negative amount, Plaid's convention for money
// coming in) by merchant_name where available — the most reliable signal for
// payroll ("ACME CORP PAYROLL", "GUSTO", etc.) — then looks for a repeating
// pattern within each group. Requires at least 3 occurrences before calling
// anything a pattern; two matching deposits could easily be coincidence.
async function computeIncomeSignals(userId) {
  const result = await pool.query(
    `select t.merchant_name, t.amount, t.posted_date
     from transactions t
     join accounts a on a.id = t.account_id
     join plaid_items pi on pi.id = a.plaid_item_id
     where pi.user_id = $1 and t.amount < 0 and t.posted_date is not null
     order by t.posted_date asc`,
    [userId]
  );

  const groups = {};
  for (const txn of result.rows) {
    const key = txn.merchant_name || 'unlabeled';
    if (!groups[key]) groups[key] = [];
    groups[key].push(txn);
  }

  let best = null;
  for (const [merchant, txns] of Object.entries(groups)) {
    if (merchant === 'unlabeled' || txns.length < 3) continue;

    const dates = txns.map(t => new Date(t.posted_date).getTime());
    const gaps = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push((dates[i] - dates[i - 1]) / 86400000);
    }
    const gapMedian = median(gaps);
    const gapMean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const gapStddev = stddev(gaps, gapMean);
    const reliability = gapMean > 0 ? Math.max(0, Math.min(1, 1 - gapStddev / gapMean)) : 0;

    const amounts = txns.map(t => Math.abs(Number(t.amount)));
    const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const cadence = classifyCadence(gapMedian);

    if (!best || txns.length > best.occurrences) {
      best = { cadence, avgAmount, reliability, occurrences: txns.length };
    }
  }

  if (best) {
    await pool.query(
      `insert into income_signals (user_id, detected_cadence, average_amount, reliability_score)
       values ($1, $2, $3, $4)`,
      [userId, best.cadence, Math.round(best.avgAmount * 100) / 100, Math.round(best.reliability * 100) / 100]
    );
  }
  return best;
}

// "Safe to spend" runway: at the current net daily pace (last 30 days of
// real transactions), how many days until cash balance reaches zero.
// Returns null (not a fabricated number) when cash flow is net-positive —
// "declining toward zero" isn't a meaningful question if it isn't declining.
async function computeCashflowRunway(userId) {
  const cashResult = await pool.query(
    `select coalesce(sum(a.current_balance), 0) as total_cash
     from accounts a
     join plaid_items pi on pi.id = a.plaid_item_id
     where pi.user_id = $1 and a.type = 'depository'`,
    [userId]
  );
  const totalCash = Number(cashResult.rows[0].total_cash) || 0;

  const flowResult = await pool.query(
    `select
       coalesce(sum(case when t.amount > 0 then t.amount else 0 end), 0) as total_out,
       coalesce(sum(case when t.amount < 0 then -t.amount else 0 end), 0) as total_in,
       min(t.posted_date) as earliest, max(t.posted_date) as latest
     from transactions t
     join accounts a on a.id = t.account_id
     join plaid_items pi on pi.id = a.plaid_item_id
     where pi.user_id = $1 and t.posted_date >= now() - interval '30 days'`,
    [userId]
  );
  const row = flowResult.rows[0];
  const totalOut = Number(row.total_out) || 0;
  const totalIn = Number(row.total_in) || 0;
  const windowDays = row.earliest && row.latest
    ? Math.max(1, Math.ceil((new Date(row.latest) - new Date(row.earliest)) / 86400000))
    : 0;

  if (windowDays === 0) {
    return { total_cash: totalCash, net_daily_change: null, runway_days: null, status: 'insufficient_data' };
  }

  const netDailyChange = (totalOut - totalIn) / windowDays;
  const runwayDays = netDailyChange > 0 ? Math.round(totalCash / netDailyChange) : null;

  return {
    total_cash: Math.round(totalCash * 100) / 100,
    net_daily_change: Math.round(netDailyChange * 100) / 100,
    runway_days: runwayDays,
    status: netDailyChange > 0 ? 'declining' : 'stable_or_growing',
    based_on_days: windowDays,
  };
}

module.exports = { computeIncomeSignals, computeCashflowRunway };
