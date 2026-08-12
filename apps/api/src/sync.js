const pool = require('./db');
const plaidClient = require('./plaidClient').plaidClient;
const { decrypt } = require('./crypto');
const { calculateRoundup } = require('./roundup');

const MUTATION_DURING_PAGINATION =
  'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';

const MAX_PAGINATION_RESTARTS = 3;

/**
 * Pull every available Transactions Sync page.
 *
 * Important:
 * Plaid requires the entire pagination cycle to restart from the
 * original cursor if the underlying transaction set mutates while
 * pagination is in progress.
 */
async function fetchTransactionUpdates(accessToken, startingCursor) {
  let restartCount = 0;

  while (true) {
    const originalCursor = startingCursor || undefined;

    let cursor = originalCursor;

    const added = [];
    const modified = [];
    const removed = [];

    try {
      let hasMore = true;

      while (hasMore) {
        const response = await plaidClient.transactionsSync({
          access_token: accessToken,
          cursor,
          count: 500,
        });

        const data = response.data;

        added.push(...(data.added || []));
        modified.push(...(data.modified || []));
        removed.push(...(data.removed || []));

        hasMore = Boolean(data.has_more);
        cursor = data.next_cursor;
      }

      return {
        added,
        modified,
        removed,
        nextCursor: cursor,
      };
    } catch (err) {
      const code = err.response?.data?.error_code;

      if (
        code !== MUTATION_DURING_PAGINATION ||
        restartCount >= MAX_PAGINATION_RESTARTS
      ) {
        throw err;
      }

      restartCount += 1;

      console.warn(
        `Transactions pagination changed during sync; restarting ` +
          `from original cursor. Attempt ${restartCount}/${MAX_PAGINATION_RESTARTS}.`
      );
    }
  }
}

/**
 * Determine why a transaction is or is not eligible for Round-Up.
 *
 * Round-Up rule:
 * - positive purchase
 * - below $800
 * - next-dollar difference must be > 0 and < $1
 */
function evaluateRoundup(amount) {
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount)) {
    return {
      eligible: false,
      reason: 'INVALID_AMOUNT',
      roundupAmount: 0,
    };
  }

  if (numericAmount <= 0) {
    return {
      eligible: false,
      reason: 'NON_POSITIVE_AMOUNT',
      roundupAmount: 0,
    };
  }

  if (numericAmount >= 800) {
    return {
      eligible: false,
      reason: 'RENT_SIZED_OR_LARGER',
      roundupAmount: 0,
    };
  }

  const roundupAmount = calculateRoundup(numericAmount);

  if (roundupAmount <= 0 || roundupAmount >= 1) {
    return {
      eligible: false,
      reason: 'NO_ROUNDUP_REQUIRED',
      roundupAmount: 0,
    };
  }

  return {
    eligible: true,
    reason: 'ELIGIBLE_PURCHASE',
    roundupAmount,
  };
}

/**
 * Reconcile one transaction into the local database.
 */
async function upsertTransaction(client, txn, accountId) {
  const result = await client.query(
    `
      INSERT INTO transactions (
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
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',now()
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
      RETURNING id
    `,
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
      txn.pending_transaction_id || null,
    ]
  );

  return result.rows[0].id;
}

/**
 * Reconcile the Round-Up state associated with a transaction.
 */
async function reconcileRoundup(client, userId, transactionId, amount) {
  const evaluation = evaluateRoundup(amount);

  if (evaluation.eligible) {
    await client.query(
      `
        INSERT INTO roundup_events (
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
          $1,$2,$3,$4,true,$5,'ROUNDUP_STANDARD_V1','active',now()
        )
        ON CONFLICT (transaction_id)
        DO UPDATE SET
          user_id = EXCLUDED.user_id,
          roundup_amount = EXCLUDED.roundup_amount,
          transaction_amount = EXCLUDED.transaction_amount,
          eligible = true,
          eligibility_reason = EXCLUDED.eligibility_reason,
          rule_version = EXCLUDED.rule_version,
          status = 'active',
          updated_at = now()
      `,
      [
        userId,
        transactionId,
        evaluation.roundupAmount,
        Number(amount),
        evaluation.reason,
      ]
    );

    return evaluation;
  }

  await client.query(
    `
      UPDATE roundup_events
      SET
        transaction_amount = $1,
        eligible = false,
        eligibility_reason = $2,
        roundup_amount = 0,
        status = 'voided',
        updated_at = now()
      WHERE transaction_id = $3
    `,
    [
      Number(amount),
      evaluation.reason,
      transactionId,
    ]
  );

  return evaluation;
}

/**
 * Mark a Plaid-removed transaction as removed.
 *
 * Do not physically delete financial intelligence history.
 */
