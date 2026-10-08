import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type WorktreeIntent = 'STAGE' | 'UNSTAGE' | 'COMMIT' | 'CREATE_BRANCH' | 'CREATE_WORKTREE' | 'PUSH' | 'INTEGRATE' | 'CLOSE'
export interface WorktreeSnapshot {
  branch: string | null
  head: string | null
  indexRevision: string
  worktreeRevision: string
  operation: string | null
}
export interface WorktreeObservation {
  repositoryId: string
  commonDirectory: string
  administrativeDirectory: string
  worktreeId: string
  generation: string
  path: string
  snapshot: WorktreeSnapshot
  contentRevision: string
}
export interface WorktreeScope { operations: WorktreeIntent[]; paths: string[]; branches: string[]; startPoints?: string[] }
export interface WorktreeApproval extends WorktreeObservation {
  requestId: string
  scope: WorktreeScope
  expiresAt: string
  recovery: boolean
}
export type WorktreeApprovalPort = (request: WorktreeApproval) => Promise<boolean>
interface Grant {
  instanceId: string
  requestId: string
  observation: WorktreeObservation
  scope: WorktreeScope
  expiresAt: string
  credentialHash: string
  state: 'APPROVED' | 'GRANTED' | 'RECOVERY_PENDING' | 'RELEASED'
}
interface Pending {
  request: WorktreeApproval
  credential: string
  state: 'PENDING' | 'APPROVED' | 'DENIED' | 'FAILED' | 'ACCEPTED'
  code?: string
}
function fail(code: string): never { throw new Error(code) }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}
export const ownershipDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')

export function assertNoWorktreeGrant(common: string, root: string): void {
  const directory = join(common, 'code-awareness-worktree-ownership')
  if (!existsSync(directory)) return
  const physical = realpathSync(root)
  for (const file of readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const grant = JSON.parse(readFileSync(join(directory, file), 'utf8')) as Grant
    if (grant.observation.path === physical && grant.state !== 'RELEASED') fail('WORKTREE_OWNERSHIP_REQUIRED')
  }
}

export async function withWorktreeTransaction<T>(commonDirectory: string, administrativeDirectory: string, operation: () => Promise<T>): Promise<T> {
  const paths = [join(commonDirectory, 'code-awareness-worktrees.lock'), join(administrativeDirectory, 'code-awareness-worktree.lock')]
  const acquired: Array<{ path: string; fd: number }> = []
  try {
    for (const path of paths) {
      let fd: number
      try { fd = openSync(path, 'wx', 0o600) } catch { fail('WORKTREE_TRANSACTION_BUSY') }
      acquired.push({ path, fd })
      writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: randomUUID() }))
    }
    return await operation()
  } finally {
    for (const entry of acquired.reverse()) {
      closeSync(entry.fd)
      try { unlinkSync(entry.path) } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    }
  }
}

function reconcileAbandonedLocks(observation: WorktreeObservation): boolean {
  const guard = join(observation.commonDirectory, 'code-awareness-reconciliation.lock')
  let descriptor: number
  try { descriptor = openSync(guard, 'wx', 0o600) } catch { fail('WORKTREE_TRANSACTION_BUSY') }
  try {
    let interruptedValidation = false
    const validationLock = join(observation.commonDirectory, 'code-awareness-validation-locks', observation.worktreeId + '.lock')
    const paths = [join(observation.commonDirectory, 'code-awareness-worktrees.lock'), join(observation.administrativeDirectory, 'code-awareness-worktree.lock'), validationLock]
    const abandoned: Array<{ path: string; text: string }> = []
    for (const path of paths) {
      if (!existsSync(path)) continue
      const text = readFileSync(path, 'utf8')
      const record = JSON.parse(text) as { pid: number; worktreeId?: string; state?: string }
      if (!Number.isSafeInteger(record.pid) || record.pid <= 0) fail('WORKTREE_RECOVERY_REQUIRED')
      if (path === validationLock && record.worktreeId === observation.worktreeId && record.state === 'RECOVERY_PENDING') {
        interruptedValidation = true
        abandoned.push({ path, text }); continue
      }
      try { process.kill(record.pid, 0); fail('WORKTREE_TRANSACTION_BUSY') }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) throw error }
      abandoned.push({ path, text })
    }
    for (const entry of abandoned) {
      if (readFileSync(entry.path, 'utf8') !== entry.text) fail('WORKTREE_TRANSACTION_BUSY')
      unlinkSync(entry.path)
    }
    return interruptedValidation
  } finally { closeSync(descriptor); unlinkSync(guard) }
}

