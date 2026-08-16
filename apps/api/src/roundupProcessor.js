/*
 * apps/api/src/roundupProcessor.js
 * Per-card roundup accumulator and batch creator.
 * Usage: require and call processRoundupForTransaction(client, transactionRow)
 * or processRoundupForTransaction(null, transactionRow) for one-shot.
 *
 * Requires environment:
 *  - MIN_SOURCE_BALANCE_CENTS (optional, default 0)
 *
 * This module is analytic-only: it does not move money.
 */

const pool = require('./db');

// Config: safety buffer (in cents) to avoid sweeps that would likely overdraft
const MIN_SOURCE_BALANCE_CENTS = Number(process.env.MIN_SOURCE_BALANCE_CENTS) || 0;

// Helper: convert dollars to cents safely
function dollarsToCents(d) {
  return Math.round(Number(d) * 100);
}

// Called after a canonical transaction is stored.
// Accepts a DB client (optional). To keep sync.js simpler, we accept a client
// if the caller already has an open one; otherwise we use pool.connect().
async function processRoundupForTransaction(clientOrPool, transactionRow) {
  const clientProvided = Boolean(clientOrPool && clientOrPool.query);
  const client = clientProvided ? clientOrPool : await pool.connect();

  if (!transactionRow || !transactionRow.account_id || !transactionRow.user_id) {
    if (!clientProvided) client.release();
    return { ok: false, reason: 'MISSING_META' };
  }

  // compute roundup amount (in cents)
  const amount = Number(transactionRow.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    if (!clientProvided) client.release();
    return { ok: false, reason: 'NOT_ELIGIBLE_AMOUNT' };
  }

  const roundup = Math.ceil(amount) - amount;
  const roundupCents = Math.round(roundup * 100);
  if (roundupCents <= 0 || roundupCents >= 100) {
    if (!clientProvided) client.release();
    return { ok: false, reason: 'NOT_ELIGIBLE_ROUNDUP' };
  }

  try {
    await client.query('BEGIN');

    // Acquire advisory lock derived from account_id (text -> bigint conversion via md5)
    await client.query(
      `SELECT pg_advisory_xact_lock((('x' || substr(md5($1),1,16))::bit(64)::bigint))`,
      [transactionRow.account_id]
    );

    // ensure accumulator exists and lock it
    const accRes = await client.query(
      `SELECT id, accumulated_cents, threshold_cents FROM roundup_accumulators WHERE account_id = $1 FOR UPDATE`,
      [transactionRow.account_id]
    );

    let accumulatorId;
    let accumulatedCents = 0;
    let thresholdCents = 200;

    if (accRes.rows.length === 0) {
      const insertAcc = await client.query(
        `INSERT INTO roundup_accumulators(user_id, account_id, threshold_cents) VALUES ($1, $2, $3) RETURNING id, accumulated_cents, threshold_cents`,
        [transactionRow.user_id, transactionRow.account_id, thresholdCents]
      );
      accumulatorId = insertAcc.rows[0].id;
      accumulatedCents = 0;
      thresholdCents = insertAcc.rows[0].threshold_cents;
    } else {
      accumulatorId = accRes.rows[0].id;
      accumulatedCents = Number(accRes.rows[0].accumulated_cents || 0);
      thresholdCents = Number(accRes.rows[0].threshold_cents || 200);
    }

    // Idempotency: try to insert the line item; if transaction_id already exists, do nothing
    const insertLineSql = `
      INSERT INTO roundup_line_items (accumulator_id, user_id, transaction_id, plaid_transaction_id, amount_cents)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (transaction_id) DO NOTHING
      RETURNING id
    `;
    const insertLineRes = await client.query(insertLineSql, [
      accumulatorId,
      transactionRow.user_id,
      transactionRow.id,
      transactionRow.plaid_transaction_id || null,
      roundupCents
    ]);

    // If the line already existed, we are done (idempotent)
    if (insertLineRes.rows.length === 0) {
      await client.query('COMMIT');
      if (!clientProvided) client.release();
      return { ok: true, created: false, reason: 'ALREADY_EXISTS' };
    }

    // Update accumulator: add roundupCents to accumulated_cents
    accumulatedCents += roundupCents;
    await client.query(
      `UPDATE roundup_accumulators SET accumulated_cents = accumulated_cents + $1, last_updated = now() WHERE id = $2`,
      [roundupCents, accumulatorId]
    );

    // If accumulator now meets/exceeds threshold, attempt to create a batch.
    if (accumulatedCents >= thresholdCents) {
      // Basic overdraft-safety check: read source account available_balance if present
      const accountRow = await client.query(
        `SELECT id, available_balance, available_balance_cents FROM accounts WHERE id = $1 LIMIT 1`,
        [transactionRow.account_id]
      );

      let availableCents = null;
      if (accountRow.rows.length > 0) {
        const ab = accountRow.rows[0].available_balance_cents != null ? accountRow.rows[0].available_balance_cents : accountRow.rows[0].available_balance;
        if (ab !== null && ab !== undefined) {
          availableCents = accountRow.rows[0].available_balance_cents != null ? Number(accountRow.rows[0].available_balance_cents) : Math.round(Number(ab) * 100);
        }
      }

      // Sum of outstanding pending (calculated or pending statuses) items for this accumulator
      const pendingSumRes = await client.query(
        `SELECT COALESCE(SUM(amount_cents),0) AS pending_total FROM roundup_line_items WHERE accumulator_id = $1 AND status IN ('calculated','pending')`,
        [accumulatorId]
      );
      const pendingTotalCents = Number(pendingSumRes.rows[0].pending_total || 0);

      // Determine if it's safe to mark batch ready
      let safeToCreate = true;
      if (availableCents !== null) {
        safeToCreate = (availableCents - pendingTotalCents - MIN_SOURCE_BALANCE_CENTS) >= 0;
      }

      if (safeToCreate) {
        // Choose destination_account_id: prefer an account flagged as destination (is_destination_target = true)
        const destRes = await client.query(
          `SELECT id FROM accounts WHERE user_id = $1 AND is_destination_target = true LIMIT 1`,
          [transactionRow.user_id]
        );
        const destinationAccountId = destRes.rows.length > 0 ? destRes.rows[0].id : null;

        // Collect items to include in batch (all pending items for this accumulator)
        const itemsRes = await client.query(
          `SELECT id, amount_cents FROM roundup_line_items WHERE accumulator_id = $1 AND status IN ('calculated','pending') ORDER BY created_at FOR UPDATE`,
          [accumulatorId]
        );

        const items = itemsRes.rows;
        const batchTotal = items.reduce((s, r) => s + Number(r.amount_cents || 0), 0);

        // Create batch record
        const batchInsert = await client.query(
          `INSERT INTO roundup_batches (user_id, destination_account_id, source_account_id, threshold_cents, total_cents, item_count, status)
           VALUES ($1,$2,$3,$4,$5,$6,'ready_for_sweep')
           RETURNING id`,
          [transactionRow.user_id, destinationAccountId, transactionRow.account_id, thresholdCents, batchTotal, items.length]
        );

        const batchId = batchInsert.rows[0].id;

        // Assign batch_id to items and mark as batched
        const itemIds = items.map(r => r.id);
        if (itemIds.length > 0) {
          await client.query(
            `UPDATE roundup_line_items SET status = 'batched', batch_id = $1 WHERE id = ANY($2::uuid[])`,
            [batchId, itemIds]
          );
        }

        // Reduce accumulator by batchTotal (leftover cents remain)
        await client.query(
          `UPDATE roundup_accumulators SET accumulated_cents = accumulated_cents - $1 WHERE id = $2`,
          [batchTotal, accumulatorId]
        );

        await client.query('COMMIT');
        if (!clientProvided) client.release();
        return { ok: true, created: true, batch_id: batchId, total_cents: batchTotal };
      } else {
        // Not safe: don't create batch; keep items pending
        await client.query('COMMIT');
        if (!clientProvided) client.release();
        return { ok: true, created: false, reason: 'NOT_SAFE_TO_CREATE_BATCH' };
      }
    } else {
      // threshold not reached yet; commit and return
      await client.query('COMMIT');
      if (!clientProvided) client.release();
      return { ok: true, created: false, reason: 'THRESHOLD_NOT_REACHED' };
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    if (!clientProvided) client.release();
    throw err;
  }
}

module.exports = {
  processRoundupForTransaction,
  dollarsToCents,
};
