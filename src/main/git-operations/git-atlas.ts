import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { basename } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import type { GitService } from '../core/git-service'
import type { GitDecoration } from '../../shared/types/git-management-types'
import type { GitAtlasComparison, GitAtlasPage, GitAtlasQuery, GitAtlasScope } from '../../shared/types/git-atlas-types'
import { AtlasCache } from './git-atlas-cache'

export class GitAtlasReader {
  private readonly key = randomBytes(32)
  private readonly pages = new AtlasCache()
  private readonly commits = new AtlasCache(2048, 4 * 1024 * 1024)
  private readonly pending = new Map<string, Promise<unknown>>()
  private generation = 0
  private revision = ''
  constructor(private readonly root: string, private readonly git: GitService, private readonly fail: (code: string) => never) {}

  invalidate(dispose = false) {
    this.generation++; this.pages.clear(); this.pending.clear()
    if (dispose) this.commits.clear()
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
    if (scope && (!['CHECKOUT', 'ALL_REFS'].includes(scope.kind) || !['AUTO', 'PRESENT'].includes(scope.anchor) ||
      [scope.baseRef, scope.focusRef].some(ref => ref !== undefined && (typeof ref !== 'string' || !/^refs\/(heads|remotes)\/.+/.test(ref) || /[\s~^:?*\[\]\\]/.test(ref) || ref.length > 256)))) this.fail('INVALID_ARGUMENT')
    const commonDirectory = realpathSync(await this.git.getCommonDirectory(this.root))
    if (scope?.kind === 'CHECKOUT') {
      const [head, branch, primary, topology] = await Promise.all([
        this.git.getCurrentCommitHash(this.root), this.git.getCurrentBranch(this.root),
        scope.baseRef ?? this.git.getAtlasSelectedBase(this.root), this.git.getCommitTopologyRevision(this.root, commonDirectory)
      ])
      const names = [...new Set([branch ? `refs/heads/${branch}` : null, primary, scope.focusRef].filter((ref): ref is string => !!ref))]
      const raw = names.length ? await this.git.getAtlasReferences(this.root, names) : ''
      const refs: GitDecoration[] = raw.split('\n').filter(Boolean).map(line => {
        const [ref, sha, , , upstream] = line.split('\0')
        return { ref, sha, name: ref.replace(/^refs\/(heads|remotes)\//, ''), kind: ref.startsWith('refs/heads/') ? 'LOCAL' : 'REMOTE', upstream: upstream || null }
      })
      if (head) refs.push({ ref: 'HEAD', sha: head, name: branch ? 'HEAD' : 'HEAD detached', kind: 'HEAD', upstream: null })
      const snapshot = createHash('sha256').update(JSON.stringify({ root: realpathSync(this.root), commonDirectory, topology, raw, head, branch, primary, scope, contextKey })).digest('hex')
      return { snapshot, refs, tags: [], detachedHeads: [], detachedCoverage: 'PARTIAL' as const, head, branch, primaryRef: refs.some(ref => ref.ref === primary) ? primary : null }
    }
    const references = this.git.getAtlasReferences(this.root)
    const [raw, worktrees, head, branch, primary, topology] = await Promise.all([
      references, this.git.listWorktreeRecords(this.root),
      this.git.getCurrentCommitHash(this.root), this.git.getCurrentBranch(this.root), references.then(raw => this.git.getAtlasPrimaryRef(this.root, raw)),
      this.git.getCommitTopologyRevision(this.root, commonDirectory)
    ])
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
    const snapshot = createHash('sha256').update(JSON.stringify({ root: normalize(realpathSync(this.root)), common, topology, raw, worktrees, detachedHeads, detachedCoverage, head, branch, primary, contextKey, ...(scope ? { scope } : {}) })).digest('hex')
    return { snapshot, refs, tags, detachedHeads, detachedCoverage, head, branch, primaryRef: refs.some(ref => ref.ref === primary) ? primary : null }
  }

  async assertSnapshot(snapshot: string, contextKey?: string, scope?: GitAtlasScope) {
    if ((await this.observe(contextKey, scope)).snapshot !== snapshot) this.fail('GIT_STATE_CHANGED')
  }

  async history(request: GitAtlasQuery): Promise<GitAtlasPage> {
    if (request.refresh) this.invalidate()
    const anchor = Math.floor(Date.now() / 60000) * 60000
    return this.coalesce(`history:${this.generation}:${anchor}:${JSON.stringify(request)}`, () => this.readHistory(request, anchor))
  }

  private async readHistory(request: GitAtlasQuery, anchor: number): Promise<GitAtlasPage> {
    const generation = this.generation
    const limit = request.limit ?? 100
    if (![7, 15, 30, 60, 90, 'ALL'].includes(request.window) || !Number.isInteger(limit) || limit < 1 || limit > 100) this.fail('INVALID_ARGUMENT')
    const before = await this.observe(request.contextKey, request.scope)
    if (this.revision !== before.snapshot) { this.pages.clear(); this.revision = before.snapshot }
    let offset = 0, queriedAt = new Date(Date.now()).toISOString(), anchorAt = queriedAt
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
    let checkoutRow: string | undefined
    if (!request.cursor && request.scope?.anchor === 'AUTO' && before.head) {
      checkoutRow = (await this.git.getAtlasHistory(this.root, [before.head], 0, 1, null)).trimEnd()
      const timestamp = checkoutRow.split('\0')[3]
      if (Date.parse(timestamp) > Date.parse(queriedAt) || request.window !== 'ALL' && Date.parse(timestamp) < Date.parse(queriedAt) - request.window * 86400000) { anchorAt = timestamp; anchorKind = 'CHECKOUT' }
    }
    const since = request.window === 'ALL' ? null : new Date(Date.parse(anchorAt) - request.window * 86400000).toISOString()
    const cacheKey = JSON.stringify(['history', before.snapshot, request.window, request.cursor ? queriedAt : anchor, anchorAt, offset, limit])
    const cached = this.pages.get<GitAtlasPage>(cacheKey)
    if (cached && generation === this.generation) return cached
    const tips = [...new Set([...before.refs.map(ref => ref.sha), ...before.detachedHeads.map(ref => ref.sha), ...before.tags.map(tag => tag.sha)])].sort()
    if (tips.join(' ').length > 24000) this.fail('ATLAS_REFERENCE_LIMIT')
    const rows = (await this.git.getAtlasHistory(this.root, tips, offset, limit + 1, since, request.scope ? anchorAt : undefined)).trimEnd().split('\n').filter(Boolean)
    if ((await this.observe(request.contextKey, request.scope)).snapshot !== before.snapshot) this.fail('GIT_STATE_CHANGED')
    const visibleRows = rows.slice(0, limit)
    if (checkoutRow && !visibleRows.some(row => row.split('\0')[0] === before.head)) visibleRows.push(checkoutRow)
    const nodes = visibleRows.map(line => {
      const [sha, parents, author, timestamp, subject] = line.split('\0')
      const immutable = this.commits.get<Omit<GitAtlasPage['nodes'][number], 'decorations'>>(sha) ?? { sha, parents: parents.split(' ').filter(Boolean), author, timestamp, subject }
      this.commits.set(sha, immutable)
      return { ...immutable, decorations: before.refs.filter(ref => ref.sha === sha) }
    })
    const present = new Set(nodes.map(node => node.sha))
    const boundary = [...new Set(nodes.flatMap(node => node.parents).filter(sha => !present.has(sha)))]
    let nextCursor: string | null = null
    if (rows.length > limit) {
      const payload = Buffer.from(JSON.stringify({ snapshot: before.snapshot, window: request.window, offset: offset + limit, queriedAt, scope: request.scope, anchorAt, anchorKind })).toString('base64url')
      nextCursor = payload + '.' + createHmac('sha256', this.key).update(payload).digest('base64url')
    }
    const result: GitAtlasPage = { ...before, ...(request.scope ? { scope: request.scope, referenceCoverage: request.scope.kind === 'CHECKOUT' ? 'SELECTED' as const : 'ALL_REFS' as const, anchorAt, anchorKind } : {}), queriedAt, since, nodes, boundary, pendingParents: boundary, nextCursor, coverage: nextCursor ? 'PARTIAL' : 'COMPLETE_WINDOW' }
    if (generation === this.generation) this.pages.set(cacheKey, result)
    return result
  }

  async compare(request: { snapshot: string; left: string; right: string; contextKey?: string; scope?: GitAtlasScope }): Promise<GitAtlasComparison> {
    return this.coalesce(`compare:${this.generation}:${JSON.stringify(request)}`, () => this.readComparison(request))
  }

  private async readComparison(request: { snapshot: string; left: string; right: string; contextKey?: string; scope?: GitAtlasScope }): Promise<GitAtlasComparison> {
    const generation = this.generation
    const before = await this.observe(request.contextKey, request.scope)
    if (request.snapshot !== before.snapshot) this.fail('GIT_STATE_CHANGED')
    const cacheKey = JSON.stringify(['compare', before.snapshot, request.left, request.right])
    const cached = this.pages.get<GitAtlasComparison>(cacheKey)
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
    if ((await this.observe(request.contextKey, request.scope)).snapshot !== before.snapshot) this.fail('GIT_STATE_CHANGED')
    const comparison = { snapshot: before.snapshot, left: { ref: left.ref, sha: left.sha }, right: { ref: right.ref, sha: right.sha }, ...result }
    if (generation === this.generation) this.pages.set(cacheKey, comparison)
    return comparison
  }
}
