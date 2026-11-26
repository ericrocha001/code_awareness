import { afterEach, expect, it } from 'vitest'
import { fixture, markdown, storedLegacyArtifact, storedLegacyIdentity, withFixtureDatabase } from './continuum-test-fixtures'
import { ArtifactStore, computeContentHash } from './artifact-store'
import { ContinuumService } from './continuum-service'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from './agent-authority'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import type { GitOperationsService } from '../git-operations/git-operations-service'
import type { ExecutionBranchSnapshot } from '../../shared/types/execution-branch-types'
import { registrySources } from '../session-context/registry-sources'
import { SessionStore } from '../session-context/store'
import { ValidationLedger } from '../validation-ledger/validation-ledger'
import { join } from 'node:path'
const closes: (() => void)[] = []
afterEach(() => { closes.reverse().forEach(close => close()); closes.length = 0 })
function setup(repo = 'catalog-A') { const f = fixture(repo); closes.push(f.close); return f }
it('issues distinct immutable receipts atomically and recovers exact revision facts after restart and replay', () => {
  const f = setup(), raw = markdown('Receipts')
  const first = f.service.publish(raw), second = f.service.publish(raw)
  const receipt = first.publicationReceipt!
  expect(receipt).toMatchObject({ schemaVersion: 1, repositoryId: 'catalog-A', artifactId: first.artifactId, revision: 1, contentHash: computeContentHash(raw), action: 'PUBLISH' })
  expect(second.publicationReceipt!.receiptId).not.toBe(receipt.receiptId)
  expect(first.replayed).toBe(false)
  expect(f.service.replayPublicationReceipt(receipt.receiptId)).toEqual({ ...first, replayed: true })
  expect(f.service.list().artifacts).toHaveLength(2)
  const updated = f.service.update(first.artifactId, 1, 'New literal body.')
  expect(updated.publicationReceipt).toMatchObject({ artifactId: first.artifactId, revision: 2, action: 'UPDATE' })
  expect(f.service.readPublicationReceipt(receipt.receiptId)).toEqual(receipt)
  expect(() => f.service.replayPublicationReceipt(receipt.receiptId)).toThrow('STALE_PUBLICATION_RECEIPT')
  expect(() => f.service.update(first.artifactId, 1, raw)).toThrow('REVISION_CONFLICT')
  withFixtureDatabase(f.path, db => {
    expect(db.prepare('SELECT count(*) AS n FROM publication_receipts').get()).toEqual({ n: 3 })
    expect(() => db.prepare('UPDATE publication_receipts SET action=? WHERE receipt_id=?').run('UPDATE', receipt.receiptId)).toThrow('Immutable publication receipt')
  }, false)
  const reopened = new ArtifactStore(f.path, 'catalog-A')
  try { expect(new ContinuumService(reopened).readPublicationReceipt(receipt.receiptId)).toEqual(receipt) } finally { reopened.close() }
  expect(setup('catalog-B').service.readPublicationReceipt(receipt.receiptId)).toBeNull()
  expect(f.service.readPublicationReceipt('publication-00000000-0000-0000-0000-000000000000')).toBeNull()
  expect(f.service.get(first.artifactId)!.revision).toBe(2)
})
it('rolls back document, revision and receipt together on invalid relations and detects corrupted receipts', () => {
  const f = setup()
  expect(() => f.service.publish(markdown('Invalid', 'relations: [{artifactId: absent, kind: implements}]\n'))).toThrow('INVALID_RELATION')
  expect(f.service.list().artifacts).toEqual([])
  const published = f.service.publish(markdown())
  withFixtureDatabase(f.path, db => {
    expect(db.prepare('SELECT count(*) AS n FROM publication_receipts').get()).toEqual({ n: 1 })
    db.exec('DROP TRIGGER publication_receipts_no_update')
    db.prepare('UPDATE publication_receipts SET payload=?').run(JSON.stringify({ ...published.publicationReceipt, repositoryId: 'forged' }))
  }, false)
  expect(() => f.service.readPublicationReceipt(published.publicationReceipt!.receiptId)).toThrow('PUBLICATION_RECEIPT_INTEGRITY')
})

