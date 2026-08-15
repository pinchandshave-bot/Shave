const pool = require('./db');

const {
  getItem,
  getAuth,
  getBalances,
  getIdentity,
  getLiabilities,
  getInvestments,
  getStatements,
  createAssetReport,
  getAssetReport,
} = require('./plaidClient');

/*
 * iBag Product Orchestrator
 *
 * This file does NOT manufacture product availability.
 *
 * Product configuration != product availability.
 * Product availability != observed data.
 * Observed data != intelligence conclusion.
 *
 * Every stage remains evidence-gated.
 *
 * Phase 1:
 * - Read-only
 * - No money movement
 * - Real authorized data only
 * - No synthetic/mock/seeded/fabricated data
 */

const PRODUCT_DOMAINS = Object.freeze([
  'transactions',
  'balance',
  'auth',
  'identity',
  'investments',
  'liabilities',
  'income',
  'assets',
  'recurring_transactions',
  'statements',
]);

const PRODUCT_STATUS = Object.freeze({
  NOT_AUTHORIZED: 'not_authorized',
  AUTHORIZED: 'authorized',
  AVAILABLE: 'available',
  OBSERVED: 'observed',
  EMPTY: 'empty',
  UNSUPPORTED: 'unsupported',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error',
});

function array(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function makeDomainState(domain) {
  return {
    domain,
    status: PRODUCT_STATUS.NOT_AUTHORIZED,
    authorized: false,
    available: false,
    observed: false,
    evidence: [],
    observation: null,
    error: null,
  };
}

/*
 * --------------------------------------------------------------------------
 * ITEM CAPABILITY STATE
 * --------------------------------------------------------------------------
 */

async function inspectItem(accessToken) {
  const itemData = await getItem(accessToken);

  const item =
    itemData?.item ||
    itemData ||
    {};

  return {
    item,

    products:
      array(item.products),

    billedProducts:
      array(item.billed_products),

    availableProducts:
      array(item.available_products),

    consentedProducts:
      array(item.consented_products),

    consentedDataScopes:
      array(item.consented_data_scopes),
  };
}


/*
 * --------------------------------------------------------------------------
 * AUTHORITATIVE PRODUCT STATE
 * --------------------------------------------------------------------------
 *
 * This does NOT say that data exists.
 *
 * It only establishes what Plaid says the Item can access.
 */

function buildCapabilityState(itemState) {
  const {
    products,
    billedProducts,
    availableProducts,
    consentedProducts,
  } = itemState;

  const states = {};

  for (const domain of PRODUCT_DOMAINS) {
    states[domain] =
      makeDomainState(domain);
  }

  /*
   * Transactions
   */
  states.transactions.authorized =
    products.includes('transactions') ||
    consentedProducts.includes('transactions');

  states.transactions.available =
    products.includes('transactions') ||
    availableProducts.includes('transactions');

  /*
   * Balance is special.
   *
   * Plaid does not require Balance initialization.
   */
  states.balance.authorized = true;
  states.balance.available = true;

  /*
   * Auth
   */
  states.auth.authorized =
    products.includes('auth') ||
    consentedProducts.includes('auth');

  states.auth.available =
    products.includes('auth') ||
    availableProducts.includes('auth');

  /*
   * Identity
   */
  states.identity.authorized =
    products.includes('identity') ||
    consentedProducts.includes('identity');

  states.identity.available =
    products.includes('identity') ||
    availableProducts.includes('identity');

  /*
   * Investments
   */
  states.investments.authorized =
    products.includes('investments') ||
    consentedProducts.includes('investments');

  states.investments.available =
    products.includes('investments') ||
    availableProducts.includes('investments');

  /*
   * Liabilities
   */
  states.liabilities.authorized =
    products.includes('liabilities') ||
    consentedProducts.includes('liabilities');

  states.liabilities.available =
    products.includes('liabilities') ||
    availableProducts.includes('liabilities');

  /*
   * Assets
   *
   * Asset Reports have a specialized lifecycle.
   */
  states.assets.authorized =
    products.includes('assets') ||
    consentedProducts.includes('assets');

  states.assets.available =
    products.includes('assets') ||
    availableProducts.includes('assets');

  /*
   * Statements
   */
  states.statements.authorized =
    products.includes('statements') ||
    consentedProducts.includes('statements');

  states.statements.available =
    products.includes('statements') ||
    availableProducts.includes('statements');

  /*
   * Income
   *
   * Income has product-specific workflows.
   * Do not infer availability from an invented incomeGet endpoint.
   */
  states.income.authorized =
    products.includes('income_verification') ||
    consentedProducts.includes('income_verification');

  states.income.available =
    products.includes('income_verification') ||
    availableProducts.includes('income_verification');

  /*
   * Recurring Transactions is an add-on to Transactions.
   *
   * We therefore distinguish:
   *
   * transaction capability
   * from
   * recurring intelligence actually observed.
   */
  states.recurring_transactions.authorized =
    states.transactions.authorized;

  states.recurring_transactions.available =
    states.transactions.available;

  /*
   * Resolve generic statuses.
   */
  for (const domain of PRODUCT_DOMAINS) {
    const state = states[domain];

    if (!state.authorized) {
      state.status =
        PRODUCT_STATUS.NOT_AUTHORIZED;
    } else if (!state.available) {
      state.status =
        PRODUCT_STATUS.UNAVAILABLE;
    } else {
      state.status =
        PRODUCT_STATUS.AVAILABLE;
    }

    state.evidence.push({
      type: 'plaid_item_capability',
      source: 'plaid_item',
      authorized:
        state.authorized,
      available:
        state.available,
    });
  }

  return states;
}


/*
 * --------------------------------------------------------------------------
 * DATABASE OBSERVATION
 * --------------------------------------------------------------------------
 *
 * This is where "available" becomes "observed".
 *
 * We NEVER turn missing data into zero.
 */

async function inspectObservedData(
  userId,
  states
) {
  /*
   * Transactions
   */
  const transactionResult =
    await pool.query(
      `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (
            WHERE pending = false
          )::int AS posted,
          COUNT(*) FILTER (
            WHERE pending = true
          )::int AS pending
        FROM transactions t
        INNER JOIN accounts a
          ON a.id = t.account_id
        INNER JOIN plaid_items p
          ON p.id = a.plaid_item_id
        WHERE p.user_id = $1
          AND p.status = 'active'
          AND t.status = 'active'
      `,
      [userId]
    );

  const transactionStats =
    transactionResult.rows[0];

  if (
    states.transactions.available
  ) {
    const total =
      Number(transactionStats.total);

    states.transactions.observed =
      total > 0;

    states.transactions.observation = {
      transaction_count: total,
      posted_transaction_count:
        Number(transactionStats.posted),
      pending_transaction_count:
        Number(transactionStats.pending),
    };

    states.transactions.status =
      total > 0
        ? PRODUCT_STATUS.OBSERVED
        : PRODUCT_STATUS.EMPTY;

    states.transactions.evidence.push({
      type: 'database_observation',
      source: 'transactions',
      count: total,
    });
  }


  /*
   * Accounts / Balance
   */
  const accountResult =
    await pool.query(
      `
        SELECT
          COUNT(*)::int AS account_count,
          COUNT(*) FILTER (
            WHERE a.current_balance IS NOT NULL
          )::int AS accounts_with_current_balance
        FROM accounts a
        INNER JOIN plaid_items p
          ON p.id = a.plaid_item_id
        WHERE p.user_id = $1
          AND p.status = 'active'
      `,
      [userId]
    );

  const accountStats =
    accountResult.rows[0];

  const accountCount =
    Number(accountStats.account_count);

  if (accountCount > 0) {
    states.balance.observed = true;
    states.balance.status =
      PRODUCT_STATUS.OBSERVED;

    states.balance.observation = {
      account_count: accountCount,
      accounts_with_current_balance:
        Number(
          accountStats
            .accounts_with_current_balance
        ),
    };

    states.balance.evidence.push({
      type: 'database_observation',
      source: 'accounts',
      count: accountCount,
    });
  } else {
    states.balance.status =
      PRODUCT_STATUS.EMPTY;
  }


  /*
   * Auth
   *
   * Auth data belongs to its own canonical layer.
   * We intentionally do not treat the existence of an Item
   * as proof that Auth data was successfully observed.
   */
  if (states.auth.available) {
    const result =
      await pool.query(
        `
          SELECT COUNT(*)::int AS count
          FROM account_auth
          WHERE user_id = $1
        `,
        [userId]
      ).catch(() => ({
        rows: [{ count: 0 }],
      }));

    const count =
      Number(result.rows[0].count);

    if (count > 0) {
      states.auth.observed = true;
      states.auth.status =
        PRODUCT_STATUS.OBSERVED;
      states.auth.observation = {
        record_count: count,
      };
    } else {
      states.auth.status =
        PRODUCT_STATUS.EMPTY;
    }
  }


  /*
   * The remaining domains deliberately use
   * capability state until their canonical storage
   * tables are confirmed.
   *
   * We do NOT manufacture "0".
   */
  return states;
}


/*
 * --------------------------------------------------------------------------
 * DOMAIN FETCHERS
 * --------------------------------------------------------------------------
 *
 * These functions retrieve live Plaid data when explicitly requested.
 *
 * They are intentionally separate from capability inspection.
 */

async function fetchDomain(
  accessToken,
  domain
) {
  switch (domain) {
    case 'auth':
      return getAuth(accessToken);

    case 'balance':
      return getBalances(accessToken);

    case 'identity':
      return getIdentity(accessToken);

    case 'liabilities':
      return getLiabilities(accessToken);

    case 'investments':
      return getInvestments(accessToken);

    case 'statements':
      return getStatements(accessToken);

    default:
      throw new Error(
        `No direct fetch workflow defined for domain: ${domain}`
      );
  }
}


/*
 * --------------------------------------------------------------------------
 * FULL ITEM INTELLIGENCE STATE
 * --------------------------------------------------------------------------
 */

async function inspectItemCapabilities({
  userId,
  accessToken,
} = {}) {
  if (!userId) {
    throw new Error(
      'inspectItemCapabilities requires userId'
    );
  }

  if (!accessToken) {
    throw new Error(
      'inspectItemCapabilities requires accessToken'
    );
  }

  const itemState =
    await inspectItem(accessToken);

  const domains =
    buildCapabilityState(
      itemState
    );

  const observed =
    await inspectObservedData(
      userId,
      domains
    );

  return {
    item: {
      plaid_item_id:
        itemState.item.item_id ||
        null,

      institution_id:
        itemState.item.institution_id ||
        null,

      institution_name:
        itemState.item.institution_name ||
        null,

      consent_expiration_time:
        itemState.item
          .consent_expiration_time ||
        null,
    },

    plaid: {
      initialized_products:
        itemState.products,

      billed_products:
        itemState.billedProducts,

      available_products:
        itemState.availableProducts,

      consented_products:
        itemState.consentedProducts,

      consented_data_scopes:
        itemState.consentedDataScopes,
    },

    domains: observed,
  };
}


/*
 * --------------------------------------------------------------------------
 * USER-LEVEL PRODUCT MATRIX
 * --------------------------------------------------------------------------
 *
 * Multiple Items are intentionally supported.
 *
 * iBag's intelligence must operate across the user's
 * entire authorized financial graph, not merely one Item.
 */

async function getUserProductMatrix(
  userId
) {
  const itemsResult =
    await pool.query(
      `
        SELECT
          id,
          plaid_item_id,
          plaid_access_token_encrypted,
          status
        FROM plaid_items
        WHERE user_id = $1
          AND status = 'active'
        ORDER BY created_at ASC
      `,
      [userId]
    );

  const matrix = [];

  for (
    const item
    of itemsResult.rows
  ) {
    /*
     * Decryption is intentionally local.
     */
    const {
      decrypt,
    } = require('./crypto');

    try {
      const accessToken =
        decrypt(
          item.plaid_access_token_encrypted
        );

      const state =
        await inspectItemCapabilities({
          userId,
          accessToken,
        });

      matrix.push(state);
    } catch (error) {
      matrix.push({
        item: {
          plaid_item_id:
            item.plaid_item_id,
        },

        error: {
          code:
            error.code ||
            'PRODUCT_MATRIX_ITEM_FAILED',

          message:
            error.message,
        },

        domains: {},
      });
    }
  }

  return matrix;
}


/*
 * --------------------------------------------------------------------------
 * COMBINATION CAPABILITY
 * --------------------------------------------------------------------------
 *
 * This answers:
 *
 * "What intelligence combinations are actually supportable
 * from the user's current evidence?"
 *
 * It does NOT claim that an intelligence conclusion exists.
 */

function deriveCombinationCapabilities(
  matrix
) {
  const combined = {};

  const hasObserved =
    domain =>
      matrix.some(
        item =>
          item.domains?.[domain]
            ?.status ===
          PRODUCT_STATUS.OBSERVED
      );

  const hasCapability =
    domain =>
      matrix.some(
        item =>
          item.domains?.[domain]
            ?.available === true
      );

  combined.cash_flow =
    hasObserved('transactions') &&
    hasObserved('balance');

  combined.income_analysis =
    hasObserved('transactions') &&
    (
      hasObserved('income') ||
      hasCapability('income')
    );

  combined.recurring_analysis =
    hasObserved('transactions');

  combined.debt_analysis =
    hasObserved('transactions') &&
    hasObserved('liabilities');

  combined.investment_analysis =
    hasObserved('transactions') &&
    hasObserved('investments');

  combined.balance_sheet =
    (
      hasObserved('balance') ||
      hasObserved('assets')
    ) &&
    hasObserved('liabilities');

  combined.roundup_analysis =
    hasObserved('transactions');

  return combined;
}


/*
 * --------------------------------------------------------------------------
 * EXPORTS
 * --------------------------------------------------------------------------
 */

module.exports = {
  PRODUCT_DOMAINS,
  PRODUCT_STATUS,

  inspectItem,
  buildCapabilityState,
  inspectObservedData,

  fetchDomain,

  inspectItemCapabilities,
  getUserProductMatrix,

  deriveCombinationCapabilities,
};
