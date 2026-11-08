import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fixture, withFixtureDatabase } from './continuum-test-fixtures'
import { ContinuumService } from './continuum-service'
import { ArtifactStore } from './artifact-store'
import { PublicationReceipts } from './publication-receipts'
import { parseContinuumAgentRequest } from './continuum-agent'
import { executeGetArtifact } from './continuum-mcp'
import { lifecycleReceipt, type LifecycleApproval, type LifecycleRequest, type LifecycleReview } from './artifact-lifecycle'
import type { LifecycleDependencies } from './artifact-lifecycle-policy'
import type { ProofWithFreshness } from '../validation-ledger/validation-ledger-types'
import { ValidationLedger } from '../validation-ledger/validation-ledger'
import { captureValidationSource, validationSourceFingerprint } from '../validation-execution/validation-source'

const cleanup: Array<() => void> = []
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(fn => fn()) })
const body = '# Verified delivery\n\nAll required semantic criteria are reviewed independently.\n\nLiteral ${payload} 🚀.'
const allow = async (review: LifecycleReview): Promise<LifecycleApproval> => ({ source: 'AUTHENTICATED_AUTHORITY', principalId: 'test-authority', reviewDigest: review.reviewDigest, approvedAt: new Date().toISOString() })
function setup(approve: LifecycleDependencies['approve'] = allow) {
  const f = fixture(); cleanup.push(f.close)
  const proofs = new Map<string, ProofWithFreshness>()
  const dependencies: LifecycleDependencies = { proof: async id => structuredClone(proofs.get(id) ?? null), approve }
  const service = new ContinuumService(f.store, undefined, undefined, dependencies)
  const plan = service.publish(body, { kind: 'EXECUTABLE_PLAN' })
  const handoff = service.publish(`---\nname: Delivery\ndescription: Concrete reviewed criteria\nkind: IMPLEMENTATION_HANDOFF\nrelations:\n  - artifactId: ${plan.artifactId}\n    kind: implements\n---\n${body}`)
  const request: LifecycleRequest = { action: 'TRANSITION', artifactId: handoff.artifactId, expectedRevision: 1, toState: 'VALIDATED', reasonCode: 'CRITERIA_ACCEPTED', evidenceRefs: ['proof-fixture'] }
  const proof: ProofWithFreshness = { proofId: 'proof-fixture', kind: 'TARGETED_TEST', producer: 'TESTER', status: 'PASSED', startedAt: '2026-11-05T00:00:00.000Z', finishedAt: '2026-11-05T00:00:01.000Z', durationMs: 1000, scope: ['lifecycle'], summary: 'Scoped criterion evidence', metrics: null, sourceFingerprint: 'fixture', runtimeInstanceId: null, commandProfile: { command: 'test', source: { version: 1, repositoryId: f.store.repositoryId, repositoryDirectory: 'fixture', cwd: 'fixture', worktreeId: 'fixture', generation: 'fixture', head: 'fixture', branch: 'fixture', indexRevision: 'fixture', worktreeRevision: 'fixture' } }, evidenceFor: [plan.artifactId], deduplicationKey: null, recordedAt: '2026-11-05T00:00:02.000Z', freshness: 'CURRENT' }
  proofs.set(proof.proofId, proof)
  return { ...f, service, dependencies, proofs, proof, plan, handoff, request }
}

function manualRequest(f: ReturnType<typeof setup>): LifecycleRequest {
  f.proof.freshness = 'UNVERIFIABLE'
  return { ...f.request, evidenceMode: 'REVIEWED_ATTESTATION', evidenceRefs: [], attestation: {
    rationale: 'Reviewed delivery report and existing executor-reported test evidence.',
    limitations: 'Executor report has no independently verified checkout freshness; human criteria review required.',
    references: [
      { type: 'ARTIFACT', repositoryId: f.store.repositoryId, artifactId: f.handoff.artifactId, expectedRevision: 1 },
      { type: 'LEDGER_PROOF', repositoryId: f.store.repositoryId, proofId: f.proof.proofId }
    ]
  } }
}

