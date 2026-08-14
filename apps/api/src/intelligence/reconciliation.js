function roundMoney(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.round(
    (number + Number.EPSILON) * 100
  ) / 100;
}

function approximatelyEqual(
  a,
  b,
  tolerance = 0.01
) {
  const left = Number(a);
  const right = Number(b);

  if (
    !Number.isFinite(left) ||
    !Number.isFinite(right)
  ) {
    return false;
  }

  return Math.abs(
    left - right
  ) <= tolerance;
}

function sum(values) {
  if (!Array.isArray(values)) {
    return 0;
  }

  return values.reduce(
    (total, value) => {
      const number = Number(value);

      return total +
        (
          Number.isFinite(number)
            ? number
            : 0
        );
    },
    0
  );
}

/*
 * Round-Up reconciliation.
 *
 * This function accepts the current intelligence.js
 * contract:
 *
 * {
 *   eligiblePurchaseCount,
 *   opportunity,
 *   categories,
 *   merchants
 * }
 *
 * The aggregate is reconciled from the category and
 * merchant populations supplied by the intelligence
 * engine.
 *
 * No financial value is fabricated when a population
 * is missing. Missing arrays are treated as an invalid
 * reconciliation input rather than silently becoming
 * valid evidence.
 */
function reconcileRoundupAggregate({
  eligiblePurchaseCount,
  opportunity,
  categories,
  merchants,
}) {
  const categoriesAreValid =
    Array.isArray(categories);

  const merchantsAreValid =
    Array.isArray(merchants);

  const globalCount =
    Number(eligiblePurchaseCount);

  const globalOpportunity =
    roundMoney(opportunity);

  const validGlobalCount =
    Number.isInteger(globalCount) &&
    globalCount >= 0;

  const validGlobalOpportunity =
    globalOpportunity !== null &&
    globalOpportunity >= 0;

  const categoryOpportunity =
    categoriesAreValid
      ? roundMoney(
          sum(
            categories.map(
              item =>
                item &&
                item.opportunity
            )
          )
        )
      : null;

  const merchantOpportunity =
    merchantsAreValid
      ? roundMoney(
          sum(
            merchants.map(
              item =>
                item &&
                item.opportunity
            )
          )
        )
      : null;

  const categoryCount =
    categoriesAreValid
      ? sum(
          categories.map(
            item =>
              item &&
              item.purchases
          )
        )
      : null;

  const merchantCount =
    merchantsAreValid
      ? sum(
          merchants.map(
            item =>
              item &&
              item.purchases
          )
        )
      : null;

  const checks = {
    categories_present:
      categoriesAreValid,

    merchants_present:
      merchantsAreValid,

    global_count_valid:
      validGlobalCount,

    global_opportunity_valid:
      validGlobalOpportunity,

    category_total_reconciles:
      categoriesAreValid &&
      validGlobalOpportunity &&
      approximatelyEqual(
        categoryOpportunity,
        globalOpportunity
      ),

    merchant_total_reconciles:
      merchantsAreValid &&
      validGlobalOpportunity &&
      approximatelyEqual(
        merchantOpportunity,
        globalOpportunity
      ),

    category_count_reconciles:
      categoriesAreValid &&
      validGlobalCount &&
      categoryCount === globalCount,

    merchant_count_reconciles:
      merchantsAreValid &&
      validGlobalCount &&
      merchantCount === globalCount,
  };

  const passed =
    Object.values(checks)
      .every(Boolean);

  return {
    valid: passed,
    passed,

    checks,

    totals: {
      global_count:
        validGlobalCount
          ? globalCount
          : null,

      global_opportunity:
        globalOpportunity,

      category_count:
        categoryCount,

      category_opportunity:
        categoryOpportunity,

      merchant_count:
        merchantCount,

      merchant_opportunity:
        merchantOpportunity,
    },
  };
}

module.exports = {
  reconcileRoundupAggregate,
  roundMoney,
  approximatelyEqual,
  sum,
};
