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

const ROUNDUP_RULE_VERSION = 'ROUNDUP_STANDARD_V1';
const RENT_SIZED_THRESHOLD = 800;

function getEligibility(amount) {
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount)) {
    return {
      eligible: false,
      reason: 'INVALID_AMOUNT',
      roundup: 0,
    };
  }

  if (numericAmount <= 0) {
    return {
      eligible: false,
      reason: 'NON_POSITIVE_AMOUNT',
      roundup: 0,
    };
  }

  if (numericAmount >= RENT_SIZED_THRESHOLD) {
    return {
      eligible: false,
      reason: 'THRESHOLD_EXCEEDED',
      roundup: 0,
    };
  }

  const roundup = calculateRoundup(numericAmount);

  if (roundup <= 0) {
    return {
      eligible: false,
      reason: 'WHOLE_DOLLAR_TRANSACTION',
      roundup: 0,
    };
  }

  return {
    eligible: true,
    reason: 'PURCHASE_UNDER_THRESHOLD',
    roundup,
  };
}

async function upsertTransaction(client, {
  accountId,
  txn,
  status = 'active',
}) {
  const existingResult = await client.query(
    `
      SELECT
        id,
        plaid_transaction_id,
        pending_transaction_id,
        amount,
        pending,
        status
      FROM transactions
      WHERE plaid_transaction_id = $1
      FOR UPDATE
    `,
    [txn.transaction_id]
  );

  let existing = existingResult.rows[0] || null;

  /*
   * Plaid can replace a pending transaction with a posted transaction.
   *
   * The posted transaction may contain pending_transaction_id pointing
   * back to the original pending transaction.
   *
   * We first attempt to locate that pending transaction so that the
   * financial event can be reconciled rather than represented as two
   * independent purchases.
   */
  if (!existing && txn.pending_transaction_id) {
    const pendingResult = await client.query(
      `
        SELECT
          id,
          plaid_transaction_id,
          pending_transaction_id,
          amount,
          pending,
          status
        FROM transactions
        WHERE plaid_transaction_id = $1
        FOR UPDATE
      `,
      [txn.pending_transaction_id]
    );

    if (pendingResult.rows.length > 0) {
      existing = pendingResult.rows[0];
    }
  }

  /*
   * If this is a posted replacement for a pending transaction,
   * retain the posted Plaid transaction as the canonical transaction
   * while retiring the pending record.
   */
  if (
    existing &&
    existing.plaid_transaction_id !== txn.transaction_id &&
    existing.pending === true &&
    txn.pending === false
  ) {
    const pendingId = existing.id;

    const roundupResult = await client.query(
      `
        SELECT id
        FROM roundup_events
        WHERE transaction_id = $1
        FOR UPDATE
      `,
      [pendingId]
    );

    /*
     * Remove the pending transaction's Round-Up before retiring
     * the pending transaction. The posted transaction will receive
     * a newly calculated Round-Up below.
     */
    if (roundupResult.rows.length > 0) {
      await client.query(
        `
          UPDATE roundup_events
          SET
            status = 'voided',
            eligible = false,
            eligibility_reason = 'PENDING_TRANSACTION_POSTED',
            updated_at = now()
          WHERE transaction_id = $1
        `,
        [pendingId]
      );
    }

    await client.query(
      `
        UPDATE transactions
        SET
          status = 'removed',
          updated_at = now()
        WHERE id = $1
      `,
      [pendingId]
    );

    existing = null;
  }

  let transactionId;

  if (existing) {
    const result = await client.query(
      `
        UPDATE transactions
        SET
          account_id = $1,
          amount = $2,
          iso_currency_code = $3,
          merchant_name = $4,
          category = $5,
          pending = $6,
          authorized_date = $7,
          posted_date = $8,
          raw = $9,
          pending_transaction_id = $10,
          status = $11,
          updated_at = now()
        WHERE id = $12
        RETURNING id
      `,
      [
        accountId,
        txn.amount,
        txn.iso_currency_code || 'USD',
        txn.merchant_name || null,
        txn.personal_finance_category?.primary || null,
        Boolean(txn.pending),
        txn.authorized_date || null,
        txn.date || null,
        JSON.stringify(txn),
        txn.pending_transaction_id || null,
        status,
        existing.id,
      ]
    );

    transactionId = result.rows[0].id;
  } else {
    const result = await client.query(
      `
        INSERT INTO transactions
        (
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
        VALUES
        (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()
        )
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
        status,
      ]
    );

    transactionId = result.rows[0].id;
  }

  return transactionId;
}

async function reconcileRoundup(client, {
  userId,
  transactionId,
  amount,
}) {
  const eligibility = getEligibility(amount);

  const existingResult = await client.query(
    `
      SELECT
        id,
        roundup_amount,
        status,
        eligible,
        transaction_amount,
        eligibility_reason
      FROM roundup_events
      WHERE transaction_id = $1
      FOR UPDATE
    `,
    [transactionId]
  );

  const existing = existingResult.rows[0] || null;

  if (!eligibility.eligible) {
    if (existing && existing.status !== 'voided') {
      await client.query(
        `
          UPDATE roundup_events
          SET
            transaction_amount = $1,
            eligible = false,
            eligibility_reason = $2,
            rule_version = $3,
            status = 'voided',
            updated_at = now()
          WHERE id = $4
        `,
        [
          Number(amount),
          eligibility.reason,
          ROUNDUP_RULE_VERSION,
          existing.id,
        ]
      );

      return {
        action: 'voided',
        amount: 0,
      };
    }

    return {
      action: 'none',
      amount: 0,
    };
  }

  if (existing) {
    await client.query(
      `
        UPDATE roundup_events
        SET
          user_id = $1,
          transaction_amount = $2,
          roundup_amount = $3,
          eligible = true,
          eligibility_reason = $4,
          rule_version = $5,
          status = 'active',
          updated_at = now()
        WHERE id = $6
      `,
      [
        userId,
        Number(amount),
        eligibility.roundup,
        eligibility.reason,
        ROUNDUP_RULE_VERSION,
        existing.id,
      ]
    );

    return {
      action:
        Number(existing.roundup_amount) === eligibility.roundup &&
        existing.status === 'active'
          ? 'unchanged'
          : 'updated',
      amount: eligibility.roundup,
    };
  }

  await client.query(
    `
      INSERT INTO roundup_events
      (
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
      VALUES
      ($1,$2,$3,$4,true,$5,$6,'active',now())
    `,
    [
      userId,
      transactionId,
      eligibility.roundup,
      Number(amount),
      eligibility.reason,
      ROUNDUP_RULE_VERSION,
    ]
  );

  return {
    action: 'created',
    amount: eligibility.roundup,
  };
}

async function markRemovedTransaction(client, transactionId) {
  const result = await client.query(
    `
      SELECT id
      FROM transactions
      WHERE plaid_transaction_id = $1
      FOR UPDATE
    `,
    [transactionId]
  );

  if (result.rows.length === 0) {
    return false;
  }

  const dbTransactionId = result.rows[0].id;

  await client.query(
    `
      UPDATE roundup_events
      SET
        status = 'voided',
        eligible = false,
        eligibility_reason = 'TRANSACTION_REMOVED_BY_PLAID',
        updated_at = now()
      WHERE transaction_id = $1
        AND status <> 'voided'
    `,
    [dbTransactionId]
  );

  await client.query(
    `
      UPDATE transactions
      SET
        status = 'removed',
        updated_at = now()
      WHERE id = $1
    `,
    [dbTransactionId]
  );

  return true;
}

async function syncOneItem(item) {
  const runInsert = await pool.query(
    `
      INSERT INTO sync_runs
      (plaid_item_id)
      VALUES ($1)
      RETURNING id
    `,
    [item.id]
  );

  const runId = runInsert.rows[0].id;

  let added = [];
  let modified = [];
  let removed = [];
  let cursor = item.cursor || null;

  let roundupCreated = 0;
  let roundupUpdated = 0;
  let roundupVoided = 0;
  let roundupUnchanged = 0;
  let removedTransactions = 0;

  try {
    const accessToken = decrypt(
      item.plaid_access_token_encrypted
    );

    let hasMore = true;

    while (hasMore) {
      const response = await plaidClient.transactionsSync({
        access_token: accessToken,
        cursor: cursor || undefined,
      });

      added = added.concat(response.data.added || []);
      modified = modified.concat(response.data.modified || []);
      removed = removed.concat(response.data.removed || []);

      hasMore = Boolean(response.data.has_more);
      cursor = response.data.next_cursor;
    }

    const acctRows = await pool.query(
      `
        SELECT
          id,
          plaid_account_id
        FROM accounts
        WHERE plaid_item_id = $1
      `,
      [item.id]
    );

    const acctMap = {};

    for (const account of acctRows.rows) {
      acctMap[account.plaid_account_id] = account.id;
    }

    const userRow = await pool.query(
      `
        SELECT user_id
        FROM plaid_items
        WHERE id = $1
      `,
      [item.id]
    );

    if (userRow.rows.length === 0) {
      throw new Error('Plaid Item owner not found');
    }

    const userId = userRow.rows[0].user_id;

    /*
     * Process additions and modifications inside one database
     * transaction so that the transaction state and its Round-Up
     * state remain synchronized.
     */
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (const txn of [...added, ...modified]) {
        const accountId = acctMap[txn.account_id];

        if (!accountId) {
          /*
           * Do not manufacture an account relationship.
           * The transaction cannot safely enter the financial
           * intelligence pipeline without a known account.
           */
          console.warn(
            `Skipping Plaid transaction ${txn.transaction_id}: account not found`
          );
          continue;
        }

        const transactionId = await upsertTransaction(client, {
          accountId,
          txn,
          status: 'active',
        });

        const roundupResult = await reconcileRoundup(client, {
          userId,
          transactionId,
          amount: txn.amount,
        });

        if (roundupResult.action === 'created') {
          roundupCreated++;
        } else if (roundupResult.action === 'updated') {
          roundupUpdated++;
        } else if (roundupResult.action === 'voided') {
          roundupVoided++;
        } else if (roundupResult.action === 'unchanged') {
          roundupUnchanged++;
        }
      }

      for (const rem of removed) {
        const wasRemoved = await markRemovedTransaction(
          client,
          rem.transaction_id
        );

        if (wasRemoved) {
          removedTransactions++;
          roundupVoided++;
        }
      }

      await client.query(
        `
          UPDATE plaid_items
          SET cursor = $1
          WHERE id = $2
        `,
        [cursor, item.id]
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
          added.length,
          modified.length,
          removed.length,
          runId,
        ]
      );

      await client.query('COMMIT');
    } catch (transactionError) {
      await client.query('ROLLBACK');
      throw transactionError;
    } finally {
      client.release();
    }

    /*
     * These are supplemental account-level intelligence operations.
     * They occur after the transaction/Round-Up state has committed.
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
      const freshAccounts = await pool.query(
        `
          SELECT id, plaid_account_id
          FROM accounts
          WHERE plaid_item_id = $1
        `,
        [item.id]
      );

      const freshAcctMap = {};

      for (const account of freshAccounts.rows) {
        freshAcctMap[account.plaid_account_id] =
          account.id;
      }

      await syncIdentity(
        accessToken,
        item.id,
        freshAcctMap
      );
    } catch (err) {
      console.error(
        'Identity synchronization failed:',
        err.message
      );
    }

    try {
      await computeIncomeSignals(userId);
    } catch (intelErr) {
      console.error(
        'Income signal computation failed:',
        intelErr.message
      );
    }

    return {
      plaid_item_id: item.plaid_item_id,
      transactions_added: added.length,
      transactions_modified: modified.length,
      transactions_removed: removedTransactions,
      roundup_created: roundupCreated,
      roundup_updated: roundupUpdated,
      roundup_voided: roundupVoided,
      roundup_unchanged: roundupUnchanged,
      cursor_updated: true,
    };
  } catch (err) {
    const message =
      err.response?.data?.error_message ||
      err.message;

    await pool.query(
      `
        UPDATE sync_runs
        SET
          finished_at = now(),
          added_count = $1,
          modified_count = $2,
          removed_count = $3,
          status = 'error',
          error_message = $4
        WHERE id = $5
      `,
      [
        added.length,
        modified.length,
        removed.length,
        message,
        runId,
      ]
    );

    console.error(
      `Plaid sync failed for item ${item.plaid_item_id}:`,
      message
    );

    return {
      plaid_item_id: item.plaid_item_id,
      transactions_added: added.length,
      transactions_modified: modified.length,
      transactions_removed: removed.length,
      error: message,
    };
  }
}

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
      `
    );

    const results = [];

    for (const item of itemsResult.rows) {
      results.push(await syncOneItem(item));
    }

    res.json({
      status: 'ok',
      items_processed: results.length,
      results,
    });
  } catch (err) {
    console.error(
      'Global sync execution failed:',
      err.message
    );

    res.status(500).json({
      status: 'error',
      message: 'Unable to complete synchronization.',
    });
  }
}

module.exports = {
  runSync,
  syncOneItem,
};