it('ratifies legacy semantics without changing text, preserves UNVERIFIABLE, and closes only the accepted plan revision', async () => {
  const f = setup()
  const old = f.store.get(f.handoff.artifactId)!
  const raw = old.rawMarkdown.replace('kind: IMPLEMENTATION_HANDOFF', 'kind: IMPLEMENTATION_HANDOFF\nstatus: VALIDATED')
  const legacy = f.store.createPublished({ artifactId: 'legacy-ratification', rawMarkdown: raw, metadata: { ...old.metadata, status: 'VALIDATED' } }, 'a'.repeat(64)).artifact
  const request = manualRequest(f)
  request.artifactId = legacy.artifactId
  request.attestation!.references[0] = { type: 'ARTIFACT', repositoryId: f.store.repositoryId, artifactId: legacy.artifactId, expectedRevision: 1 }
  const before = f.store.get(legacy.artifactId)
  expect(await f.service.transitionLifecycle({ ...request, action: 'ASSESS' })).toMatchObject({ state: 'REVIEW_REQUIRED', review: { evidenceMode: 'REVIEWED_ATTESTATION', evidence: [], attestation: { origin: 'AGENT_ATTESTED', references: [expect.anything(), expect.objectContaining({ classification: 'PASSED/UNVERIFIABLE' })] } } })
  expect(f.store.get(legacy.artifactId)).toEqual(before)
  expect(await f.service.transitionLifecycle(request)).toMatchObject({ state: 'PERSISTED', revision: 2 })
  expect(f.store.get(legacy.artifactId)!.rawMarkdown).toBe(raw)
  expect(f.proof.freshness).toBe('UNVERIFIABLE')
  expect(await f.service.transitionLifecycle(request)).toMatchObject({ replayed: true, revision: 2 })
  const closure: LifecycleRequest = { ...request, artifactId: f.plan.artifactId, toState: 'COMPLETED', reasonCode: 'CLOSURE_ACCEPTED', supportingArtifactId: legacy.artifactId,
    attestation: { ...request.attestation!, references: [{ type: 'ARTIFACT', repositoryId: f.store.repositoryId, artifactId: legacy.artifactId, expectedRevision: 2 }] } }
  expect(await f.service.transitionLifecycle({ ...closure, evidenceMode: 'AUTO_VERIFIED', attestation: undefined })).toMatchObject({ reason: 'REVIEWED_CLOSURE_REQUIRES_ATTESTATION' })
  expect(await f.service.transitionLifecycle(closure)).toMatchObject({ state: 'PERSISTED', revision: 2 })
  const reopened = new ArtifactStore(f.path, f.store.repositoryId)
  try { expect(lifecycleReceipt(reopened.get(legacy.artifactId)!)?.review.evidenceMode).toBe('REVIEWED_ATTESTATION'); expect(reopened.get(f.plan.artifactId)!.metadata.status).toBe('COMPLETED') } finally { reopened.close() }
})

