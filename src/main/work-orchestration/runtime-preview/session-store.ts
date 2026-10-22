import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { nativeObservation } from './native-owner'

const selectionSchema = z.object({ repositoryId: z.string(), worktreeId: z.string(), generation: z.string(), profileId: z.string(), fingerprint: z.string() }).strict()
export const sessionSchema = z.object({
  schemaVersion: z.literal(1), sessionId: z.string().uuid(), operationId: z.string().uuid(), selection: selectionSchema,
  persistence: z.enum(['PERSISTED', 'UNVERIFIABLE']),
  profileRevision: z.number().int().positive(), gitFingerprint: z.string(), revision: z.number().int().nonnegative(), at: z.string(),
  startedAt: z.string(), endedAt: z.string().nullable(),
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
  readiness: z.enum(['NOT_OBSERVED', 'READY', 'NOT_READY', 'UNVERIFIABLE']), liveness: z.enum(['NOT_OBSERVED', 'VERIFIED', 'UNVERIFIABLE']),
  attestation: z.object({ artifact: z.enum(['NOT_OBSERVED', 'VERIFIED', 'UNVERIFIABLE', 'STALE']), loadedCode: z.enum(['NOT_OBSERVED', 'VERIFIED', 'UNVERIFIABLE', 'STALE']) }).strict(),
  coverage: z.array(z.object({ stage: z.enum(['TARGET_CHECKOUT', 'ENDPOINT', 'SERVED_ARTIFACT', 'LOADED_COMPONENT', 'BEHAVIOR']),
    component: z.enum(['TARGET', 'PROCESS', 'WEB', 'ELECTRON_MAIN', 'ELECTRON_PRELOAD', 'ELECTRON_RENDERER']),
    status: z.enum(['VERIFIED', 'UNVERIFIABLE', 'NOT_OBSERVED', 'STALE']), fingerprint: z.string().nullable(), evidenceRef: z.string().nullable(),
    at: z.string(), reasonCode: z.string() }).strict()).max(32),
  shutdown: z.object({ graceMs: z.number().int().nonnegative().max(120000), forceMs: z.number().int().positive().max(120000), graceful: z.boolean() }).strict()
}).strict()
export type PreviewSessionRecord = z.infer<typeof sessionSchema>
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
  read(id: string): PreviewSessionRecord {
    const directory = this.directory(id); this.assertSafe(directory)
    const files = readdirSync(directory).filter(n => /^\d{3}\.json$/.test(n)).sort()
    if (!files.length || files.length > 256) throw new Error('SESSION_RECORD_UNVERIFIABLE')
    let latest: PreviewSessionRecord | undefined
    for (const [index, name] of files.entries()) {
      const path = join(directory, name); this.assertSafe(path)
      if (lstatSync(path).size > 32768) throw new Error('SESSION_RECORD_LIMIT')
      const value = sessionSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
      if (value.sessionId !== id || value.revision !== index || (latest && (value.operationId !== latest.operationId || value.profileRevision !== latest.profileRevision || value.gitFingerprint !== latest.gitFingerprint || JSON.stringify(value.selection) !== JSON.stringify(latest.selection)))) throw new Error('SESSION_RECORD_UNVERIFIABLE')
      latest = value
    }
    return latest!
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