async function markTransactionRemoved(client, removed) {
  const transactionId = removed.transaction_id;

  const transactionResult = await client.query(
    `
      SELECT id
      FROM transactions
      WHERE plaid_transaction_id = $1
      FOR UPDATE
    `,
    [transactionId]
  );

  if (transactionResult.rows.length === 0) {
    return false;
  }

  const localId = transactionResult.rows[0].id;

  await client.query(
    `
      UPDATE transactions
      SET
        status = 'removed',
        updated_at = now()
      WHERE id = $1
    `,
    [localId]
  );

  await client.query(
    `
      UPDATE roundup_events
      SET
        eligible = false,
        eligibility_reason = 'TRANSACTION_REMOVED',
        roundup_amount = 0,
        status = 'voided',
        updated_at = now()
      WHERE transaction_id = $1
    `,
    [localId]
  );

  return true;
}

async function syncOneItem(item) {
  const runInsert = await pool.query(
    `
      INSERT INTO sync_runs (plaid_item_id)
      VALUES ($1)
      RETURNING id
    `,
    [item.id]
  );

  const runId = runInsert.rows[0].id;

  try {
    const accessToken = decrypt(
      item.plaid_access_token_encrypted
    );

    const {
      added,
      modified,
      removed,
      nextCursor,
    } = await fetchTransactionUpdates(
      accessToken,
      item.cursor
    );

    const accountRows = await pool.query(
      `
        SELECT id, plaid_account_id
        FROM accounts
        WHERE plaid_item_id = $1
      `,
      [item.id]
    );

    const accountMap = {};

    for (const account of accountRows.rows) {
      accountMap[account.plaid_account_id] = account.id;
    }

    const userResult = await pool.query(
      `
        SELECT user_id
        FROM plaid_items
        WHERE id = $1
      `,
      [item.id]
    );

    if (userResult.rows.length === 0) {
      throw new Error('Plaid Item owner not found');
    }

    const userId = userResult.rows[0].user_id;

    let syncedAdded = 0;
    let syncedModified = 0;
    let syncedRemoved = 0;

    /*
     * Apply added transactions.
     */
    for (const txn of added) {
      const accountId = accountMap[txn.account_id];

      if (!accountId) {
        console.warn(
          `Skipping transaction ${txn.transaction_id}: ` +
          `account ${txn.account_id} not found`
        );
        continue;
      }

      const transactionId = await upsertTransaction(
        pool,
        txn,
        accountId
      );

      await reconcileRoundup(
        pool,
        userId,
        transactionId,
        txn.amount
      );

      syncedAdded++;
    }

    /*
     * Apply modified transactions.
     */
    for (const txn of modified) {
      const accountId = accountMap[txn.account_id];

      if (!accountId) {
        console.warn(
          `Skipping modified transaction ${txn.transaction_id}: ` +
          `account ${txn.account_id} not found`
        );
        continue;
      }

      const transactionId = await upsertTransaction(
        pool,
        txn,
        accountId
      );

      await reconcileRoundup(
        pool,
        userId,
        transactionId,
        txn.amount
      );

      syncedModified++;
    }

    /*
     * Apply removed transactions.
     *
     * This happens after added/modified processing so a
     * pending -> posted transition can be reconciled correctly.
     */
    for (const removedTxn of removed) {
      const wasKnown = await markTransactionRemoved(
        pool,
        removedTxn
      );

      if (wasKnown) {
        syncedRemoved++;
      }
    }

    /*
     * Persist the cursor only after ALL transaction updates
     * have been successfully applied.
     */
    await pool.query(
      `
        UPDATE plaid_items
        SET cursor = $1
        WHERE id = $2
      `,
      [nextCursor, item.id]
    );

    await pool.query(
      `
        UPDATE sync_runs
        SET
          finished_at = now(),
          added_count = $1,
          modified_count = $2,
          removed_count = $3,
          status = 'success'
        WHERE id = $4
      `,
      [
        syncedAdded,
        syncedModified,
        syncedRemoved,
        runId,
      ]
    );

    return {
      plaid_item_id: item.plaid_item_id,
      transactions_added: syncedAdded,
      transactions_modified: syncedModified,
      transactions_removed: syncedRemoved,
    };
  } catch (err) {
    const detail =
      err.response?.data?.error_message ||
      err.response?.data?.display_message ||
      err.message;

    await pool.query(
      `
        UPDATE sync_runs
        SET
          finished_at = now(),
          status = 'error',
          error_message = $1
        WHERE id = $2
      `,
      [detail, runId]
    );

    return {
      plaid_item_id: item.plaid_item_id,
      error: detail,
    };
  }
}

async function runSync(req, res) {
  const itemsResult = await pool.query(
    `
      SELECT
        id,
        plaid_item_id,
        plaid_access_token_encrypted,
        cursor
      FROM plaid_items
      WHERE status = 'active'
    `
  );

  const results = [];

  for (const item of itemsResult.rows) {
    results.push(
      await syncOneItem(item)
    );
  }

  res.json({
    status: 'ok',
    items_processed: results.length,
    results,
  });
}

module.exports = {
  runSync,
  syncOneItem,
};
