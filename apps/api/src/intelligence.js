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

function classifyCadence(medianGapDays) {
  if (medianGapDays >= 5 && medianGapDays <= 9) return 'weekly';
  if (medianGapDays >= 12 && medianGapDays <= 17) return 'biweekly';
  if (medianGapDays >= 27 && medianGapDays <= 33) return 'monthly';
  return 'irregular';
}

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

  // Group by merchant_name when present; direct deposits often lack it
  // (a real, documented Plaid fill-rate gap), so fall back to grouping by
  // rounded amount for those rather than dropping them entirely.
  const groups = {};
  for (const txn of result.rows) {
    const amount = Math.abs(Number(txn.amount));
    const key = txn.merchant_name || `amt:${Math.round(amount)}`;
    if (!groups[key]) groups[key] = { label: txn.merchant_name || null, txns: [] };
    groups[key].txns.push(txn);
  }

  let best = null;
  for (const [key, group] of Object.entries(groups)) {
    const txns = group.txns;
    if (txns.length < 3) continue;

    const dates = txns.map(t => new Date(t.posted_date).getTime());
    const gaps = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push((dates[i] - dates[i - 1]) / 86400000);
    }
    const gapMedian = median(gaps);
    const gapMean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const gapStddev = stddev(gaps, gapMean);
    const reliability = gapMean > 0 ? Math.max(0, Math.min(1, 1 - gapStddev / gapMean)) : 0;

    const cadence = classifyCadence(gapMedian);
    if (cadence === 'irregular') continue; // not a real income signal — don't store it as one

    const amounts = txns.map(t => Math.abs(Number(t.amount)));
    const avgAmount = median(amounts); // resistant to one outlier deposit skewing the number
    const lastDate = new Date(dates[dates.length - 1]);
    const nextExpectedDate = new Date(lastDate.getTime() + gapMedian * 86400000);

    if (!best || txns.length > best.occurrences) {
      best = {
        sourceLabel: group.label || key,
        cadence, avgAmount, reliability,
        occurrences: txns.length,
        lastDate, nextExpectedDate,
      };
    }
  }

  if (best) {
    await pool.query(
      `insert into income_signals
        (user_id, detected_cadence, average_amount, reliability_score,
         source_merchant, last_detected_date, next_expected_date)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId, best.cadence, Math.round(best.avgAmount * 100) / 100,
        Math.round(best.reliability * 100) / 100, best.sourceLabel,
        best.lastDate.toISOString().slice(0, 10),
        best.nextExpectedDate.toISOString().slice(0, 10),
      ]
    );
  }
  return best;
}

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
