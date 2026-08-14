const pool = require('./db');
const plaidClient =
  require('./plaidClient').plaidClient;

const { decrypt } =
  require('./crypto');

const {
  calculateRoundup,
  getRoundupEligibility,
  RULE_VERSION,
} = require('./roundup');

const MUTATION_DURING_PAGINATION =
  'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';

const MAX_PAGINATION_RESTARTS = 3;

async function fetchTransactionUpdates(
  accessToken,
  startingCursor
) {
  let restartCount = 0;

  while (true) {
    const originalCursor =
      startingCursor || undefined;

    let cursor = originalCursor;

    const added = [];
    const modified = [];
    const removed = [];

    try {
      let hasMore = true;

      while (hasMore) {
        const response =
          await plaidClient.transactionsSync({
            access_token:
              accessToken,
            cursor,
            count: 500,
          });

        const data =
          response.data;

        added.push(
          ...(data.added || [])
        );

        modified.push(
          ...(data.modified || [])
        );

        removed.push(
          ...(data.removed || [])
        );

        hasMore =
          Boolean(data.has_more);

        cursor =
          data.next_cursor;
      }

      return {
        added,
        modified,
        removed,
        nextCursor: cursor,
      };
    } catch (err) {
      const code =
        err.response?.data?.error_code;

      if (
        code !==
          MUTATION_DURING_PAGINATION ||
        restartCount >=
          MAX_PAGINATION_RESTARTS
      ) {
        throw err;
      }

      restartCount += 1;

      console.warn(
        `Transactions pagination changed during sync. ` +
          `Restarting from original cursor. ` +
          `Attempt ${restartCount}/${MAX_PAGINATION_RESTARTS}.`
      );
    }
  }
}

