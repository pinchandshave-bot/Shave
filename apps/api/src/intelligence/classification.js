/*
 * iBag Transaction Classification
 *
 * Classification is evidence-gated.
 *
 * IMPORTANT:
 * Positive amount means money leaving the account under iBag's
 * established transaction convention. It does NOT automatically
 * mean economic spending.
 *
 * The classifier uses Plaid's preserved raw transaction payload
 * where available, plus the canonical fields already stored in
 * the transactions table.
 */

const TYPES = Object.freeze({
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

const ECONOMIC_ROLES = Object.freeze({
  ECONOMIC_OUTFLOW: 'ECONOMIC_OUTFLOW',
  ECONOMIC_INFLOW: 'ECONOMIC_INFLOW',
  ACCOUNT_MOVEMENT_ONLY: 'ACCOUNT_MOVEMENT_ONLY',
  NONE: 'NONE',
  UNKNOWN: 'UNKNOWN',
});

function normalize(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value)
    .trim()
    .toUpperCase();
}

function rawObject(transaction) {
  if (!transaction || !transaction.raw) {
    return {};
  }

  if (typeof transaction.raw === 'object') {
    return transaction.raw;
  }

  try {
    return JSON.parse(transaction.raw);
  } catch {
    return {};
  }
}

function getPlaidPrimaryCategory(transaction) {
  const raw = rawObject(transaction);

  return normalize(
    raw.personal_finance_category?.primary ||
      raw.personal_finance_category?.detailed ||
      transaction.category
  );
}

function getPlaidDetailedCategory(transaction) {
  const raw = rawObject(transaction);

  return normalize(
    raw.personal_finance_category?.detailed
  );
}

function getPaymentChannel(transaction) {
  const raw = rawObject(transaction);

  return normalize(
    raw.payment_channel
  );
}

function getTransactionCode(transaction) {
  const raw = rawObject(transaction);

  return normalize(
    raw.transaction_code
  );
}

function getName(transaction) {
  const raw = rawObject(transaction);

  return normalize(
    transaction.merchant_name ||
      raw.merchant_name ||
      raw.name ||
      ''
  );
}

function containsAny(value, terms) {
  const normalized = normalize(value);

  return terms.some(term =>
    normalized.includes(normalize(term))
  );
}

function classifyTransaction(transaction) {
  const amount = Number(transaction?.amount);

  if (!Number.isFinite(amount) || amount === 0) {
    return {
      type: TYPES.UNKNOWN,
      economicRole: ECONOMIC_ROLES.UNKNOWN,
      confidence: 'insufficient',
      evidenceState: 'insufficient',
      reason: 'INVALID_OR_ZERO_AMOUNT',
    };
  }

  const primary = getPlaidPrimaryCategory(transaction);
  const detailed = getPlaidDetailedCategory(transaction);
  const channel = getPaymentChannel(transaction);
  const code = getTransactionCode(transaction);
  const name = getName(transaction);

  /*
   * Plaid transaction categories are treated as evidence,
   * not as absolute truth.
   */

  const transferEvidence =
    primary === 'TRANSFER_IN' ||
    primary === 'TRANSFER_OUT' ||
    detailed.includes('TRANSFER') ||
    code.includes('TRANSFER');

  const incomeEvidence =
    primary === 'INCOME' ||
    detailed.includes('DIRECT_DEPOSIT') ||
    detailed.includes('PAYROLL') ||
    detailed.includes('INCOME');

  const refundEvidence =
    primary === 'INCOME' &&
    (
      detailed.includes('REFUND') ||
      detailed.includes('RETURN')
    );

  const loanEvidence =
    primary === 'LOAN_PAYMENTS' ||
    detailed.includes('LOAN') ||
    detailed.includes('MORTGAGE');

  const feeEvidence =
    primary === 'BANK_FEES' ||
    detailed.includes('FEE');

  const withdrawalEvidence =
    primary === 'CASH_WITHDRAWAL' ||
    detailed.includes('ATM') ||
    channel === 'ATM';

  if (transferEvidence) {
    return {
      type:
        amount > 0
          ? TYPES.TRANSFER_OUT
          : TYPES.TRANSFER_IN,

      economicRole:
        ECONOMIC_ROLES.ACCOUNT_MOVEMENT_ONLY,

      confidence: 'high',
      evidenceState: 'observed',
      reason: 'PLAID_TRANSFER_CLASSIFICATION',
    };
  }

  if (refundEvidence || (
    amount < 0 &&
    containsAny(name, [
      'REFUND',
      'RETURN',
      'REVERSAL',
    ])
  )) {
    return {
      type: TYPES.REFUND,
      economicRole: ECONOMIC_ROLES.ECONOMIC_INFLOW,
      confidence: 'medium',
      evidenceState: 'observed',
      reason: 'REFUND_EVIDENCE',
    };
  }

  if (loanEvidence && amount > 0) {
    return {
      type: TYPES.LOAN_PAYMENT,
      economicRole: ECONOMIC_ROLES.ECONOMIC_OUTFLOW,
      confidence: 'high',
      evidenceState: 'observed',
      reason: 'PLAID_LOAN_CLASSIFICATION',
    };
  }

  if (feeEvidence && amount > 0) {
    return {
      type: TYPES.FEE,
      economicRole: ECONOMIC_ROLES.ECONOMIC_OUTFLOW,
      confidence: 'high',
      evidenceState: 'observed',
      reason: 'PLAID_FEE_CLASSIFICATION',
    };
  }

  if (withdrawalEvidence && amount > 0) {
    return {
      type: TYPES.WITHDRAWAL,
      economicRole: ECONOMIC_ROLES.ACCOUNT_MOVEMENT_ONLY,
      confidence: 'high',
      evidenceState: 'observed',
      reason: 'PLAID_WITHDRAWAL_CLASSIFICATION',
    };
  }

  if (incomeEvidence && amount < 0) {
    return {
      type: TYPES.INCOME,
      economicRole: ECONOMIC_ROLES.ECONOMIC_INFLOW,
      confidence: 'high',
      evidenceState: 'observed',
      reason: 'PLAID_INCOME_CLASSIFICATION',
    };
  }

  /*
   * Purchase requires positive outflow and evidence that it is
   * an ordinary purchase rather than an explicitly classified
   * transfer/loan/fee/withdrawal.
   *
   * We do not promote every positive transaction automatically.
   */
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
    return {
      type: TYPES.PURCHASE,
      economicRole: ECONOMIC_ROLES.ECONOMIC_OUTFLOW,
      confidence: 'high',
      evidenceState: 'observed',
      reason: 'PLAID_PURCHASE_CATEGORY',
    };
  }

  /*
   * A merchant name plus an ordinary positive transaction can
   * provide moderate purchase evidence, but ambiguous transactions
   * remain UNKNOWN.
   */
  if (
    amount > 0 &&
    name &&
    !containsAny(name, [
      'TRANSFER',
      'PAYMENT',
      'LOAN',
      'MORTGAGE',
      'FEE',
      'ATM',
      'WITHDRAWAL',
      'DEPOSIT',
    ])
  ) {
    return {
      type: TYPES.PURCHASE,
      economicRole: ECONOMIC_ROLES.ECONOMIC_OUTFLOW,
      confidence: 'medium',
      evidenceState: 'inferred',
      reason: 'MERCHANT_PURCHASE_PATTERN',
    };
  }

  if (amount < 0) {
    return {
      type: TYPES.UNKNOWN,
      economicRole: ECONOMIC_ROLES.UNKNOWN,
      confidence: 'insufficient',
      evidenceState: 'limited',
      reason: 'UNCLASSIFIED_INCOMING_TRANSACTION',
    };
  }

  return {
    type: TYPES.UNKNOWN,
    economicRole: ECONOMIC_ROLES.UNKNOWN,
    confidence: 'insufficient',
    evidenceState: 'limited',
    reason: 'INSUFFICIENT_CLASSIFICATION_EVIDENCE',
  };
}

function isEligiblePurchaseClassification(classification) {
  return Boolean(
    classification &&
    classification.type === TYPES.PURCHASE &&
    (
      classification.confidence === 'high' ||
      classification.confidence === 'medium'
    )
  );
}

module.exports = {
  TYPES,
  ECONOMIC_ROLES,
  classifyTransaction,
  isEligiblePurchaseClassification,
};
