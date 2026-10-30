import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { nativeObservation, rootExitSchema } from './native-owner'
import { previewContextManifest } from './context-contract'

const selectionSchema = z.object({ repositoryId: z.string(), worktreeId: z.string(), generation: z.string(), profileId: z.string(), fingerprint: z.string() }).strict()
export const terminationSchema = z.object({
  kind: z.enum(['STOP_REQUESTED', 'UNEXPECTED_EXIT', 'STARTUP_FAILURE', 'UNKNOWN']),
  reasonCode: z.string().min(1).max(160), observedAt: z.string().max(64), rootExit: rootExitSchema,
  supervisor: z.object({ status: z.enum(['RESPONDING', 'EXITED', 'UNKNOWN']), phase: z.string().max(80).nullable(),
    pid: z.number().int().positive().nullable(), created: z.string().max(64).nullable() }).strict(),
  supervisorExit: z.object({ observedAt: z.string().max(64) }).strict().optional(),
  process: nativeObservation.nullable()
}).strict()
export const sessionSchema = z.object({
  schemaVersion: z.literal(1), sessionId: z.string().uuid(), operationId: z.string().uuid(), selection: selectionSchema,
  persistence: z.enum(['PERSISTED', 'UNVERIFIABLE']),
  profileRevision: z.number().int().positive(), gitFingerprint: z.string(), revision: z.number().int().nonnegative(), at: z.string(),
  snapshotEndpoint: z.boolean().optional(),
  spawnedAt: z.string().optional(), functionalAt: z.string().optional(),
  startedAt: z.string(), endedAt: z.string().nullable(),
  stopIntent: z.object({ requestedAt: z.string().max(64) }).strict().optional(),
  termination: terminationSchema.optional(),
  context: previewContextManifest.optional(),
  build: z.object({ captureId: z.string().regex(/^[a-f0-9]{64}$/), buildId: z.string().regex(/^[a-f0-9]{64}$/), runtimeId: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  sourceSnapshot: z.object({ head: z.string().nullable(), branch: z.string().nullable(), indexRevision: z.string(), worktreeRevision: z.string(), dirty: z.boolean(), operation: z.string().nullable().optional() }).strict().nullable(),
  sourceObservation: z.object({ at: z.string(), fingerprint: z.string(), snapshot: z.object({ head: z.string().nullable(), branch: z.string().nullable(), indexRevision: z.string(), worktreeRevision: z.string(), dirty: z.boolean(), operation: z.string().nullable().optional() }).strict() }).strict().optional(),
  state: z.enum(['PREPARING', 'RUNNING', 'STOPPING', 'STOPPED', 'FAILED', 'CLEANUP_INCOMPLETE', 'OWNERSHIP_UNVERIFIED']),
  reconciliation: z.enum(['NOT_REQUIRED', 'REQUIRED', 'OBSERVED']), failure: z.string().max(256).nullable(),
  resources: z.enum(['RESERVED', 'RELEASED', 'UNVERIFIABLE']), process: nativeObservation.nullable(),
  processEvidence: z.object({ at: z.string(), members: z.array(z.object({ pid: z.number().int().positive(), created: z.string(), role: z.string().max(64) }).strict()).max(128) }).strict().optional(),
  runtimeEvidence: z.object({ preflight: z.enum(['SUPPORTED', 'UNKNOWN']), at: z.string(), scope: z.literal('DECLARED_INSTALL_SCRIPTS'), runtime: z.string(), abi: z.string(), platform: z.literal('win32'), arch: z.literal('x64'), modules: z.array(z.string()).max(16) }).strict().optional(),
  resourceInventory: z.array(z.object({ name: z.string().max(1024), kind: z.enum(['JOB', 'STOP_EVENT', 'SESSION_DIRECTORY', 'SESSION_ENDPOINT', 'DISABLED']),
    reference: z.string().max(2048), state: z.enum(['RESERVED', 'RELEASED', 'UNVERIFIABLE']) }).strict()).max(34),
  recoveryObservation: z.object({ jobPresent: z.boolean(), jobQueryError: z.number().int(), activeProcesses: z.number().int().nonnegative().nullable(),
    sameProcessAlive: z.boolean().nullable(), adopted: z.literal(false), terminated: z.literal(false) }).strict().nullable(),
  validationLinks: z.array(z.object({ bindingId: z.string().max(128), executionId: z.string().max(512), criterionId: z.string().max(128), proofId: z.string().max(128), evidenceRevision: z.number().int().min(0).max(255), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()).max(16).optional(),
  readiness: z.enum(['NOT_OBSERVED', 'READY', 'NOT_READY', 'UNVERIFIABLE']), liveness: z.enum(['NOT_OBSERVED', 'VERIFIED', 'UNVERIFIABLE']),
  attestation: z.object({ artifact: z.enum(['NOT_OBSERVED', 'VERIFIED', 'UNVERIFIABLE', 'STALE']), loadedCode: z.enum(['NOT_OBSERVED', 'VERIFIED', 'UNVERIFIABLE', 'STALE']) }).strict(),
  coverage: z.array(z.object({ stage: z.enum(['TARGET_CHECKOUT', 'ENDPOINT', 'SERVED_ARTIFACT', 'LOADED_COMPONENT', 'BEHAVIOR']),
    component: z.enum(['TARGET', 'PROCESS', 'WEB', 'ELECTRON_MAIN', 'ELECTRON_PRELOAD', 'ELECTRON_RENDERER']),
    status: z.enum(['VERIFIED', 'UNVERIFIABLE', 'NOT_OBSERVED', 'STALE']), fingerprint: z.string().nullable(), evidenceRef: z.string().nullable(),
    at: z.string(), reasonCode: z.string() }).strict()).max(32),
  shutdown: z.object({ graceMs: z.number().int().nonnegative().max(120000), forceMs: z.number().int().positive().max(120000), graceful: z.boolean() }).strict()
}).strict()
export type PreviewSessionRecord = z.infer<typeof sessionSchema>
const intentSchema = z.object({
  operationId: z.string().uuid(), key: z.string().regex(/^[a-f0-9]{64}$/), repositoryId: z.string().max(128),
  branch: z.string().max(512), at: z.string().max(64), revision: z.number().int().min(0).max(1),
  head: z.string().max(128).nullable().optional(), worktreeId: z.string().max(128).nullable().optional(),
  sessionId: z.string().uuid().nullable(), reasonCode: z.string().max(160).nullable(),
  phase: z.enum(['PREPARING', 'BLOCKED', 'FAILED', 'UNKNOWN', 'RUNNING'])
}).strict()
export type PreviewIntentReceipt = z.infer<typeof intentSchema>
export class PreviewSessionStore {
  readonly root: string
  constructor(directory: string) {
    if (!isAbsolute(directory)) throw new Error('ABSOLUTE_STORE_REQUIRED')
    mkdirSync(directory, { recursive: true })
    this.root = resolve(directory)
    this.assertSafe(this.root)
    if (realpathSync(this.root).toLowerCase() !== this.root.toLowerCase()) throw new Error('SESSION_STORE_LINK')
  }
  private assertSafe(path: string) {
    let current = resolve(path)
    for (;;) {
      if (lstatSync(current).isSymbolicLink()) throw new Error('SESSION_STORE_LINK')
      const parent = resolve(current, '..'); if (parent === current) break; current = parent
    }
  }
  directory(id: string) { return join(this.root, z.string().uuid().parse(id)) }
  runtime(id: string) { return join(this.directory(id), 'runtime') }
  assertExternal(worktree: string) {
    const path = relative(realpathSync(worktree), this.root)
    if (!path || !(path === '..' || path.startsWith('..' + sep) || isAbsolute(path))) throw new Error('SESSION_STORE_INSIDE_WORKTREE')
  }
  private immutable(path: string, value: unknown) {
    const temp = join(this.root, randomUUID() + '.tmp')
    const fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
    try { linkSync(temp, path) } finally { unlinkSync(temp) }
  }
  readIntent(operationId: string): PreviewIntentReceipt | undefined {
    z.string().uuid().parse(operationId)
    this.assertSafe(this.root)
    let result: PreviewIntentReceipt | undefined
    for (const revision of [0, 1]) {
      const path = join(this.root, `intent-${operationId}-${revision}.json`)
      if (!existsSync(path)) break
      this.assertSafe(path)
      if (lstatSync(path).size > 4096) throw new Error('INTENT_RECEIPT_LIMIT')
      const value = intentSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
      if (value.operationId !== operationId || value.revision !== revision || result && (value.key !== result.key || value.repositoryId !== result.repositoryId || value.branch !== result.branch)) throw new Error('INTENT_RECEIPT_UNVERIFIABLE')
      result = value
    }
    return result
  }
  appendIntent(receipt: PreviewIntentReceipt) {
    intentSchema.parse(receipt)
    this.assertSafe(this.root)
    const previous = this.readIntent(receipt.operationId)
    if (receipt.revision === 0) {
      if (previous) throw new Error('OPERATION_ID_CONFLICT')
      if (readdirSync(this.root).filter(n => /^intent-.*-0\.json$/.test(n)).length >= 128) throw new Error('INTENT_RETENTION_LIMIT')
    } else if (!previous || previous.revision !== 0 || previous.key !== receipt.key || previous.repositoryId !== receipt.repositoryId || previous.branch !== receipt.branch) throw new Error('INTENT_RECEIPT_UNVERIFIABLE')
    this.immutable(join(this.root, `intent-${receipt.operationId}-${receipt.revision}.json`), receipt)
  }
  unresolvedIntent() {
    const sessions = this.list()
    return readdirSync(this.root).filter(n => /^intent-[a-f0-9-]{36}-0\.json$/.test(n)).some(name => {
      const receipt = this.readIntent(name.slice(7, -7))!
      return receipt.revision === 0 && !sessions.some(session => session.operationId === receipt.operationId)
    })
  }
  reserve(record: PreviewSessionRecord) {
    if (this.list().length >= 128) throw new Error('SESSION_RETENTION_LIMIT')
    this.assertSafe(this.root)
    this.immutable(join(this.root, 'active.json'), { sessionId: record.sessionId })
    mkdirSync(this.directory(record.sessionId))
    mkdirSync(this.runtime(record.sessionId))
    this.append(record)
  }
  append(record: PreviewSessionRecord) {
    sessionSchema.parse(record)
    if (record.revision >= 256) throw new Error('SESSION_EVENT_LIMIT')
    this.assertSafe(this.directory(record.sessionId))
    this.immutable(join(this.directory(record.sessionId), String(record.revision).padStart(3, '0') + '.json'), record)
  }
  read(id: string, revision?: number): PreviewSessionRecord {
    if (revision !== undefined && (!Number.isInteger(revision) || revision < 0 || revision > 255)) throw new Error('INVALID_SESSION_REVISION')
    const directory = this.directory(id); this.assertSafe(directory)
    const files = readdirSync(directory).filter(n => /^\d{3}\.json$/.test(n)).sort()
    if (!files.length || files.length > 256) throw new Error('SESSION_RECORD_UNVERIFIABLE')
    let latest: PreviewSessionRecord | undefined
    let selected: PreviewSessionRecord | undefined
    for (const [index, name] of files.entries()) {
      const path = join(directory, name); this.assertSafe(path)
      if (lstatSync(path).size > 32768) throw new Error('SESSION_RECORD_LIMIT')
      const value = sessionSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
      if (value.sessionId !== id || value.revision !== index || (latest && (value.operationId !== latest.operationId || value.profileRevision !== latest.profileRevision || value.gitFingerprint !== latest.gitFingerprint || JSON.stringify(value.selection) !== JSON.stringify(latest.selection)))) throw new Error('SESSION_RECORD_UNVERIFIABLE')
      if (latest?.build && JSON.stringify(latest.build) !== JSON.stringify(value.build)) throw new Error('SESSION_BUILD_CHANGED')
      if (latest?.context && JSON.stringify(latest.context) !== JSON.stringify(value.context)) throw new Error('SESSION_CONTEXT_CHANGED')
      if (latest?.stopIntent && JSON.stringify(latest.stopIntent) !== JSON.stringify(value.stopIntent)) throw new Error('SESSION_STOP_INTENT_CHANGED')
      if (latest?.termination && latest.termination.kind !== 'UNKNOWN') {
        const { supervisorExit: beforeExit, ...before } = latest.termination
        const { supervisorExit: afterExit, ...after } = value.termination ?? {}
        if (JSON.stringify(before) !== JSON.stringify(after) || beforeExit && JSON.stringify(beforeExit) !== JSON.stringify(afterExit)) throw new Error('SESSION_TERMINATION_CHANGED')
      }
      if (latest && ['FAILED', 'STOPPED'].includes(latest.state) && (value.state !== latest.state || value.failure !== latest.failure || value.resources !== latest.resources || value.endedAt !== latest.endedAt || JSON.stringify(value.termination) !== JSON.stringify(latest.termination) || JSON.stringify(value.stopIntent) !== JSON.stringify(latest.stopIntent))) throw new Error('SESSION_TERMINAL_CHANGED')
      latest = value
      if (value.revision === revision) selected = value
    }
    if (revision !== undefined && !selected) throw new Error('SESSION_REVISION_NOT_FOUND')
    return revision === undefined ? latest! : selected!
  }
  list() { return readdirSync(this.root).filter(n => z.string().uuid().safeParse(n).success).map(id => this.read(id)) }
  active(): string | undefined {
    const path = join(this.root, 'active.json')
    if (!existsSync(path)) return undefined
    this.assertSafe(path)
    return z.object({ sessionId: z.string().uuid() }).strict().parse(JSON.parse(readFileSync(path, 'utf8'))).sessionId
  }
  release(id: string) {
    if (this.active() !== id) throw new Error('ACTIVE_SESSION_CHANGED')
    unlinkSync(join(this.root, 'active.json'))
  }
  releaseResources(id: string) {
    const runtime = this.runtime(id)
    if (!existsSync(runtime)) return
    const visit = (path: string) => {
      this.assertSafe(path)
      const stat = lstatSync(path)
      if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name))
    }
    if (resolve(runtime) !== join(this.root, id, 'runtime')) throw new Error('RESOURCE_PATH_MISMATCH')
    visit(runtime)
    rmSync(runtime, { recursive: true })
  }
  nativeJournal(id: string): Array<Record<string, unknown>> {
    const path = join(this.directory(id), 'native.jsonl')
    if (!existsSync(path)) return []
    this.assertSafe(path)
    if (lstatSync(path).size > 70000) throw new Error('NATIVE_JOURNAL_LIMIT')
    const operationId = this.read(id).operationId
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => {
      const value = JSON.parse(line)
      if (value.schemaVersion !== 1 || value.sessionId !== id || value.operationId !== operationId || typeof value.phase !== 'string' || !Number.isInteger(value.ownerPid) || value.ownerPid <= 0 || typeof value.ownerCreated !== 'string' || !/^\d+$/.test(value.ownerCreated)) throw new Error('NATIVE_JOURNAL_UNVERIFIABLE')
      return value
    })
  }
}
