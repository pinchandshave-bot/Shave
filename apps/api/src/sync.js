const pool = require('./db');
const plaidClient = require('./plaidClient').plaidClient;
const { decrypt } = require('./crypto');
const { calculateRoundup } = require('./roundup');
const { syncBalance, syncLiabilities, syncInvestments, syncIdentity } = require('./products');
const { computeIncomeSignals } = require('./intelligence');

async function syncOneItem(item) {
  const runInsert = await pool.query(
    'insert into sync_runs (plaid_item_id) values ($1) returning id',
    [item.id]
  );
  const runId = runInsert.rows[0].id;
  try {
    const accessToken = decrypt(item.plaid_access_token_encrypted);
    let cursor = item.cursor;
    let added = [], modified = [], removed = [];
    let hasMore = true;
    while (hasMore) {
      const response = await plaidClient.transactionsSync({
        access_token: accessToken,
        cursor: cursor || undefined,
      });
      added = added.concat(response.data.added);
      modified = modified.concat(response.data.modified);
      removed = removed.concat(response.data.removed);
      hasMore = response.data.has_more;
      cursor = response.data.next_cursor;
    }
    const acctRows = await pool.query(
      'select id, plaid_account_id from accounts where plaid_item_id = $1',
      [item.id]
    );
    const acctMap = {};
    for (const a of acctRows.rows) acctMap[a.plaid_account_id] = a.id;
    const userRow = await pool.query('select user_id from plaid_items where id = $1', [item.id]);
    const userId = userRow.rows[0].user_id;

    let syncedCount = 0;
    for (const txn of [...added, ...modified]) {
      const accountId = acctMap[txn.account_id];
      if (!accountId) continue;
      const txnInsert = await pool.query(
        `insert into transactions
          (account_id, plaid_transaction_id, amount, iso_currency_code, merchant_name, category, pending, authorized_date, posted_date, raw)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (plaid_transaction_id) do update set
           amount = excluded.amount, pending = excluded.pending, raw = excluded.raw
         returning id`,
        [
          accountId, txn.transaction_id, txn.amount, txn.iso_currency_code,
          txn.merchant_name, txn.personal_finance_category?.primary || null,
          txn.pending, txn.authorized_date, txn.date, JSON.stringify(txn),
        ]
      );
      syncedCount++;
      const txnDbId = txnInsert.rows[0].id;
      const roundup = calculateRoundup(Number(txn.amount));

      if (roundup > 0) {
        // Option B: keep the roundup in sync with the transaction's amount.
        // A pending charge's amount routinely changes once it posts (tips,
        // pump pre-auths, etc.) — this updates the roundup to match rather
        // than freezing it at the first-seen amount.
        await pool.query(
          `insert into roundup_events (user_id, transaction_id, roundup_amount)
           values ($1, $2, $3)
           on conflict (transaction_id) do update set roundup_amount = excluded.roundup_amount`,
          [userId, txnDbId, roundup]
        );
      } else {
        // The transaction's amount changed such that it's no longer
        // roundup-eligible (e.g. corrected to a refund, or crossed the
        // rent-sized threshold). If an earlier pass created a roundup
        // event for it, that's now stale and needs to go — otherwise a
        // corrected transaction leaves phantom savings behind.
        await pool.query('delete from roundup_events where transaction_id = $1', [txnDbId]);
      }
    }

    // Plaid explicitly tells us which transactions no longer exist (a
    // pending charge that got cancelled before posting, a duplicate Plaid
    // itself retracted). Previously collected into `removed` and never
    // acted on — that let cancelled transactions, and any roundup counted
    // against them, sit in the database indefinitely.
    for (const rem of removed) {
      const existing = await pool.query(
        'select id from transactions where plaid_transaction_id = $1',
        [rem.transaction_id]
      );
      if (existing.rows.length > 0) {
        const removedId = existing.rows[0].id;
        await pool.query('delete from roundup_events where transaction_id = $1', [removedId]);
        await pool.query('delete from transactions where id = $1', [removedId]);
      }
    }

    await pool.query('update plaid_items set cursor = $1 where id = $2', [cursor, item.id]);

    await syncBalance(accessToken, acctMap);
    await syncLiabilities(accessToken, acctMap);
    await syncInvestments(accessToken, acctMap);
    await syncIdentity(accessToken, item.id, acctMap);

    try {
      await computeIncomeSignals(userId);
    } catch (intelErr) {
      console.error('Income signal computation failed for user', userId, intelErr.message);
    }

    await pool.query(
      "update sync_runs set finished_at = now(), added_count = $1, status = 'success' where id = $2",
      [syncedCount, runId]
    );
    return { plaid_item_id: item.plaid_item_id, transactions_synced: syncedCount, removed_count: removed.length };
  } catch (err) {
    const message = err.response?.data?.error_message || err.message;
    await pool.query(
      "update sync_runs set finished_at = now(), status = 'error', error_message = $1 where id = $2",
      [message, runId]
    );
    return { plaid_item_id: item.plaid_item_id, error: message };
  }
}

async function runSync(req, res) {
  const itemsResult = await pool.query(
    "select id, plaid_item_id, plaid_access_token_encrypted, cursor from plaid_items where status = 'active'"
  );
  const results = [];
  for (const item of itemsResult.rows) {
    results.push(await syncOneItem(item));
  }
  res.json({ status: 'ok', items_processed: results.length, results });
}

module.exports = { runSync, syncOneItem };
