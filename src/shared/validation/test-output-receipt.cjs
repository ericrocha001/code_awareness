const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const ACCEPTANCE_KEYS = new Set([
  'id', 'provider', 'version', 'sha256', 'pin', 'source', 'outcome',
  'sourceIdentity', 'coverage', 'sessions', 'usageCoverage',
  'transcriptImported', 'code', 'reason'
])
const PIN_VALUES = new Set(['VERIFIED', 'MISMATCH', 'UNVERIFIED'])
const SOURCE_VALUES = new Set(['PROVIDER_PIN_AND_CLI_VERSION', 'PROVIDER_PIN_CONFIG', 'UNAVAILABLE'])
const OUTCOME_VALUES = new Set(['VERIFIED', 'VERSION_MISMATCH', 'PIN_MISMATCH', 'SOURCE_UNAVAILABLE', 'SKIPPED', 'ERROR', 'INCOMPLETE'])
const SOURCE_IDENTITY_VALUES = new Set(['BEFORE_AFTER_CAPTURED', 'SOURCE_CHANGED_DURING_RUN', 'SOURCE_UNAVAILABLE'])
const COVERAGE_VALUES = new Set(['COMPLETE', 'PARTIAL', 'UNAVAILABLE'])
const ID_PATTERN = /^[A-Z0-9_]{3,64}$/
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]{1,32})?$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,64}$/

function receiptDigest(receipt) {
  const { digest, registration, ...execution } = receipt
  return createHash('sha256').update(JSON.stringify(execution)).digest('hex')
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])
    )
  }
  return value
}

function sameValidationSource(before, after) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return false
  return JSON.stringify(canonical(before)) === JSON.stringify(canonical(after))
}

function sourceIdentityFromLedger(ledger) {
  if (!ledger || !ledger.before || !ledger.after) return 'SOURCE_UNAVAILABLE'
  return sameValidationSource(ledger.before, ledger.after) ? 'BEFORE_AFTER_CAPTURED' : 'SOURCE_CHANGED_DURING_RUN'
}

function validAcceptanceShape(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  if (Object.keys(raw).some(key => !ACCEPTANCE_KEYS.has(key))) return false
  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return false
  if (typeof raw.provider !== 'string' || !PROVIDER_PATTERN.test(raw.provider)) return false
  if (raw.version !== null && (typeof raw.version !== 'string' || !VERSION_PATTERN.test(raw.version))) return false
  if (raw.sha256 !== null && (typeof raw.sha256 !== 'string' || !SHA256_PATTERN.test(raw.sha256))) return false
  if (!PIN_VALUES.has(raw.pin) || !SOURCE_VALUES.has(raw.source) || !OUTCOME_VALUES.has(raw.outcome)) return false
  if (raw.sourceIdentity !== undefined && !SOURCE_IDENTITY_VALUES.has(raw.sourceIdentity)) return false
  if (raw.coverage !== undefined && !COVERAGE_VALUES.has(raw.coverage)) return false
  if (raw.sessions !== undefined && (typeof raw.sessions !== 'number' || !Number.isSafeInteger(raw.sessions) || raw.sessions < 0 || raw.sessions > 10000)) return false
  if (raw.usageCoverage !== undefined && !COVERAGE_VALUES.has(raw.usageCoverage)) return false
  if (raw.transcriptImported !== false) return false
  if (raw.code !== undefined && (typeof raw.code !== 'string' || !CODE_PATTERN.test(raw.code))) return false
  if (raw.reason !== undefined && (typeof raw.reason !== 'string' || !CODE_PATTERN.test(raw.reason))) return false
  return true
}

function evaluateAcceptanceSummary(raw, ledger) {
  const sourceIdentity = ledger !== undefined
    ? sourceIdentityFromLedger(ledger)
    : (raw && typeof raw === 'object' && SOURCE_IDENTITY_VALUES.has(raw.sourceIdentity) ? raw.sourceIdentity : 'SOURCE_UNAVAILABLE')
  if (!validAcceptanceShape(raw)) {
    const safeId = raw && typeof raw === 'object' && typeof raw.id === 'string' && ID_PATTERN.test(raw.id) ? raw.id : 'ACCEPTANCE'
    const safeProvider = raw && typeof raw === 'object' && typeof raw.provider === 'string' && PROVIDER_PATTERN.test(raw.provider) ? raw.provider : 'unknown'
    return {
      sufficient: false,
      reason: 'Provider acceptance summary failed schema or privacy validation.',
      acceptance: {
        id: safeId,
        provider: safeProvider,
        version: null,
        sha256: null,
        pin: 'UNVERIFIED',
        source: 'UNAVAILABLE',
        outcome: 'INCOMPLETE',
        sourceIdentity,
        transcriptImported: false,
        reason: 'ACCEPTANCE_SCHEMA_INVALID'
      }
    }
  }
  const acceptance = {
    id: raw.id,
    provider: raw.provider,
    version: raw.version,
    sha256: raw.sha256,
    pin: raw.pin,
    source: raw.source,
    outcome: raw.outcome,
    sourceIdentity,
    ...(raw.coverage !== undefined ? { coverage: raw.coverage } : {}),
    ...(raw.sessions !== undefined ? { sessions: raw.sessions } : {}),
    ...(raw.usageCoverage !== undefined ? { usageCoverage: raw.usageCoverage } : {}),
    transcriptImported: false,
    ...(raw.code !== undefined ? { code: raw.code } : {}),
    ...(raw.reason !== undefined ? { reason: raw.reason } : {})
  }
  const verifiedFacts =
    acceptance.pin === 'VERIFIED' &&
    acceptance.source === 'PROVIDER_PIN_AND_CLI_VERSION' &&
    typeof acceptance.version === 'string' &&
    typeof acceptance.sha256 === 'string' &&
    (acceptance.sessions === undefined || acceptance.sessions >= 1)
  if (acceptance.outcome !== 'VERIFIED' || !verifiedFacts) {
    if (acceptance.outcome === 'VERIFIED') {
      acceptance.outcome = 'INCOMPLETE'
      acceptance.reason ??= 'ACCEPTANCE_EVIDENCE_INCOMPLETE'
    }
    return {
      sufficient: false,
      reason: 'Provider acceptance evidence is incomplete.',
      acceptance
    }
  }
  return { sufficient: true, acceptance }
}

function recordTestAcceptance(summary, targetFile = process.env.CODE_AWARENESS_TEST_ACCEPTANCE_FILE) {
  if (typeof targetFile !== 'string' || !targetFile.trim()) return false
  fs.mkdirSync(path.dirname(targetFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(targetFile, JSON.stringify(summary), { mode: 0o600 })
  return true
}

function readRecordedAcceptance(targetFile) {
  if (typeof targetFile !== 'string' || !targetFile.trim()) return { present: false }
  let stat
  try { stat = fs.lstatSync(targetFile) }
  catch (error) { if (error.code === 'ENOENT') return { present: false }; throw error }
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) return { present: true, raw: null }
    return { present: true, raw: JSON.parse(fs.readFileSync(targetFile, 'utf8')) }
  } catch {
    return { present: true, raw: null }
  } finally {
    fs.rmSync(targetFile, { force: true })
  }
}

module.exports = {
  receiptDigest,
  sameValidationSource,
  sourceIdentityFromLedger,
  evaluateAcceptanceSummary,
  recordTestAcceptance,
  readRecordedAcceptance
}