it('requires contextual scoped sources and independent approval, and rejects forged client authority', async () => {
  const f = setup(async () => null), request = manualRequest(f)
  const cases: LifecycleRequest[] = [
    { ...request, attestation: undefined },
    { ...request, attestation: { ...request.attestation!, references: [] } },
    { ...request, attestation: { ...request.attestation!, references: [{ type: 'ARTIFACT', repositoryId: 'other-repo', artifactId: f.handoff.artifactId, expectedRevision: 1 }] } },
    { ...request, attestation: { ...request.attestation!, references: [{ type: 'ARTIFACT', repositoryId: f.store.repositoryId, artifactId: 'missing', expectedRevision: 1 }] } },
    { ...request, attestation: { ...request.attestation!, references: [{ type: 'ARTIFACT', repositoryId: f.store.repositoryId, artifactId: f.handoff.artifactId, expectedRevision: 9 }] } },
    { ...request, attestation: { ...request.attestation!, references: [{ type: 'LEDGER_PROOF', repositoryId: f.store.repositoryId, proofId: 'missing' }] } }
  ]
  for (const invalid of cases) expect(await f.service.transitionLifecycle(invalid)).toMatchObject({ state: 'REVIEW_REQUIRED', reason: 'CONTEXTUAL_ATTESTATION_REQUIRED' })
  expect(await f.service.transitionLifecycle(request)).toMatchObject({ reason: 'AUTHORITY_APPROVAL_REQUIRED' })
  expect(() => parseContinuumAgentRequest('transition_artifact_lifecycle', { ...request, approved: true })).toThrow('INVALID_ARGUMENT')
  expect(() => parseContinuumAgentRequest('transition_artifact_lifecycle', { ...request, evidenceMode: 'AUTO_VERIFIED' })).toThrow('INVALID_ARGUMENT')
  expect(parseContinuumAgentRequest('transition_artifact_lifecycle', request)).toEqual(request)
  expect(f.store.get(f.handoff.artifactId)!.revision).toBe(1)
  f.proof.commandProfile!.source!.repositoryId = 'other-repo'
  expect(await f.service.transitionLifecycle(request)).toMatchObject({ reason: 'CONTEXTUAL_ATTESTATION_REQUIRED' })
})

it('rejects stale target, changed support and changed referenced proof during manual approval', async () => {
  for (const change of ['target', 'support', 'proof'] as const) {
    const f = setup(), request = manualRequest(f)
    f.dependencies.approve = async review => {
      if (change === 'proof') f.proof.summary = 'Changed after operator inspection'
      else { const id = change === 'target' ? f.handoff.artifactId : f.plan.artifactId; f.service.update(id, 1, f.store.get(id)!.rawMarkdown + '\nChanged') }
      return allow(review)
    }
    if (change === 'target') await expect(f.service.transitionLifecycle(request)).rejects.toThrow('REVISION_CONFLICT')
    else expect(await f.service.transitionLifecycle(request)).toMatchObject({ reason: change === 'support' ? 'ARTIFACT_CONTEXT_CHANGED' : 'ATTESTATION_CHANGED_DURING_APPROVAL' })
    expect(lifecycleReceipt(f.store.get(f.handoff.artifactId)!)).toBeNull()
  }
})

it('requires the approved Handoff and rechecks its attested evidence before plan closure', async () => {
  const f = setup(), request = manualRequest(f)
  const closure: LifecycleRequest = { ...request, artifactId: f.plan.artifactId, toState: 'COMPLETED', reasonCode: 'CLOSURE_ACCEPTED' }
  expect(await f.service.transitionLifecycle(closure)).toMatchObject({ reason: 'VALIDATED_CLOSURE_REQUIRED' })
  await f.service.transitionLifecycle(request)
  f.proof.summary = 'Changed after ratification'
  expect(await f.service.transitionLifecycle(closure)).toMatchObject({ reason: 'CONTEXTUAL_ATTESTATION_REQUIRED' })
  closure.attestation = { ...request.attestation!, references: [{ type: 'ARTIFACT', repositoryId: f.store.repositoryId, artifactId: f.handoff.artifactId, expectedRevision: 2 }] }
  expect(await f.service.transitionLifecycle(closure)).toMatchObject({ reason: 'CLOSURE_ATTESTATION_CHANGED' })
  expect(f.store.get(f.plan.artifactId)!.metadata.status).toBe('PENDING')
})