async function reconcileRoundup(
  client,
  userId,
  transactionId
) {
  const transactionResult =
    await client.query(
      `
        SELECT
          id,
          amount,
          merchant_name,
          category,
          pending,
          authorized_date,
          posted_date,
          raw,
          pending_transaction_id,
          status
        FROM transactions
        WHERE id = $1
        FOR UPDATE
      `,
      [transactionId]
    );

  if (!transactionResult.rows.length) {
    throw new Error(
      `Transaction ${transactionId} not found during Round-Up reconciliation`
    );
  }

  const transaction =
    transactionResult.rows[0];

  /*
   * Pending transactions do not become authoritative
   * Round-Up events.
   */
  if (transaction.pending === true) {
    await client.query(
      `
        UPDATE roundup_events
        SET
          eligible = false,
          eligibility_reason = 'PENDING_TRANSACTION',
          roundup_amount = 0,
          rule_version = $1,
          status = 'voided',
          updated_at = now()
        WHERE transaction_id = $2
      `,
      [
        RULE_VERSION,
        transactionId,
      ]
    );

    return {
      eligible: false,
      reason:
        'PENDING_TRANSACTION',
      roundupAmount: 0,
    };
  }

  const evaluation =
    getRoundupEligibility(
      transaction
    );

  if (evaluation.eligible) {
    const roundupAmount =
      calculateRoundup(
        transaction
      );

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
          $1,$2,$3,$4,true,$5,$6,'active',now()
        )
        ON CONFLICT (transaction_id)
        DO UPDATE SET
          user_id =
            EXCLUDED.user_id,

          roundup_amount =
            EXCLUDED.roundup_amount,

          transaction_amount =
            EXCLUDED.transaction_amount,

          eligible =
            true,

          eligibility_reason =
            EXCLUDED.eligibility_reason,

          rule_version =
            EXCLUDED.rule_version,

          status =
            'active',

          updated_at =
            now()
      `,
      [
        userId,
        transactionId,
        roundupAmount,
        Number(transaction.amount),
        evaluation.reason,
        RULE_VERSION,
      ]
    );

    return {
      eligible: true,
      reason:
        evaluation.reason,
      roundupAmount,
    };
  }

  await client.query(
    `
      UPDATE roundup_events
      SET
        transaction_amount = $1,
        eligible = false,
        eligibility_reason = $2,
        roundup_amount = 0,
        rule_version = $3,
        status = 'voided',
        updated_at = now()
      WHERE transaction_id = $4
    `,
    [
      Number(transaction.amount),
      evaluation.reason,
      RULE_VERSION,
      transactionId,
    ]
  );

  return {
    eligible: false,
    reason:
      evaluation.reason,
    roundupAmount: 0,
  };
}

/*
 * Resolve a posted transaction that Plaid identifies
 * as replacing a pending transaction.
 */
async function findPendingReplacement(
  client,
  txn
) {
  if (!txn.pending_transaction_id) {
    return null;
  }

  const result =
    await client.query(
      `
        SELECT id
        FROM transactions
        WHERE plaid_transaction_id = $1
          AND status = 'active'
        LIMIT 1
        FOR UPDATE
      `,
      [txn.pending_transaction_id]
    );

  if (!result.rows.length) {
    return null;
  }

  return result.rows[0].id;
}

async function upsertTransaction(
  client,
  txn,
  accountId
) {
  /*
   * First attempt pending → posted reconciliation.
   */
  if (!txn.pending) {
    const pendingLocalId =
      await findPendingReplacement(
        client,
        txn
      );

    if (pendingLocalId) {
      const result =
        await client.query(
          `
            UPDATE transactions
            SET
              plaid_transaction_id =
                $1,

              account_id =
                $2,

              amount =
                $3,

              iso_currency_code =
                $4,

              merchant_name =
                $5,

              category =
                $6,

              pending =
                false,

              authorized_date =
                $7,

              posted_date =
                $8,

              raw =
                $9,

              pending_transaction_id =
                $10,

              status =
                'active',

              updated_at =
                now()

            WHERE id = $11

            RETURNING id
          `,
          [
            txn.transaction_id,
            accountId,
            txn.amount,
            txn.iso_currency_code ||
              'USD',
            txn.merchant_name ||
              null,
            txn.personal_finance_category
              ?.primary ||
              null,
            txn.authorized_date ||
              null,
            txn.date ||
              null,
            JSON.stringify(txn),
            txn.pending_transaction_id ||
              null,
            pendingLocalId,
          ]
        );

      return result.rows[0].id;
    }
  }

  const result =
    await client.query(
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

        ON CONFLICT (
          plaid_transaction_id
        )

        DO UPDATE SET
          account_id =
            EXCLUDED.account_id,

          amount =
            EXCLUDED.amount,

          iso_currency_code =
            EXCLUDED.iso_currency_code,

          merchant_name =
            EXCLUDED.merchant_name,

          category =
            EXCLUDED.category,

          pending =
            EXCLUDED.pending,

          authorized_date =
            EXCLUDED.authorized_date,

          posted_date =
            EXCLUDED.posted_date,

          raw =
            EXCLUDED.raw,

          pending_transaction_id =
            EXCLUDED.pending_transaction_id,

          status =
            'active',

          updated_at =
            now()

        RETURNING id
      `,
      [
        accountId,
        txn.transaction_id,
        txn.amount,
        txn.iso_currency_code ||
          'USD',
        txn.merchant_name ||
          null,
        txn.personal_finance_category
          ?.primary ||
          null,
        Boolean(txn.pending),
        txn.authorized_date ||
          null,
        txn.date ||
          null,
        JSON.stringify(txn),
        txn.pending_transaction_id ||
          null,
      ]
    );

  return result.rows[0].id;
}

