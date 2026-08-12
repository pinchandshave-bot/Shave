const pool = require('./db');
const plaidClient = require('./plaidClient').plaidClient;
const { decrypt } = require('./crypto');
const { calculateRoundup } = require('./roundup');
const {
  syncBalance,
  syncLiabilities,
  syncInvestments,
  syncIdentity,
} = require('./products');
const { computeIncomeSignals } = require('./intelligence');

async function syncOneItem(item) {
  const runInsert = await pool.query(
    `INSERT INTO sync_runs (plaid_item_id)
     VALUES ($1)
     RETURNING id`,
    [item.id]
  );

  const runId = runInsert.rows[0].id;

  let addedCount = 0;
  let modifiedCount = 0;
  let removedCount = 0;

  try {
    const accessToken = decrypt(item.plaid_access_token_encrypted);

    let cursor = item.cursor || undefined;
    let hasMore = true;

    const added = [];
    const modified = [];
    const removed = [];

    /*
     * ----------------------------------------------------------
     * PLAID TRANSACTION SYNC
     * ----------------------------------------------------------
     *
     * We consume every page until has_more is false.
     * Plaid's next_cursor becomes the durable cursor only after
     * the complete sync has been successfully processed.
     */
    while (hasMore) {
      const response = await plaidClient.transactionsSync({
        access_token: accessToken,
        cursor,
      });

      const data = response.data;

      added.push(...(data.added || []));
      modified.push(...(data.modified || []));
      removed.push(...(data.removed || []));

      hasMore = Boolean(data.has_more);
      cursor = data.next_cursor;
    }

    /*
     * ----------------------------------------------------------
     * ACCOUNT MAP
     * ----------------------------------------------------------
     */
    const acctRows = await pool.query(
      `SELECT id, plaid_account_id
       FROM accounts
       WHERE plaid_item_id = $1`,
      [item.id]
    );

    const acctMap = {};

    for (const account of acctRows.rows) {
      acctMap[account.plaid_account_id] = account.id;
    }

    const userRow = await pool.query(
      `SELECT user_id
       FROM plaid_items
       WHERE id = $1`,
      [item.id]
    );

    if (userRow.rows.length === 0) {
      throw new Error(`No user found for Plaid item ${item.id}`);
    }

    const userId = userRow.rows[0].user_id;

    /*
     * ----------------------------------------------------------
     * ADDED TRANSACTIONS
     * ----------------------------------------------------------
     */
    for (const txn of added) {
      const accountId = acctMap[txn.account_id];

      if (!accountId) {
        continue;
      }

      await upsertTransaction({
        userId,
        accountId,
        txn,
      });

      addedCount++;
    }

    /*
     * ----------------------------------------------------------
     * MODIFIED TRANSACTIONS
     * ----------------------------------------------------------
     */
    for (const txn of modified) {
      const accountId = acctMap[txn.account_id];

      if (!accountId) {
        continue;
      }

      await upsertTransaction({
        userId,
        accountId,
        txn,
      });

      modifiedCount++;
    }

    /*
     * ----------------------------------------------------------
     * REMOVED TRANSACTIONS
     * ----------------------------------------------------------
     *
     * Do NOT hard-delete financial history.
     *
     * Plaid is telling us that this transaction should no longer
     * be considered part of the current Item transaction set.
     *
     * We preserve the record and mark it removed so the system
     * retains an auditable history.
     */
    for (const rem of removed) {
      const existing = await pool.query(
        `SELECT id
         FROM transactions
         WHERE plaid_transaction_id = $1`,
        [rem.transaction_id]
      );

      if (existing.rows.length === 0) {
        continue;
      }

      const transactionId = existing.rows[0].id;

      await pool.query(
        `UPDATE transactions
         SET status = 'removed',
             updated_at = now()
         WHERE id = $1`,
        [transactionId]
      );

      /*
       * A removed transaction cannot continue contributing an
       * active Round-Up.
       */
      await pool.query(
        `UPDATE roundup_events
         SET status = 'voided',
             eligible = false,
             eligibility_reason = 'TRANSACTION_REMOVED',
             updated_at = now()
         WHERE transaction_id = $1
           AND status = 'active'`,
        [transactionId]
      );

      removedCount++;
    }

    /*
     * ----------------------------------------------------------
     * CURSOR COMMIT
     * ----------------------------------------------------------
     *
     * Only advance the cursor after transaction processing has
     * completed successfully.
     */
    await pool.query(
      `UPDATE plaid_items
       SET cursor = $1
       WHERE id = $2`,
      [cursor || null, item.id]
    );

    /*
     * ----------------------------------------------------------
     * BALANCE / LIABILITY / INVESTMENT / IDENTITY SYNC
     * ----------------------------------------------------------
     */
    await syncBalance(accessToken, acctMap);
    await syncLiabilities(accessToken, acctMap);
    await syncInvestments(accessToken, acctMap);
    await syncIdentity(accessToken, item.id, acctMap);

    /*
     * ----------------------------------------------------------
     * FINANCIAL INTELLIGENCE
     * ----------------------------------------------------------
     *
     * Round-Up intelligence is the current Phase 1 capability.
     * Income signals remain isolated so an intelligence failure
     * does not corrupt the financial synchronization state.
     */
    try {
      await computeIncomeSignals(userId);
    } catch (intelErr) {
      console.error(
        'Income signal computation failed for user',
        userId,
        intelErr
      );
    }

    /*
     * ----------------------------------------------------------
     * SYNC RUN SUCCESS
     * ----------------------------------------------------------
     */
    await pool.query(
      `UPDATE sync_runs
       SET finished_at = now(),
           added_count = $1,
           modified_count = $2,
           removed_count = $3,
           status = 'success'
       WHERE id = $4`,
      [
        addedCount,
        modifiedCount,
        removedCount,
        runId,
      ]
    );

    return {
      plaid_item_id: item.plaid_item_id,
      transactions_added: addedCount,
      transactions_modified: modifiedCount,
      transactions_removed: removedCount,
      status: 'success',
    };
  } catch (err) {
    const message =
      err.response?.data?.error_message ||
      err.response?.data?.display_message ||
      err.message ||
      'Unknown synchronization error';

    console.error(
      `Plaid sync failed for item ${item.plaid_item_id}:`,
      err
    );

    await pool.query(
      `UPDATE sync_runs
       SET finished_at = now(),
           added_count = $1,
           modified_count = $2,
           removed_count = $3,
           status = 'error',
           error_message = $4
       WHERE id = $5`,
      [
        addedCount,
        modifiedCount,
        removedCount,
        message,
        runId,
      ]
    );

    return {
      plaid_item_id: item.plaid_item_id,
      transactions_added: addedCount,
      transactions_modified: modifiedCount,
      transactions_removed: removedCount,
      status: 'error',
      error: message,
    };
  }
}