it('persists an authorized Handoff and real closure once, with MCP readback and restart-safe receipts', async () => {
  const f = setup(), raw = f.service.get(f.handoff.artifactId)!.rawMarkdown
  const accepted = await f.service.transitionLifecycle(f.request)
  expect(accepted).toMatchObject({ state: 'PERSISTED', revision: 2, replayed: false })
  const read = JSON.parse(executeGetArtifact(f.service, { artifactId: f.handoff.artifactId }).content[0].text)
  expect(read).toMatchObject({ metadata: { status: 'VALIDATED' }, lifecycle: { basis: 'AUTHORIZED_TRANSITION', assessment: 'APPROVED_AT_REVISION', revision: 2 } })
  expect(read.rawMarkdown.replace('status: VALIDATED\n', '')).toBe(raw)
  const closure: LifecycleRequest = { ...f.request, artifactId: f.plan.artifactId, toState: 'COMPLETED', reasonCode: 'CLOSURE_ACCEPTED', evidenceRefs: [] }
  expect(await f.service.transitionLifecycle(closure)).toMatchObject({ state: 'PERSISTED', revision: 2 })
  const reopened = new ArtifactStore(f.path, f.store.repositoryId); cleanup.push(() => reopened.close())
  const service = new ContinuumService(reopened, undefined, undefined, { ...f.dependencies, approve: async () => { throw new Error('Replay must not ask for approval') } })
  expect(await service.transitionLifecycle(closure)).toMatchObject({ state: 'PERSISTED', replayed: true, revision: 2 })
  expect(service.get(f.plan.artifactId)!.metadata.status).toBe('COMPLETED')
  expect(lifecycleReceipt(reopened.get(f.plan.artifactId)!)).toMatchObject({ review: { evidence: [{ proofId: f.proof.proofId }] }, approval: { principalId: 'test-authority' } })
  expect(reopened.getRevision(f.plan.artifactId, 1)!.metadata.status).toBe('PENDING')
  withFixtureDatabase(f.path, db => expect(db.prepare('SELECT count(*) AS n FROM artifact_revisions WHERE artifact_id=?').get(f.plan.artifactId)).toEqual({ n: 2 }))
})

it.each(['missing', 'denied', 'wrong-digest', 'forged-native-identity'] as const)('requires independent server authority: %s', async mode => {
  const approval = vi.fn(async (review: LifecycleReview) => mode === 'denied' ? null : ({ ...(await allow(review)), ...(mode === 'wrong-digest' ? { reviewDigest: 'wrong' } : mode === 'forged-native-identity' ? { source: 'NATIVE_DESKTOP_CONFIRMATION' as const } : {}) }))
  const f = setup(mode === 'missing' ? undefined : approval)
  if (mode === 'missing') f.dependencies.approve = undefined
  expect(await f.service.transitionLifecycle(f.request)).toMatchObject({ state: 'REVIEW_REQUIRED', reason: 'AUTHORITY_APPROVAL_REQUIRED' })
  expect(f.store.get(f.handoff.artifactId)!.revision).toBe(1)
})

it.each(['wrong-plan', 'wrong-repository', 'unverifiable', 'stale', 'failed', 'missing'] as const)('rejects insufficient or unrelated evidence: %s', async mode => {
  const approve = vi.fn(allow), f = setup(approve)
  if (mode === 'wrong-plan') f.proof.evidenceFor = ['another-plan']
  if (mode === 'wrong-repository') f.proof.commandProfile!.source!.repositoryId = 'other-repo'
  if (mode === 'unverifiable') f.proof.freshness = 'UNVERIFIABLE'
  if (mode === 'stale') f.proof.freshness = 'SOURCE_STALE'
  if (mode === 'failed') f.proof.status = 'FAILED'
  if (mode === 'missing') f.proofs.clear()
  expect(await f.service.transitionLifecycle(f.request)).toMatchObject({ state: 'REVIEW_REQUIRED', reason: 'EVIDENCE_SCOPE_OR_FRESHNESS_UNVERIFIED' })
  expect(approve).not.toHaveBeenCalled(); expect(f.store.get(f.handoff.artifactId)!.metadata.status).toBeUndefined()
})

it('ASSESS diagnoses eligible evidence without granting approval or writing; forged caller approval fields fail', async () => {
  const approve = vi.fn(allow), f = setup(approve)
  expect(await f.service.transitionLifecycle({ ...f.request, action: 'ASSESS' })).toMatchObject({ state: 'REVIEW_REQUIRED', reason: 'EXPLICIT_CRITERIA_APPROVAL_REQUIRED' })
  expect(approve).not.toHaveBeenCalled()
  expect(() => parseContinuumAgentRequest('transition_artifact_lifecycle', { ...f.request, approved: true, principalId: 'user' })).toThrow('INVALID_ARGUMENT')
  expect(await f.service.transitionLifecycle({ ...f.request, artifactId: f.plan.artifactId, toState: 'COMPLETED', reasonCode: 'CLOSURE_ACCEPTED' })).toMatchObject({ state: 'REVIEW_REQUIRED', reason: 'VALIDATED_CLOSURE_REQUIRED' })
  expect(f.store.get(f.plan.artifactId)!.metadata.status).toBe('PENDING')
})

