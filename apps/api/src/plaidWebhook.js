const crypto = require('crypto');

const pool = require('./db');
const {
  plaidClient,
} = require('./plaidClient');
const {
  syncOneItem,
} = require('./sync');


/*
 * Plaid webhook verification key cache.
 *
 * Plaid identifies the signing key with the JWT "kid".
 * Keys can rotate, so the cache is keyed by kid rather than
 * assuming that one verification key remains valid forever.
 */
const verificationKeyCache =
  new Map();


const WEBHOOK_MAX_AGE_SECONDS =
  5 * 60;


/* -------------------------------------------------------------------------- */
/* JWT / PLAID VERIFICATION                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Decode one base64url JWT component.
 *
 * This is decoding only.
 * Signature verification happens separately below.
 */
function decodeJwtPart(
  value
) {
  const normalized =
    value
      .replace(/-/g, '+')
      .replace(/_/g, '/');

  const padding =
    normalized.length % 4;

  const padded =
    padding === 0
      ? normalized
      : normalized +
        '='.repeat(
          4 - padding
        );

  return JSON.parse(
    Buffer.from(
      padded,
      'base64'
    ).toString('utf8')
  );
}


/**
 * Decode a JWT without trusting its contents.
 */
function decodeJwt(
  token
) {
  if (
    typeof token !==
      'string' ||
    token.split('.').length !==
      3
  ) {
    throw new Error(
      'Invalid Plaid verification JWT'
    );
  }

  const [
    encodedHeader,
    encodedPayload,
    encodedSignature,
  ] =
    token.split('.');

  return {
    encodedHeader,
    encodedPayload,
    encodedSignature,

    header:
      decodeJwtPart(
        encodedHeader
      ),

    payload:
      decodeJwtPart(
        encodedPayload
      ),
  };
}


/**
 * Retrieve the Plaid webhook verification key for a JWT kid.
 */
async function getVerificationKey(
  keyId
) {
  if (
    verificationKeyCache.has(
      keyId
    )
  ) {
    return verificationKeyCache.get(
      keyId
    );
  }

  const response =
    await plaidClient.webhookVerificationKeyGet(
      {
        key_id: keyId,
      }
    );

  const key =
    response?.data?.key;

  if (!key) {
    throw new Error(
      'Plaid did not return a webhook verification key'
    );
  }

  if (
    key.kid !== keyId
  ) {
    throw new Error(
      'Plaid webhook verification key ID mismatch'
    );
  }

  verificationKeyCache.set(
    keyId,
    key
  );

  return key;
}


/**
 * Verify the authenticity and integrity of a Plaid webhook.
 *
 * Plaid signs the request with an ES256 JWT.
 *
 * Verification requirements:
 *
 * 1. Plaid-Verification header must exist.
 * 2. JWT algorithm must be ES256.
 * 3. JWT kid must identify the verification key.
 * 4. Signature must validate.
 * 5. iat must be no more than five minutes old.
 * 6. SHA-256 of the exact raw request body must match
 *    request_body_sha256 in the verified JWT.
 */
