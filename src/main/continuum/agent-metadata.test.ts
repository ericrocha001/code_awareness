import { afterEach, expect, it, vi } from 'vitest'
import { fixture, withFixtureDatabase } from './continuum-test-fixtures'
import { ContinuumService } from './continuum-service'
import { assertArtifactAgent, authenticatedAgentPrincipal, authorizeArtifactAgent } from './agent-authority'
import { lifecycleReceipt } from './artifact-lifecycle'
import { parseAgentArtifactUpdate, parseContinuumAgentRequest } from './continuum-agent'
import sharp from 'sharp'
import { PublicationReceipts } from './publication-receipts'
import type { LifecycleDependencies } from './artifact-lifecycle-policy'
import type { ProofWithFreshness } from '../validation-ledger/validation-ledger-types'
import { McpLifecycle } from '../mcp/mcp-lifecycle'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'

const closes: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); closes.splice(0).reverse().forEach(close => close()) })
function setup() {
  const f = fixture(); closes.push(f.close)
  const approve = vi.fn(async () => { throw new Error('DESKTOP_MUST_NOT_BE_REQUIRED') })
  const proofs = new Map<string, ProofWithFreshness>()
  const dependencies: LifecycleDependencies = { approve, proof: async id => structuredClone(proofs.get(id) ?? null) }
  const service = new ContinuumService(f.store, undefined, undefined, dependencies)
  const authority = authorizeArtifactAgent(authenticatedAgentPrincipal('LOCAL_AGENT_CHANNEL', () => true), f.store.repositoryId, () => true, 'fixture-worktree')
  const plan = service.publish('# P6 plan\n\nAll required changes are specified for this scoped delivery.', { kind: 'EXECUTABLE_PLAN' })
  const report = service.publish(`---\nname: Existing evidence\ndescription: Scoped delivery report with explicit limits\nkind: OBSERVATION\nrelations:\n  - artifactId: ${plan.artifactId}\n    kind: validates\n---\n# Existing report\n\nScoped tests passed; executor-reported checkout evidence is not independently CURRENT.`)
  const lifecycle = { evidenceRefs: [], attestation: { rationale: 'Reviewed the existing delivery report against all plan criteria.', limitations: 'Executor report lacks automatic freshness; this is an accountable agent judgment.', references: [{ type: 'ARTIFACT' as const, repositoryId: f.store.repositoryId, artifactId: report.artifactId, expectedRevision: 1 }] } }
  return { ...f, service, authority, approve, dependencies, proofs, plan, report, lifecycle }
}
function proofFor(f: ReturnType<typeof setup>, id: string, finishedAt: string): ProofWithFreshness {
  return { proofId: id, kind: 'TARGETED_TEST', producer: 'SYSTEM', status: 'PASSED', startedAt: finishedAt, finishedAt, durationMs: 0, scope: ['metadata'], summary: 'Verified source fact', metrics: null, sourceFingerprint: 'fixture', runtimeInstanceId: null,
    commandProfile: { command: 'private-source-command', source: { version: 1, repositoryId: f.store.repositoryId, repositoryDirectory: 'fixture', cwd: 'fixture', worktreeId: 'fixture', generation: 'fixture', head: 'fixture', branch: 'fixture', indexRevision: 'fixture', worktreeRevision: 'fixture' } },
    evidenceFor: [f.plan.artifactId], deduplicationKey: null, recordedAt: finishedAt, freshness: 'CURRENT' }
}

it('edits description, relations, tags and status in one revision without a desktop or a required Handoff, and replays once', async () => {
  const f = setup(), original = f.service.get(f.plan.artifactId)!
  const raw = original.rawMarkdown.replace('status: PENDING', `status: COMPLETED\ntags: [p6-reviewed]\nrelations:\n  - artifactId: ${f.report.artifactId}\n    kind: derived-from`).replace(original.metadata.description!, 'Delivery completed with scoped evidence')
  const result = await f.service.updateAgent(f.authority, f.plan.artifactId, 1, raw, {}, f.lifecycle)
  expect(result).toMatchObject({ state: 'PERSISTED', revision: 2, lifecycleReceipt: { review: { evidenceMode: 'REVIEWED_ATTESTATION', supporting: null }, approval: { source: 'AUTHENTICATED_AUTHORITY', principalId: f.authority.principal.principalId } } })
  expect(f.approve).not.toHaveBeenCalled()
  const read = f.service.get(f.plan.artifactId)!
  expect(read).toMatchObject({ metadata: { status: 'COMPLETED', tags: ['p6-reviewed'], description: 'Delivery completed with scoped evidence' }, lifecycle: { evidenceMode: 'REVIEWED_ATTESTATION' } })
  expect(f.store.list({ tag: 'p6-reviewed', status: 'COMPLETED' }).artifacts.map(a => a.artifactId)).toEqual([f.plan.artifactId])
  expect(f.store.getRevision(f.plan.artifactId, 1)!.rawMarkdown).toBe(original.rawMarkdown)
  expect(await f.service.updateAgent(f.authority, f.plan.artifactId, 1, raw, {}, f.lifecycle)).toMatchObject({ replayed: true, revision: 2 })
})

