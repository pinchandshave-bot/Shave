const pool = require('./db');

const {
  plaidClient,
  getItem,
  getAuth,
  getBalances,
  getIdentity,
  getLiabilities,
  getInvestments,
  getStatements,
} = require('./plaidClient');

const { decrypt } = require('./crypto');

const {
  calculateRoundup,
  getRoundupEligibility,
  RULE_VERSION,
} = require('./roundup');

const MUTATION_DURING_PAGINATION =
  'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';

const MAX_PAGINATION_RESTARTS = 3;

/*
 * --------------------------------------------------------------------------
 * IBAG PLAID DOMAIN CONTRACT
 * --------------------------------------------------------------------------
 *
 * iBag never treats a requested Plaid product as observed financial data.
 *
 * Product state is determined from the actual Plaid Item.
 *
 * Important distinctions:
 *
 * requested
 *   The application requested the capability.
 *
 * initialized
 *   Plaid reports the product as initialized on the Item.
 *
 * available
 *   Plaid reports the product as available for the Item.
 *
 * consented
 *   The user has consented to the applicable product scope.
 *
 * observed
 *   An endpoint was successfully called and returned real data.
 *
 * unsupported / unavailable
 *   iBag does not have usable access to that domain for this Item.
 *
 * No state below creates financial data.
 */

const DOMAIN_PRODUCTS = Object.freeze({
  transactions: ['transactions'],

  auth: ['auth'],

  identity: ['identity'],

  investments: [
    'investments',
    'investments_auth',
  ],

  liabilities: ['liabilities'],

  statements: ['statements'],

  recurring_transactions: [
    'recurring_transactions',
  ],

  assets: ['assets'],

  income: [
    'income',
    'income_verification',
  ],
});

/*
 * Balance is deliberately not included above as a normal product gate.
 *
 * Plaid exposes account balances through accountsBalanceGet().
 *
 * Balance may be billed differently from Item products and should not be
 * treated as equivalent to the product arrays returned by Item Get.
 */

const DOMAIN_ENDPOINTS = Object.freeze({
  transactions: 'transactionsSync',
  auth: 'authGet',
  identity: 'identityGet',
  investments: 'investmentsHoldingsGet',
  liabilities: 'liabilitiesGet',
  statements: 'statementsList',
  balance: 'accountsBalanceGet',
});

/*
 * --------------------------------------------------------------------------
 * GENERAL UTILITIES
 * --------------------------------------------------------------------------
 */

function getPlaidErrorCode(error) {
  return (
    error?.response?.data?.error_code ||
    error?.response?.data?.error_code ||
    null
  );
}

function getPlaidErrorMessage(error) {
  return (
    error?.response?.data?.error_message ||
    error?.response?.data?.display_message ||
    error?.message ||
    'Unknown Plaid error'
  );
}

function isCapabilityError(error) {
  const code = getPlaidErrorCode(error);

  /*
   * We deliberately do not maintain a huge guessed list of Plaid error
   * codes here.
   *
   * Capability state is primarily determined by Item Get.
   *
   * This helper is used only to classify a domain failure as non-fatal
   * to the remainder of the Item synchronization.
   */
  return Boolean(code);
}

function uniqueStrings(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .filter(
          value =>
            typeof value === 'string' &&
            value.length > 0
        )
    ),
  ];
}

function productMatches(
  product,
  productList
) {
  return productList.includes(product);
}

/*
 * --------------------------------------------------------------------------
 * PLAID ITEM CAPABILITY DISCOVERY
 * --------------------------------------------------------------------------
 */

