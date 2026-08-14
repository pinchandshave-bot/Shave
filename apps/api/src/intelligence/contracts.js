function assertNumberOrNull(value, name) {
  if (
    value !== null &&
    value !== undefined &&
    !Number.isFinite(Number(value))
  ) {
    throw new Error(
      `INTELLIGENCE_CONTRACT: ${name} must be numeric or null`
    );
  }
}

function validateRoundup(roundup) {
  if (!roundup) {
    throw new Error(
      'INTELLIGENCE_CONTRACT: roundup missing'
    );
  }

  const fields = [
    'opportunity',
    'average',
    'median',
    'smallest',
    'largest',
  ];

  for (const field of fields) {
    assertNumberOrNull(
      roundup[field],
      `roundup.${field}`
    );
  }

  if (
    !Number.isInteger(
      Number(
        roundup.eligible_purchase_count
      )
    )
  ) {
    throw new Error(
      'INTELLIGENCE_CONTRACT: eligible_purchase_count must be integer'
    );
  }

  if (
    !Array.isArray(
      roundup.category_concentration
    )
  ) {
    throw new Error(
      'INTELLIGENCE_CONTRACT: category_concentration must be array'
    );
  }

  if (
    !Array.isArray(
      roundup.merchant_concentration
    )
  ) {
    throw new Error(
      'INTELLIGENCE_CONTRACT: merchant_concentration must be array'
    );
  }
}

function validateRunway(balance) {
  if (!balance) {
    throw new Error(
      'INTELLIGENCE_CONTRACT: balance missing'
    );
  }

  if (
    balance.evidence_state ===
    'insufficient' &&
    balance.runway_days !== null
  ) {
    throw new Error(
      'INTELLIGENCE_CONTRACT: insufficient runway evidence cannot contain runway_days'
    );
  }

  assertNumberOrNull(
    balance.runway_days,
    'balance.runway_days'
  );

  assertNumberOrNull(
    balance.runway_months,
    'balance.runway_months'
  );
}

function validateFinancialIntelligence(contract) {
  if (!contract) {
    throw new Error(
      'INTELLIGENCE_CONTRACT: response missing'
    );
  }

  if (contract.status !== 'ok') {
    throw new Error(
      'INTELLIGENCE_CONTRACT: invalid status'
    );
  }

  validateRoundup(
    contract.roundup
  );

  validateRunway(
    contract.balance
  );

  return true;
}

module.exports = {
  validateFinancialIntelligence,
};