async function verifyPlaidWebhook(
  rawBody,
  verificationHeader
) {
  if (
    !verificationHeader
  ) {
    throw new Error(
      'Missing Plaid-Verification header'
    );
  }

  const decoded =
    decodeJwt(
      verificationHeader
    );

  const header =
    decoded.header;

  const payload =
    decoded.payload;

  if (
    header.alg !==
    'ES256'
  ) {
    throw new Error(
      'Unsupported Plaid webhook signing algorithm'
    );
  }

  if (
    header.typ &&
    header.typ !==
      'JWT'
  ) {
    throw new Error(
      'Invalid Plaid webhook JWT type'
    );
  }

  if (
    !header.kid ||
    typeof header.kid !==
      'string'
  ) {
    throw new Error(
      'Plaid webhook JWT is missing kid'
    );
  }

  if (
    !payload.iat ||
    typeof payload.iat !==
      'number'
  ) {
    throw new Error(
      'Plaid webhook JWT is missing iat'
    );
  }

  if (
    !payload.request_body_sha256 ||
    typeof payload.request_body_sha256 !==
      'string'
  ) {
    throw new Error(
      'Plaid webhook JWT is missing request_body_sha256'
    );
  }


  const now =
    Math.floor(
      Date.now() / 1000
    );

  const age =
    now - payload.iat;


  /*
   * Reject timestamps too far in the future as well as
   * timestamps older than the five-minute verification window.
   */
  if (
    age < 0 ||
    age >
      WEBHOOK_MAX_AGE_SECONDS
  ) {
    throw new Error(
      'Plaid webhook verification JWT is outside the five-minute validity window'
    );
  }


  const key =
    await getVerificationKey(
      header.kid
    );


  if (
    key.alg !==
      'ES256' ||
    key.kty !==
      'EC' ||
    key.crv !==
      'P-256' ||
    !key.x ||
    !key.y
  ) {
    throw new Error(
      'Invalid Plaid webhook verification JWK'
    );
  }


  const publicKey =
    crypto.createPublicKey({
      key,
      format: 'jwk',
    });


  const signingInput =
    decoded.encodedHeader +
    '.' +
    decoded.encodedPayload;


  const signature =
    Buffer.from(
      decoded.encodedSignature
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(
          Math.ceil(
            decoded.encodedSignature.length /
              4
          ) *
            4,
          '='
        ),
      'base64'
    );


  const verifier =
    crypto.createVerify(
      'SHA256'
    );


  verifier.update(
    signingInput
  );

  verifier.end();


  const signatureValid =
    verifier.verify(
      {
        key: publicKey,
        dsaEncoding:
          'ieee-p1363',
      },
      signature
    );


  if (
    !signatureValid
  ) {
    /*
     * If the cached key is stale because Plaid rotated keys,
     * remove it and allow a fresh request on the next webhook.
     */
    verificationKeyCache.delete(
      header.kid
    );

    throw new Error(
      'Invalid Plaid webhook signature'
    );
  }


  const bodyHash =
    crypto
      .createHash(
        'sha256'
      )
      .update(
        rawBody
      )
      .digest('hex');


  const claimedHash =
    payload.request_body_sha256;


  const bodyHashBuffer =
    Buffer.from(
      bodyHash,
      'utf8'
    );

  const claimedHashBuffer =
    Buffer.from(
      claimedHash,
      'utf8'
    );


  if (
    bodyHashBuffer.length !==
    claimedHashBuffer.length
  ) {
    throw new Error(
      'Plaid webhook body hash mismatch'
    );
  }


  if (
    !crypto.timingSafeEqual(
      bodyHashBuffer,
      claimedHashBuffer
    )
  ) {
    throw new Error(
      'Plaid webhook body hash mismatch'
    );
  }


  return {
    header,
    payload,
  };
}


/* -------------------------------------------------------------------------- */
/* ITEM LOOKUP                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Find the local Plaid Item associated with the Plaid item_id.
 *
 * Never trust a user ID supplied by the webhook body to determine
 * ownership of local financial records. The authoritative local
 * relationship is the plaid_items table.
 */
async function getLocalItem(
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
      [
        plaidItemId,
      ]
    );

  if (
    result.rows.length ===
    0
  ) {
    return null;
  }

  return result.rows[0];
}


/* -------------------------------------------------------------------------- */
/* ITEM WEBHOOK HANDLING                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Mark a local Item as requiring user attention.
 *
 * We retain the Item and its financial history.
 * The status communicates that Plaid requires an Item update.
 */
