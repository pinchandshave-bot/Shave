const pool = require('./db');
const plaidClient = require('./plaidClient').plaidClient;
const { decrypt } = require('./crypto');
const { calculateRoundup, getRoundupEligibility } = require('./roundup');
const {
  syncBalance,
  syncLiabilities,
  syncInvestments,
  syncIdentity,
} = require('./products');
const { computeIncomeSignals } = require('./intelligence');

/**
 * Production transaction synchronization.
 *
 * Responsibilities:
 * - Incrementally synchronize Plaid transactions.
 * - Preserve transaction lifecycle.
 * - Preserve pending -> posted lineage.
 * - Maintain deterministic Round-Up calculations.
 * - Void Round-Ups when their source transaction is removed/ineligible.
 * - Keep provenance for every Round-Up.
 * - Maintain sync-run audit information.
 * - Remain idempotent when the same Plaid data is received more than once.
 *
 * Phase 1 scope:
 * Round-Up intelligence only.
 *
 * This service NEVER moves money.
 */

async function syncOneItem(item) {
  const client = await pool.connect();

  let runId = null;

  try {
    const runInsert = await client.query(
      `
        INSERT INTO sync_runs (plaid_item_id)
        VALUES ($1)
        RETURNING id
      `,
      [item.id]
    );

    runId = runInsert.rows[0].id;

    const accessToken = decrypt(item.plaid_access_token_encrypted);

    let cursor = item.cursor || undefined;

    const added = [];
    const modified = [];
    const removed = [];

    let hasMore = true;

    /*
     * Plaid transactions/sync is cursor based.
     *
     * Continue until Plaid confirms the complete change set has
     * been consumed.
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
     * Resolve all accounts belonging to this Item.
     */
    const acctRows = await client.query(
      `
        SELECT id, plaid_account_id
        FROM accounts
        WHERE plaid_item_id = $1
      `,
      [item.id]
    );

    const acctMap = {};

    for (const account of acctRows.rows) {
      acctMap[account.plaid_account_id] = account.id;
    }

    const userResult = await client.query(
      `
        SELECT user_id
        FROM plaid_items
        WHERE id = $1
      `,
      [item.id]
    );

    if (userResult.rows.length === 0) {
      throw new Error('Plaid Item owner could not be resolved');
    }

    const userId = userResult.rows[0].user_id;

    let addedCount = 0;
    let modifiedCount = 0;
    let removedCount = 0;

    /*
     * Process added and modified transactions together.
     *
     * We intentionally process each transaction inside the same
     * database transaction as the synchronization run so that
     * transaction state and Round-Up state cannot partially diverge.
     */
    await client.query('BEGIN');

    for (const transaction of [...added, ...modified]) {
      const accountId = acctMap[transaction.account_id];

      /*
       * A Plaid transaction that references an account we do not
       * recognize must never be inserted into the user's data.
       */
      if (!accountId) {
        continue;
      }

      const isModified = modified.some(
        (txn) => txn.transaction_id === transaction.transaction_id
      );

      /*
       * Plaid's pending_transaction_id is the critical linkage
       * between a posted transaction and its previous pending form.
       */
      const pendingTransactionId =
        transaction.pending_transaction_id || null;

      /*
       * First determine whether the transaction itself already exists.
       */
      const directExisting = await client.query(
        `
          SELECT
            id,
            plaid_transaction_id,
            pending_transaction_id,
            status
          FROM transactions
          WHERE plaid_transaction_id = $1
          LIMIT 1
        `,
        [transaction.transaction_id]
      );

      let transactionDbId = null;

      /*
       * If Plaid has converted a pending transaction into a posted
       * transaction, locate the pending record through its Plaid ID.
       *
       * We update the existing record's Plaid transaction ID instead
       * of creating a second financial transaction.
       */
      if (
        pendingTransactionId &&
        transaction.pending === false
      ) {
        const pendingExisting = await client.query(
          `
            SELECT
              id,
              plaid_transaction_id
            FROM transactions
            WHERE plaid_transaction_id = $1
            LIMIT 1
          `,
          [pendingTransactionId]
        );

        if (pendingExisting.rows.length > 0) {
          const existing = pendingExisting.rows[0];

          /*
           * If the posted transaction ID is different from the pending
           * transaction ID, migrate the same database transaction
           * record to the posted Plaid transaction ID.
           *
           * The Round-Up foreign key therefore remains attached to
           * the same logical financial transaction.
           */
          if (
            existing.plaid_transaction_id !==
            transaction.transaction_id
          ) {
            const updated = await client.query(
              `
                UPDATE transactions
                SET
                  plaid_transaction_id = $1,
                  pending_transaction_id = $2,
                  account_id = $3,
                  amount = $4,
                  iso_currency_code = $5,
                  merchant_name = $6,
                  category = $7,
                  pending = $8,
                  authorized_date = $9,
                  posted_date = $10,
                  raw = $11,
                  status = 'active',
                  updated_at = now()
                WHERE id = $12
                RETURNING id
              `,
              [
                transaction.transaction_id,
                pendingTransactionId,
                accountId,
                transaction.amount,
                transaction.iso_currency_code || 'USD',
                transaction.merchant_name || null,
                transaction.personal_finance_category?.primary || null,
                Boolean(transaction.pending),
                transaction.authorized_date || null,
                transaction.date || null,
                JSON.stringify(transaction),
                existing.id,
              ]
            );

            transactionDbId = updated.rows[0].id;
          }
        }
      }

      /*
       * If there was no pending -> posted migration, perform a normal
       * upsert by Plaid transaction ID.
       */
      if (!transactionDbId) {
        const result = await client.query(
          `
            INSERT INTO transactions (
              account_id,
              plaid_transaction_id,
              pending_transaction_id,
              amount,
              iso_currency_code,
              merchant_name,
              category,
              pending,
              authorized_date,
              posted_date,
              raw,
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
              'active',
              now()
            )
            ON CONFLICT (plaid_transaction_id)
            DO UPDATE SET
              account_id = EXCLUDED.account_id,
              pending_transaction_id = EXCLUDED.pending_transaction_id,
              amount = EXCLUDED.amount,
              iso_currency_code = EXCLUDED.iso_currency_code,
              merchant_name = EXCLUDED.merchant_name,
              category = EXCLUDED.category,
              pending = EXCLUDED.pending,
              authorized_date = EXCLUDED.authorized_date,
              posted_date = EXCLUDED.posted_date,
              raw = EXCLUDED.raw,
              status = 'active',
              updated_at = now()
            RETURNING id
          `,
          [
            accountId,
            transaction.transaction_id,
            pendingTransactionId,
            transaction.amount,
            transaction.iso_currency_code || 'USD',
            transaction.merchant_name || null,
            transaction.personal_finance_category?.primary || null,
            Boolean(transaction.pending),
            transaction.authorized_date || null,
            transaction.date || null,
            JSON.stringify(transaction),
          ]
        );

        transactionDbId = result.rows[0].id;
      }

      /*
       * Round-Up eligibility is evaluated from the current transaction
       * state every time the transaction changes.
       */
      const eligibility = getRoundupEligibility(
        Number(transaction.amount)
      );

      const roundupAmount = calculateRoundup(
        Number(transaction.amount)
      );

      /*
       * Pending transactions are intentionally not treated as final
       * Round-Up events.
       *
       * The transaction itself is retained because it is real bank
       * activity, but Round-Up intelligence becomes active only when
       * the transaction is posted and eligible.
       */
      const eligible =
        !transaction.pending &&
        eligibility.eligible &&
        roundupAmount > 0 &&
        roundupAmount < 1;

      if (eligible) {
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
              $1,
              $2,
              $3,
              $4,
              true,
              $5,
              $6,
              'active',
              now()
            )
            ON CONFLICT (transaction_id)
            DO UPDATE SET
              user_id = EXCLUDED.user_id,
              roundup_amount = EXCLUDED.roundup_amount,
              transaction_amount = EXCLUDED.transaction_amount,
              eligible = EXCLUDED.eligible,
              eligibility_reason = EXCLUDED.eligibility_reason,
              rule_version = EXCLUDED.rule_version,
              status = 'active',
              updated_at = now()
          `,
          [
            userId,
            transactionDbId,
            roundupAmount,
            transaction.amount,
            eligibility.reason,
            eligibility.ruleVersion,
          ]
        );
      } else {
        /*
         * Never silently delete an existing Round-Up.
         *
         * A previously eligible transaction can become:
         * - pending,
         * - refunded,
         * - corrected,
         * - too large,
         * - otherwise ineligible.
         *
         * In those cases the historical Round-Up is retained but
         * explicitly voided.
         */
        await client.query(
          `
            UPDATE roundup_events
            SET
              eligible = false,
              eligibility_reason = $1,
              status = 'voided',
              roundup_amount = CASE
                WHEN roundup_amount < 0 THEN 0
                ELSE roundup_amount
              END,
              transaction_amount = $2,
              updated_at = now()
            WHERE transaction_id = $3
              AND status = 'active'
          `,
          [
            transaction.pending
              ? 'PENDING_TRANSACTION'
              : eligibility.reason,
            transaction.amount,
            transactionDbId,
          ]
        );
      }

      if (isModified) {
        modifiedCount++;
      } else {
        addedCount++;
      }
    }

    /*
     * Plaid explicitly reports transactions that no longer exist.
     *
     * We do not physically delete them because financial intelligence
     * requires an auditable lifecycle.
     */
    for (const removedTransaction of removed) {
      const existing = await client.query(
        `
          SELECT id
          FROM transactions
          WHERE plaid_transaction_id = $1
          LIMIT 1
        `,
        [removedTransaction.transaction_id]
      );

      if (existing.rows.length === 0) {
        continue;
      }

      const transactionId = existing.rows[0].id;

      /*
       * Preserve the Round-Up record but void it.
       */
      await client.query(
        `
          UPDATE roundup_events
          SET
            eligible = false,
            eligibility_reason = 'PLAID_TRANSACTION_REMOVED',
            status = 'voided',
            updated_at = now()
          WHERE transaction_id = $1
            AND status = 'active'
        `,
        [transactionId]
      );

      /*
       * Preserve the transaction itself for auditability.
       */
      await client.query(
        `
          UPDATE transactions
          SET
            status = 'removed',
            updated_at = now()
          WHERE id = $1
        `,
        [transactionId]
      );

      removedCount++;
    }

    /*
     * Cursor is advanced only after the entire change set has been
     * successfully persisted.
     *
     * This is important: a failed database transaction must not
     * advance the cursor and permanently skip Plaid changes.
     */
    await client.query(
      `
        UPDATE plaid_items
        SET cursor = $1
        WHERE id = $2
      `,
      [cursor || null, item.id]
    );

    await client.query(
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
        addedCount,
        modifiedCount,
        removedCount,
        runId,
      ]
    );

    await client.query('COMMIT');

    /*
     * These are separate product synchronizations. They operate on
     * the same real Plaid Item but are not part of the transaction
     * lifecycle above.
     */
    try {
      await syncBalance(accessToken, acctMap);
    } catch (err) {
      console.error(
        'Balance synchronization failed:',
        err.message
      );
    }

    try {
      await syncLiabilities(accessToken, acctMap);
    } catch (err) {
      console.error(
        'Liability synchronization failed:',
        err.message
      );
    }

    try {
      await syncInvestments(accessToken, acctMap);
    } catch (err) {
      console.error(
        'Investment synchronization failed:',
        err.message
      );
    }

    try {
      await syncIdentity(accessToken, item.id, acctMap);
    } catch (err) {
      console.error(
        'Identity synchronization failed:',
        err.message
      );
    }

    /*
     * Intelligence is derived from synchronized real financial data.
     */
    try {
      await computeIncomeSignals(userId);
    } catch (err) {
      console.error(
        'Income signal computation failed:',
        err.message
      );
    }

    return {
      plaid_item_id: item.plaid_item_id,
      transactions_added: addedCount,
      transactions_modified: modifiedCount,
      transactions_removed: removedCount,
      cursor_advanced: true,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error(
        'Rollback failed:',
        rollbackError.message
      );
    }

    const message =
      err.response?.data?.error_message ||
      err.response?.data?.error_code ||
      err.message ||
      'Unknown synchronization error';

    if (runId) {
      try {
        await pool.query(
          `
            UPDATE sync_runs
            SET
              finished_at = now(),
              status = 'error',
              error_message = $1
            WHERE id = $2
          `,
          [message, runId]
        );
      } catch (auditError) {
        console.error(
          'Unable to record sync failure:',
          auditError.message
        );
      }
    }

    console.error(
      `Plaid synchronization failed for Item ${item.plaid_item_id}:`,
      message
    );

    return {
      plaid_item_id: item.plaid_item_id,
      error: message,
    };
  } finally {
    client.release();
  }
}


/**
 * Process every active Plaid Item.
 *
 * No fabricated/demo Items are created.
 * Only real active Items already belonging to users are processed.
 */
async function runSync(req, res) {
  try {
    const itemsResult = await pool.query(
      `
        SELECT
          id,
          plaid_item_id,
          plaid_access_token_encrypted,
          cursor
        FROM plaid_items
        WHERE status = 'active'
        ORDER BY created_at ASC
      `
    );

    const results = [];

    for (const item of itemsResult.rows) {
      results.push(await syncOneItem(item));
    }

    const failed = results.filter(
      (result) => result.error
    ).length;

    return res.json({
      status: failed > 0 ? 'partial' : 'ok',
      items_processed: results.length,
      items_failed: failed,
      results,
    });
  } catch (err) {
    console.error(
      'Sync runner failed:',
      err.message
    );

    return res.status(500).json({
      status: 'error',
      message: 'Unable to run financial synchronization',
    });
  }
}

module.exports = {
  runSync,
  syncOneItem,
};
