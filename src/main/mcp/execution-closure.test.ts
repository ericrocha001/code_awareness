import { describe, expect, it, vi } from 'vitest'
import { assessExecutionClosure, ASSESS_EXECUTION_CLOSURE_TOOL, type ClosureDependencies } from './execution-closure'
import type { Artifact } from '../continuum/continuum-types'
import { ChannelMcpAdapter } from './channel-mcp-adapter'
import { createMcpHttpServer } from './mcp-http-server'

function artifact(id: string, kind: string, status: string): Artifact {
  return { artifactId: id, revision: 1, metadata: { name: id, kind, status, ...(kind === 'IMPLEMENTATION_HANDOFF' ? { relations: [{ artifactId: 'plan', kind: 'implements' }] } : {}) },
    rawMarkdown: 'VALIDADO — 134 testes; https://github.com/owner/repo/pull/new/branch', createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z', contentHash: 'hash', provenance: {} }
}
function fixture() {
  const plan = artifact('plan', 'EXECUTABLE_PLAN', 'COMPLETED'), handoff = artifact('handoff', 'IMPLEMENTATION_HANDOFF', 'VALIDATED')
  const docs = new Map([plan, handoff].map(a => [a.artifactId, a]))
  const reader = { get: vi.fn((id: string) => docs.get(id) ?? null), list: vi.fn(() => ({ artifacts: [...docs.values()].filter(a => a.metadata.kind === 'IMPLEMENTATION_HANDOFF').map(a => ({ artifactId: a.artifactId })) } as any)), publish: vi.fn(), update: vi.fn() }
  const ledger = { listProofs: vi.fn(async (_filter: any): Promise<any[]> => []) }
  const github = vi.fn(async (_number: number) => ({ repositoryId: 'repo', repository: 'owner/repo', pullRequest: { number: 23, head: { sha: 'a'.repeat(40), repository: 'owner/repo' }, base: { sha: 'b'.repeat(40), repository: 'owner/repo' }, state: 'open', mergedAt: null, observedAt: '2026-10-29T00:00:00Z' } as any }))
  const deps: ClosureDependencies = { repositoryId: 'repo', assertActive: vi.fn(), reader, ledger, github }
  const run = (args: unknown = { planArtifactId: 'plan' }) => assessExecutionClosure(deps, args).then(r => r.closureAssessment)
  return { deps, plan, handoff, docs, reader, ledger, github, run }
}
const proof = (freshness = 'CURRENT', status = 'PASSED') => ({ proofId: 'proof-1', kind: 'TARGETED_TEST', status, freshness, evidenceFor: ['plan'], scope: ['src/feature.ts'], commandProfile: { source: { repositoryId: 'repo' } }, sourceFingerprint: 'fingerprint', runtimeInstanceId: null, recordedAt: '2026-10-29T00:00:00Z' })

describe('execution closure assessment', () => {
  it('signals the motivating lifecycle mismatch without inventing a PR or denying local tests', async () => {
    const f = fixture(); f.plan.metadata.status = 'PENDING'; f.handoff.metadata.status = 'DONE'
    const result = await f.run()
    expect(result.result).toBe('REVIEW_REQUIRED')
    expect(result.findings.map(f => f.code)).toContain('HANDOFF_NON_CANONICAL')
    expect(result.documentation.plan.status).toBe('PENDING')
    expect(result.evidence.declarations[0].evidence).toBe('DECLARED')
    expect(result.delivery.state).toBe('NOT_CHECKED')
    expect(f.github).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toMatch(/134|pull\/new|ABSENT|no local tests were run/)
    expect(f.reader.publish).not.toHaveBeenCalled(); expect(f.reader.update).not.toHaveBeenCalled()
  })
  it.each(['COMPLETED', 'PENDING'])('reports literal %s with a validated Handoff', async status => {
    const f = fixture(); f.plan.metadata.status = status
    const result = await f.run()
    expect(result.result).toBe(status === 'COMPLETED' ? 'READY_FOR_REVIEW' : 'REVIEW_REQUIRED')
    expect(result.mergeAuthorized).toBe(false)
    expect(result.evidence.contractCoverage).toBe('NOT_DEMONSTRATED')
    expect(result.nextActions.join(' ')).toContain('Human review')
  })
  it.each(['CURRENT', 'SOURCE_STALE', 'RUNTIME_HISTORICAL', 'UNVERIFIABLE'])('preserves %s proof without equating freshness with failure', async freshness => {
    const f = fixture(); f.ledger.listProofs.mockImplementation(async filter => filter.requirementId === 'plan' ? [proof(freshness)] : [])
    const result = await f.run()
    expect(result.evidence.proofs[0]).toMatchObject({ status: 'PASSED', freshness, evidence: freshness === 'CURRENT' ? 'VERIFIED_CURRENT' : 'NOT_DEMONSTRATED' })
    expect(result.findings.map(f => f.code)).not.toContain('PROOF_FAILED')
    expect(f.ledger.listProofs.mock.calls.map(([filter]) => filter.requirementId)).toEqual(['plan', 'handoff'])
  })
  it.each(['FAILED', 'ERROR'])('reports %s without verifying acceptance', async status => {
    const f = fixture(); f.ledger.listProofs.mockResolvedValue([proof('CURRENT', status)])
    const result = await f.run()
    expect(result.findings.map(f => f.code)).toContain('PROOF_' + status)
    expect(result.evidence.proofs[0].evidence).toBe('NOT_DEMONSTRATED')
  })
  it('discovers bounded inbound implements only and does not choose between conflicting Handoffs', async () => {
    const f = fixture(); f.docs.set('other', artifact('other', 'IMPLEMENTATION_HANDOFF', 'BLOCKED'))
    const result = await f.run()
    expect(result.documentation.state).toBe('AMBIGUOUS')
    expect(result.documentation.handoffs).toHaveLength(2)
    expect(f.reader.list).toHaveBeenCalledExactlyOnceWith({ relatedToArtifactId: 'plan', direction: 'inbound', relationKind: 'implements', kind: 'IMPLEMENTATION_HANDOFF', limit: 6 })
  })
  it('retains ambiguity between distinct validated Handoffs without interpreting Markdown', async () => {
    const f = fixture(); const other = artifact('other', 'IMPLEMENTATION_HANDOFF', 'VALIDATED'); other.contentHash = 'different'
    f.docs.set('other', other)
    expect((await f.run()).documentation.state).toBe('AMBIGUOUS')
  })
  it('caps document and proof coverage and never returns bodies, commands or summaries', async () => {
    const f = fixture()
    for (let n = 0; n < 8; n++) f.docs.set('h' + n, artifact('h' + n, 'IMPLEMENTATION_HANDOFF', 'VALIDATED'))
    f.ledger.listProofs.mockImplementation(async filter => Array.from({ length: 21 }, (_, i) => ({ ...proof(), proofId: filter.requirementId + i, evidenceFor: [filter.requirementId], summary: 'x'.repeat(10000) })))
    const result = await f.run()
    expect(result.documentation.handoffs).toHaveLength(5)
    expect(result.evidence.proofs).toHaveLength(20)
    expect(result.documentation.complete).toBe(false); expect(result.evidence.complete).toBe(false)
    expect(f.ledger.listProofs).toHaveBeenCalledTimes(6)
    expect(f.reader.list).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result).length).toBeLessThan(18000)
    expect(JSON.stringify(result)).not.toContain('summary')
  })
  it('retains documents if optional sources are unavailable', async () => {
    const f = fixture(); f.deps.ledger = undefined; f.deps.github = undefined
    const result = await f.run({ planArtifactId: 'plan', prNumber: 23 })
    expect(result.documentation.state).toBe('CONSISTENT')
    expect(result.delivery.state).toBe('UNAVAILABLE')
    expect(result.evidence.state).toBe('UNAVAILABLE')
    f.deps.ledger = f.ledger; f.ledger.listProofs.mockRejectedValue(new Error('offline'))
    f.deps.github = f.github; f.github.mockRejectedValue(new Error('404'))
    expect((await f.run({ planArtifactId: 'plan', prNumber: 23 })).documentation.state).toBe('CONSISTENT')
  })
  it.each(['OPEN', 'CLOSED', 'MERGED'])('uses one explicitly selected real PR for %s', async state => {
    const f = fixture(); const response = await f.github(23); f.github.mockClear()
    response.pullRequest.state = state === 'OPEN' ? 'open' : 'closed'; response.pullRequest.mergedAt = state === 'MERGED' ? '2026-10-29T00:00:00Z' : null
    f.github.mockResolvedValue(response)
    f.plan.metadata.expectedHeadSha = 'a'.repeat(40); f.handoff.metadata.expectedBaseSha = 'b'.repeat(40)
    const result = await f.run({ planArtifactId: 'plan', prNumber: 23 })
    expect(result.delivery).toMatchObject({ state, shaVerification: 'COMPARED' })
    expect(f.github).toHaveBeenCalledExactlyOnceWith(23)
    expect(result.delivery.comparisons).toHaveLength(2)
  })
  it('reports SHA and association conflicts from explicit metadata', async () => {
    const f = fixture(); f.handoff.metadata.expectedHeadSha = 'c'.repeat(40); f.handoff.metadata.prNumber = 24
    const result = await f.run({ planArtifactId: 'plan', prNumber: 23 })
    expect(result.findings.map(f => f.code)).toEqual(expect.arrayContaining(['PR_SHA_MISMATCH', 'PR_ASSOCIATION_CONFLICT']))
  })
  it('rejects cross-repository proofs and PRs', async () => {
    const f = fixture(); f.ledger.listProofs.mockResolvedValue([{ ...proof(), commandProfile: { source: { repositoryId: 'other' } } }])
    expect((await f.run()).evidence.proofs).toHaveLength(0)
    f.ledger.listProofs.mockResolvedValue([{ ...proof('UNVERIFIABLE'), commandProfile: { checkout: { repositoryId: 'other' } } }])
    expect((await f.run()).evidence.proofs).toHaveLength(0)
    const response = await f.github(23); response.repositoryId = 'other'; f.github.mockResolvedValue(response)
    await expect(f.run({ planArtifactId: 'plan', prNumber: 23 })).rejects.toThrow('REPOSITORY_CONTEXT_CHANGED')
  })
  it('rejects context changes and document revision drift during async reads', async () => {
    const f = fixture(); f.ledger.listProofs.mockImplementation(async () => { f.plan.revision++; return [] })
    f.reader.get.mockImplementation(id => structuredClone(f.docs.get(id) ?? null))
    await expect(f.run()).rejects.toThrow('DOCUMENT_CONTEXT_CHANGED')
    f.deps.assertActive = () => { throw new Error('PROJECT_CONTEXT_CHANGED') }
    await expect(f.run()).rejects.toThrow('PROJECT_CONTEXT_CHANGED')
  })
  it.each([{ planArtifactId: 'plan', path: '/other' }, { planArtifactId: 'plan', branch: 'main' }, { planArtifactId: 'plan', repositoryId: 'other' }, { planArtifactId: 'plan', prNumber: 0 }, { planArtifactId: 'plan', prNumber: 1.5 }])('rejects extra selectors and invalid PR numbers %j', async args => {
    const f = fixture(); await expect(f.run(args)).rejects.toThrow('INVALID_ARGUMENT'); expect(f.reader.get).not.toHaveBeenCalled()
  })
  it('smokes discovery and execution through real MCP HTTP without mutations', async () => {
    const f = fixture()
    const adapter = new ChannelMcpAdapter({ projectId: 'project', repoRoot: '/repo', navigation: {} as any, artifactReader: f.reader, executionClosure: f.deps }, undefined, undefined, f.ledger as any)
    expect(adapter.listTools()).toContainEqual(ASSESS_EXECUTION_CLOSURE_TOOL)
    expect(new ChannelMcpAdapter({ projectId: 'project', repoRoot: '/repo', navigation: {} as any }).listTools()).not.toContainEqual(ASSESS_EXECUTION_CLOSURE_TOOL)
    const server = createMcpHttpServer(adapter, () => {})
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'assess_execution_closure', arguments: { planArtifactId: 'plan' } } }) })
      const body = await response.json() as any
      expect(JSON.parse(body.result.content[0].text).closureAssessment).toMatchObject({ repositoryId: 'repo', result: 'READY_FOR_REVIEW', mergeAuthorized: false })
      expect(f.reader.publish).not.toHaveBeenCalled(); expect(f.reader.update).not.toHaveBeenCalled()
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
})