async function handleItemError(
  body
) {
  if (
    !body.item_id
  ) {
    return {
      handled: false,
      reason:
        'ITEM webhook did not contain item_id',
    };
  }

  const item =
    await getLocalItem(
      body.item_id
    );

  if (!item) {
    console.warn(
      'Received Plaid ITEM webhook for unknown Item:',
      body.item_id
    );

    return {
      handled: false,
      reason:
        'Unknown Plaid Item',
    };
  }


  const errorCode =
    body.error?.error_code ||
    null;


  const errorMessage =
    body.error?.error_message ||
    body.error?.display_message ||
    null;


  /*
   * ITEM ERROR means the Item needs attention.
   *
   * We do not delete financial data.
   * We do not delete the access token.
   * We preserve the Item so the user can repair it through
   * Plaid Link update mode.
   */
  await pool.query(
    `
      UPDATE plaid_items
      SET
        status = 'error',
        updated_at = now()
      WHERE id = $1
    `,
    [
      item.id,
    ]
  );


  console.warn(
    'Plaid Item entered error state:',
    {
      plaid_item_id:
        body.item_id,
      error_code:
        errorCode,
      error_message:
        errorMessage,
    }
  );


  return {
    handled: true,
    action:
      'item_marked_error',
    plaid_item_id:
      body.item_id,
    error_code:
      errorCode,
  };
}


/**
 * Mark an Item active again after Plaid reports that a previously
 * broken Item has been repaired.
 */
async function handleItemRepaired(
  body
) {
  if (
    !body.item_id
  ) {
    return {
      handled: false,
      reason:
        'ITEM webhook did not contain item_id',
    };
  }

  const item =
    await getLocalItem(
      body.item_id
    );

  if (!item) {
    console.warn(
      'Received Plaid repaired webhook for unknown Item:',
      body.item_id
    );

    return {
      handled: false,
      reason:
        'Unknown Plaid Item',
    };
  }


  await pool.query(
    `
      UPDATE plaid_items
      SET
        status = 'active',
        updated_at = now()
      WHERE id = $1
    `,
    [
      item.id,
    ]
  );


  return {
    handled: true,
    action:
      'item_marked_active',
    plaid_item_id:
      body.item_id,
  };
}


/* -------------------------------------------------------------------------- */
/* TRANSACTION WEBHOOK HANDLING                                               */
/* -------------------------------------------------------------------------- */

/**
 * Handle transaction webhooks.
 *
 * iBag uses /transactions/sync.
 *
 * Therefore the webhook itself is only the notification that
 * new transaction state exists. The actual financial records are
 * retrieved through syncOneItem(), which owns:
 *
 *   added
 *   modified
 *   removed
 *   cursor advancement
 *   Round-Up reconciliation
 *   transaction history preservation
 */
async function handleTransactionWebhook(
  body
) {
  const webhookCode =
    body.webhook_code;


  if (
    !body.item_id
  ) {
    return {
      handled: false,
      reason:
        'TRANSACTIONS webhook did not contain item_id',
    };
  }


  const item =
    await getLocalItem(
      body.item_id
    );


  if (!item) {
    console.warn(
      'Received Plaid transaction webhook for unknown Item:',
      body.item_id
    );

    return {
      handled: false,
      reason:
        'Unknown Plaid Item',
    };
  }


  /*
   * With transactions/sync, SYNC_UPDATES_AVAILABLE is the
   * authoritative transaction-change notification.
   *
   * The older INITIAL_UPDATE, HISTORICAL_UPDATE,
   * DEFAULT_UPDATE, and TRANSACTIONS_REMOVED webhooks are
   * intentionally not used as separate synchronization paths.
   */
  if (
    webhookCode !==
    'SYNC_UPDATES_AVAILABLE'
  ) {
    return {
      handled: true,
      action:
        'ignored_non_sync_transaction_webhook',
      webhook_code:
        webhookCode,
      plaid_item_id:
        body.item_id,
    };
  }


  /*
   * If an Item is not currently active, do not pull new financial
   * data automatically. The Item must be repaired/re-enabled first.
   */
  if (
    item.status !==
    'active'
  ) {
    return {
      handled: true,
      action:
        'sync_skipped_item_not_active',
      plaid_item_id:
        body.item_id,
      item_status:
        item.status,
    };
  }


  const syncResult =
    await syncOneItem(
      item
    );


  if (
    syncResult?.error
  ) {
    throw new Error(
      syncResult.error
    );
  }


  return {
    handled: true,
    action:
      'item_synchronized',
    plaid_item_id:
      body.item_id,
    sync:
      syncResult,
  };
}


