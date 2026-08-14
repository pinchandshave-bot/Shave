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

function reconcileRoundup({
  events,
  globalCount,
  globalOpportunity,
  categories,
  merchants,
}) {
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
       