it('binds only authorized exact revisions, preserves history across scopes, and paginates persisted receipts', async () => {
  const f = setup(), { service } = f
  async function scope(label: string) {
    const plan = service.publish('# Plan ' + label + '\n\nA document that defines this execution.', { kind: 'EXECUTABLE_PLAN' })
    const snapshot = { repositoryId: 'catalog-A', worktreeId: label.repeat(64), worktreeGeneration: 'd'.repeat(64),
      branchRef: 'refs/heads/' + label, branchGeneration: 'e'.repeat(64), branchRevision: 'f'.repeat(64),
      head: 'a'.repeat(40), fingerprint: 'b'.repeat(64) } satisfies ExecutionBranchSnapshot
    const observe = async () => snapshot
    const boot = await service.bootstrapExecution({ planArtifactId: plan.artifactId }, observe)
    const current = () => true
    const authority = authorizeArtifactAgent(authenticatedAgentPrincipal('MCP', current), 'catalog-A', current, snapshot.worktreeId)
    const { anchor } = await service.resolveExecutionContext(authority, undefined, observe)
    return { plan, authority, anchor: anchor!, observe, executionId: boot.executionId }
  }
  const a = await scope('a'), b = await scope('b')
  const adapter = new ChannelMcpAdapter({ projectId: 'catalog-A', repoRoot: f.dir, navigation: {} as never,
    continuum: service,
    sessionContext: { call: async () => { throw new Error('UNEXPECTED_GRAPH_SCAN') } },
    gitOperations: { deliverySnapshot: (id?: string) => id === a.authority.worktreeId ? a.observe() : b.observe() } as GitOperationsService })
  const discover = async (selector: object, limit = 20, cursor?: string) => {
    const response = await adapter.callTool('discover_execution_context', { selector, view: 'MEMBERSHIP', limit, cursor }, undefined, a.authority)
    expect(response.isError, JSON.stringify(response.content)).toBeUndefined()
    return JSON.parse(response.content[0].type === 'text' ? response.content[0].text : '{}')
  }
  const membership = { planArtifactId: a.plan.artifactId, expectedPlanRevision: a.plan.revision }
  const raw = markdown('Investigation')
  const result = await adapter.callTool('publish_artifact', { rawMarkdown: raw, membership }, undefined, a.authority)
  expect(result.isError).toBeUndefined()
  const published = JSON.parse(result.content[0].type === 'text' ? result.content[0].text : '{}')
  const handoff = service.publish(`---\nname: Handoff\ndescription: Authorized handoff fixture\nkind: IMPLEMENTATION_HANDOFF\nrelations: [{ artifactId: ${a.plan.artifactId}, kind: implements }]\n---\nHandoff body\n`, {}, a.authority, a.anchor)
  expect(handoff.publicationReceipt?.documentaryMembership).toBe('HANDOFF_IMPLEMENTS')
  const neutral = service.publish(markdown('Independent'), {}, a.authority, a.anchor)
  expect(neutral.publicationReceipt?.deliveryContext?.executionId).toBe(a.executionId)
  expect(service.membershipAt(neutral.artifactId)).toBeNull()
  const newPlan = service.publish('# Pending plan\n\nA plan authored during this execution.', { kind: 'EXECUTABLE_PLAN' }, a.authority, a.anchor)
  expect(newPlan.publicationReceipt?.documentaryMembership).toBeUndefined()
  expect(f.store.getExecutionIdentity(newPlan.artifactId)).toBeNull()
  const legacy = storedLegacyArtifact(f.store, markdown('Legacy declaration', 'executionId: ' + a.executionId + '\n'))
  expect(service.membershipAt(legacy.artifactId)).toBeNull()
  expect(service.publishHuman(markdown('Human', '', 'Independent human publication')).publicationReceipt?.documentaryMembership).toBeUndefined()
  expect(() => service.publish(raw, { membership }, b.authority, b.anchor)).toThrow('MEMBERSHIP_TARGET_CONFLICT')
  expect(() => service.publish(raw, { membership: { ...membership, expectedPlanRevision: 2 } }, a.authority, a.anchor)).toThrow('MEMBERSHIP_TARGET_CONFLICT')
  const conflict = `---\nname: Conflict\ndescription: Conflicting handoff fixture\nkind: IMPLEMENTATION_HANDOFF\nrelations: [{ artifactId: ${a.plan.artifactId}, kind: implements }, { artifactId: ${b.plan.artifactId}, kind: implements }]\n---\nHandoff body\n`
  expect(() => service.publish(conflict, {}, a.authority, a.anchor)).toThrow('MEMBERSHIP_TARGET_CONFLICT')
  expect(() => service.publish(markdown('Forged', 'metadata: { executionId: counterfeit }\n'))).toThrow('AUTHORITATIVE_METADATA_RESERVED')
  expect(() => service.publish(raw, { membership })).toThrow('MEMBERSHIP_AUTHORITY_REQUIRED')
  const page = await discover({ type: 'EXECUTION', id: a.executionId }, 1)
  expect(page.members).toMatchObject([{ artifactId: published.artifactId }])
  expect((await discover({ type: 'EXECUTION', id: a.executionId }, 1, page.nextCursor)).members).toMatchObject([{ artifactId: handoff.artifactId }])
  expect((await discover({ type: 'EXECUTION', id: b.executionId })).members).toEqual([])
  const delivery = service.publicationDeliveryPage(undefined, 1, { executionId: a.executionId })
  expect(service.publicationDeliveryPage(delivery.nextCursor, 1, { executionId: a.executionId }).observations[0]?.artifactId).toBe(handoff.artifactId)
  expect(service.replayPublicationReceipt(published.publicationReceipt.receiptId).replayed).toBe(true)
  const sessions = new SessionStore(join(f.dir, 'sessions.db'), 'catalog-A')
  const ledger = new ValidationLedger(join(f.dir, 'validation.db'))
  closes.push(() => { sessions.close(); ledger.close() })
  const readRegistry = registrySources({ repositoryId: 'catalog-A', root: f.dir, continuum: () => service, ledger,
    github: { commitPullRequests: async () => [], getPullRequest: async () => { throw new Error('UNEXPECTED_NETWORK') },
      pullRequestCommits: async () => { throw new Error('UNEXPECTED_NETWORK') } },
    networkAllowed: () => false, assertCurrent: () => {} })
  const selectedExecution = { kind: 'EXECUTION' as const, id: a.executionId }
  sessions.registry.apply({ repositoryId: 'catalog-A', source: 'DELIVERY_CONTINUUM', revision: 'known-global-page', cursor: '1', status: 'PARTIAL', edges: [] }, undefined)
  const globalCursor = sessions.registry.cursors().DELIVERY_CONTINUUM
  sessions.registry.applyAll(await readRegistry({ selector: selectedExecution, cursors: sessions.registry.cursors() }), () => {})
  expect(sessions.registry.cursors().DELIVERY_CONTINUUM).toBe(globalCursor)
  const graph = sessions.registry.contextGraph(selectedExecution, undefined, 1, true)
  expect(graph.edges.filter(edge => edge.evidenceKind === 'DOCUMENTARY_MEMBERSHIP_VERIFIED').map(edge => edge.evidenceRef).sort())
    .toEqual([published.publicationReceipt.receiptId, handoff.publicationReceipt!.receiptId].sort())
  expect(graph.edges.some(edge => edge.evidenceKind === 'EXECUTION_ROOT_VERIFIED')).toBe(true)
  const updated = await service.updateAgent(b.authority, published.artifactId, 1, markdown('Edited elsewhere'), {}, undefined, b.observe)
  expect(updated.state).toBe('PERSISTED')
  expect('publicationReceipt' in updated && updated.publicationReceipt?.deliveryContext?.executionId).toBe(b.executionId)
  expect(service.membershipAt(published.artifactId)).toBeNull()
  expect((await discover({ type: 'ARTIFACT', id: published.artifactId, revision: 1 })).membership).toMatchObject({ executionId: a.executionId, evidenceRef: published.publicationReceipt.receiptId })
  await service.updateAgent(a.authority, published.artifactId, 2, markdown('Revalidated'), {}, undefined, a.observe)
  expect(service.membershipAt(published.artifactId)).toMatchObject({ executionId: a.executionId, revision: 3 })
  await service.updateAgent(a.authority, published.artifactId, 3, markdown('Independent now'), { membership: { action: 'UNLINK', reason: 'Wrong scope' } }, undefined, a.observe)
  expect(service.membershipAt(published.artifactId)).toBeNull()
  expect(service.membershipAt(published.artifactId, 3)?.executionId).toBe(a.executionId)
  const repaired = await service.repairMetadata(a.authority, handoff.artifactId, 1, a.observe)
  expect(repaired).toMatchObject({ state: 'PERSISTED', revision: 2, publicationReceipt: { documentaryMembership: 'HANDOFF_IMPLEMENTS' } })
  expect(service.membershipAt(handoff.artifactId)).toMatchObject({ revision: 2, executionId: a.executionId })

  const count = service.list().artifacts.length
  withFixtureDatabase(f.path, db => db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON publication_receipts BEGIN SELECT RAISE(ABORT, 'receipt failure'); END"), false)
  expect(() => service.publish(raw, { membership }, a.authority, a.anchor)).toThrow('receipt failure')
  expect(service.list().artifacts).toHaveLength(count)
  withFixtureDatabase(f.path, db => db.exec('DROP TRIGGER fail_receipt'), false)
  const reopened = new ArtifactStore(f.path, 'catalog-A')
  try {
    expect(reopened.membershipAt(handoff.artifactId, 1)?.evidenceRef).toBe(handoff.publicationReceipt?.receiptId)
    expect(reopened.executionMembers(a.executionId).members.map(member => member?.artifactId)).toEqual([handoff.artifactId])
  } finally { reopened.close() }
  service.revokeExecutionActivation({ worktreeId: a.authority.worktreeId! })
  expect(() => service.publish(raw, { membership }, a.authority, a.anchor)).toThrow('MEMBERSHIP_ACTIVATION_INVALID')
  service.update(b.plan.artifactId, 1, '# Revised plan\n\nChange after eligibility was checked.')
  expect(() => service.publish(raw, { membership: { planArtifactId: b.plan.artifactId, expectedPlanRevision: 1 } }, b.authority, b.anchor)).toThrow('DELIVERY_CONTEXT_STALE')
  const duplicate = storedLegacyArtifact(f.store, `---\nname: Duplicate legacy plan\ndescription: Collision fixture\nkind: EXECUTABLE_PLAN\nexecutionId: ${a.executionId}\n---\nBody`)
  storedLegacyIdentity(f.path, duplicate, a.executionId)
  expect(service.executionMembers(a.executionId)).toMatchObject({ coverage: 'PARTIAL', members: [] })
  await expect(service.bootstrapExecution({ planArtifactId: duplicate.artifactId }, a.observe)).rejects.toThrow('EXECUTION_IDENTITY_CONFLICT')
})