/*
 * ============================================================
 * TRANSACTION UPSERT
 * ============================================================
 *
 * This function is deliberately centralized.
 *
 * Plaid transactions can move through:
 *
 * pending -> posted
 *
 * and can also be modified or removed.
 *
 * The database therefore needs to retain:
 *
 * - Plaid transaction ID
 * - pending transaction lineage
 * - current amount
 * - pending state
 * - lifecycle status
 * - latest raw Plaid representation
 */
async function upsertTransaction({ userId, accountId, txn }) {
  const pendingTransactionId =
    txn.pending_transaction_id || null;

  const status = 'active';

  const result = await pool.query(
    `INSERT INTO transactions (
       account_id,
       plaid_transaction_id,
       amount,
       iso_currency_code,
       merchant_name,
       category,
       pending,
       authorized_date,
       posted_date,
       raw,
       pending_transaction_id,
       status,
       updated_at
     )
     VALUES (
       $1,
       $2,
       $3,
       $4,
       $5,
       $6,
       $7,
       $8,
       $9,
       $10,
       $11,
       $12,
       now()
     )
     ON CONFLICT (plaid_transaction_id)
     DO UPDATE SET
       account_id = EXCLUDED.account_id,
       amount = EXCLUDED.amount,
       iso_currency_code = EXCLUDED.iso_currency_code,
       merchant_name = EXCLUDED.merchant_name,
       category = EXCLUDED.category,
       pending = EXCLUDED.pending,
       authorized_date = EXCLUDED.authorized_date,
       posted_date = EXCLUDED.posted_date,
       raw = EXCLUDED.raw,
       pending_transaction_id = EXCLUDED.pending_transaction_id,
       status = 'active',
       updated_at = now()
     RETURNING id`,
    [
      accountId,
      txn.transaction_id,
      txn.amount,
      txn.iso_currency_code || 'USD',
      txn.merchant_name || null,
      txn.personal_finance_category?.primary || null,
      Boolean(txn.pending),
      txn.authorized_date || null,
      txn.date || null,
      JSON.stringify(txn),
      pendingTransactionId,
      status,
    ]
  );

  const transactionId = result.rows[0].id;

  /*
   * ----------------------------------------------------------
   * ROUND-UP DETERMINATION
   * ----------------------------------------------------------
   */
  const amount = Number(txn.amount);

  const roundup =
    !txn.pending
      ? calculateRoundup(amount)
      : 0;

  /*
   * Pending transactions do not create a final Round-Up.
   *
   * This prevents a temporary authorization amount from becoming
   * a financial-intelligence result before the transaction posts.
   */
  if (roundup > 0) {
    await pool.query(
      `INSERT INTO roundup_events (
         user_id,
         transaction_id,
         roundup_amount,
         transaction_amount,
         eligible,
         eligibility_reason,
         rule_version,
         status,
         updated_at
       )
       VALUES (
         $1,
         $2,
         $3,
         $4,
         true,
         'ELIGIBLE_PURCHASE',
         'ROUNDUP_STANDARD_V1',
         'active',
         now()
       )
       ON CONFLICT (transaction_id)
       DO UPDATE SET
         roundup_amount = EXCLUDED.roundup_amount,
         transaction_amount = EXCLUDED.transaction_amount,
         eligible = true,
         eligibility_reason = 'ELIGIBLE_PURCHASE',
         rule_version = EXCLUDED.rule_version,
         status = 'active',
         updated_at = now()`,
      [
        userId,
        transactionId,
        roundup,
        amount,
      ]
    );
  } else {
    /*
     * If a transaction becomes pending, becomes a refund/credit,
     * reaches the exclusion threshold, or otherwise becomes
     * ineligible, its existing Round-Up must not remain active.
     */
    await pool.query(
      `UPDATE roundup_events
       SET status = 'voided',
           eligible = false,
           eligibility_reason = $1,
           transaction_amount = $2,
           updated_at = now()
       WHERE transaction_id = $3
         AND status = 'active'`,
      [
        txn.pending
          ? 'TRANSACTION_PENDING'
          : amount <= 0
            ? 'NON_POSITIVE_TRANSACTION'
            : amount >= 800
              ? 'TRANSACTION_EXCEEDS_THRESHOLD'
              : 'NOT_ROUNDUP_ELIGIBLE',
        amount,
        transactionId,
      ]
    );
  }

  /*
   * ----------------------------------------------------------
   * PENDING -> POSTED LINEAGE
   * ----------------------------------------------------------
   *
   * If Plaid identifies this transaction as the posted form of
   * a previous pending transaction, connect the records.
   */
  if (pendingTransactionId) {
    await pool.query(
      `UPDATE transactions
       SET status = CASE
         WHEN plaid_transaction_id = $1 THEN status
         ELSE 'removed'
       END,
       updated_at = now()
       WHERE plaid_transaction_id = $2
         AND plaid_transaction_id <> $1`,
      [
        txn.transaction_id,
        pendingTransactionId,
      ]
    );
  }

  return transactionId;
}


/*
 * ============================================================
 * RUN ALL ACTIVE ITEMS
 * ============================================================
 */
async function runSync(req, res) {
  try {
    const itemsResult = await pool.query(
      `SELECT
         id,
         plaid_item_id,
         plaid_access_token_encrypted,
         cursor
       FROM plaid_items
       WHERE status = 'active'
       ORDER BY created_at ASC`
    );

    const results = [];

    for (const item of itemsResult.rows) {
      results.push(await syncOneItem(item));
    }

    const hasErrors = results.some(
      (result) => result.status === 'error'
    );

    res.status(hasErrors ? 207 : 200).json({
      status: hasErrors ? 'partial_error' : 'ok',
      items_processed: results.length,
      results,
    });
  } catch (err) {
    console.error('Global sync failure:', err);

    res.status(500).json({
      status: 'error',
      error: err.message || 'Synchronization failed',
    });
  }
}

module.exports = {
  runSync,
  syncOneItem,
};
