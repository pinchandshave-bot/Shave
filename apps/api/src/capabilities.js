const {
  getItem,
  getProductCoverage,
  getBalances,
} = require('./plaidClient');

/*
 * iBag Capability Intelligence
 *
 * HARD RULES:
 *
 * - No synthetic data.
 * - No mock data.
 * - No seeded data.
 * - No fabricated financial observations.
 * - No product is considered observed merely because it was requested.
 * - No product is considered available merely because it exists in code.
 * - No zero is substituted for unavailable data.
 *
 * This module evaluates authoritative Plaid state.
 *
 * Capability
 *     != authorization
 *
 * Authorization
 *     != availability
 *
 * Availability
 *     != observation
 *
 * Observation must come from an actual successful data retrieval.
 */

/* -------------------------------------------------------------------------- */
/* CAPABILITY DEFINITIONS                                                     */
/* -------------------------------------------------------------------------- */

const CAPABILITIES = Object.freeze({
  transactions: {
    key: 'transactions',
    plaidProduct: 'transactions',
    intelligenceDomain: 'transactions',
    endpoint: 'transactionsSync',
  },

  auth: {
    key: 'auth',
    plaidProduct: 'auth',
    intelligenceDomain: 'account_access',
    endpoint: 'authGet',
  },

  identity: {
    key: 'identity',
    plaidProduct: 'identity',
    intelligenceDomain: 'identity',
    endpoint: 'identityGet',
  },

  investments: {
    key: 'investments',
    plaidProduct: 'investments',
    intelligenceDomain: 'investments',
    endpoint: 'investmentsHoldingsGet',
  },

  liabilities: {
    key: 'liabilities',
    plaidProduct: 'liabilities',
    intelligenceDomain: 'liabilities',
    endpoint: 'liabilitiesGet',
  },

  assets: {
    key: 'assets',
    plaidProduct: 'assets',
    intelligenceDomain: 'assets',
    endpoint: 'assetReportCreate',
  },

  statements: {
    key: 'statements',
    plaidProduct: 'statements',
    intelligenceDomain: 'statements',
    endpoint: 'statementsList',
  },

  income: {
    key: 'income',
    plaidProduct: 'income',
    intelligenceDomain: 'income',
    endpoint: null,
  },

  recurring_transactions: {
    key: 'recurring_transactions',
    plaidProduct: 'recurring_transactions',
    intelligenceDomain: 'recurring_transactions',
    endpoint: 'transactionsRecurringGet',
  },

  balance: {
    key: 'balance',
    plaidProduct: null,
    intelligenceDomain: 'liquidity',
    endpoint: 'accountsBalanceGet',
  },
});

/* -------------------------------------------------------------------------- */
/* STATES                                                                     */
/* -------------------------------------------------------------------------- */

const CAPABILITY_STATES = Object.freeze({
  NOT_REQUESTED: 'not_requested',
  REQUESTED: 'requested',
  CONSENTED: 'consented',
  AVAILABLE: 'available',
  OBSERVED: 'observed',
  NOT_SUPPORTED: 'not_supported',
  NOT_AUTHORIZED: 'not_authorized',
  CONSENT_REQUIRED: 'consent_required',
  ACCOUNT_INCOMPATIBLE: 'account_incompatible',
  STALE: 'stale',
  TEMPORARILY_UNAVAILABLE: 'temporarily_unavailable',
  ERROR: 'error',
  UNKNOWN: 'unknown',
});

/* -------------------------------------------------------------------------- */
/* ARRAY NORMALIZATION                                                        */
/* -------------------------------------------------------------------------- */

function normalizeArray(value) {
  return Array.isArray(value)
    ? value.map(String)
    : [];
}

/* -------------------------------------------------------------------------- */
/* PRODUCT STATE                                                              */
/* -------------------------------------------------------------------------- */

/*
 * We deliberately keep these states conservative.
 *
 * If Plaid has not explicitly established something,
 * iBag does not upgrade it to a stronger state.
 */

