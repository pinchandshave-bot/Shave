/*
 * ============================================================================
 * iBag Transaction Classification
 * ============================================================================
 *
 * AUTHORITATIVE CLASSIFICATION CONTRACT
 *
 * Canonical output:
 *
 * {
 *   type,
 *   economic_role,
 *   confidence,
 *   evidence_state,
 *   reason
 * }
 *
 * PHASE 1 RULES
 * -------------
 * - Classification uses real authorized transaction evidence.
 * - Plaid classifications are evidence, not unquestionable truth.
 * - Account movement is not automatically economic activity.
 * - Unknown remains unknown.
 * - No financial conclusion is fabricated.
 *
 * TRANSACTION CONVENTION
 * ----------------------
 * Positive amount:
 *   Money leaving the account.
 *
 * Negative amount:
 *   Money entering the account.
 *
 * This convention is preserved throughout iBag.
 */


/* ============================================================================
 * CLASSIFICATIONS
 * ========================================================================== */

const CLASSIFICATIONS = Object.freeze({
  PURCHASE: 'PURCHASE',
  TRANSFER_IN: 'TRANSFER_IN',
  TRANSFER_OUT: 'TRANSFER_OUT',
  INCOME: 'INCOME',
  REFUND: 'REFUND',
  LOAN_PAYMENT: 'LOAN_PAYMENT',
  FEE: 'FEE',
  WITHDRAWAL: 'WITHDRAWAL',
  UNKNOWN: 'UNKNOWN',
});


/* ============================================================================
 * ECONOMIC ROLES
 * ========================================================================== */

const ECONOMIC_ROLES = Object.freeze({
  ECONOMIC_OUTFLOW: 'ECONOMIC_OUTFLOW',
  ECONOMIC_INFLOW: 'ECONOMIC_INFLOW',
  ACCOUNT_MOVEMENT_ONLY: 'ACCOUNT_MOVEMENT_ONLY',
  NONE: 'NONE',
  UNKNOWN: 'UNKNOWN',
});


/* ============================================================================
 * NORMALIZATION
 * ========================================================================== */

function normalize(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return '';
  }

  return String(value)
    .trim()
    .toUpperCase();
}


/* ============================================================================
 * RAW PLAID PAYLOAD
 * ========================================================================== */

function rawObject(transaction) {
  if (
    !transaction ||
    transaction.raw === null ||
    transaction.raw === undefined
  ) {
    return {};
  }

  if (
    typeof transaction.raw === 'object'
  ) {
    return transaction.raw;
  }

  try {
    return JSON.parse(
      transaction.raw
    );
  } catch {
    return {};
  }
}


/* ============================================================================
 * PLAID EVIDENCE EXTRACTION
 * ========================================================================== */

function getPlaidPrimaryCategory(
  transaction
) {
  const raw =
    rawObject(transaction);

  return normalize(
    raw.personal_finance_category
      ?.primary ||
      transaction.category
  );
}


function getPlaidDetailedCategory(
  transaction
) {
  const raw =
    rawObject(transaction);

  return normalize(
    raw.personal_finance_category
      ?.detailed
  );
}


function getPaymentChannel(
  transaction
) {
  const raw =
    rawObject(transaction);

  return normalize(
    raw.payment_channel
  );
}


function getTransactionCode(
  transaction
) {
  const raw =
    rawObject(transaction);

  return normalize(
    raw.transaction_code
  );
}


function getName(transaction) {
  const raw =
    rawObject(transaction);

  return normalize(
    transaction.merchant_name ||
    raw.merchant_name ||
    raw.name ||
    ''
  );
}


/* ============================================================================
 * STRING EVIDENCE
 * ========================================================================== */

function containsAny(
  value,
  terms
) {
  const normalized =
    normalize(value);

  return terms.some(
    term =>
      normalized.includes(
        normalize(term)
      )
  );
}


/* ============================================================================
 * CLASSIFICATION RESULT
 * ========================================================================== */

function result({
  type,
  economicRole,
  confidence,
  evidenceState,
  reason,
}) {
  return {
    type,

    economic_role:
      economicRole,

    confidence,

    evidence_state:
      evidenceState,

    reason,
  };
}


/* ============================================================================
 * CLASSIFIER
 * ========================================================================== */