it('refuses forged authority, wrong repository, stale revisions, invalid tags and policy bypass without partially editing', async () => {
  const f = setup(), before = f.service.get(f.plan.artifactId)!, raw = before.rawMarkdown
  await expect(f.service.updateAgent({ ...f.authority }, before.artifactId, 1, raw)).rejects.toThrow('AGENT_UNAUTHORIZED')
  const other = authorizeArtifactAgent(authenticatedAgentPrincipal('MCP', () => true), 'other-repo', () => true)
  expect(() => assertArtifactAgent(other, f.store.repositoryId)).toThrow('REPOSITORY_MISMATCH')
  await expect(f.service.updateAgent(other, before.artifactId, 1, raw)).rejects.toThrow('REPOSITORY_MISMATCH')
  await expect(f.service.updateAgent(f.authority, before.artifactId, 4, raw)).rejects.toThrow('REVISION_CONFLICT')
  await expect(f.service.updateAgent(f.authority, before.artifactId, 1, raw.replace('status: PENDING', 'status: PENDING\ntags: [Invalid Tag]'))).rejects.toThrow()
  await expect(f.service.updateAgent(f.authority, before.artifactId, 1, raw.replace('kind: EXECUTABLE_PLAN', 'kind: DOCUMENT').replace('PENDING', 'COMPLETED'))).rejects.toThrow('LIFECYCLE_POLICY_CHANGE_REQUIRES_REVIEW')
  expect(() => parseAgentArtifactUpdate({ artifactId: before.artifactId, expectedRevision: 1, rawMarkdown: raw, principalId: 'forged' })).toThrow()
  expect(() => parseContinuumAgentRequest('repair_artifact_metadata', { artifactId: before.artifactId, expectedRevision: 1, contentHash: 'invented' })).toThrow('INVALID_ARGUMENT')
  expect(await f.service.updateAgent(f.authority, before.artifactId, 1, raw.replace('status: PENDING', 'status: COMPLETED'))).toMatchObject({ state: 'REVIEW_REQUIRED' })
  expect(f.service.get(before.artifactId)).toEqual(before)
})

it('permits supported kind correction with explicit contextual judgment while enforcing the corrected kind policy', async () => {
  const f = setup(), before = f.store.get(f.plan.artifactId)!
  const corrected = before.rawMarkdown.replace('kind: EXECUTABLE_PLAN', 'kind: ARCHITECTURAL_DECISION').replace('status: PENDING', 'status: ACTIVE')
  expect(await f.service.updateAgent(f.authority, before.artifactId, 1, corrected, {}, f.lifecycle)).toMatchObject({ state: 'PERSISTED', revision: 2 })
  expect(f.service.get(before.artifactId)!.metadata).toMatchObject({ kind: 'ARCHITECTURAL_DECISION', status: 'ACTIVE' })
  const invalid = corrected.replace('status: ACTIVE', 'status: COMPLETED')
  expect(await f.service.updateAgent(f.authority, before.artifactId, 2, invalid, {}, f.lifecycle)).toMatchObject({ state: 'REVIEW_REQUIRED', reason: 'POLICY_OR_REASON_MISMATCH' })
  expect(f.store.get(before.artifactId)!.revision).toBe(2)
})

it.each(['{}', '{broken'])('repairs corrupted technical projections from immutable sources without decoding the damaged metadata: %s', damagedMetadata => {
  const f = setup(), original = f.store.get(f.plan.artifactId)!
  withFixtureDatabase(f.path, db => db.prepare("UPDATE artifacts SET content_hash='corrupt', name='wrong', created_at='2000-01-01', metadata_json=? WHERE artifact_id=?").run(damagedMetadata, original.artifactId), false)
  const repair = f.service.repairMetadata(f.authority, original.artifactId, 1)
  expect(repair).toMatchObject({ state: 'PERSISTED', revision: 2, publicationReceipt: { contentHash: original.contentHash } })
  const read = f.store.get(original.artifactId)!
  expect(read).toMatchObject({ artifactId: original.artifactId, contentHash: original.contentHash, createdAt: original.createdAt, metadata: original.metadata, provenance: { technicalRepair: { sourceRevision: 1, principalId: f.authority.principal.principalId } } })
  expect(f.store.getRevision(original.artifactId, 1)).toEqual(original)
  expect(f.service.repairMetadata(f.authority, original.artifactId, 1)).toMatchObject({ replayed: true, revision: 2 })
})

