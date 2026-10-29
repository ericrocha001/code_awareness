import { z } from 'zod'
import type { Artifact, IArtifactReader } from '../continuum/continuum-types'
import type { ValidationLedger } from '../validation-ledger/validation-ledger'
import type { GitHubIntegrationService } from '../github/github-integration-service'
import type { McpToolDefinition, McpToolResult } from './mcp-types'

const request = z.object({ planArtifactId: z.string().trim().min(1).max(200), prNumber: z.number().int().positive().safe().optional() }).strict()
const handoffLimit = 5
const proofLimit = 20
export interface ClosureContext {
  repositoryId: string
  assertActive(): void
}
export interface ClosureDependencies extends ClosureContext {
  reader: IArtifactReader
  ledger?: Pick<ValidationLedger, 'listProofs'>
  github?: (prNumber: number) => ReturnType<GitHubIntegrationService['getPullRequest']>
}
export const ASSESS_EXECUTION_CLOSURE_TOOL: McpToolDefinition = {
  name: 'assess_execution_closure',
  description: 'Read-only on-demand closure diagnosis after publishing an implementation Handoff and before proposing a PR. Select one planArtifactId; optional explicit prNumber checks only this repository. Independent documentation, proof and Git dimensions; READY_FOR_REVIEW covers inspected consistency only, never contract acceptance or merge authorization. Corrections belong to the author using update_artifact with expectedRevision. No Markdown inference, corpus scan, mutation or automatic suites.',
  securitySchemes: [{ type: 'oauth2', scopes: [] }],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: { type: 'object', properties: { planArtifactId: { type: 'string', minLength: 1, maxLength: 200 }, prNumber: { type: 'integer', minimum: 1 } }, required: ['planArtifactId'], additionalProperties: false }
}
type Finding = { code: string; severity: 'INFO' | 'WARNING' | 'ERROR'; artifactId?: string }
function document(artifact: Artifact) {
  return { artifactId: artifact.artifactId, revision: artifact.revision, kind: artifact.metadata.kind, status: artifact.metadata.status ?? null, updatedAt: artifact.updatedAt }
}
function identityError(error: unknown) {
  return error instanceof Error && /REPOSITORY_CONTEXT_CHANGED|PROJECT_CONTEXT_CHANGED|CONTINUUM_INACTIVE/.test(error.message)
}

