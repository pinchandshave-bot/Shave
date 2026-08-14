/*
 * iBag Transaction Classification
 *
 * Classification is deliberately separate from transaction polarity.
 *
 * Positive amount  = account outflow
 * Negative amount  = account inflow
 *
 * That does NOT mean:
 * positive = economic spending
 * negative = income
 *
 * Classification determines the economic meaning.
 */

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

const ECONOMIC_ROLES = Object.freeze({
  SPENDING: 'SPENDING',
  INCOME: 'INCOME',
  TRANSFER: 'TRANSFER',
  REFUND: 'REFUND',
  FEE: 'FEE',
  LOAN_PAYMENT: 'LOAN_PAYMENT',
  WITHDRAWAL: 'WITHDRAWAL',
  UNKNOWN: 'UNKNOWN',
});

function normalize(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function getRaw(transaction) {
  if (!transaction) return {};

  if (transaction.raw && typeof transaction.raw === 'object') {
    return transaction.raw;
  }

  if (typeof transaction.raw === 'string') {
    try {
      return JSON.parse(transaction.raw);
    } catch (_) {
      return {};
    }
  }

  return {};
}

function getPlaidCategory(transaction) {
  const raw = getRaw(transaction);

  const primary =
    raw.personal_finance_category?.primary ||
    raw.personal_finance_category?.detailed ||
    transaction.category ||
    '';

  return normalize(primary);
}

function getMerchant(transaction) {
  return normalize(
    transaction.merchant_name ||
    getRaw(transaction).merchant_name ||
    ''
  );
}

function isRefund(transaction) {
  const raw = getRaw(transaction);
  const category = getPlaidCategory(transaction);
  const merchant = getMerchant(transaction);

  return (
    category.includes('REFUND') ||
    category.includes('RETURN') ||
    merchant.includes('REFUND') ||
    merchant.includes('RETURN')
  );
}

function isFee(transaction) {
  const category = getPlaidCategory(transaction);
  const merchant = getMerchant(transaction);

  return (
    category.includes('FEE') ||
    category.includes('BANK_FEE') ||
    merchant.includes('FEE')
  );
}

function isLoanPayment(transaction) {
  const category = getPlaidCategory(transaction);
  const raw = getRaw(transaction);

  const detailed =
    normalize(
      raw.personal_finance_category?.detailed
    );

  return (
    category.includes('LOAN') ||
    category.includes('DEBT') ||
    detailed.includes('LOAN') ||
    detailed.includes('DEBT')
  );
}

function isTransfer(transaction) {
  const raw = getRaw(transaction);

  const category = getPlaidCategory(transaction);
  const detailed = normalize(
    raw.personal_finance_category?.detailed
  );

  return (
    category.includes('TRANSFER') ||
    detailed.includes('TRANSFER') ||
    Boolean(transaction.pending_transaction_id &&
      (
        category.includes('TRANSFER')
      ))
  );
}

function isWithdrawal(transaction) {
  const category = getPlaidCategory(transaction);
  const merchant = getMerchant(transaction);

  return (
    category.includes('CASH_WITHDRAWAL') ||
    category.includes('ATM') ||
    merchant.includes('ATM')
  );
}

function isClearlyIncome(transaction) {
  const raw = getRaw(transaction);
  const category = getPlaidCategory(transaction);
  const detailed = normalize(
    raw.personal_finance_category?.detailed
  );

  return (
    category.includes('INCOME') ||
    detailed.includes('INCOME') ||
    category.includes('PAYROLL') ||
    detailed.includes('PAYROLL')
  );
}

function classifyTransaction(transaction) {
  const amount = Number(transaction?.amount);

  if (!Number.isFinite(amount) || amount === 0) {
    return {
      classification: CLASSIFICATIONS.UNKNOWN,
      economic_role: ECONOMIC_ROLES.UNKNOWN,
      confidence: 'insufficient',
      reason: 'INVALID_OR_ZERO_AMOUNT',
      evidence: [],
    };
  }

  const incoming = amount < 0;

  if (isRefund(transaction)) {
    return {
      classification: CLASSIFICATIONS.REFUND,
      economic_role: ECONOMIC_ROLES.REFUND,
      confidence: 'high',
      reason: 'REFUND_EVIDENCE',
      evidence: ['transaction_category_or_merchant'],
    };
  }

  if (isFee(transaction)) {
    return {
      classification: CLASSIFICATIONS.FEE,
      economic_role: ECONOMIC_ROLES.FEE,
      confidence: 'high',
      reason: 'FEE_EVIDENCE',
      evidence: ['transaction_category_or_merchant'],
    };
  }

  if (isTransfer(transaction)) {
    return {
      classification: incoming
        ? CLASSIFICATIONS.TRANSFER_IN
        : CLASSIFICATIONS.TRANSFER_OUT,
      economic_role: ECONOMIC_ROLES.TRANSFER,
      confidence: 'high',
      reason: 'TRANSFER_EVIDENCE',
      evidence: ['plaid_transfer_category'],
    };
  }

  if (isWithdrawal(transaction)) {
    return {
      classification: CLASSIFICATIONS.WITHDRAWAL,
      economic_role: ECONOMIC_ROLES.WITHDRAWAL,
      confidence: 'high',
      reason: 'ATM_OR_CASH_WITHDRAWAL_EVIDENCE',
      evidence: ['transaction_category_or_merchant'],
    };
  }

  if (isLoanPayment(transaction)) {
    return {
      classification: CLASSIFICATIONS.LOAN_PAYMENT,
      economic_role: ECONOMIC_ROLES.LOAN_PAYMENT,
      confidence: 'medium',
      reason: 'LOAN_OR_DEBT_CATEGORY',
      evidence: ['transaction_category'],
    };
  }

  if (incoming && isClearlyIncome(transaction)) {
    return {
      classification: CLASSIFICATIONS.INCOME,
      economic_role: ECONOMIC_ROLES.INCOME,
      confidence: 'high',
      reason: 'PLAID_INCOME_CATEGORY',
      evidence: ['plaid_income_category'],
    };
  }

  if (!incoming) {
    return {
      classification: CLASSIFICATIONS.PURCHASE,
      economic_role: ECONOMIC_ROLES.SPENDING,
      confidence: 'medium',
      reason: 'POSITIVE_NON_TRANSFER_TRANSACTION',
      evidence: ['transaction_polarity', 'absence_of_exclusion_category'],
    };
  }

  /*
   * Incoming money that is not explicitly identified as income
   * must remain unclassified.
   */
  return {
    classification: CLASSIFICATIONS.UNKNOWN,
    economic_role: ECONOMIC_ROLES.UNKNOWN,
    confidence: 'insufficient',
    reason: 'INCOMING_MONEY_NOT_CLASSIFIED_AS_INCOME',
    evidence: ['transaction_polarity'],
  };
}

function isEligiblePurchase(transaction) {
  const result = classifyTransaction(transaction);

  return (
    result.classification === CLASSIFICATIONS.PURCHASE &&
    result.economic_role === ECONOMIC_ROLES.SPENDING
  );
}

module.exports = {
  CLASSIFICATIONS,
  ECONOMIC_ROLES,
  classifyTransaction,
  isEligiblePurchase,
};
