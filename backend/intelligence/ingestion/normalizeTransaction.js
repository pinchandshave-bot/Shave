'use strict';

function numberOrNull(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function firstDefined(...values) {
  return values.find(
    value =>
      value !== undefined &&
      value !== null &&
      value !== ''
  ) ?? null;
}

function normalizeTransaction(row) {
  const amount = numberOrNull(row.amount);

  const id = firstDefined(
    row.id,
    row.plaid_transaction_id,
    row.transaction_id
  );

  const merchantName = firstDefined(
    row.merchant_name,
    row.merchantName,
    row.name
  );

  const category = firstDefined(
    row.category,
    row.personal_finance_category_primary,
    row.personal_finance_category,
    row.personal_finance_category_detailed
  );

  return {
    id,

    plaidTransactionId: firstDefined(
      row.plaid_transaction_id,
      row.transaction_id
    ),

    accountId: firstDefined(
      row.account_id
    ),

    merchantName,

    merchantKey:
      merchantName
        ? String(merchantName)
            .trim()
            .toLowerCase()
        : null,

    category,

    amount,

    absoluteAmount:
      amount === null
        ? null
        : Math.abs(amount),

    authorizedDate:
      firstDefined(
        row.authorized_date,
        row.authorized_datetime
      ),

    postedDate:
      firstDefined(
        row.date,
        row.posted_date,
        row.posted_datetime
      ),

    pending:
      Boolean(row.pending),

    raw: row
  };
}

function normalizeTransactions(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError(
      'normalizeTransactions expects an array.'
    );
  }

  return rows
    .map(normalizeTransaction)
    .filter(transaction => transaction.id);
}

module.exports = {
  normalizeTransaction,
  normalizeTransactions
};