async function discoverItemCapabilities(
  accessToken
) {
  const itemData =
    await getItem(accessToken);

  const item =
    itemData?.item ||
    itemData ||
    {};

  const products =
    uniqueStrings(item.products);

  const billedProducts =
    uniqueStrings(
      item.billed_products
    );

  const availableProducts =
    uniqueStrings(
      item.available_products
    );

  const consentedProducts =
    uniqueStrings(
      item.consented_products
    );

  const requestedProducts =
    uniqueStrings([
      ...products,
      ...billedProducts,
      ...availableProducts,
      ...consentedProducts,
    ]);

  const domains = {};

  for (
    const [domain, productNames]
    of Object.entries(
      DOMAIN_PRODUCTS
    )
  ) {
    const initialized =
      productNames.some(
        product =>
          productMatches(
            product,
            products
          )
      );

    const billed =
      productNames.some(
        product =>
          productMatches(
            product,
            billedProducts
          )
      );

    const available =
      productNames.some(
        product =>
          productMatches(
            product,
            availableProducts
          )
      );

    const consented =
      productNames.some(
        product =>
          productMatches(
            product,
            consentedProducts
          )
      );

    let state = 'not_available';

    if (initialized) {
      state = 'initialized';
    } else if (consented) {
      state = 'consented';
    } else if (available) {
      state = 'available';
    }

    domains[domain] = {
      products: [...productNames],
      initialized,
      billed,
      available,
      consented,
      state,
      observed: false,
    };
  }

  /*
   * Balance is an operational account-data capability, not a normal
   * product gate.
   */
  domains.balance = {
    products: [],
    initialized: true,
    billed: false,
    available: true,
    consented: false,
    state: 'operational',
    observed: false,
  };

  return {
    item_id:
      item.item_id ||
      null,

    institution_id:
      item.institution_id ||
      null,

    institution_name:
      item.institution_name ||
      null,

    consent_expiration_time:
      item.consent_expiration_time ||
      null,

    products,
    billed_products:
      billedProducts,
    available_products:
      availableProducts,
    consented_products:
      consentedProducts,

    requested_or_present_products:
      requestedProducts,

    domains,
  };
}

/*
 * --------------------------------------------------------------------------
 * TRANSACTION PAGINATION
 * --------------------------------------------------------------------------
 *
 * Plaid /transactions/sync is cursor based.
 *
 * We consume every page before returning the complete delta.
 *
 * If Plaid reports that the transaction set changed while pagination was
 * occurring, restart from the original cursor.
 */

