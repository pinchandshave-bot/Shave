'use strict';

const {
  CONFIDENCE_LEVEL
} = require('./types');

function confidenceFromEvidence(factors = []) {
  const validFactors = factors.filter(Boolean);

  if (validFactors.length === 0) {
    return {
      level: CONFIDENCE_LEVEL.INSUFFICIENT,
      score: 0,
      factors: []
    };
  }

  /*
   * This is intentionally transparent.
   *
   * The score is not pretending to be a statistical probability.
   * It represents evidence strength until domain-specific statistical
   * models are introduced.
   */

  let score = 0.5;

  for (const factor of validFactors) {
    switch (factor.strength) {
      case 'VERY_HIGH':
        score += 0.15;
        break;

      case 'HIGH':
        score += 0.10;
        break;

      case 'MEDIUM':
        score += 0.05;
        break;

      default:
        break;
    }
  }

  score = Math.min(1, Number(score.toFixed(4)));

  let level = CONFIDENCE_LEVEL.LOW;

  if (score >= 0.90) {
    level = CONFIDENCE_LEVEL.VERY_HIGH;
  } else if (score >= 0.75) {
    level = CONFIDENCE_LEVEL.HIGH;
  } else if (score >= 0.55) {
    level = CONFIDENCE_LEVEL.MEDIUM;
  }

  return {
    level,
    score,
    factors: validFactors
  };
}

module.exports = {
  confidenceFromEvidence
};