function determineProductState({
  key,
  plaidProduct,
  requested,
  initialized,
  billed,
  available,
  consented,
}) {
  /*
   * Balance is not represented as a Plaid Item product.
   * It requires an actual accountsBalanceGet observation.
   */
  if (!plaidProduct) {
    return {
      state: CAPABILITY_STATES.UNKNOWN,
      reason:
        'Capability is retrieved through a dedicated Plaid endpoint rather than Item product state.',
    };
  }

  const wasRequested =
    requested.includes(plaidProduct);

  const isInitialized =
    initialized.includes(plaidProduct);

  const isBilled =
    billed.includes(plaidProduct);

  const isAvailable =
    available.includes(plaidProduct);

  const isConsented =
    consented.includes(plaidProduct);

  /*
   * Strongest state is intentionally NOT OBSERVED here.
   *
   * Item product metadata does not prove that usable financial
   * observations were actually retrieved.
   */

  if (isInitialized) {
    return {
      state: CAPABILITY_STATES.AVAILABLE,
      reason:
        'Plaid Item reports this product as initialized.',
      requested: wasRequested,
      initialized: true,
      billed: isBilled,
      available: isAvailable,
      consented: isConsented,
    };
  }

  if (isConsented) {
    return {
      state: CAPABILITY_STATES.CONSENTED,
      reason:
        'Plaid reports consent for this product, but initialization has not been established.',
      requested: wasRequested,
      initialized: false,
      billed: isBilled,
      available: isAvailable,
      consented: true,
    };
  }

  if (wasRequested && isAvailable) {
    return {
      state: CAPABILITY_STATES.AVAILABLE,
      reason:
        'The product was requested and Plaid reports it as available.',
      requested: true,
      initialized: false,
      billed: isBilled,
      available: true,
      consented: false,
    };
  }

  if (wasRequested && !isAvailable) {
    return {
      state: CAPABILITY_STATES.NOT_SUPPORTED,
      reason:
        'The product was requested but Plaid does not report it as available for this Item.',
      requested: true,
      initialized: false,
      billed: isBilled,
      available: false,
      consented: false,
    };
  }

  return {
    state: CAPABILITY_STATES.NOT_REQUESTED,
    reason:
      'The product has not been established as requested or initialized for this Item.',
    requested: false,
    initialized: false,
    billed: isBilled,
    available: isAvailable,
    consented: false,
  };
}

/* -------------------------------------------------------------------------- */
/* CAPABILITY EVALUATION                                                      */
/* -------------------------------------------------------------------------- */