it('repairs visual metadata from its canonical revision while verifying and preserving the original media', async () => {
  const f = setup(), data = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#123456' } }).webp({ lossless: true }).toBuffer()
  const published = await f.service.publishVisual('# Visual repair\n\nCanonical image bytes and descriptive context must remain intact.', data)
  const original = f.service.getVisual(published.artifactId)
  withFixtureDatabase(f.path, db => db.prepare("UPDATE artifacts SET metadata_json='{broken', content_hash='corrupt' WHERE artifact_id=?").run(published.artifactId), false)
  expect(f.service.repairMetadata(f.authority, published.artifactId, 1)).toMatchObject({ state: 'PERSISTED', revision: 2 })
  const repaired = f.service.getVisual(published.artifactId)
  expect(repaired.media).toEqual(original.media)
  expect(repaired.data).toEqual(data)
  expect(repaired.artifact.rawMarkdown).toBe(original.artifact.rawMarkdown)
})

it('binds actual MCP writes to the canonical repository rather than the Code Map project id and rejects forged binding headers', async () => {
  const f = setup(), mcp = new McpLifecycle({ log: () => {} })
  try {
    await mcp.activateContext({ projectId: 'different-code-map-id', repoRoot: f.dir, navigation: {} as ProjectContextNavigation, continuum: f.service })
    const state = mcp.getState()
    if (state.status !== 'RUNNING') throw new Error('MCP unavailable')
    const raw = f.store.get(f.plan.artifactId)!.rawMarkdown.replace('status: PENDING', 'status: CANCELLED')
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_artifact', arguments: { artifactId: f.plan.artifactId, expectedRevision: 1, rawMarkdown: raw } } })
    const headers = { 'content-type': 'application/json', ...mcp.getAgentBindingHeaders() }
    const forged = await fetch(state.endpoint, { method: 'POST', headers: { ...headers, 'x-code-awareness-binding': 'forged', 'x-code-awareness-principal': 'admin' }, body })
    expect(forged.status).toBe(409)
    const result = await fetch(state.endpoint, { method: 'POST', headers, body }).then(r => r.json()) as any
    expect(result.result.isError).toBeUndefined()
    expect(JSON.parse(result.result.content[0].text)).toMatchObject({ state: 'PERSISTED', revision: 2 })
    expect(f.service.get(f.plan.artifactId)!.metadata.status).toBe('CANCELLED')
    expect(f.approve).not.toHaveBeenCalled()
  } finally { await mcp.dispose() }
})

it('rolls combined status, tags, indexes, history and receipts back atomically on publication failure', async () => {
  const f = setup(), before = f.store.get(f.plan.artifactId)!
  vi.spyOn(PublicationReceipts.prototype, 'issue').mockImplementation(() => { throw new Error('receipt failure') })
  await expect(f.service.updateAgent(f.authority, before.artifactId, 1, before.rawMarkdown.replace('status: PENDING', 'status: COMPLETED\ntags: [rollback-tag]'), {}, f.lifecycle)).rejects.toThrow('receipt failure')
  expect(f.store.get(before.artifactId)).toEqual(before)
  expect(f.store.getRevision(before.artifactId, 2)).toBeNull()
  expect(f.store.list({ tag: 'rollback-tag' }).artifacts).toHaveLength(0)
  expect(lifecycleReceipt(f.store.get(before.artifactId)!)).toBeNull()
})