it('enforces revision CAS, evidence recheck and active repository scope across asynchronous approval', async () => {
  const f = setup()
  await expect(f.service.transitionLifecycle({ ...f.request, expectedRevision: 99 })).rejects.toThrow('REVISION_CONFLICT')
  f.dependencies.approve = async review => { f.proof.freshness = 'SOURCE_STALE'; return allow(review) }
  expect(await f.service.transitionLifecycle(f.request)).toMatchObject({ state: 'REVIEW_REQUIRED', reason: 'EVIDENCE_CHANGED_DURING_APPROVAL' })
  f.proof.freshness = 'CURRENT'
  f.dependencies.approve = async review => { f.service.update(f.handoff.artifactId, 1, f.store.get(f.handoff.artifactId)!.rawMarkdown + '\nchanged'); return allow(review) }
  await expect(f.service.transitionLifecycle(f.request)).rejects.toThrow('REVISION_CONFLICT')
  let active = true
  const service = new ContinuumService(f.store, undefined, () => active, { ...f.dependencies, approve: async review => { active = false; return allow(review) } })
  await expect(service.transitionLifecycle({ ...f.request, expectedRevision: 2 })).rejects.toThrow('REPOSITORY_CONTEXT_CHANGED')
})

it('preserves historical acceptance but reports revoked proof and changed document freshness without rewriting history', async () => {
  const f = setup()
  await f.service.transitionLifecycle(f.request)
  f.proof.status = 'FAILED'
  expect(await f.service.transitionLifecycle({ ...f.request, action: 'ASSESS', expectedRevision: 2 })).toMatchObject({ evidence: { freshness: 'REVIEW_REQUIRED' } })
  expect(f.service.get(f.handoff.artifactId)!.metadata.status).toBe('VALIDATED')
  const prior = f.store.get(f.handoff.artifactId)!
  f.service.update(f.handoff.artifactId, 2, prior.rawMarkdown + '\nNew semantic criterion')
  expect(f.service.get(f.handoff.artifactId)!.lifecycle).toMatchObject({ freshness: 'SOURCE_STALE', assessment: 'REVIEW_REQUIRED' })
  expect(lifecycleReceipt(f.store.getRevision(f.handoff.artifactId, 2)!)).not.toBeNull()
  await expect(f.service.transitionLifecycle(f.request)).rejects.toThrow('REVISION_CONFLICT')
  expect(() => f.service.update(f.handoff.artifactId, 3, prior.rawMarkdown.replace('VALIDATED', 'BLOCKED'))).toThrow('LIFECYCLE_TRANSITION_REQUIRED')
})

it('rolls back document, indexes, history and lifecycle receipt together when publication receipt fails', async () => {
  const f = setup(), prior = f.store.get(f.handoff.artifactId)
  vi.spyOn(PublicationReceipts.prototype, 'issue').mockImplementation(() => { throw new Error('receipt failure') })
  await expect(f.service.transitionLifecycle(f.request)).rejects.toThrow('receipt failure')
  expect(f.store.get(f.handoff.artifactId)).toEqual(prior)
  expect(f.store.getRevision(f.handoff.artifactId, 2)).toBeNull()
  expect(f.store.list({ status: 'VALIDATED' }).artifacts).toHaveLength(0)
})

