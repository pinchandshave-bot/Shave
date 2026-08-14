function roundMoney(value) {
  return Math.round(
    (Number(value) + Number.EPSILON) * 100
  ) / 100;
}

function approximatelyEqual(
  a,
  b,
  tolerance = 0.01
) {
  return Math.abs(
    Number(a) - Number(b)
  ) <= tolerance;
}

function sum(values) {
  return values.reduce(
    (total, value) =>
      total + Number(value || 0),
    0
  );
}

const reconciliation =
  reconcileRoundupAggregate({
    events: eligibleEvents,

    globalCount:
      eligibleEvents.length,

    globalOpportunity:
      round(opportunity),

    categories,

    merchants,
  });
  const categoryOpportunity =
    roundMoney(
      sum(
        categories.map(
          item => item.opportunity
        )
      )
    );

  const merchantOpportunity =
    roundMoney(
      sum(
        merchants.map(
          item => item.opportunity
        )
      )
    );

  const categoryCount =
    sum(
      categories.map(
        item => item.purchases
      )
    );

  const merchantCount =
    sum(
      merchants.map(
        item => item.purchases
      )
    );

  const uniqueTransactionIds =
    new Set(
      events.map(
        event => event.transaction_id
      )
    );

  const checks = {
    category_total_reconciles:
      approximatelyEqual(
        categoryOpportunity,
        globalOpportunity
      ),

    merchant_total_reconciles:
      approximatelyEqual(
        merchantOpportunity,
        globalOpportunity
      ),

    category_count_reconciles:
      categoryCount === globalCount,

    merchant_count_reconciles:
      merchantCount === globalCount,

    event_count_reconciles:
      events.length === globalCount,

    transaction_uniqueness:
      uniqueTransactionIds.size ===
      events.length,
  };

  const passed =
    Object.values(checks)
      .every(Boolean);

  return {
    passed,

    checks,

    totals: {
      global_count:
        Number(globalCount || 0),

      global_opportunity:
        roundMoney(
          globalOpportunity
        ),

      category_count:
        categoryCount,

      category_opportunity:
        categoryOpportunity,

      merchant_count:
        merchantCount,

      merchant_opportunity:
        merchantOpportunity,

      event_count:
        events.length,

      unique_transaction_count:
        uniqueTransactionIds.size,
    },
  };
}

module.exports = {
  reconcileRoundupAggregate,
  roundMoney,
  approximatelyEqual,
  sum,
};
