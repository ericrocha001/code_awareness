import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { basename } from 'node:path'
import { existsSync, realpathSync, statSync } from 'node:fs'
import type { GitService } from '../core/git-service'
import type { GitDecoration } from '../../shared/types/git-management-types'
import type { GitAtlasComparison, GitAtlasPage, GitAtlasQuery, GitAtlasScope } from '../../shared/types/git-atlas-types'
import { AtlasCache, type AtlasCommit, type AtlasHistorySlice, type AtlasPersistence } from './git-atlas-cache'
import type { AtlasCatalogManifest, AtlasCatalogState } from '../../shared/types/git-atlas-catalog-types'
import { AtlasCollector } from './git-atlas-collector'

export class GitAtlasReader {
  private readonly key = randomBytes(32)
  private readonly pages = new AtlasCache()
  private readonly commits = new AtlasCache(2048, 4 * 1024 * 1024)
  private readonly pending = new Map<string, Promise<unknown>>()
  private generation = 0
  private structuralIdentity = ''
  private readonly anchors = new Map<string, { at: string; revision?: string }>()
  private readonly slices = new AtlasCache(64, 2 * 1024 * 1024)
  private persistence?: AtlasPersistence
  private persistenceCommon = ''
  private persistenceToken = 0
  private persistenceReason: string | null = null
  private disposed = false
  private persistenceReady: Promise<void> = Promise.resolve()
  private deliveredSnapshot = ''
  private detachCollector?: () => void
  private catalogRequest = 0
  private manifest?: AtlasCatalogManifest
  private flushing?: Promise<void>
  private readonly writes = new Map<string, { slice: AtlasHistorySlice; commits: AtlasCommit[]; observation: AtlasCatalogManifest }>()
  constructor(private readonly root: string, private readonly git: GitService, private readonly fail: (code: string) => never,
    private readonly openPersistence?: (common: string) => AtlasPersistence | Promise<AtlasPersistence>,
    private readonly mutationPending: () => boolean = () => false) {}

  stopCollection() { this.catalogRequest++; this.detachCollector?.(); this.detachCollector = undefined }

  private async catalogManifest(contextKey?: string, revalidate = false): Promise<AtlasCatalogManifest> {
    const source = await this.git.getAtlasSourceFingerprint(this.root)
    if (!revalidate && this.manifest?.sourceFingerprint === source) return this.manifest
    const current = await this.observe(contextKey, { kind: 'ALL_REFS', anchor: 'AUTO' })
    if (source !== await this.git.getAtlasSourceFingerprint(this.root)) this.fail('GIT_STATE_CHANGED')
    const tips = [...new Set([...current.refs.map(ref => ref.sha), ...current.tags.map(tag => tag.sha), ...current.detachedHeads.map(item => item.sha)])].sort()
    if (tips.join(' ').length > 24000) this.fail('ATLAS_REFERENCE_LIMIT')
    return this.manifest = { scopeKey: 'LOCAL_REACHABLE_V1', revision: current.historyRevision, topology: current.topologyRevision, worktreeGeneration: current.worktreeGeneration,
      tips, refs: current.refs, tags: current.tags, observedAt: new Date().toISOString(), available: current.detachedCoverage === 'COMPLETE', sourceFingerprint: source }
  }

  async startCollection(snapshot: string, contextKey: string, changed: (state: AtlasCatalogState) => void): Promise<AtlasCatalogState> {
    if (!snapshot || snapshot !== this.deliveredSnapshot || this.disposed) this.fail('GIT_STATE_CHANGED')
    this.stopCollection()
    const request = this.catalogRequest
    const manifest = await this.catalogManifest(contextKey)
    await this.storageReady()
    if (this.disposed || request !== this.catalogRequest) this.fail('REPOSITORY_CONTEXT_CHANGED')
    const store = this.persistence
    const state: AtlasCatalogState = { manifest, coverage: 'UNKNOWN', acquired: 0, diagnostic: this.catalogDiagnostic(), reason: null }
    if (store?.diagnostic().state === 'READY') {
      this.detachCollector = AtlasCollector.attach({ store, manifest, observe: () => this.catalogManifest(contextKey, true),
        fingerprint: () => this.git.getAtlasSourceFingerprint(this.root), metadata: shas => this.git.getAtlasFullCommitMetadata(this.root, shas),
        busy: () => this.disposed || this.pending.size > 0 || this.writes.size > 0 || this.mutationPending(),
        changed: next => { if (!this.disposed && request === this.catalogRequest) changed(next) } })
      state.coverage = 'NOT_STARTED'
    }
    return state
  }

