const window = { type: 'object', properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 }, textOffset: { type: 'integer', minimum: 0 }, textLimit: { type: 'integer', minimum: 1, maximum: 4000 } }, additionalProperties: false }
const version = { type: 'integer', minimum: 1 }
export const academyImpactSchema = {
  type: 'object',
  properties: {
    skillId: { type: 'string', minLength: 1 }, expectedVersion: version, baseVersion: version, targetVersion: version,
    package: { type: 'object', properties: { skillMd: { type: 'string', minLength: 1 }, artifacts: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['skillMd', 'artifacts'], additionalProperties: false },
    changes: window, consumers: window, evidence: window, consumerId: { type: 'string', minLength: 1 }
  },
  required: ['skillId'], additionalProperties: false,
  oneOf: [
    { required: ['expectedVersion', 'package'], not: { anyOf: [{ required: ['baseVersion'] }, { required: ['targetVersion'] }] } },
    { required: ['baseVersion', 'targetVersion'], not: { anyOf: [{ required: ['expectedVersion'] }, { required: ['package'] }] } }
  ]
}

const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' }
export const academyImpactFreshnessSchema = {
  type: 'object', properties: {
    candidateHash: hash,
    snapshot: {
      type: 'object', properties: {
        schema: { type: 'integer', const: 1 }, skillId: { type: 'string', minLength: 1 }, baseVersion: version, targetVersion: version,
        candidateHash: hash, sourceHash: hash, baseHash: hash, catalogHash: hash, consumerHash: hash, fingerprint: hash,
        names: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]*$' } }
      }, required: ['schema', 'skillId', 'baseVersion', 'candidateHash', 'sourceHash', 'baseHash', 'catalogHash', 'consumerHash', 'fingerprint', 'names'], additionalProperties: false
    }
  }, required: ['snapshot'], additionalProperties: false
}
