const pool = require('./db');

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function computeIncomeSignal(userId) {
  // Negative amount = money IN. This is where income lives.
  const deposits = await pool.query(
    `select t.merchant_name, t.amount, t.posted_date
     from transactions t
     join accounts a on a.id = t.account_id
     join plaid_items pi on pi.id = a.plaid_item_id
     where pi.user_id = $1 and t.amount < 0 and t.posted_date is not null
     order by t.posted_date asc`,
    [userId]
  );

  // Group by merchant/payer name — a recurring payer is the strongest income signal.
  const byPayer = {};
  for (const row of deposits.rows) {
    const key = row.merchant_name || 'Unknown';
    if (!byPayer[key]) byPayer[key] = [];
    byPayer[key].push({ amount: Math.abs(Number(row.amount)), date: new Date(row.posted_date) });
  }

  let best = null;
  for (const [payer, txns] of Object.entries(byPayer)) {
    if (txns.length < 3) continue; // need at least 3 occurrences to call it a pattern

    const gaps = [];
    for (let i = 1; i < txns.length; i++) {
      gaps.push((txns[i].date - txns[i - 1].date) / 86400000);
    }
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance = gaps.reduce((sum, g) => sum + Math.pow(g - avgGap, 2), 0) / gaps.length;
    const stdDev = Math.sqrt(variance);
    const reliability = Math.max(0, Math.min(1, 1 - stdDev / avgGap));

    let cadence;
    if (avgGap >= 5 && avgGap <= 9) cadence = 'weekly';
    else if (avgGap >= 12 && avgGap <= 16) cadence = 'biweekly';
    else if (avgGap >= 27 && avgGap <= 33) cadence = 'monthly';
    else cadence = 'irregular';

    const avgAmount = median(txns.map(t => t.amount));

    // Prefer the payer with the most consistent (highest-reliability) pattern.
    if (!best || reliability > best.reliability_score) {
      best = { detected_cadence: cadence, average_amount: avgAmount, reliability_score: Math.round(reliability * 100) / 100 };
    }
  }

  if (!best) return null; // not enough data yet — don't write a low-confidence guess

  await pool.query(
    `insert into income_signals (user_id, detected_cadence, average_amount, reliability_score, computed_at)
     values ($1, $2, $3, $4, now())
     on conflict (user_id) do update set
       detected_cadence = excluded.detected_cadence, average_amount = excluded.average_amount,
       reliability_score = excluded.reliability_score, computed_at = now()`,
    [userId, best.detected_cadence, best.average_amount, best.reliability_score]
  );

  return best;
}

module.exports = { computeIncomeSignal };