  catalogDiagnostic() {
    if (this.persistenceReason) return { state: 'SUSPENDED' as const, reason: this.persistenceReason }
    if (this.writes.size) return { state: 'SUSPENDED' as const, reason: 'WRITES_PENDING' }
    return this.persistence?.diagnostic() ?? { state: 'UNAVAILABLE' as const, reason: this.persistenceCommon ? 'OPENING_OR_UNAVAILABLE' : 'NOT_REQUESTED' }
  }

  invalidate(dispose = false) {
    if (this.disposed) return
    this.stopCollection()
    this.deliveredSnapshot = ''
    this.generation++; this.pages.clear(); this.pending.clear(); this.anchors.clear()
    if (dispose) {
      this.drainOnClose()
      if (this.writes.size) console.warn('[GitAtlas] Shutdown with unconfirmed writes', { pending: this.writes.size, reason: this.persistenceReason })
      this.disposed = true; this.commits.clear(); this.slices.clear(); this.persistenceToken++; this.persistence?.close(); this.persistence = undefined
    }
  }

  private drainOnClose() {
    const deadline = Date.now() + 250
    this.persistence?.retry?.()
    for (const [key, value] of this.writes) {
      if (Date.now() >= deadline || !this.saveWrite(key, value)) break
    }
    if (this.writes.size) this.persistenceReason = 'SHUTDOWN_WITH_UNCONFIRMED_WRITES'
  }

  private preparePersistence(common: string, retry = false) {
    if (!this.openPersistence || this.disposed || this.persistenceCommon === common && !retry) return
    this.stopCollection()
    if (this.persistenceCommon !== common) {
      this.drainOnClose()
      if (this.writes.size) this.fail('ATLAS_PERSISTENCE_PENDING_CONTEXT_CHANGE')
    }
    this.persistence?.close(); this.persistence = undefined; this.persistenceCommon = common; this.persistenceReason = null
    const token = ++this.persistenceToken
    this.persistenceReady = new Promise<void>(resolve => setImmediate(() => {
      if (this.disposed || token !== this.persistenceToken) { resolve(); return }
      Promise.resolve().then(() => this.openPersistence!(common)).then(store => {
        if (this.disposed || token !== this.persistenceToken) { store.close(); return }
        this.persistence = store; this.persistenceReason = null
      }).catch(() => { if (token === this.persistenceToken) this.persistenceReason = 'OPEN_FAILED' }).finally(resolve)
    }))
  }

  private async storageReady() {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([this.persistenceReady, new Promise<void>(resolve => { timer = setTimeout(resolve, 1500) })])
    if (timer) clearTimeout(timer)
    if (this.disposed) this.fail('REPOSITORY_CONTEXT_CHANGED')
  }

  private saveWrite(key: string, value: { slice: AtlasHistorySlice; commits: AtlasCommit[]; observation: AtlasCatalogManifest }): boolean {
    try {
      if (!this.persistence?.save(key, value.slice, value.commits, value.observation)) {
        this.persistenceReason = this.persistence?.diagnostic().reason ?? 'WRITE_UNCONFIRMED'
        return false
      }
      if (this.writes.get(key) === value) this.writes.delete(key)
      this.persistenceReason = null
      return true
    } catch { this.persistenceReason = 'WRITE_FAILED'; return false }
  }