it('keeps agent corrections on stale automation replay and accepts a later verified fact without losing unrelated metadata', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-07T12:00:00Z'))
  const f = setup(), first = proofFor(f, 'automatic-first', '2026-11-07T11:59:00Z')
  f.proofs.set(first.proofId, first)
  expect(await f.service.reconcileAutomaticMetadata(f.plan.artifactId, 1, first.proofId, { description: 'Hook value', customNull: null })).toMatchObject({ state: 'PERSISTED', revision: 2 })
  const corrected = f.store.get(f.plan.artifactId)!.rawMarkdown.replace('Hook value', 'Agent corrected value').replace('status: PENDING', 'status: PENDING\ncustomField: preserved').replace('customNull: null\n', '')
  await f.service.updateAgent(f.authority, f.plan.artifactId, 2, corrected)
  expect(await f.service.reconcileAutomaticMetadata(f.plan.artifactId, 1, first.proofId, { description: 'Hook value', customNull: null })).toMatchObject({ replayed: true, revision: 3 })
  const stale = proofFor(f, 'automatic-delayed', '2026-11-07T11:59:30Z'); f.proofs.set(stale.proofId, stale)
  expect(await f.service.reconcileAutomaticMetadata(f.plan.artifactId, 3, stale.proofId, { description: 'Old delayed value', customNull: null })).toMatchObject({ state: 'PERSISTED', conflicts: ['description', 'customNull'] })
  expect(f.store.get(f.plan.artifactId)!.metadata.description).toBe('Agent corrected value')
  expect(f.store.get(f.plan.artifactId)!.metadata).not.toHaveProperty('customNull')
  vi.setSystemTime(new Date('2026-11-07T12:01:00Z'))
  const newer = proofFor(f, 'automatic-new-fact', '2026-11-07T12:00:30Z'); f.proofs.set(newer.proofId, newer)
  const revision = f.store.get(f.plan.artifactId)!.revision
  expect(await f.service.reconcileAutomaticMetadata(f.plan.artifactId, revision, newer.proofId, { description: 'New verified fact' })).toMatchObject({ state: 'PERSISTED', conflicts: [] })
  expect(f.store.get(f.plan.artifactId)!.metadata).toMatchObject({ description: 'New verified fact', customField: 'preserved', status: 'PENDING' })
  newer.freshness = 'UNVERIFIABLE'
  await expect(f.service.reconcileAutomaticMetadata(f.plan.artifactId, revision + 1, newer.proofId, { description: 'Do not apply' })).rejects.toThrow('AUTOMATION_SOURCE_UNVERIFIED')
})

it('uses contextual UNVERIFIABLE evidence without upgrading it or exposing private source payloads', async () => {
  const f = setup(), proof = proofFor(f, 'manual-unverifiable', new Date().toISOString())
  proof.freshness = 'UNVERIFIABLE'; f.proofs.set(proof.proofId, proof)
  const raw = f.store.get(f.plan.artifactId)!.rawMarkdown.replace('status: PENDING', 'status: COMPLETED')
  const result = await f.service.updateAgent(f.authority, f.plan.artifactId, 1, raw, {}, { evidenceRefs: [], attestation: { ...f.lifecycle.attestation,
    references: [{ type: 'LEDGER_PROOF', repositoryId: f.store.repositoryId, proofId: proof.proofId }] } })
  expect(result).toMatchObject({ state: 'PERSISTED', lifecycleReceipt: { review: { evidence: [], attestation: { references: [{ classification: 'PASSED/UNVERIFIABLE' }] } } } })
  expect(JSON.stringify(result)).not.toContain('private-source-command')
  expect(proof.freshness).toBe('UNVERIFIABLE')
  expect(f.approve).not.toHaveBeenCalled()
})

it('allows a new accountable closure judgment when a supporting Handoff has historically stale evidence', async () => {
  const f = setup()
  const handoff = f.service.publish(`---\nname: Legacy closure\ndescription: Historical report with contextual evidence\nkind: IMPLEMENTATION_HANDOFF\nrelations:\n  - artifactId: ${f.plan.artifactId}\n    kind: implements\n---\n# Delivery\n\nThe original delivery report needs a later evidence correction.`)
  const handoffRaw = f.store.get(handoff.artifactId)!.rawMarkdown.replace('kind: IMPLEMENTATION_HANDOFF', 'kind: IMPLEMENTATION_HANDOFF\nstatus: VALIDATED')
  expect(await f.service.updateAgent(f.authority, handoff.artifactId, 1, handoffRaw, {}, { ...f.lifecycle, supportingArtifactId: f.plan.artifactId })).toMatchObject({ state: 'PERSISTED', revision: 2 })
  const reportRaw = f.store.get(f.report.artifactId)!.rawMarkdown + '\nAdditional contextual verification corrects the historical evidence.'
  await f.service.updateAgent(f.authority, f.report.artifactId, 1, reportRaw)
  const planRaw = f.store.get(f.plan.artifactId)!.rawMarkdown.replace('status: PENDING', 'status: COMPLETED')
  expect(await f.service.updateAgent(f.authority, f.plan.artifactId, 1, planRaw, {}, { evidenceRefs: [], supportingArtifactId: handoff.artifactId,
    attestation: { ...f.lifecycle.attestation, references: [{ type: 'ARTIFACT', repositoryId: f.store.repositoryId, artifactId: f.report.artifactId, expectedRevision: 2 }] } })).toMatchObject({ state: 'PERSISTED', revision: 2 })
  expect(f.approve).not.toHaveBeenCalled()
})