export class GitWorktreeOwnership {
  private readonly instanceId = randomUUID()
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly observe: (id: string) => Promise<WorktreeObservation>, private readonly approve: WorktreeApprovalPort,
    private readonly now: () => number = Date.now) {}

  private file(observation: Pick<WorktreeObservation, 'commonDirectory' | 'worktreeId'>): string {
    const directory = join(observation.commonDirectory, 'code-awareness-worktree-ownership')
    mkdirSync(directory, { recursive: true })
    return join(directory, observation.worktreeId + '.json')
  }

  private read(observation: Pick<WorktreeObservation, 'commonDirectory' | 'worktreeId'>): Grant | null {
    const file = this.file(observation)
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Grant : null
  }

  private write(grant: Grant): void {
    const file = this.file(grant.observation)
    const temporary = file + '.' + randomUUID() + '.tmp'
    writeFileSync(temporary, JSON.stringify(grant), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  }

  async locked<T>(observation: WorktreeObservation, operation: () => Promise<T>): Promise<T> {
    return withWorktreeTransaction(observation.commonDirectory, observation.administrativeDirectory, operation)
  }

  private coherent(expected: WorktreeObservation, actual: WorktreeObservation): void {
    if (ownershipDigest(expected) !== ownershipDigest(actual)) fail('GIT_STATE_CHANGED')
  }

  async request(worktreeId: string, snapshot: WorktreeSnapshot, scope: WorktreeScope, durationSeconds: number, recovery = false) {
    for (const [id, pending] of this.pending) if (Date.parse(pending.request.expiresAt) <= this.now()) this.pending.delete(id)
    if (this.pending.size >= 100) fail('WORKTREE_HANDOFF_CAPACITY')
    const observation = await this.observe(worktreeId)
    if (ownershipDigest(snapshot) !== ownershipDigest(observation.snapshot)) fail('GIT_STATE_CHANGED')
    if (snapshot.operation && !(snapshot.operation === 'MERGE' && scope.operations.includes('INTEGRATE'))) fail('GIT_OPERATION_IN_PROGRESS')
    const requestId = randomUUID()
    const credential = randomBytes(32).toString('hex')
    const request: WorktreeApproval = { ...observation, requestId, scope, expiresAt: new Date(this.now() + durationSeconds * 1000).toISOString(), recovery }
    this.pending.set(requestId, { request, credential, state: 'PENDING' })
    void this.authorize(requestId)
    return { requestId, requestCredential: credential, state: 'PENDING', mutationAllowed: false, expiresAt: request.expiresAt, retryAfterMs: 2000 }
  }

  private async authorize(requestId: string): Promise<void> {
    const pending = this.pending.get(requestId)!
    try {
      if (!await this.approve(pending.request)) { pending.state = 'DENIED'; return }
      if (this.now() >= Date.parse(pending.request.expiresAt)) fail('WORKTREE_GRANT_EXPIRED')
      const observed = await this.observe(pending.request.worktreeId)
      const { requestId: _id, scope: _scope, expiresAt: _expires, recovery: _recovery, ...expected } = pending.request
      this.coherent(expected, observed)
      const interruptedValidation = pending.request.recovery && reconcileAbandonedLocks(observed)
      await this.locked(observed, async () => {
        this.coherent(observed, await this.observe(observed.worktreeId))
        const existing = this.read(observed)
        if (existing && existing.state !== 'RELEASED') {
          if (!pending.request.recovery) fail('WORKTREE_RECOVERY_REQUIRED')
          if (existing.instanceId === this.instanceId && ['APPROVED', 'GRANTED'].includes(existing.state) && Date.parse(existing.expiresAt) > this.now() && !interruptedValidation) fail('WORKTREE_OWNERSHIP_CONFLICT')
        }
        this.write({ instanceId: this.instanceId, requestId, observation: observed, scope: pending.request.scope,
          expiresAt: pending.request.expiresAt, credentialHash: ownershipDigest(pending.credential), state: 'APPROVED' })
      })
      pending.state = 'APPROVED'
    } catch (error) { pending.state = 'FAILED'; pending.code = error instanceof Error ? error.message : 'WORKTREE_APPROVAL_FAILED' }
  }

  async accept(requestId: string, credential: string) {
    const pending = this.pending.get(requestId)
    if (!pending || pending.credential !== credential) fail('WORKTREE_REQUEST_NOT_FOUND')
    if (this.now() >= Date.parse(pending.request.expiresAt)) fail('WORKTREE_GRANT_EXPIRED')
    if (pending.state === 'APPROVED' || pending.state === 'ACCEPTED') {
      const observed = await this.observe(pending.request.worktreeId)
      await this.locked(observed, async () => {
        const grant = this.read(observed)
        if (!grant || grant.requestId !== requestId || grant.instanceId !== this.instanceId || !['APPROVED', 'GRANTED'].includes(grant.state)) fail('WORKTREE_RECOVERY_REQUIRED')
        this.coherent(grant.observation, await this.observe(observed.worktreeId))
        grant.state = 'GRANTED'
        this.write(grant)
        pending.state = 'ACCEPTED'
      })
      return { state: 'KNOWN_GRANTED', leaseId: requestId, leaseCredential: credential, expiresAt: pending.request.expiresAt, scope: pending.request.scope,
        guarantee: 'COOPERATIVE_OPERATOR_CONFIRMED_PAUSE' }
    }
    return { state: pending.state, code: pending.code, mutationAllowed: false, ...(pending.state === 'PENDING' ? { retryAfterMs: 2000 } : {}) }
  }

  async state(worktreeId: string) {
    const observed = await this.observe(worktreeId)
    return this.peek(observed)
  }

  peek(observed: Pick<WorktreeObservation, 'commonDirectory' | 'worktreeId' | 'generation'>) {
    const grant = this.read(observed)
    if (!grant || grant.state === 'RELEASED') return 'NOT_GRANTED'
    if (grant.observation.generation !== observed.generation || grant.instanceId !== this.instanceId || grant.state !== 'GRANTED' || Date.parse(grant.expiresAt) <= this.now()) return 'UNKNOWN_OR_STALE'
    return 'KNOWN_GRANTED'
  }

  async execute<T>(worktreeId: string, leaseId: string, credential: string, intent: WorktreeIntent | 'RELEASE',
    effect: (observation: WorktreeObservation, scope: WorktreeScope, assertCurrent: () => Promise<void>) => Promise<T>): Promise<T> {
    const observed = await this.observe(worktreeId)
    return this.locked(observed, async () => {
      const grant = this.read(observed)
      if (!grant || grant.requestId !== leaseId || grant.credentialHash !== ownershipDigest(credential)) fail('WORKTREE_OWNERSHIP_REQUIRED')
      if (grant.instanceId !== this.instanceId || grant.state !== 'GRANTED') fail('WORKTREE_RECOVERY_REQUIRED')
      if (Date.parse(grant.expiresAt) <= this.now()) fail('WORKTREE_GRANT_EXPIRED')
      if (intent !== 'RELEASE' && !grant.scope.operations.includes(intent)) fail('WORKTREE_INTENT_NOT_GRANTED')
      this.coherent(grant.observation, await this.observe(worktreeId))
      const assertCurrent = async () => {
        if (Date.parse(grant.expiresAt) <= this.now()) fail('WORKTREE_GRANT_EXPIRED')
        this.coherent(grant.observation, await this.observe(worktreeId))
        if (Date.parse(grant.expiresAt) <= this.now()) fail('WORKTREE_GRANT_EXPIRED')
      }
      try {
        if (intent === 'CLOSE') { grant.state = 'RELEASED'; this.write(grant) }
        await assertCurrent()
        const result = await effect(observed, grant.scope, assertCurrent)
        if (intent !== 'CLOSE') grant.observation = await this.observe(worktreeId)
        grant.state = intent === 'RELEASE' || intent === 'CLOSE' ? 'RELEASED' : result && typeof result === 'object' && 'isError' in result && result.isError ? 'RECOVERY_PENDING' : 'GRANTED'
        this.write(grant)
        return result
      } catch (error) {
        grant.state = 'RECOVERY_PENDING'
        this.write(grant)
        throw error
      }
    })
  }
}
