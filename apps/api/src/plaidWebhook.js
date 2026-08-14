```javascript
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { jwtDecode } = require('jwt-decode');
const { importJWK, jwtVerify } = require('jose');

const pool = require('./db');
const { plaidClient } = require('./plaidClient');
const { syncOneItem } = require('./sync');


const WEBHOOK_VERIFICATION_WINDOW_SECONDS = 5 * 60;


/**
 * Plaid webhook verification.
 *
 * Plaid sends:
 *
 *   plaid-verification: <JWT>
 *
 * The JWT contains:
 *
 *   request_body_sha256
 *   iat
 *   key_id
 *
 * We verify:
 *
 *   1. The JWT signature using Plaid's webhook verification key.
 *   2. The JWT is recent.
 *   3. The SHA-256 hash of the RAW request body matches the JWT claim.
 *
 * The raw body is mandatory here.
 */
async function verifyPlaidWebhook(
  rawBody,
  verificationToken
) {
  if (!rawBody) {
    throw new Error(
      'Plaid webhook raw request body is required'
    );
  }

  if (!verificationToken) {
    throw new Error(
      'Plaid webhook verification token is required'
    );
  }


  let decoded;

  try {
    decoded =
      jwtDecode(
        verificationToken
      );
  } catch (err) {
    throw new Error(
      'Invalid Plaid webhook verification JWT'
    );
  }


  const keyId =
    decoded.key_id;

  if (!keyId) {
    throw new Error(
      'Plaid webhook verification JWT is missing key_id'
    );
  }


  const verificationKeyResponse =
    await plaidClient.webhookVerificationKeyGet({
      key_id: keyId,
    });


  const verificationKey =
    verificationKeyResponse.data.key;


  if (!verificationKey) {
    throw new Error(
      'Plaid webhook verification key was not returned'
    );
  }


  /*
   * Plaid's verification key is a JWK.
   *
   * Convert it to a jose-compatible CryptoKey.
   */
  const publicKey =
    await importJWK(
      verificationKey,
      'ES256'
    );


  await jwtVerify(
    verificationToken,
    publicKey,
    {
      algorithms: ['ES256'],
    }
  );


  const issuedAt =
    Number(decoded.iat);

  if (
    !Number.isFinite(
      issuedAt
    )
  ) {
    throw new Error(
      'Plaid webhook verification JWT is missing iat'
    );
  }


  const now =
    Math.floor(
      Date.now() / 1000
    );


  if (
    Math.abs(
      now - issuedAt
    ) >
    WEBHOOK_VERIFICATION_WINDOW_SECONDS
  ) {
    throw new Error(
      'Plaid webhook verification JWT is outside the allowed time window'
    );
  }


  const expectedHash =
    decoded.request_body_sha256;


  if (!expectedHash) {
    throw new Error(
      'Plaid webhook verification JWT is missing request_body_sha256'
    );
  }


  const actualHash =
    crypto
      .createHash('sha256')
      .update(rawBody)
      .digest('hex');


  const expectedBuffer =
    Buffer.from(
      expectedHash,
      'hex'
    );

  const actualBuffer =
    Buffer.from(
      actualHash,
      'hex'
    );


  if (
    expectedBuffer.length !==
    actualBuffer.length
  ) {
    throw new Error(
      'Plaid webhook request body hash mismatch'
    );
  }


  if (
    !crypto.timingSafeEqual(
      expectedBuffer,
      actualBuffer
    )
  ) {
    throw new Error(
      'Plaid webhook request body hash mismatch'
    );
  }


  return decoded;
}


/**
 * Find the local Plaid Item associated with a Plaid Item ID.
 */
async function getPlaidItem(
  plaidItemId
) {
  const result =
    await pool.query(
      `
        SELECT
          id,
          user_id,
          plaid_item_id,
          plaid_access_token_encrypted,
          cursor,
          status
        FROM plaid_items
        WHERE plaid_item_id = $1
        LIMIT 1
      `,
      [plaidItemId]
    );


  if (
    result.rows.length ===
    0
  ) {
    return null;
  }


  return result.rows[0];
}


/**
 * Handle Plaid's transaction update notification.
 *
 * Plaid does NOT send the transaction dataset through this webhook.
 *
 * The webhook is the notification mechanism.
 *
 * The existing sync engine is responsible for retrieving the actual
 * changes through /transactions/sync.
 */
async function handleTransactionUpdate(
  webhook
) {
  const {
    item_id: plaidItemId,
    webhook_code: webhookCode,
  } = webhook;


  if (!plaidItemId) {
    throw new Error(
      'Plaid transaction webhook is missing item_id'
    );
  }


  const item =
    await getPlaidItem(
      plaidItemId
    );


  if (!item) {
    console.warn(
      `Received Plaid webhook for unknown Item ${plaidItemId}`
    );

    return {
      status: 'ignored',
      reason: 'UNKNOWN_ITEM',
      plaid_item_id:
        plaidItemId,
      webhook_code:
        webhookCode,
    };
  }


  /*
   * If the Item is no longer active, acknowledge the webhook
   * without attempting synchronization.
   */
  if (
    item.status !==
    'active'
  ) {
    return {
      status: 'ignored',
      reason:
        'ITEM_NOT_ACTIVE',
      plaid_item_id:
        plaidItemId,
      webhook_code:
        webhookCode,
    };
  }


  /*
   * The webhook is only the trigger.
   *
   * syncOneItem() performs the authoritative /transactions/sync
   * operation, applies added/modified/removed changes, reconciles
   * Round-Up intelligence, and advances the cursor only after
   * successful processing.
   */
  const syncResult =
    await syncOneItem(
      item
    );


  if (
    syncResult?.error
  ) {
    return {
      status: 'error',
      reason:
        'TRANSACTION_SYNC_FAILED',
      plaid_item_id:
        plaidItemId,
      webhook_code:
        webhookCode,
      sync:
        syncResult,
    };
  }


  return {
    status: 'processed',
    plaid_item_id:
      plaidItemId,
    webhook_code:
      webhookCode,
    sync:
      syncResult,
  };
}


/**
 * Express webhook handler.
 *
 * IMPORTANT:
 *
 * This handler expects req.rawBody to contain the exact bytes received
 * from Plaid. The JSON parser must not alter the body before this
 * handler runs.
 */
async function plaidWebhook(
  req,
  res
) {
  try {
    const verificationToken =
      req.header(
        'plaid-verification'
      );


    if (
      !verificationToken
    ) {
      return res.status(401).json({
        status: 'error',
        message:
          'Plaid webhook verification token is required',
      });
    }


    if (
      !req.rawBody
    ) {
      return res.status(400).json({
        status: 'error',
        message:
          'Plaid webhook raw request body is unavailable',
      });
    }


    await verifyPlaidWebhook(
      req.rawBody,
      verificationToken
    );


    const webhook =
      req.body;


    if (
      !webhook ||
      typeof webhook !==
        'object'
    ) {
      return res.status(400).json({
        status: 'error',
        message:
          'Invalid Plaid webhook body',
      });
    }


    const webhookType =
      webhook.webhook_type;


    /*
     * Transactions notifications.
     *
     * SYNC_UPDATES_AVAILABLE is the primary notification that
     * tells iBag to run /transactions/sync.
     *
     * Other transaction webhook codes may be useful for observability
     * but should not blindly trigger a transaction synchronization.
     */
    if (
      webhookType ===
      'TRANSACTIONS'
    ) {
      if (
        webhook.webhook_code ===
        'SYNC_UPDATES_AVAILABLE'
      ) {
        const result =
          await handleTransactionUpdate(
            webhook
          );


        /*
         * Return success after the synchronization attempt has been
         * handled. Plaid should not be given an authentication or
         * transport error merely because an unknown Item was received.
         */
        if (
          result.status ===
          'error'
        ) {
          console.error(
            'Plaid transaction webhook sync failed:',
            result
          );

          return res.status(500).json({
            status: 'error',
            message:
              'Transaction synchronization failed',
          });
        }


        return res.status(200).json({
          status: 'ok',
          result,
        });
      }


      /*
       * Other TRANSACTIONS webhook codes are acknowledged but do not
       * automatically initiate synchronization.
       */
      return res.status(200).json({
        status: 'ok',
        result: {
          status:
            'acknowledged',
          webhook_type:
            webhookType,
          webhook_code:
            webhook.webhook_code,
        },
      });
    }


    /*
     * Webhook types outside Transactions are acknowledged here.
     *
     * Their dedicated intelligence/synchronization behavior will be
     * implemented when those Plaid products are intentionally
     * activated by iBag.
     */
    return res.status(200).json({
      status: 'ok',
      result: {
        status:
          'acknowledged',
        webhook_type:
          webhookType ||
          null,
        webhook_code:
          webhook.webhook_code ||
          null,
      },
    });
  } catch (err) {
    console.error(
      'Plaid webhook processing failed:',
      err
    );


    /*
     * Authentication / verification failures are rejected.
     *
     * Processing failures are also surfaced as server errors so the
     * integration does not silently claim that an update was handled
     * when it was not.
     */
    return res.status(500).json({
      status: 'error',
      message:
        'Plaid webhook processing failed',
    });
  }
}


module.exports = {
  plaidWebhook,
  verifyPlaidWebhook,
};
```
