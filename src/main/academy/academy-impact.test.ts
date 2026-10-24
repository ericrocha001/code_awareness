import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcademyService } from './academy-service'
import { AcademyLocalAdapter } from './local-adapter'
import { executeAcademyTool, ACADEMY_MCP_TOOLS } from './academy-mcp'
import { hashAcademyPackage } from './academy-package'
import { AcademyStore } from './academy-store'

const pkg = (name: string, body = 'Você pode revisar.', artifacts: Record<string, string> = {}) => ({ skillMd: `---\nname: ${name}\ndescription: Preflight fixture\n---\n${body}`, artifacts })
const paths: string[] = [], services: AcademyService[] = []
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'academy-impact-')); paths.push(root)
  const service = new AcademyService(join(root, 'academy.db')); services.push(service)
  const source = service.store.create({ package: pkg('feature-investment-gate', 'Você pode revisar.', { 'references/rule.md': 'old' }), scope: 'GLOBAL', origin: 'IMPORT' })
  return { service, source }
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('Academy impact projection', () => {
  it('revalidates a stateless fingerprint and distinguishes source, consumer, catalog and candidate drift', async () => {
    const { service, source } = setup()
    const consumer = service.store.create({ package: pkg('consumer', source.name), scope: 'GLOBAL', origin: 'IMPORT' })
    const candidate = pkg(source.name, 'candidate')
    const input = { skillId: source.id, expectedVersion: 1, package: candidate }
    const initial = service.analyzeChangeImpact(input)
    expect(service.verifyChangeImpact({ snapshot: initial.snapshot })).toMatchObject({ state: 'CURRENT', atomicUntilUpdate: false, candidateCheck: 'PROVIDED_IDENTITY_ONLY' })
    expect(service.verifyChangeImpact({ snapshot: initial.snapshot, candidateHash: hashAcademyPackage(pkg(source.name, 'another')) })).toMatchObject({ state: 'STALE', reasons: ['CANDIDATE_CHANGED'] })
    const reordered = Object.fromEntries(Object.entries(initial.snapshot).reverse())
    expect(service.verifyChangeImpact({ snapshot: reordered }).state).toBe('CURRENT')
    service.store.update({ skillId: consumer.id, expectedVersion: 1, package: pkg(consumer.name, `Changed ${source.name}`), origin: 'IMPORT' })
    expect(service.verifyChangeImpact({ snapshot: initial.snapshot })).toMatchObject({ state: 'STALE', reasons: expect.arrayContaining(['CONSUMER_CHANGED', 'CATALOG_OR_REACH_CHANGED']) })
    let snapshot = service.analyzeChangeImpact(input).snapshot
    service.store.create({ package: pkg('new-nonconsumer'), scope: 'GLOBAL', origin: 'IMPORT' })
    expect(service.verifyChangeImpact({ snapshot })).toMatchObject({ state: 'STALE', reasons: ['CATALOG_OR_REACH_CHANGED'] })
    snapshot = service.analyzeChangeImpact(input).snapshot
    service.store.update({ skillId: source.id, expectedVersion: 1, package: pkg(source.name, 'concurrent source edit'), origin: 'IMPORT' })
    expect(service.verifyChangeImpact({ snapshot })).toMatchObject({ state: 'STALE', reasons: ['BASE_CHANGED'] })
    const local = new AcademyLocalAdapter(service).operations
    const remote = await executeAcademyTool(service, 'verify_academy_change_impact', { snapshot })
    expect(JSON.parse((remote.content[0] as { text: string }).text)).toEqual(await local.verify_change_impact.execute({ snapshot }, { connected: () => true }))
    expect(service.verifyChangeImpact({ snapshot: { ...snapshot, fingerprint: '0'.repeat(64) } }).state).toBe('UNKNOWN')
    await service.close()
    expect(service.verifyChangeImpact({ snapshot }).state).toBe('UNKNOWN')
  })
  it('fingerprints scope/association and status changes and uses one consistent SQLite snapshot across connections', () => {
    const { service, source } = setup()
    const a = service.store.upsertDestination(join(paths[0], 'a'), 'a'), b = service.store.upsertDestination(join(paths[0], 'b'), 'b')
    const consumer = service.store.create({ package: pkg('consumer', source.name), scope: 'PROJECT', projectIds: [a.id], origin: 'IMPORT' })
    const input = { skillId: source.id, expectedVersion: 1, package: source.current.package }
    let snapshot = service.analyzeChangeImpact(input).snapshot
    service.store.setDestinationEnabled(a.id, false)
    expect(service.verifyChangeImpact({ snapshot })).toMatchObject({ state: 'STALE', reasons: ['CATALOG_OR_REACH_CHANGED'] })
    expect(service.analyzeChangeImpact(input).consumers.items[0].reach).toBe('AMBIGUOUS')
    service.store.setDestinationEnabled(a.id, true)
    expect(service.verifyChangeImpact({ snapshot }).state).toBe('CURRENT')
    const read = service.store.readImpactCatalog.bind(service.store)
    const ordering = vi.spyOn(service.store, 'readImpactCatalog').mockImplementation((...args) => {
      const catalog = read(...args)
      return { ...catalog, skills: catalog.skills.reverse(), destinations: catalog.destinations.reverse() }
    })
    expect(service.analyzeChangeImpact(input).snapshot.fingerprint).toBe(snapshot.fingerprint)
    ordering.mockRestore()
    service.store.update({ skillId: consumer.id, expectedVersion: 1, package: consumer.current.package, scope: 'PROJECT', projectIds: [b.id], origin: 'IMPORT' })
    expect(service.verifyChangeImpact({ snapshot }).state).toBe('STALE')
    snapshot = service.analyzeChangeImpact(input).snapshot
    service.store.update({ skillId: consumer.id, expectedVersion: 2, package: consumer.current.package, scope: 'GLOBAL', projectIds: [], origin: 'IMPORT' })
    expect(service.verifyChangeImpact({ snapshot }).state).toBe('STALE')
    snapshot = service.analyzeChangeImpact(input).snapshot
    service.store.archive(consumer.id, 3)
    expect(service.verifyChangeImpact({ snapshot }).state).toBe('STALE')
    service.store.restore(consumer.id, 3)
    const other = new AcademyStore(service.store.databasePath)
    const original = service.store.list.bind(service.store)
    let changed = false
    vi.spyOn(service.store, 'list').mockImplementation(status => {
      const result = original(status)
      if (!changed) {
        changed = true
        other.update({ skillId: consumer.id, expectedVersion: 3, package: pkg(consumer.name, 'new external version'), origin: 'IMPORT' })
      }
      return result
    })
    try {
      const during = service.analyzeChangeImpact(input)
      expect(during.consumers.items[0].version).toBe(3)
      expect(service.verifyChangeImpact({ snapshot: during.snapshot }).state).toBe('STALE')
    } finally { other.close() }
  })
  it('keeps direct, negative, broad and ambiguous references as evidence, never dependency verdicts', () => {
    const { service, source } = setup()
    for (const [name, body] of [
      ['signal-driven-feature-design', 'Não use feature-investment-gate como layout.'],
      ['market-intelligence-mining', '[revisão](../feature-investment-gate/references/rule.md)\nfeature-investment-gate\n[missing](../feature-investment-gate/unknown.md)'],
      ['unrelated', 'feature-investment-gate-extra is a different name.']
    ]) service.store.create({ package: pkg(name, body), scope: 'GLOBAL', origin: 'IMPORT' })
    const result = service.analyzeChangeImpact({ skillId: source.id, expectedVersion: 1, package: pkg(source.name, 'Você deve revisar.', { 'references/rule.md': 'new' }), evidence: { limit: 10 } })
    expect(result.totalCandidates).toBe(2)
    const market = result.consumers.items.find(c => c.name === 'market-intelligence-mining')!
    expect(market.evidence.items.map(e => e.changeLink)).toEqual(['EXATO', 'POR_SKILL', 'INDETERMINADO'])
    expect(market.evidence.items[2].nature).toBe('AMBIGUOUS')
    expect(result.consumers.items.find(c => c.name === 'signal-driven-feature-design')!.evidence.items[0]).toMatchObject({ line: 5, changeLink: 'POR_SKILL', excerpt: { text: 'Não use feature-investment-gate como layout.' } })
    expect(JSON.stringify(result)).not.toMatch(/AFFECTED|UNAFFECTED|riskScore/)
  })
  it('restricts disjoint projects and archived consumers while preserving GLOBAL and unknown reach', () => {
    const { service, source } = setup()
    const a = service.store.upsertDestination(join(paths[0], 'a'), 'a'), b = service.store.upsertDestination(join(paths[0], 'b'), 'b')
    service.store.update({ skillId: source.id, expectedVersion: 1, package: source.current.package, scope: 'PROJECT', projectIds: [a.id], origin: 'IMPORT' })
    for (const [name, scope, projectIds] of [['shared', 'PROJECT', [a.id]], ['other', 'PROJECT', [b.id]], ['global', 'GLOBAL', []], ['unknown', 'PROJECT', []]] as const) service.store.create({ package: pkg(name, source.name), scope, projectIds: [...projectIds], origin: 'IMPORT' })
    const archived = service.store.create({ package: pkg('archived', source.name), scope: 'GLOBAL', origin: 'IMPORT' }); service.store.archive(archived.id, 1)
    const result = service.analyzeChangeImpact({ skillId: source.id, expectedVersion: 2, package: source.current.package })
    expect(result.consumers.items.map(c => c.name).sort()).toEqual(['global', 'shared', 'unknown'])
    expect(result.consumers.items.find(c => c.name === 'unknown')!.reach).toBe('AMBIGUOUS')
  })
  it('supports retrospective versions and candidate mode equally through MCP/local, without mutation or distribution', async () => {
    const { service, source } = setup()
    const next = pkg(source.name, 'changed')
    service.store.update({ skillId: source.id, expectedVersion: 1, package: next, origin: 'IMPORT' })
    service.store.create({ package: pkg('consumer', Array(5).fill(source.name).join('\n')), scope: 'GLOBAL', origin: 'IMPORT' })
    const before = service.snapshot(), history = service.history(source.id)
    const write = vi.spyOn(service.store, 'update'), distribution = vi.spyOn(service, 'scheduleReconciliationForSkill')
    const input = { skillId: source.id, baseVersion: 1, targetVersion: 2, evidence: { limit: 1 } }
    const local = new AcademyLocalAdapter(service).operations
    const result = await local.change_impact.execute(input, { connected: () => true })
    const remote = await executeAcademyTool(service, 'analyze_academy_change_impact', input)
    expect(remote.isError).toBeUndefined()
    expect(JSON.parse((remote.content[0] as { text: string }).text)).toEqual(result)
    const projection = service.analyzeChangeImpact(input)
    expect(projection.consumers.items[0].evidence).toMatchObject({ total: 5, nextOffset: 1 })
    expect(service.analyzeChangeImpact({ ...input, consumerId: projection.consumers.items[0].skillId, evidence: { offset: 4 } }).consumers.items[0].evidence.items[0].line).toBe(9)
    expect(service.analyzeChangeImpact({ skillId: source.id, expectedVersion: 2, package: next }).diff.changes.total).toBe(0)
    expect(service.snapshot()).toEqual(before); expect(service.history(source.id)).toEqual(history)
    expect(write).not.toHaveBeenCalled(); expect(distribution).not.toHaveBeenCalled()
    expect(ACADEMY_MCP_TOOLS.some(t => t.name === 'analyze_academy_change_impact')).toBe(true)
    for (const invalid of [{ ...input, package: next }, { skillId: source.id, expectedVersion: 1, package: next }, { ...input, evidence: { limit: 51 } }]) {
      const remoteError = await executeAcademyTool(service, 'analyze_academy_change_impact', invalid)
      expect(remoteError.isError).toBe(true)
      expect(() => local.change_impact.execute(invalid, { connected: () => true })).toThrow()
    }
  })
})