  private flushWrites(): Promise<void> {
    if (this.flushing) return this.flushing
    const token = this.persistenceToken
    const run = async () => {
      let attempts = 0
      while (!this.disposed && token === this.persistenceToken && this.writes.size) {
        const [key, value] = this.writes.entries().next().value!
        this.persistence?.retry?.()
        if (this.saveWrite(key, value)) attempts = 0
        else if (++attempts >= 3) return
        await new Promise<void>(resolve => attempts ? setTimeout(resolve, attempts * 100) : setImmediate(resolve))
      }
    }
    const result = run().finally(() => { if (this.flushing === result) this.flushing = undefined })
    this.flushing = result
    return result
  }

  private async persist(key: string, slice: AtlasHistorySlice, commits: AtlasCommit[], observation: AtlasCatalogManifest) {
    if (!this.openPersistence || this.disposed) return
    await this.storageReady()
    await this.flushWrites()
    if (this.disposed) return
    const bytes = Buffer.byteLength(JSON.stringify({ slice, commits, observation }))
    const full = () => this.writes.size >= 8 || [...this.writes.values()].reduce((total, value) => total + Buffer.byteLength(JSON.stringify(value)), bytes) > 8 * 1024 * 1024
    while (!this.writes.has(key) && full() && this.writes.size) {
      await this.flushWrites()
      if (this.persistenceReason || this.disposed) break
    }
    if (!this.writes.has(key) && full()) {
      this.persistenceReason = 'WRITE_NOT_ACCEPTED_BACKPRESSURE'
      return
    }
    this.writes.set(key, { slice, commits, observation })
    await this.flushWrites()
  }

