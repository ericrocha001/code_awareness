import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ListProofsFilter,
  ProofFreshness,
  ProofStatus,
  ProofWithFreshness,
  RecordProofInput,
  ValidationProof
} from './validation-ledger-types'
import { captureValidationSource, validationSourceFingerprint, type ValidationSource } from '../validation-execution/validation-source'
import type { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'

interface LedgerRow {
  proof_id: string
  kind: string
  producer: string
  status: string
  started_at: string
  finished_at: string
  duration_ms: number
  scope_json: string
  source_fingerprint: string | null
  runtime_instance_id: string | null
  summary: string
  metrics_json: string | null
  command_profile_json: string | null
  evidence_for_json: string
  deduplication_key: string | null
  recorded_at: string
}

function rowToProof(row: LedgerRow): ValidationProof {
  return {
    proofId: row.proof_id,
    kind: row.kind as ValidationProof['kind'],
    producer: row.producer as ValidationProof['producer'],
    status: row.status as ValidationProof['status'],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    scope: JSON.parse(row.scope_json),
    sourceFingerprint: row.source_fingerprint,
    runtimeInstanceId: row.runtime_instance_id,
    summary: row.summary,
    metrics: row.metrics_json ? JSON.parse(row.metrics_json) : null,
    commandProfile: row.command_profile_json ? JSON.parse(row.command_profile_json) : null,
    evidenceFor: JSON.parse(row.evidence_for_json),
    deduplicationKey: row.deduplication_key,
    recordedAt: row.recorded_at
  }
}

async function classifyFreshness(
  proof: ValidationProof,
  currentInstanceId: string | null,
  sources = new Map<string, Promise<ValidationSource>>()
): Promise<ProofFreshness> {
  if (proof.commandProfile?.checkout) return 'UNVERIFIABLE'
  if (proof.runtimeInstanceId && currentInstanceId && proof.runtimeInstanceId !== currentInstanceId) return 'RUNTIME_HISTORICAL'
  const source = proof.commandProfile?.source
  if (!source || source.version !== 1 || !proof.sourceFingerprint || proof.status === 'ERROR' || proof.commandProfile?.cwd !== source.cwd ||
    validationSourceFingerprint(source) !== proof.sourceFingerprint) return 'UNVERIFIABLE'
  try {
    const key = JSON.stringify([source.cwd, source.repositoryId])
    let reading = sources.get(key)
    if (!reading) {
      reading = captureValidationSource(source.cwd, source.repositoryId)
      sources.set(key, reading)
    }
    const current = await reading
    if (current.repositoryDirectory !== source.repositoryDirectory || current.worktreeId !== source.worktreeId || current.generation !== source.generation) return 'UNVERIFIABLE'
    return validationSourceFingerprint(current) === proof.sourceFingerprint ? 'CURRENT' : 'SOURCE_STALE'
  } catch { return 'UNVERIFIABLE' }
}

const VALID_KINDS = new Set([
  'TARGETED_TEST',
  'SUBSYSTEM_TEST',
  'FULL_TEST_SUITE',
  'TYPECHECK',
  'BUILD',
  'E2E',
  'MANUAL_ACCEPTANCE'
])

const VALID_PRODUCERS = new Set(['IMPLEMENTER', 'ARCHITECT', 'USER', 'SYSTEM', 'TESTER'])

const VALID_STATUSES = new Set(['PASSED', 'FAILED', 'ERROR'])

export class ValidationLedger {
  private readonly db: BetterSqlite3Database
  private readonly runtimeIdentity: RuntimeIdentityProvider | undefined

  constructor(dbPath: string, runtimeIdentity?: RuntimeIdentityProvider) {
    this.runtimeIdentity = runtimeIdentity

    const dir = join(dbPath, '..')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.ensureSchema()
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS validation_proofs (
        proof_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        producer TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        scope_json TEXT NOT NULL,
        source_fingerprint TEXT,
        runtime_instance_id TEXT,
        summary TEXT NOT NULL,
        metrics_json TEXT,
        command_profile_json TEXT,
        evidence_for_json TEXT NOT NULL DEFAULT '[]',
        deduplication_key TEXT,
        recorded_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vl_dedup ON validation_proofs(deduplication_key)
        WHERE deduplication_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_vl_kind ON validation_proofs(kind);
      CREATE INDEX IF NOT EXISTS idx_vl_status ON validation_proofs(status);
      CREATE INDEX IF NOT EXISTS idx_vl_producer ON validation_proofs(producer);
      CREATE INDEX IF NOT EXISTS idx_vl_recorded_at ON validation_proofs(recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_vl_source_fp ON validation_proofs(source_fingerprint)
        WHERE source_fingerprint IS NOT NULL;
    `)
  }

  private getCurrentInstanceId(): string | null {
    return this.runtimeIdentity?.getInstanceId() ?? null
  }

  recordProof(input: RecordProofInput): ValidationProof {
    if (!VALID_KINDS.has(input.kind)) {
      throw new Error(`INVALID_ARGUMENT: Unknown kind "${input.kind}"`)
    }
    if (!VALID_PRODUCERS.has(input.producer)) {
      throw new Error(`INVALID_ARGUMENT: Unknown producer "${input.producer}"`)
    }
    if (!VALID_STATUSES.has(input.status)) {
      throw new Error(`INVALID_ARGUMENT: Unknown status "${input.status}"`)
    }
    if (!Array.isArray(input.scope) || input.scope.length === 0) {
      throw new Error('INVALID_ARGUMENT: scope must be a non-empty array')
    }
    if (typeof input.summary !== 'string' || input.summary.trim().length === 0) {
      throw new Error('INVALID_ARGUMENT: summary must be a non-empty string')
    }
    if (typeof input.durationMs !== 'number' || input.durationMs < 0) {
      throw new Error('INVALID_ARGUMENT: durationMs must be a non-negative number')
    }

    // If deduplicationKey is provided, check for existing record
    if (input.deduplicationKey) {
      const existing = this.db
        .prepare('SELECT * FROM validation_proofs WHERE deduplication_key = ?')
        .get(input.deduplicationKey) as LedgerRow | undefined
      if (existing) {
        return rowToProof(existing)
      }
    }

    const proofId = `proof-${randomUUID()}`
    const recordedAt = new Date().toISOString()
    const evidenceFor = input.evidenceFor ?? []

    const proof: ValidationProof = {
      proofId,
      kind: input.kind,
      producer: input.producer,
      status: input.status,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs: input.durationMs,
      scope: input.scope,
      sourceFingerprint: input.sourceFingerprint ?? null,
      runtimeInstanceId: input.runtimeInstanceId ?? null,
      summary: input.summary,
      metrics: input.metrics ?? null,
      commandProfile: input.commandProfile ?? null,
      evidenceFor,
      deduplicationKey: input.deduplicationKey ?? null,
      recordedAt
    }

    this.db
      .prepare(
        `INSERT INTO validation_proofs
          (proof_id, kind, producer, status, started_at, finished_at, duration_ms,
           scope_json, source_fingerprint, runtime_instance_id, summary,
           metrics_json, command_profile_json, evidence_for_json,
           deduplication_key, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        proof.proofId,
        proof.kind,
        proof.producer,
        proof.status,
        proof.startedAt,
        proof.finishedAt,
        proof.durationMs,
        JSON.stringify(proof.scope),
        proof.sourceFingerprint,
        proof.runtimeInstanceId,
        proof.summary,
        proof.metrics ? JSON.stringify(proof.metrics) : null,
        proof.commandProfile ? JSON.stringify(proof.commandProfile) : null,
        JSON.stringify(proof.evidenceFor),
        proof.deduplicationKey,
        proof.recordedAt
      )

    return proof
  }

  getProof(proofId: string): ValidationProof | null {
    const row = this.db
      .prepare('SELECT * FROM validation_proofs WHERE proof_id = ?')
      .get(proofId) as LedgerRow | undefined
    return row ? rowToProof(row) : null
  }

  async getProofWithFreshness(proofId: string): Promise<ProofWithFreshness | null> {
    const proof = this.getProof(proofId)
    if (!proof) return null
    const freshness = await classifyFreshness(proof, this.getCurrentInstanceId())
    return { ...proof, freshness }
  }

  async listProofs(filter: ListProofsFilter = {}): Promise<ProofWithFreshness[]> {
    const currentInstanceId = this.getCurrentInstanceId()
    const sources = new Map<string, Promise<ValidationSource>>()

    let query = 'SELECT * FROM validation_proofs WHERE 1=1'
    const params: (string | number | null)[] = []

    if (filter.status) {
      query += ' AND status = ?'
      params.push(filter.status)
    }
    if (filter.kind) {
      query += ' AND kind = ?'
      params.push(filter.kind)
    }
    if (filter.producer) {
      query += ' AND producer = ?'
      params.push(filter.producer)
    }
    if (filter.requirementId) {
      query += ` AND json_each.value = ?`
      query = `SELECT vp.* FROM validation_proofs vp, json_each(vp.evidence_for_json) WHERE json_each.value = ?`
      params.unshift(filter.requirementId)
      // Reset and rebuild for this special case
      const reqRows = this.db
        .prepare(
          `SELECT vp.* FROM validation_proofs vp, json_each(vp.evidence_for_json)
           WHERE json_each.value = ?
           ORDER BY vp.recorded_at DESC
           LIMIT ?`
        )
        .all(filter.requirementId, filter.limit ?? 100) as LedgerRow[]

      let results = await Promise.all(reqRows.map(rowToProof).map(async (proof) => ({
        ...proof,
        freshness: await classifyFreshness(proof, currentInstanceId, sources)
      })))

      if (filter.freshness) {
        results = results.filter((p) => p.freshness === filter.freshness)
      }
      return results
    }

    query += ' ORDER BY recorded_at DESC'
    query += ` LIMIT ?`
    params.push(filter.limit ?? 100)

    const rows = this.db.prepare(query).all(...params) as LedgerRow[]

    let results = await Promise.all(rows.map(rowToProof).map(async (proof) => ({
      ...proof,
      freshness: await classifyFreshness(proof, currentInstanceId, sources)
    })))

    if (filter.freshness) {
      results = results.filter((p) => p.freshness === filter.freshness)
    }

    return results
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // Ignore close errors
    }
  }
}