export async function assessExecutionClosure(deps: ClosureDependencies, input: unknown) {
  const parsed = request.safeParse(input)
  if (!parsed.success) throw new Error('INVALID_ARGUMENT')
  const { planArtifactId, prNumber } = parsed.data
  deps.assertActive()
  const startedAt = new Date().toISOString()
  const plan = deps.reader.get(planArtifactId)
  if (!plan) throw new Error('ARTIFACT_NOT_FOUND')
  if (plan.metadata.kind !== 'EXECUTABLE_PLAN') throw new Error('INVALID_PLAN_KIND')
  const findings: Finding[] = []
  const actions = new Set<string>()
  const finding = (code: string, severity: Finding['severity'], action: string, artifactId?: string) => {
    if (findings.some(item => item.code === code && item.artifactId === artifactId)) return
    findings.push({ code, severity, ...(artifactId ? { artifactId } : {}) }); actions.add(action)
  }
  const page = deps.reader.list({ relatedToArtifactId: planArtifactId, direction: 'inbound', relationKind: 'implements', kind: 'IMPLEMENTATION_HANDOFF', limit: handoffLimit + 1 })
  const handoffs: Artifact[] = []
  const documentsComplete = !page.nextCursor && page.artifacts.length <= handoffLimit
  if (!documentsComplete) finding('HANDOFF_COVERAGE_PARTIAL', 'WARNING', 'Review remaining inbound implements Handoffs explicitly.')
  for (const item of page.artifacts.slice(0, handoffLimit)) {
    const artifact = deps.reader.get(item.artifactId)
    if (!artifact || artifact.metadata.kind !== 'IMPLEMENTATION_HANDOFF' || !artifact.metadata.relations?.some(r => r.kind === 'implements' && r.artifactId === planArtifactId)) throw new Error('DOCUMENT_CONTEXT_CHANGED')
    handoffs.push(artifact)
  }
  if (!['PENDING', 'COMPLETED', 'CANCELLED'].includes(plan.metadata.status ?? '')) finding('PLAN_NON_CANONICAL', 'WARNING', 'Author reviews literal lifecycle and updates only at expectedRevision.', planArtifactId)
  for (const handoff of handoffs) {
    if (!['VALIDATED', 'BLOCKED'].includes(handoff.metadata.status ?? '')) finding('HANDOFF_NON_CANONICAL', 'WARNING', 'Author reviews literal lifecycle and updates only at expectedRevision.', handoff.artifactId)
    if (handoff.metadata.status === 'BLOCKED') finding('HANDOFF_BLOCKED', 'WARNING', 'Review the linked blocked Handoff.', handoff.artifactId)
  }
  if (!handoffs.length) finding('HANDOFF_NOT_FOUND', 'WARNING', 'Publish or explicitly identify the implementation Handoff; tests are not inferred absent.')
  if (plan.metadata.status === 'PENDING' && handoffs.some(h => h.metadata.status === 'VALIDATED')) finding('PLAN_LIFECYCLE_PENDING', 'WARNING', 'Author reconciles the plan only after reviewing full completion evidence.', planArtifactId)
  if (['COMPLETED', 'CANCELLED'].includes(plan.metadata.status ?? '') && handoffs.some(h => h.metadata.status === 'BLOCKED' || plan.metadata.status === 'CANCELLED' && h.metadata.status === 'VALIDATED')) finding('LIFECYCLE_CONFLICT', 'WARNING', 'Review conflicting plan and Handoff lifecycle before closure.')
  const signatures = handoffs.map(h => JSON.stringify([h.contentHash, h.metadata.status, h.metadata.executionId, h.metadata.prNumber, h.metadata.expectedHeadSha, h.metadata.expectedBaseSha]))
  const ambiguous = new Set(signatures).size > 1
  if (ambiguous) finding('HANDOFF_AMBIGUOUS', 'WARNING', 'Author resolves conflicting linked Handoffs; none was selected as authoritative.')

  const proofs = new Map<string, Record<string, unknown>>()
  let proofsComplete = !!deps.ledger
  let ledgerAvailable = !!deps.ledger
  if (!deps.ledger) finding('LEDGER_UNAVAILABLE', 'WARNING', 'Review local validation evidence; Ledger unavailability does not imply tests were not run.')
  if (deps.ledger) {
    for (const artifact of [plan, ...handoffs]) {
      deps.assertActive()
      try {
        const items = await deps.ledger.listProofs({ requirementId: artifact.artifactId, limit: proofLimit + 1 })
        deps.assertActive()
        if (items.length > proofLimit) proofsComplete = false
        for (const proof of items.slice(0, proofLimit)) {
          const source = proof.commandProfile?.source
          if (!proof.evidenceFor.includes(artifact.artifactId) || [source?.repositoryId, proof.commandProfile?.checkout?.repositoryId].some(id => id && id !== deps.repositoryId)) {
            proofsComplete = false
            finding('PROOF_SCOPE_MISMATCH', 'WARNING', 'Review Ledger proof association and source repository.', artifact.artifactId)
            continue
          }
          const verified = proof.status === 'PASSED' && proof.freshness === 'CURRENT'
          if (proofs.size >= proofLimit && !proofs.has(proof.proofId)) { proofsComplete = false; continue }
          proofs.set(proof.proofId, { proofId: proof.proofId, kind: proof.kind, status: proof.status, freshness: proof.freshness,
            evidence: verified ? 'VERIFIED_CURRENT' : 'NOT_DEMONSTRATED', scope: proof.scope.slice(0, 4).map(s => s.slice(0, 120)), scopeComplete: proof.scope.length <= 4 && proof.scope.every(s => s.length <= 120),
            source: { repositoryId: source?.repositoryId ?? null, sourceFingerprint: proof.sourceFingerprint, runtimeInstanceId: proof.runtimeInstanceId }, recordedAt: proof.recordedAt })
          if (proof.status !== 'PASSED') finding('PROOF_' + proof.status, 'WARNING', 'Review the linked failed or errored proof; do not infer current acceptance.', artifact.artifactId)
        }
      } catch (error) {
        if (identityError(error)) throw error
        deps.assertActive(); ledgerAvailable = false; proofsComplete = false
        finding('LEDGER_UNAVAILABLE', 'WARNING', 'Review local validation evidence; Ledger unavailability does not imply tests were not run.')
        break
      }
    }
  }
  if (!proofsComplete && ledgerAvailable) finding('PROOF_COVERAGE_PARTIAL', 'WARNING', 'Inspect additional linked proofs explicitly.')
  if (!proofs.size) finding('PROOFS_NOT_REGISTERED', 'INFO', 'Review declared local evidence; no registered proof does not mean no local tests.')
  finding('CONTRACT_COVERAGE_NOT_DEMONSTRATED', 'INFO', 'Human review compares plan contracts against declared and verified evidence; no Markdown parsing establishes sufficiency.')

  let delivery: Record<string, unknown> = { state: 'NOT_CHECKED', source: null }
  if (prNumber !== undefined) {
    delivery = { state: 'UNAVAILABLE', source: 'GITHUB_REST', prNumber }
    if (deps.github) {
      try {
        deps.assertActive()
        const result = await deps.github(prNumber)
        deps.assertActive()
        const pr = result.pullRequest
        if (result.repositoryId !== deps.repositoryId || pr.number !== prNumber || pr.base.repository.toLowerCase() !== result.repository.toLowerCase()) throw new Error('REPOSITORY_CONTEXT_CHANGED')
        const comparisons = [plan, ...handoffs].flatMap(artifact => ['expectedHeadSha', 'expectedBaseSha'].flatMap(key => {
          const value = artifact.metadata[key]
          if (value === undefined) return []
          const matches = typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && value === (key === 'expectedHeadSha' ? pr.head.sha : pr.base.sha)
          if (!matches) finding('PR_SHA_MISMATCH', 'WARNING', 'Review explicit metadata SHAs against the current GitHub PR.', artifact.artifactId)
          return [{ artifactId: artifact.artifactId, field: key, matches }]
        }))
        for (const artifact of [plan, ...handoffs]) if (artifact.metadata.prNumber !== undefined && artifact.metadata.prNumber !== prNumber) finding('PR_ASSOCIATION_CONFLICT', 'WARNING', 'Review the explicitly selected PR against artifact metadata.', artifact.artifactId)
        delivery = { state: pr.mergedAt ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED', source: 'GITHUB_REST', repository: result.repository, prNumber, headSha: pr.head.sha, baseSha: pr.base.sha, observedAt: pr.observedAt,
          association: 'EXPLICIT_REQUEST_NOT_INFERRED', comparisons, shaVerification: comparisons.length ? 'COMPARED' : 'NOT_CHECKED' }
      } catch (error) {
        if (identityError(error)) throw error
        deps.assertActive()
        finding('GITHUB_UNAVAILABLE', 'WARNING', 'Review GitHub availability or PR identity; documentary assessment remains available.')
      }
    } else finding('GITHUB_UNAVAILABLE', 'WARNING', 'GitHub dependency is unavailable; documentary assessment remains available.')
  }
  deps.assertActive()
  for (const artifact of [plan, ...handoffs]) if (deps.reader.get(artifact.artifactId)?.revision !== artifact.revision) throw new Error('DOCUMENT_CONTEXT_CHANGED')
  return { closureAssessment: {
    repositoryId: deps.repositoryId, startedAt, observedAt: new Date().toISOString(),
    result: findings.some(f => f.severity !== 'INFO') ? 'REVIEW_REQUIRED' : 'READY_FOR_REVIEW',
    coverage: 'INSPECTED_SOURCES_ONLY', mergeAuthorized: false,
    documentation: { state: ambiguous ? 'AMBIGUOUS' : findings.some(f => /LIFECYCLE|NON_CANONICAL|HANDOFF_/.test(f.code)) ? 'REVIEW_REQUIRED' : 'CONSISTENT', source: 'CONTINUUM', complete: documentsComplete, plan: document(plan), handoffs: handoffs.map(document) },
    evidence: { source: 'VALIDATION_LEDGER', state: ledgerAvailable ? 'INSPECTED' : 'UNAVAILABLE', complete: proofsComplete, contractCoverage: 'NOT_DEMONSTRATED', proofs: [...proofs.values()], declarations: handoffs.map(h => ({ artifactId: h.artifactId, revision: h.revision, evidence: 'DECLARED', scope: 'HANDOFF_CONTENT_NOT_INDEPENDENTLY_VERIFIED' })) },
    delivery, findings, nextActions: [...actions]
  } }
}

export async function executeAssessExecutionClosure(deps: ClosureDependencies, input: unknown): Promise<McpToolResult> {
  try { return { content: [{ type: 'text', text: JSON.stringify(await assessExecutionClosure(deps, input)) }] } }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'CLOSURE_UNAVAILABLE' }] } }
}