async function fetchTransactionUpdates(
  accessToken,
  startingCursor
) {
  let restartCount = 0;

  while (true) {
    const originalCursor =
      startingCursor || undefined;

    let cursor =
      originalCursor;

    const added = [];
    const modified = [];
    const removed = [];

    try {
      let hasMore = true;

      while (hasMore) {
        const response =
          await plaidClient.transactionsSync({
            access_token: accessToken,
            cursor,
            count: 500,
          });

        const data =
          response.data || {};

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
          Boolean(
            data.has_more
          );

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
        getPlaidErrorCode(err);

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

/*
 * --------------------------------------------------------------------------
 * ROUND-UP RECONCILIATION
 * --------------------------------------------------------------------------
 *
 * Round-Ups are analytical/intelligence records only.
 *
 * NO MONEY MOVEMENT OCCURS HERE.
 *
 * Pending transactions are not authoritative Round-Up events.
 */

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

  if (
    !transactionResult.rows.length
  ) {
    throw new Error(
      `Transaction ${transactionId} not found during Round-Up reconciliation`
    );
  }

  const transaction =
    transactionResult.rows[0];

  if (
    transaction.pending === true
  ) {
    await client.query(
      `
        UPDATE roundup_events
        SET
          eligible = false,
          eligibility_reason =
            'PENDING_TRANSACTION',
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
 * --------------------------------------------------------------------------
 * PENDING → POSTED RECONCILIATION
 * --------------------------------------------------------------------------
 */

async function findPendingReplacement(
  client,
  txn
) {
  if (
    !txn.pending_transaction_id
  ) {
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
      [
        txn.pending_transaction_id,
      ]
    );

  if (!result.rows.length) {
    return null;
  }

  return result.rows[0].id;
}

/*
 * --------------------------------------------------------------------------
 * TRANSACTION UPSERT
 * --------------------------------------------------------------------------
 */

async function upsertTransaction(
  client,
  txn,
  accountId
) {
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
              plaid_transaction_id = $1,
              account_id = $2,
              amount = $3,
              iso_currency_code = $4,
              merchant_name = $5,
              category = $6,
              pending = false,
              authorized_date = $7,
              posted_date = $8,
              raw = $9,
              pending_transaction_id = $10,
              status = 'active',
              updated_at = now()
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

/*
 * --------------------------------------------------------------------------
 * REMOVED TRANSACTION
 * --------------------------------------------------------------------------
 */

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
      [
        removed.transaction_id,
      ]
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

/*
 * --------------------------------------------------------------------------
 * BALANCE SYNCHRONIZATION
 * --------------------------------------------------------------------------
 *
 * Balance is real account state.
 *
 * We only update accounts that can be matched to the current Plaid Item.
 *
 * We never create accounts from an unmatched balance response.
 */

async function syncBalances(
  client,
  accessToken,
  itemId
) {
  const response =
    await plaidClient.accountsBalanceGet({
      access_token: accessToken,
    });

  const accounts =
    response.data?.accounts ||
    [];

  let updated = 0;
  let unmatched = 0;

  for (
    const account
    of accounts
  ) {
    const result =
      await client.query(
        `
          UPDATE accounts
          SET
            current_balance = $1,
            available_balance = $2,
            balance_iso_currency_code = $3,
            balance_updated_at = now(),
            updated_at = now()
          WHERE plaid_item_id = $4
            AND plaid_account_id = $5
          RETURNING id
        `,
        [
          account.balances?.current ??
            null,

          account.balances?.available ??
            null,

          account.balances
            ?.iso_currency_code ??
            null,

          itemId,

          account.account_id,
        ]
      );

    if (result.rows.length) {
      updated += 1;
    } else {
      /*
       * Do not manufacture an account.
       *
       * Account synchronization belongs to the Item/account initialization
       * lifecycle.
       */
      unmatched += 1;
    }
  }

  return {
    state: 'observed',
    observations:
      accounts.length,
    updated,
    unmatched,
  };
}

/*
 * --------------------------------------------------------------------------
 * GENERIC DOMAIN OBSERVATION
 * --------------------------------------------------------------------------
 *
 * These calls deliberately do not invent persistence tables.
 *
 * The returned real Plaid response is available to the orchestration result.
 *
 * Domain-specific persistence will be added only against the actual
 * production schema for each domain.
 */

async function observeDomain(
  domain,
  accessToken,
  capability
) {
  if (
    !capability
  ) {
    return {
      domain,
      state: 'not_available',
      observed: false,
      observations: 0,
    };
  }

  if (
    !capability.initialized &&
    !capability.consented &&
    !capability.available
  ) {
    return {
      domain,
      state: 'not_available',
      observed: false,
      observations: 0,
      reason:
        'Plaid Item does not report usable capability for this domain.',
    };
  }

  try {
    let data = null;

    switch (domain) {
      case 'auth':
        data =
          await getAuth(
            accessToken
          );
        break;

      case 'identity':
        data =
          await getIdentity(
            accessToken
          );
        break;

      case 'liabilities':
        data =
          await getLiabilities(
            accessToken
          );
        break;

      case 'investments':
        data =
          await getInvestments(
            accessToken
          );
        break;

      case 'statements':
        data =
          await getStatements(
            accessToken
          );
        break;

      /*
       * Recurring Transactions is deliberately not guessed here.
       *
       * Plaid documents this as /transactions/recurring/get and describes
       * it as an add-on to Transactions. The current plaidClient contract
       * supplied to this application does not expose that endpoint.
       *
       * Therefore we report the capability but do not invent an API call.
       */
      case 'recurring_transactions':
        return {
          domain,
          state: 'capability_detected_endpoint_not_configured',
          observed: false,
          observations: 0,
          endpoint:
            'transactionsRecurringGet',
        };

      /*
       * Assets uses the Asset Report lifecycle and therefore is not a
       * simple account-domain GET operation.
       *
       * Do not manufacture an observation here.
       */
      case 'assets':
        return {
          domain,
          state:
            'capability_detected_specialized_workflow',
          observed: false,
          observations: 0,
          endpoint:
            'assetReportCreate/assetReportGet',
        };

      /*
       * Income has current Plaid Credit / income-verification workflows.
       *
       * The application deliberately does not invent incomeGet().
       */
      case 'income':
        return {
          domain,
          state:
            'capability_detected_specialized_workflow',
          observed: false,
          observations: 0,
          endpoint:
            'credit/*_income/*',
        };

      default:
        return {
          domain,
          state: 'not_configured',
          observed: false,
          observations: 0,
        };
    }

    return {
      domain,
      state: 'observed',
      observed: true,
      observations: countDomainObservations(
        domain,
        data
      ),
      data,
    };
  } catch (err) {
    return {
      domain,
      state: isCapabilityError(err)
        ? 'observation_failed'
        : 'error',
      observed: false,
      observations: 0,
      error_code:
        getPlaidErrorCode(err),
      error_message:
        getPlaidErrorMessage(err),
    };
  }
}

/*
 * --------------------------------------------------------------------------
 * OBSERVATION COUNTING
 * --------------------------------------------------------------------------
 *
 * This is metadata only.
 *
 * It is deliberately conservative.
 */

function countDomainObservations(
  domain,
  data
) {
  if (!data) {
    return 0;
  }

  switch (domain) {
    case 'auth':
      return Array.isArray(
        data.numbers?.ach
      )
        ? data.numbers.ach.length
        : 0;

    case 'identity':
      return Array.isArray(
        data.accounts
      )
        ? data.accounts.length
        : 0;

    case 'liabilities':
      return Array.isArray(
        data.accounts
      )
        ? data.accounts.length
        : 0;

    case 'investments':
      return Array.isArray(
        data.accounts
      )
        ? data.accounts.length
        : 0;

    case 'statements':
      return Array.isArray(
        data.statements
      )
        ? data.statements.length
        : 0;

    default:
      return 0;
  }
}

/*
 * --------------------------------------------------------------------------
 * DOMAIN ORCHESTRATION
 * --------------------------------------------------------------------------
 */

async function synchronizeDomains(
  client,
  accessToken,
  itemId,
  capabilities
) {
  const domains = {};

  /*
   * Balance is operational and independently synchronized.
   */
  try {
    domains.balance =
      await syncBalances(
        client,
        accessToken,
        itemId
      );
  } catch (err) {
    domains.balance = {
      state: 'observation_failed',
      observed: false,
      observations: 0,
      error_code:
        getPlaidErrorCode(err),
      error_message:
        getPlaidErrorMessage(err),
    };
  }

  /*
   * These domains are observed independently.
   *
   * Failure in one does not invalidate transactions or another successful
   * domain.
   */
  const observationDomains = [
    'auth',
    'identity',
    'liabilities',
    'investments',
    'statements',
    'recurring_transactions',
    'assets',
    'income',
  ];

  for (
    const domain
    of observationDomains
  ) {
    domains[domain] =
      await observeDomain(
        domain,
        accessToken,
        capabilities.domains[
          domain
        ]
      );
  }

  return domains;
}

/*
 * --------------------------------------------------------------------------
 * SYNC ONE PLAID ITEM
 * --------------------------------------------------------------------------
 */

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

    /*
     * ----------------------------------------------------------------------
     * AUTHORITATIVE ITEM CAPABILITY DISCOVERY
     * ----------------------------------------------------------------------
     */

    const capabilities =
      await discoverItemCapabilities(
        accessToken
      );

    /*
     * ----------------------------------------------------------------------
     * OWNER
     * ----------------------------------------------------------------------
     */

    const userResult =
      await client.query(
        `
          SELECT user_id
          FROM plaid_items
          WHERE id = $1
        `,
        [item.id]
      );

    if (
      !userResult.rows.length
    ) {
      throw new Error(
        'Plaid Item owner not found'
      );
    }

    const userId =
      userResult.rows[0].user_id;

    /*
     * ----------------------------------------------------------------------
     * ACCOUNT MAP
     * ----------------------------------------------------------------------
     */

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

    /*
     * ----------------------------------------------------------------------
     * TRANSACTIONS
     * ----------------------------------------------------------------------
     *
     * Transactions are only synchronized when the Item actually has the
     * Transactions capability.
     */

    let transactionResult = {
      state: 'not_available',
      added: 0,
      modified: 0,
      removed: 0,
      nextCursor:
        item.cursor || null,
    };

    const transactionCapability =
      capabilities.domains
        .transactions;

    if (
      transactionCapability
        .initialized ||
      transactionCapability
        .consented ||
      transactionCapability
        .available
    ) {
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

      let syncedAdded = 0;
      let syncedModified = 0;
      let syncedRemoved = 0;

      /*
       * ADDED
       */
      for (
        const txn
        of added
      ) {
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

      /*
       * MODIFIED
       */
      for (
        const txn
        of modified
      ) {
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

      /*
       * REMOVED
       */
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
       * Cursor is advanced only after every transaction mutation and
       * Round-Up reconciliation has succeeded.
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

      transactionResult = {
        state: 'observed',
        added:
          syncedAdded,
        modified:
          syncedModified,
        removed:
          syncedRemoved,
        nextCursor,
      };
    }

    /*
     * ----------------------------------------------------------------------
     * OTHER DOMAINS
     * ----------------------------------------------------------------------
     *
     * These are intentionally independent.
     *
     * A failure in Identity does not roll back successful transaction
     * synchronization.
     *
     * NOTE:
     * The actual specialized-domain persistence layer must be connected
     * against the real current database schema before those observations
     * are written as canonical financial records.
     */

    const domainResults =
      await synchronizeDomains(
        client,
        accessToken,
        item.id,
        capabilities
      );

    /*
     * ----------------------------------------------------------------------
     * COMMIT
     * ----------------------------------------------------------------------
     *
     * Transactions, balance observations that were matched to existing
     * accounts, and all other safe state changes are committed together.
     *
     * Specialized observations that could not yet be canonically persisted
     * are not fabricated.
     */

    await client.query(
      'COMMIT'
    );

    /*
     * ----------------------------------------------------------------------
     * SUCCESS RECORD
     * ----------------------------------------------------------------------
     */

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
        transactionResult.added,
        transactionResult.modified,
        transactionResult.removed,
        runId,
      ]
    );

    /*
     * ----------------------------------------------------------------------
     * RESULT
     * ----------------------------------------------------------------------
     *
     * This result is deliberately rich.
     *
     * It distinguishes:
     *
     *   capability
     *   observation
     *   failure
     *   specialization
     *
     * without ever converting capability into financial data.
     */

    return {
      plaid_item_id:
        item.plaid_item_id,

      item_id:
        capabilities.item_id,

      institution:
        capabilities.institution_name ||
        null,

      consent_expiration_time:
        capabilities.consent_expiration_time,

      capabilities: {
        products:
          capabilities.products,

        billed_products:
          capabilities.billed_products,

        available_products:
          capabilities.available_products,

        consented_products:
          capabilities.consented_products,

        domains:
          capabilities.domains,
      },

      transactions:
        transactionResult,

      domains:
        domainResults,
    };
  } catch (err) {
    await client.query(
      'ROLLBACK'
    );

    const detail =
      getPlaidErrorMessage(err);

    console.error(
      `Plaid Item ${item.plaid_item_id} sync failed:`,
      err
    );

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

      error_code:
        getPlaidErrorCode(err),
    };
  } finally {
    client.release();
  }
}

/*
 * --------------------------------------------------------------------------
 * RUN ALL ACTIVE PLAID ITEMS
 * --------------------------------------------------------------------------
 */

async function runSync(
  req,
  res
) {
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
        result =>
          result.error
      );

    return res.json({
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

    return res.status(500).json({
      status: 'error',
      message:
        err.message,
    });
  }
}

/*
 * --------------------------------------------------------------------------
 * EXPORTS
 * --------------------------------------------------------------------------
 */

module.exports = {
  runSync,
  syncOneItem,
  fetchTransactionUpdates,
  discoverItemCapabilities,
  synchronizeDomains,
};