  private coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key)
    if (existing) return existing.then(value => structuredClone(value) as T)
    const result = run()
    this.pending.set(key, result)
    void result.finally(() => { if (this.pending.get(key) === result) this.pending.delete(key) }).catch(() => {})
    return result.then(value => structuredClone(value))
  }

  private async observe(contextKey?: string, scope?: GitAtlasScope) {
    if (this.disposed) this.fail('REPOSITORY_CONTEXT_CHANGED')
    if (scope && (!['CHECKOUT', 'ALL_REFS'].includes(scope.kind) || !['AUTO', 'PRESENT'].includes(scope.anchor) ||
      [scope.baseRef, scope.focusRef].some(ref => ref !== undefined && (typeof ref !== 'string' || !/^refs\/(heads|remotes)\/.+/.test(ref) || /[\s~^:?*\[\]\\]/.test(ref) || ref.length > 256)))) this.fail('INVALID_ARGUMENT')
    const [directories, checkout] = await Promise.all([this.git.getRepositoryDirectories(this.root), this.git.getAtlasCheckoutState(this.root)])
    const commonDirectory = realpathSync(directories.common), admin = realpathSync(directories.admin), physical = realpathSync(this.root)
    const adminStats = statSync(admin, { bigint: true }), rootStats = statSync(physical, { bigint: true })
    const worktreeGeneration = createHash('sha256').update(JSON.stringify([admin, String(adminStats.dev), String(adminStats.ino), String(adminStats.birthtimeNs), physical, String(rootStats.ino), String(rootStats.birthtimeNs)])).digest('hex')
    const topology = await this.git.getCommitTopologyRevision(this.root, commonDirectory)
    this.preparePersistence(commonDirectory)
    const structuralIdentity = JSON.stringify([commonDirectory, topology])
    if (this.structuralIdentity !== structuralIdentity) { this.commits.clear(); this.structuralIdentity = structuralIdentity }
    if (scope?.kind === 'CHECKOUT') {
      const { head, branch } = checkout
      const primary = scope.baseRef ?? await this.git.getAtlasSelectedBase(this.root)
      const names = [...new Set([branch ? `refs/heads/${branch}` : null, primary, scope.focusRef].filter((ref): ref is string => !!ref))]
      const raw = names.length ? await this.git.getAtlasReferences(this.root, names) : ''
      const observation = { referenceFingerprint: this.git.atlasReferenceFingerprint(checkout, await this.git.getAtlasReferences(this.root)) }
      const refs: GitDecoration[] = raw.split('\n').filter(Boolean).map(line => {
        const [ref, sha, , , upstream] = line.split('\0')
        return { ref, sha, name: ref.replace(/^refs\/(heads|remotes)\//, ''), kind: ref.startsWith('refs/heads/') ? 'LOCAL' : 'REMOTE', upstream: upstream || null }
      })
      if (head) refs.push({ ref: 'HEAD', sha: head, name: branch ? 'HEAD' : 'HEAD detached', kind: 'HEAD', upstream: null })
      const historyRevision = createHash('sha256').update(JSON.stringify({ root: physical, commonDirectory, topology, worktreeGeneration, raw, head, branch, primary, scope })).digest('hex')
      const snapshot = createHash('sha256').update(JSON.stringify([historyRevision, contextKey])).digest('hex')
      return { snapshot, historyRevision, observation, worktreeGeneration, topologyRevision:topology, refs, tags: [], detachedHeads: [], detachedCoverage: 'PARTIAL' as const, head, branch, primaryRef: refs.some(ref => ref.ref === primary) ? primary : null }
    }
    const references = this.git.getAtlasReferences(this.root)
    const [raw, worktrees, primary] = await Promise.all([
      references, this.git.listWorktreeRecords(this.root, true),
      references.then(raw => this.git.getAtlasPrimaryRef(this.root, raw))
    ])
    const { head, branch } = checkout
    const lines = raw.trimEnd().split('\n').filter(Boolean)
    if (lines.length > 512 || worktrees.length > 256000 || worktrees.split('\0\0').length > 512) this.fail('ATLAS_REFERENCE_LIMIT')
    const refs: GitDecoration[] = []
    const tags: GitAtlasPage['tags'] = []
    for (const line of lines) {
      const [ref, sha, symbolic, peeled, upstream, objectType, peeledType] = line.split('\0')
      if (symbolic) continue
      if (ref.startsWith('refs/tags/')) {
        if (objectType === 'commit' || peeledType === 'commit') tags.push({ name: ref.slice(10), sha: peeled || sha })
        continue
      }
      refs.push({ ref, sha, name: ref.replace(/^refs\/(heads|remotes)\//, ''), kind: ref.startsWith('refs/heads/') ? 'LOCAL' : 'REMOTE', upstream: upstream || null })
    }
    if (head) refs.push({ ref: 'HEAD', sha: head, name: branch ? 'HEAD' : 'HEAD detached', kind: 'HEAD', upstream: null })
    const detachedHeads: GitAtlasPage['detachedHeads'] = []
    let detachedCoverage: GitAtlasPage['detachedCoverage'] = 'COMPLETE'
    const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
    const common = normalize(commonDirectory)
    for (const record of worktrees.split('\0\0')) {
      const fields = record.split('\0')
      if (!fields.includes('detached')) continue
      const sha = fields.find(field => field.startsWith('HEAD '))?.slice(5)
      const path = fields.find(field => field.startsWith('worktree '))?.slice(9)
      if (!path || fields.some(field => field.startsWith('prunable')) || !existsSync(path)) { detachedCoverage = 'PARTIAL'; continue }
      try {
        if (normalize(realpathSync(await this.git.getCommonDirectory(path))) !== common || await this.git.getCurrentCommitHash(path) !== sha) { detachedCoverage = 'PARTIAL'; continue }
        if (sha && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) detachedHeads.push({ sha, name: basename(path) })
      } catch { detachedCoverage = 'PARTIAL' }
    }
    const historyRevision = createHash('sha256').update(JSON.stringify({ root: normalize(physical), common, topology, worktreeGeneration, raw, worktrees, detachedHeads, detachedCoverage, head, branch, primary, ...(scope ? { scope } : {}) })).digest('hex')
    const snapshot = createHash('sha256').update(JSON.stringify([historyRevision, contextKey])).digest('hex')
    const observation = { referenceFingerprint: this.git.atlasReferenceFingerprint(checkout, raw), sourceFingerprint: this.git.atlasSourceFingerprint(this.root, directories, checkout, raw, worktrees, topology) }
    return { snapshot, historyRevision, observation, worktreeGeneration, topologyRevision:topology, refs, tags, detachedHeads, detachedCoverage, head, branch, primaryRef: refs.some(ref => ref.ref === primary) ? primary : null }
  }

  async assertSnapshot(snapshot: string, contextKey?: string, scope?: GitAtlasScope) {
    if ((await this.observe(contextKey, scope)).snapshot !== snapshot) this.fail('GIT_STATE_CHANGED')
  }

  async history(request: GitAtlasQuery): Promise<GitAtlasPage> {
    if (request.refresh) this.invalidate()
    const session = JSON.stringify([request.contextKey, request.scope, request.window])
    const current = this.anchors.get(session) ?? { at: new Date().toISOString() }
    const anchor = current.at
    this.anchors.set(session, current)
    if (this.anchors.size > 64) this.anchors.delete(this.anchors.keys().next().value!)
    const page = await this.coalesce(`history:${this.generation}:${anchor}:${JSON.stringify(request)}`, () => this.readHistory(request, anchor))
    this.deliveredSnapshot = page.snapshot
    return page
  }

  private cachedCommits(shas: string[]): Map<string, AtlasCommit> {
    const found = new Map<string, AtlasCommit>()
    for (const sha of shas) {
      const cached = this.commits.getReadonly<AtlasCommit>(sha) ?? this.persistence?.getDisplayCommit(sha)
      if (cached) { found.set(sha, cached); if (!Object.isFrozen(cached)) this.commits.set(sha, cached) }
    }
    return found
  }

  private async readCommits(shas: string[]): Promise<Map<string, AtlasCommit>> {
    const identity = this.structuralIdentity
    const found = this.cachedCommits(shas)
    const missing = shas.filter(sha => !found.has(sha))
    if (!missing.length) return found
    const raw = await this.git.getAtlasCommitMetadata(this.root, missing)
    if (identity !== this.structuralIdentity) this.fail('GIT_STATE_CHANGED')
    for (const line of raw.trimEnd().split('\n').filter(Boolean)) {
      const [sha, parents, author, timestamp, subject] = line.split('\0')
      if (!missing.includes(sha)) this.fail('GIT_STATE_CHANGED')
      const commit = { sha, parents: parents.split(' ').filter(Boolean), author, timestamp, subject }
      this.commits.set(sha, commit); found.set(sha, this.commits.getReadonly<AtlasCommit>(sha) ?? commit)
    }
    if (shas.some(sha => !found.has(sha))) this.fail('GIT_STATE_CHANGED')
    return found
  }

  private async readHistory(request: GitAtlasQuery, anchor: string): Promise<GitAtlasPage> {
    const generation = this.generation
    const limit = request.limit ?? 100
    if (![7, 15, 30, 60, 90, 'ALL'].includes(request.window) || !Number.isInteger(limit) || limit < 1 || limit > 100) this.fail('INVALID_ARGUMENT')
    const before = await this.observe(request.contextKey, request.scope)
    if (request.refresh && !this.persistence && this.persistenceCommon) this.preparePersistence(this.persistenceCommon, true)
    const alreadyReady = !!this.persistence
    await this.storageReady()
    if (generation !== this.generation) this.fail('GIT_STATE_CHANGED')
    const session = JSON.stringify([request.contextKey, request.scope, request.window])
    const current = this.anchors.get(session)
    if (!request.cursor) {
      if (current?.revision && current.revision !== before.historyRevision) anchor = new Date().toISOString()
      this.anchors.set(session, { at: anchor, revision: before.historyRevision })
    }
    let offset = 0, queriedAt = anchor, anchorAt = queriedAt
    let anchorKind: 'PRESENT' | 'CHECKOUT' = 'PRESENT'
    if (request.cursor) {
      try {
        const [payload, signature, extra] = request.cursor.split('.')
        const expected = createHmac('sha256', this.key).update(payload).digest(), actual = Buffer.from(signature, 'base64url')
        if (extra || expected.length !== actual.length || !timingSafeEqual(expected, actual)) this.fail('GIT_STATE_CHANGED')
        const position = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
        if (position.snapshot !== before.snapshot || position.window !== request.window || !Number.isSafeInteger(position.offset) || position.offset < 0 || !Number.isFinite(Date.parse(position.queriedAt))) this.fail('GIT_STATE_CHANGED')
        if (JSON.stringify(position.scope) !== JSON.stringify(request.scope) || !Number.isFinite(Date.parse(position.anchorAt ?? position.queriedAt))) this.fail('GIT_STATE_CHANGED')
        offset = position.offset; queriedAt = position.queriedAt; anchorAt = position.anchorAt ?? queriedAt; anchorKind = position.anchorKind ?? 'PRESENT'
      } catch { this.fail('GIT_STATE_CHANGED') }
    }
    let checkoutCommit: AtlasCommit | undefined
    if (!request.cursor && request.scope?.anchor === 'AUTO' && before.head) {
      checkoutCommit = (await this.readCommits([before.head])).get(before.head)
      const timestamp = checkoutCommit!.timestamp
      if (Date.parse(timestamp) > Date.parse(queriedAt) || request.window !== 'ALL' && Date.parse(timestamp) < Date.parse(queriedAt) - request.window * 86400000) { anchorAt = timestamp; anchorKind = 'CHECKOUT' }
    }
    const since = request.window === 'ALL' ? null : new Date(Date.parse(anchorAt) - request.window * 86400000).toISOString()
    const upperBound = request.window !== 'ALL' && request.scope && anchorKind === 'CHECKOUT' ? anchorAt : null
    const sliceKey = JSON.stringify(['history-v3', before.historyRevision, request.window, request.window === 'ALL' ? 'ALL' : anchorAt, offset, limit])
    const cacheKey = JSON.stringify(['page', sliceKey, before.snapshot, queriedAt])
    const cached = this.pages.getReadonly<GitAtlasPage>(cacheKey)
    if (cached && generation === this.generation) return { ...cached, observation: before.observation }
    const tips = [...new Set([...before.refs.map(ref => ref.sha), ...before.detachedHeads.map(ref => ref.sha), ...before.tags.map(tag => tag.sha)])].sort()
    if (tips.join(' ').length > 24000) this.fail('ATLAS_REFERENCE_LIMIT')
    if (generation !== this.generation) this.fail('GIT_STATE_CHANGED')
    const storedSlice = !request.refresh ? this.persistence?.getSlice(sliceKey) : undefined
    let slice = !request.refresh ? this.slices.getReadonly<AtlasHistorySlice>(sliceKey) ?? storedSlice : undefined
    if (slice && (slice.revision !== before.historyRevision || slice.worktreeGeneration !== before.worktreeGeneration || slice.window !== request.window || slice.offset !== offset || slice.limit !== limit || request.window !== 'ALL' && slice.anchorAt !== anchorAt || slice.since !== since || slice.upperBound !== upperBound || JSON.stringify(slice.tips) !== JSON.stringify(tips) || JSON.stringify(slice.scope) !== JSON.stringify(request.scope))) slice = undefined
    if (!slice && !request.refresh && offset === 0) {
      const compatible = (candidate: AtlasHistorySlice) => candidate.revision === before.historyRevision && candidate.worktreeGeneration === before.worktreeGeneration && !candidate.hasMore && candidate.offset === 0 && candidate.shas.length <= limit &&
        (candidate.since === null || since !== null && Date.parse(candidate.since) <= Date.parse(since)) && (candidate.upperBound === null || Date.parse(candidate.upperBound) >= Date.parse(anchorAt)) &&
        JSON.stringify(candidate.tips) === JSON.stringify(tips) && JSON.stringify(candidate.scope) === JSON.stringify(request.scope)
      const candidate = this.slices.findReadonly<AtlasHistorySlice>(compatible) ?? this.persistence?.findSlice(before.historyRevision, since, anchorAt)
      if (candidate && compatible(candidate)) {
        const objects = await this.readCommits(candidate.shas)
        const shas = candidate.shas.filter(sha => {
          const time = Date.parse(objects.get(sha)!.timestamp)
          return (since === null || time >= Date.parse(since)) && (upperBound === null || time <= Date.parse(upperBound))
        })
        slice = { ...candidate, window: request.window, limit, shas, since, upperBound, anchorAt, anchorKind, queriedAt }
      }
    }
    if (!slice) {
      const rows = await this.historyOrder(request, before, tips, offset, limit + 1, since, upperBound)
      const shas = rows.slice(0, limit)
      if (checkoutCommit && !shas.includes(checkoutCommit.sha)) shas.push(checkoutCommit.sha)
      slice = { revision: before.historyRevision, worktreeGeneration: before.worktreeGeneration, scope: request.scope, tips, window: request.window, offset, limit, shas, hasMore: rows.length > limit, since, upperBound, anchorAt, anchorKind, queriedAt }
    }
    const known = this.cachedCommits(slice.shas)
    const durable = alreadyReady && storedSlice && slice === storedSlice && known.size === slice.shas.length
    const objects = known.size === slice.shas.length ? known : await this.readCommits(slice.shas)
    const after = durable ? before : await this.observe(request.contextKey, request.scope)
    if (generation !== this.generation || after.snapshot !== before.snapshot) this.fail('GIT_STATE_CHANGED')
    const nodes = slice.shas.filter(sha => !request.scope || request.window === 'ALL' || Date.parse(objects.get(sha)!.timestamp) <= Date.parse(anchorAt)).map(sha => {
      const immutable = objects.get(sha)!
      return { ...immutable, decorations: before.refs.filter(ref => ref.sha === sha) }
    })
    const present = new Set(nodes.map(node => node.sha))
    const boundary = [...new Set(nodes.flatMap(node => node.parents).filter(sha => !present.has(sha)))]
    let nextCursor: string | null = null
    if (slice.hasMore) {
      const payload = Buffer.from(JSON.stringify({ snapshot: before.snapshot, window: request.window, offset: offset + limit, queriedAt, scope: request.scope, anchorAt, anchorKind })).toString('base64url')
      nextCursor = payload + '.' + createHmac('sha256', this.key).update(payload).digest('base64url')
    }
    const { historyRevision: _revision, ...presentation } = before
    const result: GitAtlasPage = { ...presentation, ...(request.scope ? { scope: request.scope, referenceCoverage: request.scope.kind === 'CHECKOUT' ? 'SELECTED' as const : 'ALL_REFS' as const, anchorAt, anchorKind } : {}), queriedAt, since, nodes, boundary, pendingParents: boundary, nextCursor, coverage: nextCursor ? 'PARTIAL' : 'COMPLETE_WINDOW' }
    if (generation === this.generation) {
      this.pages.set(cacheKey, result); this.slices.set(sliceKey, slice)
      if (!durable) await this.persist(sliceKey,slice,[...objects.values()],{scopeKey:JSON.stringify(request.scope??'LEGACY'),revision:before.historyRevision,topology:before.topologyRevision,worktreeGeneration:before.worktreeGeneration,tips,refs:before.refs,tags:before.tags,observedAt:new Date().toISOString(),available:request.scope?.kind==='CHECKOUT'||before.detachedCoverage==='COMPLETE'})
    }
    if (this.disposed) this.fail('REPOSITORY_CONTEXT_CHANGED')
    if (generation !== this.generation) this.fail('GIT_STATE_CHANGED')
    return result
  }

  private async historyOrder(request: GitAtlasQuery, before: Awaited<ReturnType<GitAtlasReader['observe']>>, tips: string[], offset: number, limit: number, since: string | null, until: string | null): Promise<string[]> {
    const store = this.persistence
    if (!store?.getOrder || store.diagnostic().state !== 'READY') return this.git.getAtlasHistoryOrder(this.root, tips, offset, limit, since, until ?? undefined)
    const key = createHash('sha256').update(JSON.stringify(['GIT_DATE_ORDER_V1', before.topologyRevision, tips])).digest('hex')
    const generation = this.generation
    while (!this.disposed && generation === this.generation) {
      const page = store.getOrder(key, offset, limit, since, until)
      if (page && (page.shas.length === limit || page.complete)) return page.shas
      if (store.diagnostic().state !== 'READY') break
      const position = page?.materialized ?? 0
      const shas = await this.coalesce(`order:${key}:${position}`, async () => {
        const rows = await this.git.getAtlasHistoryOrder(this.root, tips, position, 101, null)
        const commits = await this.readCommits(rows)
        const after = await this.observe(request.contextKey, request.scope)
        if (this.disposed || generation !== this.generation || after.snapshot !== before.snapshot) this.fail('GIT_STATE_CHANGED')
        const observedAt = new Date().toISOString()
        const slice: AtlasHistorySlice = { revision: key, worktreeGeneration: before.worktreeGeneration, tips, window: 'ALL', offset: position, limit: 100, shas: rows, hasMore: rows.length === 101, since: null, upperBound: null, anchorAt: observedAt, anchorKind: 'PRESENT', queriedAt: observedAt,
          order: { key, offset: position, shas: rows, complete: rows.length < 101 } }
        await this.persist(`order:${key}:${position}`, slice, [...commits.values()], { scopeKey: 'GIT_DATE_ORDER_V1', revision: before.historyRevision, topology: before.topologyRevision, worktreeGeneration: before.worktreeGeneration, tips, refs: before.refs, tags: before.tags, observedAt, available: before.detachedCoverage === 'COMPLETE' })
        return rows
      })
      const saved = store.getOrder(key, offset, limit, since, until)
      if (!saved || saved.materialized <= position && !saved.complete) break
      if (shas.length < 101 && saved.complete) return saved.shas
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    if (this.disposed) this.fail('REPOSITORY_CONTEXT_CHANGED')
    if (generation !== this.generation) this.fail('GIT_STATE_CHANGED')
    return this.git.getAtlasHistoryOrder(this.root, tips, offset, limit, since, until ?? undefined)
  }

  async compare(request: { snapshot: string; left: string; right: string; contextKey?: string; scope?: GitAtlasScope }): Promise<GitAtlasComparison> {
    return this.coalesce(`compare:${this.generation}:${JSON.stringify(request)}`, () => this.readComparison(request))
  }

  private async readComparison(request: { snapshot: string; left: string; right: string; contextKey?: string; scope?: GitAtlasScope }): Promise<GitAtlasComparison> {
    const generation = this.generation
    const before = await this.observe(request.contextKey, request.scope)
    if (generation !== this.generation) this.fail('GIT_STATE_CHANGED')
    if (request.snapshot !== before.snapshot) this.fail('GIT_STATE_CHANGED')
    const cacheKey = JSON.stringify(['compare', before.snapshot, request.left, request.right])
    const cached = this.pages.getReadonly<GitAtlasComparison>(cacheKey)
    if (cached && generation === this.generation) return cached
    const resolve = async (value: string) => {
      const ref = before.refs.find(ref => ref.ref === value)
      if (ref) return { ref: ref.ref, sha: ref.sha }
      if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) return null
      try { return { ref: value, sha: await this.git.resolveCommit(this.root, value, { noLazyFetch: true }) } } catch { return null }
    }
    const [left, right] = await Promise.all([resolve(request.left), resolve(request.right)])
    if (!left || !right || left.ref === right.ref) this.fail('INVALID_REF')
    const result = await this.git.compareAtlasRefs(this.root, left.sha, right.sha)
    const after = await this.observe(request.contextKey, request.scope)
    if (generation !== this.generation || after.snapshot !== before.snapshot) this.fail('GIT_STATE_CHANGED')
    const comparison = { snapshot: before.snapshot, left: { ref: left.ref, sha: left.sha }, right: { ref: right.ref, sha: right.sha }, ...result }
    if (generation === this.generation) this.pages.set(cacheKey, comparison)
    return comparison
  }
}