async function markTransactionRemoved(
  client,
  removed
) {
  const result =
    await client.query(
      `
        SELECT id
        FROM transactions
        WHERE plaid_transaction_id = $1
        FOR UPDATE
      `,
      [removed.transaction_id]
    );

  if (!result.rows.length) {
    return false;
  }

  const localId =
    result.rows[0].id;

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
        eligibility_reason =
          'TRANSACTION_REMOVED',
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
  const runInsert =
    await pool.query(
      `
        INSERT INTO sync_runs (
          plaid_item_id
        )
        VALUES ($1)
        RETURNING id
      `,
      [item.id]
    );

  const runId =
    runInsert.rows[0].id;

  const client =
    await pool.connect();

  try {
    await client.query(
      'BEGIN'
    );

    const accessToken =
      decrypt(
        item.plaid_access_token_encrypted
      );

    const {
      added,
      modified,
      removed,
      nextCursor,
    } =
      await fetchTransactionUpdates(
        accessToken,
        item.cursor
      );

    const accountRows =
      await client.query(
        `
          SELECT
            id,
            plaid_account_id
          FROM accounts
          WHERE plaid_item_id = $1
        `,
        [item.id]
      );

    const accountMap = {};

    for (
      const account
      of accountRows.rows
    ) {
      accountMap[
        account.plaid_account_id
      ] = account.id;
    }

    const userResult =
      await client.query(
        `
          SELECT user_id
          FROM plaid_items
          WHERE id = $1
        `,
        [item.id]
      );

    if (!userResult.rows.length) {
      throw new Error(
        'Plaid Item owner not found'
      );
    }

    const userId =
      userResult.rows[0].user_id;

    let syncedAdded = 0;
    let syncedModified = 0;
    let syncedRemoved = 0;

    for (const txn of added) {
      const accountId =
        accountMap[
          txn.account_id
        ];

      if (!accountId) {
        console.warn(
          `Skipping transaction ${txn.transaction_id}: account not found`
        );
        continue;
      }

      const transactionId =
        await upsertTransaction(
          client,
          txn,
          accountId
        );

      await reconcileRoundup(
        client,
        userId,
        transactionId
      );

      syncedAdded += 1;
    }

    for (const txn of modified) {
      const accountId =
        accountMap[
          txn.account_id
        ];

      if (!accountId) {
        console.warn(
          `Skipping modified transaction ${txn.transaction_id}: account not found`
        );
        continue;
      }

      const transactionId =
        await upsertTransaction(
          client,
          txn,
          accountId
        );

      await reconcileRoundup(
        client,
        userId,
        transactionId
      );

      syncedModified += 1;
    }

    for (
      const removedTxn
      of removed
    ) {
      const wasKnown =
        await markTransactionRemoved(
          client,
          removedTxn
        );

      if (wasKnown) {
        syncedRemoved += 1;
      }
    }

    /*
     * Cursor is committed only after the complete
     * financial state transition succeeds.
     */
    await client.query(
      `
        UPDATE plaid_items
        SET cursor = $1
        WHERE id = $2
      `,
      [
        nextCursor,
        item.id,
      ]
    );

    await client.query(
      'COMMIT'
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
      plaid_item_id:
        item.plaid_item_id,

      transactions_added:
        syncedAdded,

      transactions_modified:
        syncedModified,

      transactions_removed:
        syncedRemoved,
    };
  } catch (err) {
    await client.query(
      'ROLLBACK'
    );

    const detail =
      err.response?.data
        ?.error_message ||
      err.response?.data
        ?.display_message ||
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
      [
        detail,
        runId,
      ]
    );

    return {
      plaid_item_id:
        item.plaid_item_id,

      error:
        detail,
    };
  } finally {
    client.release();
  }
}

async function runSync(req, res) {
  try {
    const result =
      await pool.query(
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

    for (
      const item
      of result.rows
    ) {
      results.push(
        await syncOneItem(item)
      );
    }

    const failures =
      results.filter(
        result => result.error
      );

    res.json({
      status:
        failures.length === 0
          ? 'ok'
          : 'partial',

      items_processed:
        results.length,

      items_failed:
        failures.length,

      results,
    });
  } catch (err) {
    console.error(
      'Scheduled sync failed:',
      err
    );

    res.status(500).json({
      status: 'error',
      message: err.message,
    });
  }
}

module.exports = {
  runSync,
  syncOneItem,
  fetchTransactionUpdates,
};
