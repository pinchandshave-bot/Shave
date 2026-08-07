// Round up to the next dollar. Excludes non-purchases (amount <= 0, which in
// Plaid's convention means a refund/credit) and rent-sized transactions.
const RENT_SIZED_THRESHOLD = 800;

function calculateRoundup(amount) {
  if (amount <= 0) return 0;
  if (amount >= RENT_SIZED_THRESHOLD) return 0;
  const roundedUp = Math.ceil(amount);
  return Number((roundedUp - amount).toFixed(2));
}

module.exports = { calculateRoundup };
