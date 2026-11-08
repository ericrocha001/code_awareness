import type { GitHubIntegrationService } from '../github/github-integration-service'
import type { RegistryBatch } from './checkpoint-registry'
import { digest } from './privacy'

type CatalogReader = GitHubIntegrationService['pullRequestCatalogPage']
interface Scan {
  version: 1; scope?: string; epoch: string; pass?: string; phase: 'FULL' | 'PREFIX' | 'IDLE'; page: number; rolling: string
  previousPass?: string; high?: string; highWatermarkUpdatedAt?: string; cutoff?: string
  nextScanAt?: number; nextFullAt?: number; lastAdvanceAt?: string; lastAttemptAt?: string; reasonCode?: string
}
const seed = digest('GITHUB_UPDATED_DESC_V1')
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
function parse(text: string | undefined): Scan | undefined {
  if (!text) return
  try {
    const value = JSON.parse(text)
    if (value.version !== 1 || !['FULL','PREFIX','IDLE'].includes(value.phase) || !Number.isSafeInteger(value.page) || value.page < 1 || !/^[a-f0-9]{64}$/.test(value.rolling) || typeof value.epoch !== 'string' || ['scope','pass','previousPass'].some(key => value[key] !== undefined && (typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/.test(value[key]))) ||
      ['high','highWatermarkUpdatedAt','cutoff','lastAdvanceAt','lastAttemptAt'].some(key => value[key] !== undefined && !timestamp(value[key])) || ['nextScanAt','nextFullAt'].some(key => value[key] !== undefined && !Number.isFinite(value[key]))) return
    return value
  } catch { return }
}
export async function discoverGitHubPage(options: { repositoryId: string; root: string; read: CatalogReader; cursor?: string; epoch: string; assertCurrent: () => void; assertNetwork?: () => void; now?: number }): Promise<RegistryBatch[]> {
  const now = options.now ?? Date.now(), observedAt = new Date(now).toISOString(), saved = parse(options.cursor)
  if (saved?.phase === 'IDLE' && saved.epoch === options.epoch && (saved.nextScanAt ?? 0) > now) return []
  let state: Scan = saved ?? { version: 1, epoch: options.epoch, phase: 'FULL', page: 1, rolling: seed }
  if (state.epoch !== options.epoch) state = { ...state, epoch: options.epoch, page: 1, rolling: seed, high: undefined, phase: 'FULL', previousPass: undefined, pass: undefined }
  if (state.phase !== 'IDLE' && state.lastAttemptAt && now - Date.parse(state.lastAttemptAt) > 60000) state = { ...state, page: 1, rolling: seed, high: undefined, previousPass: undefined, pass: undefined, phase: 'FULL' }
  if (state.phase === 'IDLE') state = { ...state, page: 1, rolling: seed, high: undefined, previousPass: undefined, pass: undefined,
    phase: state.highWatermarkUpdatedAt && (state.nextFullAt ?? 0) > now ? 'PREFIX' : 'FULL',
    cutoff: state.highWatermarkUpdatedAt ? new Date(Date.parse(state.highWatermarkUpdatedAt) - 300000).toISOString() : undefined }
  state.pass ??= digest(JSON.stringify([options.epoch, now, state.previousPass]))
  const batch = (cursor: Scan, status: string): RegistryBatch => ({ repositoryId: options.repositoryId, source: 'GITHUB_DISCOVERY', revision: digest(JSON.stringify(cursor)), cursor: JSON.stringify(cursor), status, edges: [] })
  try {
    const guard = options.assertNetwork ?? options.assertCurrent
    guard()
    const page = await options.read(options.root, state.page, guard)
    guard()
    if (page.repositoryId !== options.repositoryId || !/^[a-f0-9]{64}$/.test(page.scope) || page.items.length > 100 || page.representation.page !== state.page || page.items.some(pr => !timestamp(pr.updatedAt) || !Number.isSafeInteger(pr.number) || pr.number < 1 || pr.base.repositoryId !== page.providerRepositoryId)) throw new Error('REMOTE_IDENTITY_MISMATCH')
    if (state.scope && state.scope !== page.scope) return [batch({ version: 1, epoch: options.epoch, scope: page.scope, phase: 'FULL', page: 1, rolling: seed, lastAttemptAt: observedAt, reasonCode: 'SOURCE_IDENTITY_CHANGED' }, 'PARTIAL')]
    state = { ...state, scope: page.scope, lastAttemptAt: observedAt }
    const rows = page.items.map(pr => ({ id: pr.id, number: pr.number, updatedAt: pr.updatedAt, head: pr.head, base: pr.base, state: pr.state, merged: pr.merged, mergedAt: pr.mergedAt, mergeCommit: pr.mergeCommit, draft: pr.draft }))
    const unique = new Set(rows.map(pr => pr.id))
    if (unique.size !== rows.length || rows.some((pr, index) => index > 0 && Date.parse(rows[index - 1].updatedAt) < Date.parse(pr.updatedAt))) throw new Error('CATALOG_ORDER_CHANGED')
    const batches: RegistryBatch[] = rows.map(pr => ({ repositoryId: options.repositoryId, source: 'GITHUB_CATALOG:PR:' + pr.number,
      revision: digest(JSON.stringify(pr)), cursor: JSON.stringify({ ...pr, scanPass: state.pass }), status: 'OBSERVED_SNAPSHOT', entities: [{ kind: 'PR', id: String(pr.number) }], edges: [] }))
    const rolling = digest(JSON.stringify([state.rolling, rows, page.hasNext]))
    const high = [state.high, ...rows.map(pr => pr.updatedAt)].filter(timestamp).sort((a, b) => Date.parse(b) - Date.parse(a))[0]
    const prefixEnd = state.phase === 'PREFIX' && state.cutoff && rows.some(pr => Date.parse(pr.updatedAt) < Date.parse(state.cutoff!))
    let status = 'PARTIAL'
    let next: Scan = { ...state, rolling, high, lastAdvanceAt: observedAt, reasonCode: 'BACKLOG_PENDING' }
    if (!page.hasNext || prefixEnd) {
      if (state.phase === 'FULL' && state.previousPass === rolling) {
        next = { ...next, phase: 'IDLE', page: 1, rolling: seed, previousPass: undefined, highWatermarkUpdatedAt: high ?? state.highWatermarkUpdatedAt,
          nextScanAt: now + 30000, nextFullAt: now + 3600000, reasonCode: 'STABLE_REPEATED_SCAN' }
        status = 'COMPLETE'
      } else if (state.phase === 'FULL') next = { ...next, page: 1, rolling: seed, high: undefined, previousPass: rolling, pass: digest(state.pass! + rolling), reasonCode: 'VERIFYING_MUTABLE_CATALOG' }
      else {
        next = { ...next, phase: 'IDLE', page: 1, rolling: seed, previousPass: undefined, nextScanAt: now + 30000, reasonCode: 'OVERLAP_WINDOW_ONLY' }
        status = 'PARTIAL'
      }
    } else next.page++
    batches.push(batch(next, status))
    return batches
  } catch (error) {
    options.assertCurrent()
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof Error ? error.message : ''
    const allowed = ['NETWORK_NOT_AUTHORIZED','RATE_LIMITED','PERMISSION_DENIED','TIMEOUT','NETWORK_ERROR','REAUTH_REQUIRED','REMOTE_CONTEXT_CHANGED','REMOTE_IDENTITY_MISMATCH','CATALOG_ORDER_CHANGED','ACCOUNT_IDENTITY_UNAVAILABLE']
    return [batch({ ...state, page: 1, rolling: seed, high: undefined, previousPass: undefined, phase: 'FULL', pass: undefined, lastAttemptAt: observedAt, reasonCode: allowed.includes(code) ? code : 'SOURCE_UNAVAILABLE' }, code === 'NETWORK_NOT_AUTHORIZED' ? code : 'UNAVAILABLE')]
  }
}