it('does not reuse a Handoff approval for a different plan revision or modified accepted evidence', async () => {
  const f = setup()
  await f.service.transitionLifecycle(f.request)
  const closure: LifecycleRequest = { ...f.request, artifactId: f.plan.artifactId, toState: 'COMPLETED', reasonCode: 'CLOSURE_ACCEPTED', evidenceRefs: [] }
  f.proof.summary = 'Changed evidence after acceptance'
  expect(await f.service.transitionLifecycle(closure)).toMatchObject({ state: 'REVIEW_REQUIRED', reason: 'CLOSURE_EVIDENCE_CHANGED' })
  f.service.update(f.plan.artifactId, 1, f.store.get(f.plan.artifactId)!.rawMarkdown + '\nNew criterion')
  expect(await f.service.transitionLifecycle({ ...closure, expectedRevision: 2 })).toMatchObject({ state: 'REVIEW_REQUIRED', reason: 'CLOSURE_TARGET_REVISION_STALE' })
})

it('does not write after an authenticated local caller disconnects while approval is pending', async () => {
  const f = setup(); let connected = true
  f.dependencies.approve = async review => { connected = false; return allow(review) }
  await expect(f.service.transitionLifecycle(f.request, () => connected)).rejects.toThrow('IPC_CLOSED')
  expect(f.store.get(f.handoff.artifactId)!.revision).toBe(1)
})

it('closes an opt-in WORK kind through the same contract without a core kind synonym', async () => {
  const f = setup()
  f.service.update(f.plan.artifactId, 1, f.store.get(f.plan.artifactId)!.rawMarkdown.replace('kind: EXECUTABLE_PLAN', 'kind: LOCAL_WORK\nlifecyclePolicy: WORK'))
  expect(await f.service.transitionLifecycle(f.request)).toMatchObject({ state: 'PERSISTED', revision: 2 })
  expect(await f.service.transitionLifecycle({ ...f.request, artifactId: f.plan.artifactId, expectedRevision: 2, toState: 'COMPLETED', reasonCode: 'CLOSURE_ACCEPTED', evidenceRefs: [] })).toMatchObject({ state: 'PERSISTED', revision: 3 })
})

it('reports a supporting revision changed while historical evidence was being read', async () => {
  const f = setup()
  await f.service.transitionLifecycle(f.request)
  f.dependencies.proof = async () => {
    f.service.update(f.plan.artifactId, 1, f.store.get(f.plan.artifactId)!.rawMarkdown + '\nChanged during proof read')
    return structuredClone(f.proof)
  }
  expect(await f.service.transitionLifecycle({ ...f.request, action: 'ASSESS', expectedRevision: 2 })).toMatchObject({ evidence: { freshness: 'SOURCE_STALE' } })
  expect(f.store.get(f.handoff.artifactId)!.metadata.status).toBe('VALIDATED')
})

it('uses persisted Ledger evidence with real checkout freshness for the domain transition', async () => {
  const f = setup(), root = join(f.dir, 'repo'); mkdirSync(root)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' })
  git('init'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'baseline')
  const source = await captureValidationSource(root, f.store.repositoryId)
  const ledger = new ValidationLedger(join(f.dir, 'ledger.db')); cleanup.push(() => ledger.close())
  const proof = ledger.recordProof({ kind: 'TARGETED_TEST', producer: 'TESTER', status: 'PASSED', startedAt: f.proof.startedAt, finishedAt: f.proof.finishedAt, durationMs: 1000, scope: ['lifecycle'], summary: 'Real persisted scoped evidence; editorial authority separately injected for this integration test', commandProfile: { command: 'test', cwd: source.cwd, source }, sourceFingerprint: validationSourceFingerprint(source), evidenceFor: [f.plan.artifactId] })
  f.dependencies.proof = id => ledger.getProofWithFreshness(id)
  f.dependencies.proofsFor = id => ledger.listProofs({ requirementId: id, limit: 10 })
  expect((await ledger.getProofWithFreshness(proof.proofId))!.freshness).toBe('CURRENT')
  expect(await f.service.transitionLifecycle({ ...f.request, evidenceRefs: [] })).toMatchObject({ state: 'PERSISTED', revision: 2, lifecycleReceipt: { review: { evidence: [{ proofId: proof.proofId }] } } })
}, 30000)
