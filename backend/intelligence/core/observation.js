'use strict';

const crypto = require('crypto');

const {
  INTELLIGENCE_STATUS,
  INTELLIGENCE_DOMAIN,
  TEMPORAL_STATE
} = require('./types');

function deterministicId(domain, subjectId, dependencyIds = []) {
  const source = [
    domain,
    subjectId || '',
    ...dependencyIds.sort()
  ].join('|');

  return crypto
    .createHash('sha256')
    .update(source)
    .digest('hex');
}

function createObservation({
  domain,
  status,
  subject,
  claim,
  value = null,
  unit = null,
  confidence,
  evidence = [],
  reasoning = null,
  temporal = {},
  dependencies = [],
  source = null
}) {
  const dependencyIds = dependencies
    .map(dependency => dependency.id)
    .filter(Boolean);

  const id = deterministicId(
    domain,
    subject?.id || subject?.key || null,
    dependencyIds
  );

  return {
    id,

    domain,

    status:
      status ||
      INTELLIGENCE_STATUS.UNKNOWN,

    subject,

    claim,

    value,

    unit,

    confidence,

    evidence,

    reasoning,

    temporal: {
      state:
        temporal.state ||
        TEMPORAL_STATE.UNKNOWN,

      validFrom:
        temporal.validFrom ||
        null,

      validTo:
        temporal.validTo ||
        null,

      observedAt:
        temporal.observedAt ||
        new Date().toISOString()
    },

    dependencies: dependencyIds,

    source,

    version: 1,

    createdAt: new Date().toISOString()
  };
}

module.exports = {
  createObservation
};