function evaluateProductCoverage(coverage) {
  const requested =
    normalizeArray(coverage?.requested);

  const initialized =
    normalizeArray(coverage?.initialized);

  const billed =
    normalizeArray(coverage?.billed);

  const available =
    normalizeArray(coverage?.available);

  const consented =
    normalizeArray(coverage?.consented);

  const result = {};

  for (const [
    key,
    definition,
  ] of Object.entries(CAPABILITIES)) {
    result[key] =
      determineProductState({
        key,
        plaidProduct:
          definition.plaidProduct,
        requested,
        initialized,
        billed,
        available,
        consented,
      });
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* BALANCE OBSERVATION                                                        */
/* -------------------------------------------------------------------------- */

/*
 * Balance is special.
 *
 * We do not say "balance available" simply because an account exists.
 *
 * We make the authoritative Plaid request and only then mark the
 * capability observed.
 */

async function evaluateBalance(accessToken) {
  try {
    const response =
      await getBalances(accessToken);

    const accounts =
      Array.isArray(response?.accounts)
        ? response.accounts
        : [];

    if (accounts.length === 0) {
      return {
        capability: 'balance',
        state:
          CAPABILITY_STATES.AVAILABLE,
        observed: false,
        observation_count: 0,
        reason:
          'Balance endpoint responded successfully, but no account balance observations were returned.',
      };
    }

    return {
      capability: 'balance',
      state:
        CAPABILITY_STATES.OBSERVED,
      observed: true,
      observation_count:
        accounts.length,
      reason:
        'Real account balance observations were returned by Plaid.',
    };
  } catch (error) {
    return {
      capability: 'balance',
      state:
        CAPABILITY_STATES.ERROR,
      observed: false,
      observation_count: 0,
      error: {
        code:
          error?.code ||
          'PLAID_BALANCE_UNKNOWN_ERROR',

        type:
          error?.type ||
          null,

        requestId:
          error?.requestId ||
          null,
      },
      reason:
        'Plaid did not provide a usable balance response.',
    };
  }
}

/* -------------------------------------------------------------------------- */
/* ITEM CAPABILITY SNAPSHOT                                                   */
/* -------------------------------------------------------------------------- */

async function getCapabilitySnapshot({
  accessToken,
  includeBalance = true,
} = {}) {
  if (!accessToken) {
    throw new Error(
      'getCapabilitySnapshot requires accessToken'
    );
  }

  /*
   * Item state is authoritative for product metadata.
   */
  const itemData =
    await getItem(accessToken);

  const item =
    itemData?.item ||
    itemData ||
    {};

  const coverage =
    await getProductCoverage(
      accessToken
    );

  const capabilities =
    evaluateProductCoverage(
      coverage
    );

  /*
   * Preserve the distinction between:
   *
   * - product metadata
   * - actual observations
   *
   * No product is upgraded to OBSERVED here merely because
   * Item metadata says it is initialized.
   */

  let balance = null;

  if (includeBalance) {
    balance =
      await evaluateBalance(
        accessToken
      );

    capabilities.balance =
      balance;
  }

  return {
    item: {
      plaid_item_id:
        item.item_id ||
        null,

      institution_id:
        item.institution_id ||
        null,

      institution_name:
        item.institution_name ||
        null,

      status:
        item.status ||
        null,
    },

    products: {
      requested:
        normalizeArray(
          coverage.requested
        ),

      initialized:
        normalizeArray(
          coverage.initialized
        ),

      billed:
        normalizeArray(
          coverage.billed
        ),

      available:
        normalizeArray(
          coverage.available
        ),

      consented:
        normalizeArray(
          coverage.consented
        ),
    },

    capabilities,

    evaluated_at:
      new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* OBSERVATION UPGRADE                                                        */
/* -------------------------------------------------------------------------- */

/*
 * Synchronization modules should call this function ONLY after a
 * real successful Plaid data response.
 *
 * This function never invents the observation.
 *
 * It simply converts an already-proven observation into an
 * explicit capability state.
 */

function markObserved(
  capability,
  observationCount
) {
  if (
    !CAPABILITIES[capability]
  ) {
    throw new Error(
      `Unknown iBag capability: ${capability}`
    );
  }

  const count =
    Number(observationCount);

  if (
    !Number.isFinite(count) ||
    count < 0
  ) {
    throw new Error(
      'observationCount must be a non-negative finite number'
    );
  }

  if (count === 0) {
    return {
      capability,
      state:
        CAPABILITY_STATES.AVAILABLE,
      observed: false,
      observation_count: 0,
      reason:
        'The capability was queried successfully but produced no observations.',
    };
  }

  return {
    capability,
    state:
      CAPABILITY_STATES.OBSERVED,
    observed: true,
    observation_count: count,
    reason:
      'The capability produced real observations from an authorized Plaid response.',
  };
}

/* -------------------------------------------------------------------------- */
/* EVIDENCE GATE                                                              */
/* -------------------------------------------------------------------------- */

/*
 * Central rule for intelligence consumers.
 *
 * A capability may only contribute observed evidence when:
 *
 *     state === OBSERVED
 *
 * Everything else remains metadata/capability information.
 */

function isObserved(capabilityState) {
  return (
    capabilityState?.state ===
    CAPABILITY_STATES.OBSERVED
  );
}

function canSupportFinancialInference(
  capabilityState
) {
  return isObserved(
    capabilityState
  );
}

/* -------------------------------------------------------------------------- */
/* SUMMARY                                                                    */
/* -------------------------------------------------------------------------- */

function summarizeCapabilities(
  capabilities
) {
  const summary = {
    observed: [],
    available: [],
    consented: [],
    unsupported: [],
    unavailable: [],
    unknown: [],
  };

  for (const [
    key,
    value,
  ] of Object.entries(
    capabilities || {}
  )) {
    switch (value?.state) {
      case CAPABILITY_STATES.OBSERVED:
        summary.observed.push(key);
        break;

      case CAPABILITY_STATES.AVAILABLE:
        summary.available.push(key);
        break;

      case CAPABILITY_STATES.CONSENTED:
        summary.consented.push(key);
        break;

      case CAPABILITY_STATES.NOT_SUPPORTED:
      case CAPABILITY_STATES.ACCOUNT_INCOMPATIBLE:
        summary.unsupported.push(key);
        break;

      case CAPABILITY_STATES.NOT_AUTHORIZED:
      case CAPABILITY_STATES.CONSENT_REQUIRED:
        summary.unavailable.push(key);
        break;

      default:
        summary.unknown.push(key);
        break;
    }
  }

  return summary;
}

/* -------------------------------------------------------------------------- */
/* EXPORTS                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  CAPABILITIES,
  CAPABILITY_STATES,

  evaluateProductCoverage,

  evaluateBalance,

  getCapabilitySnapshot,

  markObserved,

  isObserved,

  canSupportFinancialInference,

  summarizeCapabilities,
};
