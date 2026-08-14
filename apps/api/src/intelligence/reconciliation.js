function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function cents(value) {
  return Math.round(money(value) * 100);
}

function dollars(centsValue) {
  return Number(
    (centsValue / 100).toFixed(2)
  );
}

function aggregateRoundupEvents(events) {
  const categoryMap = new Map();
  const merchantMap = new Map();

  let totalCents = 0;
  let count = 0;
  const transactionIds = new Set();

  for (const event of events) {
    if (!event) continue;

    const amountCents =
      cents(event.roundup_amount);

    const transactionId =
      event.transaction_id;

    if (!transactionId) {
      throw new Error(
        'ROUNDUP_RECONCILIATION: event missing transaction_id'
      );
    }

    if (transactionIds.has(transactionId)) {
      throw new Error(
        `ROUNDUP_RECONCILIATION: duplicate active event for transaction ${transactionId}`
      );
    }

    transactionIds.add(transactionId);

    totalCents += amountCents;
    count += 1;

    const category =
      String(event.category || 'Uncategorized')
        .trim() || 'Uncategorized';

    const merchant =
      String(event.merchant_name || 'Unknown merchant')
        .trim() || 'Unknown merchant';

    if (!categoryMap.has(category)) {
      categoryMap.set(category, {
        name: category,
        purchases: 0,
        opportunityCents: 0,
      });
    }

    const categoryEntry =
      categoryMap.get(category);

    categoryEntry.purchases += 1;
    categoryEntry.opportunityCents += amountCents;

    if (!merchantMap.has(merchant)) {
      merchantMap.set(merchant, {
        name: merchant,
        purchases: 0,
        opportunityCents: 0,
      });
    }

    const merchantEntry =
      merchantMap.get(merchant);

    merchantEntry.purchases += 1;
    merchantEntry.opportunityCents += amountCents;
  }

  const categories =
    Array.from(categoryMap.values()).map(item => ({
      name: item.name,
      purchases: item.purchases,
      opportunity: dollars(item.opportunityCents),
    }));

  const merchants =
    Array.from(merchantMap.values()).map(item => ({
      name: item.name,
      purchases: item.purchases,
      opportunity: dollars(item.opportunityCents),
    }));

  return {
    count,
    opportunity: dollars(totalCents),
    categories,
    merchants,
    transactionIds,
  };
}

function reconcileRoundupAggregate({
  eligiblePurchaseCount,
  opportunity,
  categories,
  merchants,
}) {
  const globalCount =
    Number(eligiblePurchaseCount);

  const globalCents =
    cents(opportunity);

  const categoryCount =
    categories.reduce(
      (sum, item) =>
        sum + Number(item.purchases || 0),
      0
    );

  const merchantCount =
    merchants.reduce(
      (sum, item) =>
        sum + Number(item.purchases || 0),
      0
    );

  const categoryCents =
    categories.reduce(
      (sum, item) =>
        sum + cents(item.opportunity),
      0
    );

  const merchantCents =
    merchants.reduce(
      (sum, item) =>
        sum + cents(item.opportunity),
      0
    );

  const checks = {
    category_count:
      categoryCount === globalCount,

    merchant_count:
      merchantCount === globalCount,

    category_total:
      categoryCents === globalCents,

    merchant_total:
      merchantCents === globalCents,
  };

  const valid =
    Object.values(checks).every(Boolean);

  return {
    valid,
    checks,
    global: {
      count: globalCount,
      opportunity: dollars(globalCents),
    },
    category: {
      count: categoryCount,
      opportunity: dollars(categoryCents),
    },
    merchant: {
      count: merchantCount,
      opportunity: dollars(merchantCents),
    },
  };
}

module.exports = {
  aggregateRoundupEvents,
  reconcileRoundupAggregate,
};