/* -------------------------------------------------------------------------- */
/* WEBHOOK ROUTER                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Process one verified Plaid webhook.
 */
async function processPlaidWebhook(
  body
) {
  if (
    !body ||
    typeof body !==
      'object'
  ) {
    throw new Error(
      'Plaid webhook body is invalid'
    );
  }


  const webhookType =
    body.webhook_type;


  if (
    webhookType ===
    'TRANSACTIONS'
  ) {
    return handleTransactionWebhook(
      body
    );
  }


  if (
    webhookType ===
    'ITEM'
  ) {
    if (
      body.webhook_code ===
      'ERROR'
    ) {
      return handleItemError(
        body
      );
    }


    if (
      body.webhook_code ===
      'LOGIN_REPAIRED'
    ) {
      return handleItemRepaired(
        body
      );
    }


    /*
     * Other Item notifications are acknowledged but do not
     * automatically mutate financial transaction history.
     */
    return {
      handled: true,
      action:
        'acknowledged_item_webhook',
      webhook_code:
        body.webhook_code ||
        null,
      plaid_item_id:
        body.item_id ||
        null,
    };
  }


  /*
   * iBag may add additional Plaid products later.
   *
   * Unknown webhook families are acknowledged after successful
   * authenticity verification rather than being treated as
   * financial transaction updates.
   */
  console.log(
    'Acknowledged Plaid webhook:',
    {
      webhook_type:
        webhookType ||
        null,
      webhook_code:
        body.webhook_code ||
        null,
      item_id:
        body.item_id ||
        null,
    }
  );


  return {
    handled: true,
    action:
      'acknowledged_unhandled_webhook_type',
    webhook_type:
      webhookType ||
      null,
    webhook_code:
      body.webhook_code ||
      null,
    plaid_item_id:
      body.item_id ||
      null,
  };
}


/* -------------------------------------------------------------------------- */
/* EXPRESS HANDLER                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Express handler for POST /plaid/webhook.
 *
 * index.js captures req.rawBody before Express JSON parsing.
 */
async function plaidWebhook(
  req,
  res
) {
  try {
    if (
      !req.rawBody ||
      !Buffer.isBuffer(
        req.rawBody
      )
    ) {
      console.error(
        'Plaid webhook rejected: raw request body unavailable'
      );

      return res.status(400).json({
        status: 'error',
        message:
          'Raw webhook body unavailable',
      });
    }


    const verificationHeader =
      req.get(
        'Plaid-Verification'
      );


    await verifyPlaidWebhook(
      req.rawBody,
      verificationHeader
    );


    /*
     * Verification succeeded.
     *
     * req.body is now safe to interpret as the authenticated
     * webhook payload.
     */
    const result =
      await processPlaidWebhook(
        req.body
      );


    /*
     * Plaid only needs confirmation that the webhook was accepted.
     * The useful processing result is logged server-side rather
     * than exposed to Plaid as an application API contract.
     */
    console.log(
      'Plaid webhook processed:',
      result
    );


    return res.status(200).json({
      status: 'ok',
    });
  } catch (err) {
    console.error(
      'Plaid webhook processing failed:',
      err
    );


    /*
     * A verification failure is rejected explicitly.
     *
     * A processing failure is also returned as a non-2xx response
     * so the webhook is not falsely acknowledged as successfully
     * processed.
     */
    return res.status(400).json({
      status: 'error',
      message:
        'Plaid webhook could not be verified or processed.',
    });
  }
}


/* -------------------------------------------------------------------------- */
/* EXPORT                                                                     */
/* -------------------------------------------------------------------------- */

module.exports = {
  plaidWebhook,
  verifyPlaidWebhook,
  processPlaidWebhook,
};