function classifyTransaction(
  transaction
) {
  const amount =
    Number(transaction?.amount);

  if (
    !Number.isFinite(amount) ||
    amount === 0
  ) {
    return result({
      type:
        CLASSIFICATIONS.UNKNOWN,

      economicRole:
        ECONOMIC_ROLES.UNKNOWN,

      confidence:
        'insufficient',

      evidenceState:
        'insufficient_evidence',

      reason:
        'INVALID_OR_ZERO_AMOUNT',
    });
  }

  const primary =
    getPlaidPrimaryCategory(
      transaction
    );

  const detailed =
    getPlaidDetailedCategory(
      transaction
    );

  const channel =
    getPaymentChannel(
      transaction
    );

  const code =
    getTransactionCode(
      transaction
    );

  const name =
    getName(transaction);


  /* --------------------------------------------------------------------------
   * TRANSFER
   * ------------------------------------------------------------------------ */

  const transferEvidence =
    primary === 'TRANSFER_IN' ||
    primary === 'TRANSFER_OUT' ||
    detailed.includes('TRANSFER') ||
    code.includes('TRANSFER');

  if (transferEvidence) {
    return result({
      type:
        amount > 0
          ? CLASSIFICATIONS.TRANSFER_OUT
          : CLASSIFICATIONS.TRANSFER_IN,

      economicRole:
        ECONOMIC_ROLES.ACCOUNT_MOVEMENT_ONLY,

      confidence:
        'high',

      evidenceState:
        'observed',

      reason:
        'PLAID_TRANSFER_CLASSIFICATION',
    });
  }


  /* --------------------------------------------------------------------------
   * REFUND
   * ------------------------------------------------------------------------ */

  const refundEvidence =
    (
      primary === 'INCOME' &&
      (
        detailed.includes('REFUND') ||
        detailed.includes('RETURN')
      )
    ) ||
    (
      amount < 0 &&
      containsAny(
        name,
        [
          'REFUND',
          'RETURN',
          'REVERSAL',
        ]
      )
    );

  if (refundEvidence) {
    return result({
      type:
        CLASSIFICATIONS.REFUND,

      economicRole:
        ECONOMIC_ROLES.ECONOMIC_INFLOW,

      confidence:
        'medium',

      evidenceState:
        'observed',

      reason:
        'REFUND_EVIDENCE',
    });
  }


  /* --------------------------------------------------------------------------
   * LOAN PAYMENT
   * ------------------------------------------------------------------------ */

  const loanEvidence =
    primary === 'LOAN_PAYMENTS' ||
    detailed.includes('LOAN') ||
    detailed.includes('MORTGAGE');

  if (
    loanEvidence &&
    amount > 0
  ) {
    return result({
      type:
        CLASSIFICATIONS.LOAN_PAYMENT,

      economicRole:
        ECONOMIC_ROLES.ECONOMIC_OUTFLOW,

      confidence:
        'high',

      evidenceState:
        'observed',

      reason:
        'PLAID_LOAN_CLASSIFICATION',
    });
  }


  /* --------------------------------------------------------------------------
   * BANK FEE
   * ------------------------------------------------------------------------ */

  const feeEvidence =
    primary === 'BANK_FEES' ||
    detailed.includes('FEE');

  if (
    feeEvidence &&
    amount > 0
  ) {
    return result({
      type:
        CLASSIFICATIONS.FEE,

      economicRole:
        ECONOMIC_ROLES.ECONOMIC_OUTFLOW,

      confidence:
        'high',

      evidenceState:
        'observed',

      reason:
        'PLAID_FEE_CLASSIFICATION',
    });
  }


  /* --------------------------------------------------------------------------
   * CASH WITHDRAWAL
   * ------------------------------------------------------------------------ */

  const withdrawalEvidence =
    primary === 'CASH_WITHDRAWAL' ||
    detailed.includes('ATM') ||
    channel === 'ATM';

  if (
    withdrawalEvidence &&
    amount > 0
  ) {
    return result({
      type:
        CLASSIFICATIONS.WITHDRAWAL,

      economicRole:
        ECONOMIC_ROLES.ACCOUNT_MOVEMENT_ONLY,

      confidence:
        'high',

      evidenceState:
        'observed',

      reason:
        'PLAID_WITHDRAWAL_CLASSIFICATION',
    });
  }


  /* --------------------------------------------------------------------------
   * INCOME
   * ------------------------------------------------------------------------ */

  const incomeEvidence =
    primary === 'INCOME' ||
    detailed.includes('DIRECT_DEPOSIT') ||
    detailed.includes('PAYROLL') ||
    detailed.includes('INCOME');

  if (
    incomeEvidence &&
    amount < 0
  ) {
    return result({
      type:
        CLASSIFICATIONS.INCOME,

      economicRole:
        ECONOMIC_ROLES.ECONOMIC_INFLOW,

      confidence:
        'high',

      evidenceState:
        'observed',

      reason:
        'PLAID_INCOME_CLASSIFICATION',
    });
  }


  /* --------------------------------------------------------------------------
   * PURCHASE — STRONG PLAID CATEGORY
   * ------------------------------------------------------------------------ */

  if (
    amount > 0 &&
    (
      primary === 'GENERAL_MERCHANDISE' ||
      primary === 'FOOD_AND_DRINK' ||
      primary === 'TRANSPORTATION' ||
      primary === 'TRAVEL' ||
      primary === 'ENTERTAINMENT' ||
      primary === 'PERSONAL_CARE' ||
      primary === 'GENERAL_SERVICES' ||
      primary === 'MEDICAL' ||
      primary === 'RENT_AND_UTILITIES'
    )
  ) {
    return result({
      type:
        CLASSIFICATIONS.PURCHASE,

      economicRole:
        ECONOMIC_ROLES.ECONOMIC_OUTFLOW,

      confidence:
        'high',

      evidenceState:
        'observed',

      reason:
        'PLAID_PURCHASE_CATEGORY',
    });
  }


  /* --------------------------------------------------------------------------
   * PURCHASE — MODERATE MERCHANT EVIDENCE
   * ------------------------------------------------------------------------ */

  if (
    amount > 0 &&
    name &&
    !containsAny(
      name,
      [
        'TRANSFER',
        'PAYMENT',
        'LOAN',
        'MORTGAGE',
        'FEE',
        'ATM',
        'WITHDRAWAL',
        'DEPOSIT',
      ]
    )
  ) {
    return result({
      type:
        CLASSIFICATIONS.PURCHASE,

      economicRole:
        ECONOMIC_ROLES.ECONOMIC_OUTFLOW,

      confidence:
        'medium',

      evidenceState:
        'inferred',

      reason:
        'MERCHANT_PURCHASE_PATTERN',
    });
  }


  /* --------------------------------------------------------------------------
   * UNKNOWN INCOMING MONEY
   * ------------------------------------------------------------------------ */

  if (amount < 0) {
    return result({
      type:
        CLASSIFICATIONS.UNKNOWN,

      economicRole:
        ECONOMIC_ROLES.UNKNOWN,

      confidence:
        'insufficient',

      evidenceState:
        'limited',

      reason:
        'UNCLASSIFIED_INCOMING_TRANSACTION',
    });
  }


  /* --------------------------------------------------------------------------
   * UNKNOWN OUTGOING MONEY
   * ------------------------------------------------------------------------ */

  return result({
    type:
      CLASSIFICATIONS.UNKNOWN,

    economicRole:
      ECONOMIC_ROLES.UNKNOWN,

    confidence:
      'insufficient',

    evidenceState:
      'limited',

    reason:
      'INSUFFICIENT_CLASSIFICATION_EVIDENCE',
  });
}


/* ============================================================================
 * ROUND-UP ELIGIBILITY
 * ========================================================================== */

function isEligiblePurchaseClassification(
  classification
) {
  return Boolean(
    classification &&
    classification.type ===
      CLASSIFICATIONS.PURCHASE &&
    (
      classification.confidence ===
        'high' ||
      classification.confidence ===
        'medium'
    )
  );
}


/* ============================================================================
 * ECONOMIC ROLE HELPERS
 * ========================================================================== */

function isEconomicInflow(
  classification
) {
  return Boolean(
    classification &&
    classification.economic_role ===
      ECONOMIC_ROLES.ECONOMIC_INFLOW
  );
}


function isEconomicOutflow(
  classification
) {
  return Boolean(
    classification &&
    classification.economic_role ===
      ECONOMIC_ROLES.ECONOMIC_OUTFLOW
  );
}


function isAccountMovementOnly(
  classification
) {
  return Boolean(
    classification &&
    classification.economic_role ===
      ECONOMIC_ROLES.ACCOUNT_MOVEMENT_ONLY
  );
}


function isUnknownClassification(
  classification
) {
  return Boolean(
    !classification ||
    classification.type ===
      CLASSIFICATIONS.UNKNOWN ||
    classification.economic_role ===
      ECONOMIC_ROLES.UNKNOWN
  );
}


/* ============================================================================
 * EXPORT
 * ========================================================================== */

module.exports = {
  CLASSIFICATIONS,
  ECONOMIC_ROLES,

  classifyTransaction,

  isEligiblePurchaseClassification,

  isEconomicInflow,
  isEconomicOutflow,
  isAccountMovementOnly,
  isUnknownClassification,
};
