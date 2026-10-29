import { z } from 'zod'
import type { PreviewSelection } from '../../../shared/types/runtime-preview-types'
import type { RuntimePreviewRequest, RuntimePreviewResult, PreviewSessionView, PreviewValidationLink, PreviewQualification } from '../../../shared/types/runtime-preview-operations'
import type { PreviewRepositories } from '../preview-repositories'
import type { PreviewProfileStore } from '../preview-profile-store'
import { PreviewPreflightService } from '../preview-preflight'
import { previewFingerprint, type PreviewProfile } from '../preview-profile'
import { diagnosticBootstrapAllowed } from './adapters'
import { PreviewSessionStore, type PreviewSessionRecord } from './session-store'
import type { RuntimePreviewRunner } from './runner'
import type { ValidationLedger } from '../../validation-ledger/validation-ledger'
import { captureValidationSource, validationSourceFingerprint } from '../../validation-execution/validation-source'
import type { RepositoryContinuumSession } from '../../continuum/project-continuum-session'
import type { CodeAwarenessProfileResolver } from './code-awareness-profile'
import { previewStatus } from './status'
import type { PreviewIntentReceipt } from './session-store'
import { previewChannelScope, previewChannelError } from './channel-contract'

const channelSelector = z.object({ scope: previewChannelScope, operation: z.string().min(1).max(64), input: z.record(z.unknown()).default({}) }).strict()
const knowledgeList = z.object({ query: z.string().max(512).optional(), kind: z.string().max(128).optional(), limit: z.number().int().min(1).max(20).default(10), cursor: z.string().max(2048).optional() }).strict()
const knowledgeGet = z.object({ artifactId: z.string().min(1).max(512) }).strict()

export const branchIntentSchema = z.object({ branch: z.string().min(1).max(512).regex(/^[^\0\r\n]+$/), operationId: z.string().uuid(),
  repositoryId: z.string().min(1).max(128).optional(), expectedHead: z.string().regex(/^[a-f0-9]{40}$/).optional(), worktreeId: z.string().min(1).max(128).optional() }).strict()
export const statusSelectorSchema = z.union([
  z.object({ operationId: z.string().uuid() }).strict(), z.object({ sessionId: z.string().uuid() }).strict()
])

const text = z.string().min(1).max(128).regex(/^[^\0\r\n]+$/), id = z.string().uuid()
const selection = z.object({ repositoryId: text, worktreeId: text, generation: text, profileId: text, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const previewRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('RUN_BRANCH_APP'), repositoryId: text, ref: z.string().min(1).max(512).regex(/^[^\0\r\n]+$/), revision: text, operationId: id,
    worktree: z.object({ worktreeId: text, generation: text }).strict().optional() }).strict(),
  z.object({ action: z.literal('PROFILES'), repositoryId: text }).strict(),
  z.object({ action: z.literal('WORKTREES'), repositoryId: text }).strict(),
  ...(['PREFLIGHT', 'AUTHORIZE'] as const).map(action => z.object({ action: z.literal(action), selection }).strict()),
  z.object({ action: z.literal('START'), selection, operationId: id }).strict(),
  z.object({ action: z.literal('LIST'), repositoryId: text, worktreeId: text.optional(), cursor: id.optional(), limit: z.number().int().min(1).max(20).optional() }).strict(),
  ...(['INSPECT', 'STOP', 'BINDINGS'] as const).map(action => z.object({ action: z.literal(action), sessionId: id }).strict()),
  z.object({ action: z.literal('PROBE'), sessionId: id, probes: z.array(z.enum(['READINESS', 'ATTESTATION'])).length(2).refine(values => new Set(values).size === values.length) }).strict(),
  z.object({ action: z.literal('EVIDENCE'), sessionId: id, revision: z.number().int().min(0).max(255).optional(), section: z.enum(['COVERAGE', 'SOURCE', 'RUNTIME']), offset: z.number().int().min(0).max(64).optional(), limit: z.number().int().min(1).max(16).optional() }).strict(),
  z.object({ action: z.literal('QUALIFY'), sessionId: id, bindingId: text, proofId: text, criterionId: text }).strict()
])
const failure = (error: unknown): RuntimePreviewResult => ({ success: false, code: error instanceof Error && /^[A-Z][A-Z_0-9:.-]{0,159}$/.test(error.message) ? error.message : 'PREVIEW_UNAVAILABLE' })
type Pending = { key: string; operationId: string; work: Promise<RuntimePreviewResult>; intent?: PreviewIntentReceipt }
const processView = (record: PreviewSessionRecord): PreviewSessionView['process'] => record.process ? {
  rootExited: record.process.rootSignaled, activeProcesses: record.process.activeProcesses, handlesClosed: record.process.knownHandlesClosed, assignedAtCreation: record.process.assignedAtCreation
} : null

export class RuntimePreviewOperations {
  private pending?: Pending
  private lastOperation: { operationId: string; code: string | null; result: RuntimePreviewResult } | null = null
  private lastOperationKey: string | null = null
  private readonly preflight: PreviewPreflightService
  constructor(private readonly repositories: PreviewRepositories, private readonly profiles: PreviewProfileStore,
    private readonly store: PreviewSessionStore, private readonly runner: RuntimePreviewRunner,
    private readonly confirm: (profile: PreviewProfile) => Promise<boolean>, private readonly ledger?: Pick<ValidationLedger, 'getProofWithFreshness'>,
    private readonly continuum?: Pick<RepositoryContinuumSession, 'getActiveService' | 'getActiveSession'>,
    private readonly branchProfiles?: Pick<CodeAwarenessProfileResolver, 'resolve'>) {
    this.preflight = new PreviewPreflightService(profiles)
  }
  private record(sessionId: string) {
    const record = this.store.read(sessionId)
    this.repositories.resolve(record.selection.repositoryId).guard()
    return record
  }
  private async profile(target: PreviewSelection) {
    const profile = (await this.profiles.profiles(target.repositoryId)).find(p => p.profileId === target.profileId)
    if (!profile || previewFingerprint(profile) !== target.fingerprint) throw new Error('PROFILE_CHANGED')
    return profile
  }
  async invokeChannel(input: unknown, guard: () => void = () => {}) {
    const parsed = channelSelector.safeParse(input)
    if (!parsed.success) return { success: false as const, code: 'SCOPE_REJECTED' }
    try {
      const { scope, operation, input: args } = parsed.data
      const context = this.repositories.resolve(scope.repositoryId)
      const current = () => { guard(); context.guard() }
      const reply = await this.runner.invokeChannel(scope, operation.startsWith('continuum.') ? 'runtime.liveness' : operation,
        operation.startsWith('continuum.') ? {} : args, current)
      if (!reply.result.success) return reply.result
      if (!operation.startsWith('continuum.')) return { success: true as const, data: { kind: 'CHANNEL', target: 'PREVIEW', ...reply } }
      if (!['continuum.list', 'continuum.get'].includes(operation)) return { success: false as const, code: 'CAPABILITY_UNAVAILABLE' }
      current()
      const service = this.continuum?.getActiveService(), active = this.continuum?.getActiveSession()
      if (!service || active?.repositoryId !== scope.repositoryId) return { success: false as const, code: 'PREVIEW_UNAVAILABLE' }
      const list = operation === 'continuum.list' ? knowledgeList.safeParse(args) : null
      const get = operation === 'continuum.get' ? knowledgeGet.safeParse(args) : null
      if (list && !list.success || get && !get.success) return { success: false as const, code: 'SCOPE_REJECTED' }
      const data = list?.success ? service.list(list.data) : get?.success ? service.get(get.data.artifactId) : null
      current()
      if (this.continuum?.getActiveSession()?.repositoryId !== scope.repositoryId || this.continuum.getActiveService() !== service) throw Error('SESSION_STALE')
      return { success: true as const, data: { kind: 'CHANNEL', target: 'HOST_CANONICAL', repositoryId: scope.repositoryId, sessionId: scope.sessionId, result: data } }
    } catch (error) {
      const parsedCode = previewChannelError.safeParse(error instanceof Error ? error.message : '')
      return { success: false as const, code: parsedCode.success ? parsedCode.data : 'PREVIEW_UNAVAILABLE' }
    }
  }
  private async check(target: PreviewSelection) {
    const context = await this.repositories.open(target.repositoryId, target.worktreeId)
    const value = await this.preflight.check(context.git, target); context.guard()
    return { kind: 'PREFLIGHT' as const, preflight: value, startAllowed: value.status === 'SUPPORTED' || diagnosticBootstrapAllowed(value, await this.profile(target)) }
  }
  async getStatus(input: unknown): Promise<RuntimePreviewResult> {
    const parsed = statusSelectorSchema.safeParse(input)
    if (!parsed.success) return { success: false, code: 'INVALID_ARGUMENT' }
    try {
      const selector = parsed.data
      const receipt = 'operationId' in selector ? this.pending?.operationId === selector.operationId && this.pending.intent ? this.pending.intent : this.store.readIntent(selector.operationId) : undefined
      const record = 'sessionId' in selector ? this.store.read(selector.sessionId) : receipt?.sessionId ? this.store.read(receipt.sessionId) : this.store.list().find(r => r.operationId === selector.operationId)
      const pending = this.pending?.operationId === (record?.operationId ?? receipt?.operationId ?? ('operationId' in selector ? selector.operationId : null))
      const stopping = !!record && this.pending?.key === 'stop:' + record.sessionId
      return { success: true, data: previewStatus(receipt, record, { ...selector, pending, stopping, owned: record ? this.runner.owns(record.sessionId) : false }) }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { success: true, data: previewStatus(undefined, undefined, parsed.data) }
      return failure(error)
    }
  }
  async runBranchApp(input: unknown, guard: () => void = () => {}): Promise<RuntimePreviewResult> {
    const parsed = branchIntentSchema.safeParse(input)
    if (!parsed.success) return { success: false, code: 'INVALID_ARGUMENT' }
    try {
      guard()
      const intent = parsed.data
      const repositoryId = intent.repositoryId ?? this.continuum?.getActiveSession()?.repositoryId
      if (!repositoryId) throw new Error('REPOSITORY_REQUIRED')
      const branch = intent.branch.startsWith('refs/') ? intent.branch : 'refs/heads/' + intent.branch
      const key = previewFingerprint({ ...intent, repositoryId, branch })
      const previous = this.store.readIntent(intent.operationId)
      if (previous) {
        if (previous.key !== key) throw new Error('OPERATION_ID_CONFLICT')
        return this.getStatus({ operationId: intent.operationId })
      }
      if (this.pending) throw new Error('PREVIEW_OPERATION_BUSY')
      if (this.store.unresolvedIntent()) throw new Error('PREVIEW_OPERATION_UNCERTAIN')
      if (this.store.list().some(r => r.operationId === intent.operationId)) throw new Error('OPERATION_ID_CONFLICT')
      const receipt: PreviewIntentReceipt = { operationId: intent.operationId, key, repositoryId, branch, at: new Date().toISOString(), revision: 0, sessionId: null, reasonCode: null, phase: 'PREPARING' }
      this.store.appendIntent(receipt)
      this.mutate('intent:' + intent.operationId, intent.operationId, async () => {
        let result: RuntimePreviewResult
        try {
          const context = await this.repositories.open(repositoryId)
          const inventory = await context.git.getBranchInventory()
          context.guard(); guard()
          const target = inventory.branches.find(b => b.ref === branch && b.repositoryId === repositoryId)
          if (!target) throw new Error('BRANCH_NOT_FOUND')
          receipt.head = target.head
          if (intent.expectedHead && target.head !== intent.expectedHead) throw new Error('EXPECTED_HEAD_MISMATCH')
          const tree = intent.worktreeId ? inventory.worktrees.find(w => w.worktreeId === intent.worktreeId && target.worktrees.some(t => t.worktreeId === w.worktreeId && t.generation === w.generation)) : undefined
          if (intent.worktreeId && !tree) throw new Error('WORKTREE_STALE')
          const candidates = inventory.worktrees.filter(w => target.worktrees.some(t => t.worktreeId === w.worktreeId && t.generation === w.generation) && w.branch === target.name && w.head === target.head)
          receipt.worktreeId = tree?.worktreeId ?? (candidates.length === 1 ? candidates[0].worktreeId : null)
          if (this.pending?.operationId === intent.operationId) this.pending.intent = receipt
          result = await this.runBranch({ action: 'RUN_BRANCH_APP', repositoryId, ref: target.ref, revision: target.revision, operationId: intent.operationId,
            ...(tree ? { worktree: { worktreeId: tree.worktreeId, generation: tree.generation } } : {}) }, guard)
        } catch (error) { result = failure(error) }
        const session = result.success && result.data.kind === 'SESSION' ? result.data.session : null
        const blocked = result.success && result.data.kind === 'BRANCH_APP'
        const reasonCode = !result.success ? result.code : result.data.kind === 'BRANCH_APP' ? result.data.reasonCode : null
        this.store.appendIntent({ ...receipt, revision: 1, at: new Date().toISOString(), sessionId: session?.sessionId ?? null,
          phase: blocked || reasonCode && /BRANCH|HEAD_MISMATCH|WORKTREE|PROFILE|PREFLIGHT/.test(reasonCode) ? 'BLOCKED' : session ? 'RUNNING' : 'FAILED', reasonCode })
        return result
      })
      return this.getStatus({ operationId: intent.operationId })
    } catch (error) { return failure(error) }
  }
  private async runBranch(request: Extract<RuntimePreviewRequest, { action: 'RUN_BRANCH_APP' }>, guard: () => void): Promise<RuntimePreviewResult> {
    const blocked = (reasonCode: string, message: string, details = {}): RuntimePreviewResult => ({ success: true, data: { kind: 'BRANCH_APP', reasonCode, message, ...details } })
    if (!this.branchProfiles) return blocked('APP_HOST_UNSUPPORTED', 'Esta instalação não oferece um perfil seguro para rodar o Code Awareness.')
    const context = await this.repositories.open(request.repositoryId), inventory = await context.git.getBranchInventory()
    const observedBranch = inventory.branches.find(b => b.ref === request.ref && b.repositoryId === request.repositoryId)
    const branch = observedBranch ? structuredClone(observedBranch) : undefined
    if (!branch || branch.revision !== request.revision || branch.generation === 'UNKNOWN') throw new Error('BRANCH_CHANGED')
    if (branch.namespace !== 'LOCAL' || !branch.worktrees.length) return blocked('BRANCH_CHECKOUT_REQUIRED', 'Esta branch precisa de um checkout local compatível antes de rodar.')
    const candidates = inventory.worktrees.filter(w => branch.worktrees.some(b => b.worktreeId === w.worktreeId && b.generation === w.generation) && w.branch === branch.name && w.head === branch.head)
    if (request.worktree && !candidates.some(w => w.worktreeId === request.worktree!.worktreeId && w.generation === request.worktree!.generation)) throw new Error('WORKTREE_STALE')
    if (!request.worktree && candidates.length > 1) return blocked('BRANCH_CHECKOUT_AMBIGUOUS', 'Há mais de um checkout desta branch. Escolha qual deseja executar.', { candidates })
    const observedTree = request.worktree ? candidates.find(w => w.worktreeId === request.worktree!.worktreeId)! : candidates[0]
    const tree = observedTree ? structuredClone(observedTree) : undefined
    if (!tree || tree.detached || tree.locked || tree.missing || tree.prunable) return blocked('APP_CHECKOUT_UNAVAILABLE', 'O checkout desta branch não está disponível para execução.')
    const verify = async () => {
      guard(); context.guard()
      const current = await context.git.getBranchInventory(), selected = current.branches.find(b => b.ref === branch.ref)
      if (!selected || selected.revision !== branch.revision || selected.generation !== branch.generation || selected.head !== branch.head || !selected.worktrees.some(w => w.worktreeId === tree.worktreeId && w.generation === tree.generation)) throw new Error('BRANCH_CHANGED')
      const identity = await context.git.getCoordinationIdentity(tree.worktreeId)
      if (identity.repositoryId !== request.repositoryId || identity.record.generation !== tree.generation || identity.record.path !== tree.path || identity.record.head !== branch.head || identity.record.branch !== branch.name || identity.record.locked || identity.record.missing || identity.record.detached || identity.record.prunable) throw new Error('WORKTREE_STALE')
      guard(); context.guard()
    }
    await verify()
    const active = this.store.list().find(r => !['STOPPED', 'FAILED'].includes(r.state) || r.resources !== 'RELEASED')
    if (active) {
      if (active.operationId === request.operationId && active.selection.repositoryId === request.repositoryId && active.selection.worktreeId === tree.worktreeId && active.selection.generation === tree.generation && active.sourceSnapshot?.branch === branch.name && active.sourceSnapshot.head === branch.head) return { success: true, data: { kind: 'SESSION', session: await this.view(active, false), pending: false } }
      return blocked('PREVIEW_SESSION_ACTIVE', 'Já existe um aplicativo de preview ativo. Encerre essa sessão explicitamente antes de rodar outra branch.', { activeSession: await this.view(active, false) })
    }
    let profile: PreviewProfile
    try { profile = await this.branchProfiles.resolve(request.repositoryId, tree.worktreeId, tree.path) }
    catch (error) {
      const result = failure(error)
      const code = !result.success ? result.code : 'APP_PROFILE_UNAVAILABLE'
      const messages: Record<string, string> = {
        APP_CHECKOUT_UNSUPPORTED: 'Este checkout não contém um aplicativo Code Awareness suportado.',
        APP_COOPERATION_MISSING: 'Falta o bootstrap V5 neste checkout. Use uma branch compatível; o checkout não será adaptado automaticamente.',
        APP_COOPERATION_INCOMPATIBLE: 'O bootstrap deste checkout difere do contrato suportado pelo host. É necessária revisão de compatibilidade.',
        APP_RUNTIME_UNAVAILABLE: 'O Electron desta Worktree não está disponível. Prepare as dependências em uma operação separada e autorizada.',
        APP_RUNTIME_INCOMPATIBLE: 'O Electron instalado nesta Worktree é incompatível com o runtime suportado pelo host.',
        APP_HOST_PROFILE_UNAVAILABLE: 'Esta instalação do host não dispõe do template necessário para formar um perfil seguro.',
        APP_NODE_UNAVAILABLE: 'O Node necessário ao lançamento não está disponível no ambiente do host.',
        APP_GIT_UNAVAILABLE: 'O Git necessário à identidade do preview não está disponível no ambiente do host.',
        APP_PROFILE_POLICY_CHANGED: 'A política do perfil foi alterada e exige revisão independente. Nenhuma garantia foi reduzida.'
      }
      return blocked(code, messages[code] ?? 'Não foi possível formar um perfil seguro para este checkout. Confira a compatibilidade V5 e as dependências desta Worktree nos detalhes.')
    }
    const target = { repositoryId: request.repositoryId, worktreeId: tree.worktreeId, generation: tree.generation, profileId: profile.profileId, fingerprint: previewFingerprint(profile) }
    const before = await this.check(target)
    if (before.preflight.diagnostics.some(d => !['PROFILE_APPROVAL_REQUIRED', 'ABI_UNVERIFIED', 'RUNTIME_COMPATIBILITY_UNVERIFIED', 'DEPENDENCY_MATERIALIZATION_UNVERIFIABLE'].includes(d.reasonCode))) return blocked('APP_PREFLIGHT_BLOCKED', 'O checkout não passou na pré-checagem. Veja a condição concreta nos detalhes.', { preflight: before.preflight })
    await verify()
    if (!await this.profiles.approved(profile)) {
      try { await this.profiles.approve(profile, this.confirm, () => { guard(); context.guard() }) }
      catch (error) { if (error instanceof Error && error.message === 'PROFILE_APPROVAL_REQUIRED') return blocked('PROFILE_APPROVAL_REQUIRED', 'Execução cancelada. Nenhum aplicativo foi iniciado.'); throw error }
    }
    await verify()
    const checked = await this.check(target)
    if (!checked.startAllowed) return blocked('APP_PREFLIGHT_BLOCKED', 'O checkout não passou na pré-checagem. Veja a condição concreta nos detalhes.', { preflight: checked.preflight })
    const record = await this.runner.start({ selection: target, operationId: request.operationId, guard: verify })
    return { success: true, data: { kind: 'SESSION', session: await this.view(record, true), pending: false } }
  }
  private async view(record: PreviewSessionRecord, current: boolean, known?: PreviewQualification): Promise<PreviewSessionView> {
    const coverage = record.coverage.map(c => ({ ...c }))
    const qualifications: PreviewQualification[] = []
    for (const link of record.validationLinks ?? []) {
      const qualified = known && known.bindingId === link.bindingId && known.proofId === link.proofId && known.criterionId === link.criterionId ? known : current ? await this.assess(record, link).catch(error => { const result = failure(error); return this.inconclusive(link, !result.success ? result.code : 'EVIDENCE_UNVERIFIABLE') }) : this.inconclusive(link, 'INSPECT_REQUIRED')
      qualifications.push(qualified)
    }
    const behavior = qualifications.find(q => q.observedStatus === 'PASSED' || q.observedStatus === 'FAILED')
    if (behavior) {
      const entry = coverage.find(c => c.stage === 'BEHAVIOR')
      if (entry) Object.assign(entry, { status: 'VERIFIED', evidenceRef: behavior.proofId, at: behavior.at, reasonCode: 'VALIDATION_LEDGER_BEHAVIOR_OBSERVED' })
    }
    let endpoint: string | null = null
    if (current && record.state === 'RUNNING' && record.readiness === 'READY' && record.coverage.some(c => c.stage === 'ENDPOINT' && c.status === 'VERIFIED')) {
      try { const profile = await this.profile(record.selection); const address = new URL(profile.probes.readiness.address); if (address.hostname === '127.0.0.1' && address.protocol === 'http:' && !address.username && !address.password) endpoint = address.origin } catch { }
    }
    return { sessionId: record.sessionId, operationId: record.operationId, selection: record.selection, revision: record.revision, profileRevision: record.profileRevision,
      state: record.state, readiness: record.readiness, liveness: record.liveness, resources: record.resources, failure: record.failure,
      observation: this.pending && !current ? 'IN_PROGRESS' : record.persistence !== 'PERSISTED' || ['OWNERSHIP_UNVERIFIED', 'CLEANUP_INCOMPLETE'].includes(record.state) ? 'UNVERIFIABLE' : current && !['STOPPED', 'FAILED'].includes(record.state) ? 'CURRENT' : 'HISTORICAL',
      source: record.sourceObservation?.snapshot ?? record.sourceSnapshot, coverage, qualifications, endpoint,
      at: record.at, startedAt: record.startedAt, endedAt: record.endedAt, process: processView(record),
      ...(record.termination ? { termination: { kind: record.termination.kind, reasonCode: record.termination.reasonCode, rootExit: record.termination.rootExit } } : {}) }
  }
  private inconclusive(link: PreviewValidationLink, reason: string): PreviewQualification {
    return { ...link, status: 'INCONCLUSIVE', observedStatus: 'UNVERIFIABLE', reasons: [reason], at: new Date().toISOString(), evidenceAt: null, scope: [] }
  }
  private async binding(record: PreviewSessionRecord, bindingId: string) {
    const active = this.continuum?.getActiveSession(), service = this.continuum?.getActiveService()
    if (!active || !service || active.repositoryId !== record.selection.repositoryId) throw new Error('CONTINUUM_REPOSITORY_UNAVAILABLE')
    const artifact = service.get(bindingId), metadata = artifact?.metadata
    if (!artifact || artifact.provenance.executionBranchBinding !== true || metadata?.bindingRole !== 'EXECUTION_BRANCH' || metadata.repositoryId !== record.selection.repositoryId ||
      metadata.worktreeId !== record.selection.worktreeId || metadata.worktreeGeneration !== record.selection.generation || typeof metadata.executionId !== 'string') throw new Error('EXECUTION_BINDING_UNVERIFIABLE')
    const context = await this.repositories.open(record.selection.repositoryId, record.selection.worktreeId)
    const inventory = await context.git.getBranchInventory(), branch = inventory.branches.find(b => b.ref === metadata.branchRef)
    if (!branch || branch.generation === 'UNKNOWN' || branch.generation !== metadata.branchGeneration || !branch.worktrees.some(w => w.worktreeId === record.selection.worktreeId && w.generation === record.selection.generation)) throw new Error('EXECUTION_BINDING_STALE')
    context.guard()
    if (active !== this.continuum?.getActiveSession() || service !== this.continuum.getActiveService()) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    return { bindingId, executionId: metadata.executionId }
  }
  private async assess(record: PreviewSessionRecord, link: PreviewValidationLink): Promise<PreviewQualification> {
    const binding = await this.binding(record, link.bindingId)
    if (binding.executionId !== link.executionId) throw new Error('EXECUTION_BINDING_CHANGED')
    const proof = await this.ledger?.getProofWithFreshness(link.proofId)
    const evidence = this.store.read(record.sessionId, link.evidenceRevision)
    const context = await this.repositories.open(record.selection.repositoryId, record.selection.worktreeId)
    const identity = await context.git.getCoordinationIdentity(record.selection.worktreeId)
    if (identity.record.generation !== record.selection.generation) throw new Error('WORKTREE_STALE')
    const source = proof?.freshness === 'CURRENT' && proof.commandProfile?.source ? proof.commandProfile.source : await captureValidationSource(identity.record.path, record.selection.repositoryId)
    const captured = evidence.sourceObservation?.snapshot ?? evidence.sourceSnapshot
    if (!proof || source.repositoryId !== record.selection.repositoryId || source.worktreeId !== record.selection.worktreeId || source.generation !== record.selection.generation || source.head !== identity.record.head || source.branch !== identity.record.branch || proof.sourceFingerprint !== validationSourceFingerprint(source) || proof.commandProfile?.source?.worktreeId !== source.worktreeId || proof.commandProfile.source.generation !== source.generation || proof.commandProfile.source.repositoryId !== source.repositoryId ||
      proof.commandProfile.cwd !== source.cwd || !proof.evidenceFor.includes(link.criterionId) || !proof.evidenceFor.includes('runtime-preview:' + record.sessionId) || !proof.evidenceFor.includes('execution:' + link.executionId)) throw new Error('VALIDATION_IDENTITY_MISMATCH')
    const reasons: string[] = []
    if (!captured || captured.head !== source.head || captured.branch !== source.branch || captured.indexRevision !== source.indexRevision || link.sourceFingerprint !== proof.sourceFingerprint) reasons.push(link.sourceFingerprint ? 'SESSION_SOURCE_STALE' : 'SESSION_SOURCE_CONTENT_UNVERIFIABLE')
    if (proof.freshness !== 'CURRENT') reasons.push('VALIDATION_PROOF_NOT_CURRENT')
    if (!['MANUAL_ACCEPTANCE', 'E2E'].includes(proof.kind)) reasons.push('BEHAVIOR_NOT_OBSERVED')
    if (proof.kind === 'E2E' && ((proof.metrics?.testsPassed ?? 0) + (proof.metrics?.testsFailed ?? 0) <= 0 || proof.status === 'PASSED' && (proof.metrics?.testsFailed ?? 0) > 0)) reasons.push('BEHAVIOR_EVIDENCE_INSUFFICIENT')
    if (Date.parse(proof.startedAt) < Date.parse(evidence.startedAt) || Date.parse(proof.finishedAt) > Date.parse(evidence.at) || Date.parse(proof.finishedAt) < Date.parse(proof.startedAt)) reasons.push('OBSERVATION_OUTSIDE_SESSION')
    if (evidence.state !== 'RUNNING' || evidence.readiness !== 'READY' || evidence.persistence !== 'PERSISTED' || evidence.liveness !== 'VERIFIED') reasons.push('RUNTIME_EVIDENCE_INCOMPLETE')
    if (!evidence.coverage.some(c => c.stage === 'TARGET_CHECKOUT' && c.status === 'VERIFIED') || !evidence.coverage.some(c => c.stage === 'ENDPOINT' && c.status === 'VERIFIED')) reasons.push('SOURCE_ENDPOINT_CHAIN_INCOMPLETE')
    const profile = await this.profile(record.selection)
    const declared = profile.adapter?.artifacts.map(artifact => artifact.path) ?? []
    const scope = declared.filter(path => proof.scope?.includes(path))
    if (!proof.scope?.length || proof.scope.some(path => !declared.includes(path))) reasons.push('VALIDATION_SCOPE_UNATTESTED')
    if (!await this.profiles.approved(profile)) reasons.push('PROFILE_APPROVAL_REQUIRED')
    for (const artifact of profile.adapter?.artifacts ?? []) {
      const loaded = evidence.coverage.find(c => c.stage === 'LOADED_COMPONENT' && c.component === artifact.component && c.evidenceRef === artifact.path)
      if (loaded?.status !== 'VERIFIED' || !loaded.fingerprint) reasons.push('LOADED_COMPONENT_INCOMPLETE:' + artifact.component)
      if (['WEB', 'ELECTRON_RENDERER'].includes(artifact.component) && !evidence.coverage.some(c => c.stage === 'SERVED_ARTIFACT' && c.component === artifact.component && c.evidenceRef === artifact.path && c.status === 'VERIFIED' && c.fingerprint)) reasons.push('SERVED_ARTIFACT_INCOMPLETE:' + artifact.component)
    }
    if (!profile.adapter?.artifacts.length) reasons.push('ARTIFACT_SCOPE_UNVERIFIABLE')
    context.guard()
    return { ...link, status: reasons.length || proof.status === 'ERROR' ? 'INCONCLUSIVE' : proof.status === 'PASSED' ? 'PASSED' : 'FAILED', observedStatus: ['MANUAL_ACCEPTANCE', 'E2E'].includes(proof.kind) ? proof.status : 'NOT_OBSERVED', reasons, at: new Date().toISOString(), evidenceAt: evidence.at, scope }
  }
  private mutate(key: string, operationId: string, work: () => Promise<RuntimePreviewResult>): RuntimePreviewResult {
    if (key.startsWith('run-branch:') && this.lastOperation?.operationId === operationId) {
      if (this.lastOperationKey !== key) throw new Error('OPERATION_ID_CONFLICT')
      return structuredClone(this.lastOperation.result)
    }
    if (this.pending && this.pending.key !== key) throw new Error('PREVIEW_OPERATION_BUSY')
    if (!this.pending || this.pending.key !== key) {
      const pending: Pending = { key, operationId, work: Promise.resolve().then(work).catch(failure) }
      this.pending = pending
      void pending.work.then(result => {
        const completed = structuredClone(result)
        if (completed.success && 'session' in completed.data && completed.data.session) {
          if (completed.data.session.observation === 'CURRENT') completed.data.session.observation = 'HISTORICAL'
        }
        this.lastOperation = { operationId, code: result.success ? null : result.code, result: completed }
        this.lastOperationKey = key
        if (this.pending === pending) this.pending = undefined
      })
    }
    return { success: true, data: { kind: 'SESSION', session: null, operationId, pending: true } }
  }
  async handle(input: unknown, guard: () => void = () => {}): Promise<RuntimePreviewResult> {
    const parsed = previewRequestSchema.safeParse(input)
    if (!parsed.success) return { success: false, code: 'INVALID_ARGUMENT' }
    const request = parsed.data as RuntimePreviewRequest
    try {
      guard()
      if (request.action === 'RUN_BRANCH_APP') return this.mutate('run-branch:' + request.operationId + ':' + previewFingerprint(request), request.operationId, () => this.runBranch(request, guard))
      if (request.action === 'PROFILES') { const context = this.repositories.resolve(request.repositoryId); const profiles = await this.preflight.list(request.repositoryId); context.guard(); guard(); return { success: true, data: { kind: 'PROFILES', profiles } } }
      if (request.action === 'WORKTREES') { const context = await this.repositories.open(request.repositoryId); context.guard(); guard(); return { success: true, data: { kind: 'WORKTREES', repositoryId: request.repositoryId, worktrees: context.worktrees } } }
      if (request.action === 'PREFLIGHT') return this.mutate('preflight:' + previewFingerprint(request.selection), previewFingerprint(request.selection), async () => { const data = await this.check(request.selection); guard(); return { success: true, data } })
      if (request.action === 'AUTHORIZE') {
        this.repositories.resolve(request.selection.repositoryId).guard()
        return this.mutate('approve:' + previewFingerprint(request.selection), previewFingerprint(request.selection), async () => {
          const profile = await this.profile(request.selection), context = await this.repositories.open(request.selection.repositoryId, request.selection.worktreeId)
          const identity = await context.git.getCoordinationIdentity(request.selection.worktreeId)
          if (identity.record.generation !== request.selection.generation) throw new Error('WORKTREE_STALE')
          await this.profiles.assertExternal(identity.record.path)
          if (!await this.profiles.approved(profile)) await this.profiles.approve(profile, this.confirm, () => { guard(); context.guard() })
          guard(); context.guard()
          return { success: true, data: await this.check(request.selection) }
        })
      }
      if (request.action === 'START') {
        this.repositories.resolve(request.selection.repositoryId).guard()
        return this.mutate('start:' + request.operationId + ':' + previewFingerprint(request.selection), request.operationId, async () => ({ success: true, data: { kind: 'SESSION', session: await this.view(await this.runner.start({ ...request, guard }), true), pending: false } }))
      }
      if (request.action === 'LIST') {
        this.repositories.resolve(request.repositoryId).guard()
        const records = this.store.list().filter(r => r.selection.repositoryId === request.repositoryId && (!request.worktreeId || r.selection.worktreeId === request.worktreeId)).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.sessionId.localeCompare(b.sessionId))
        const offset = request.cursor ? records.findIndex(r => r.sessionId === request.cursor) + 1 : 0
        if (request.cursor && !offset) throw new Error('INVALID_SESSION_CURSOR')
        const page = records.slice(offset, offset + (request.limit ?? 10))
        return { success: true, data: { kind: 'SESSIONS', sessions: await Promise.all(page.map(r => this.view(r, false))), nextCursor: offset + page.length < records.length ? page.at(-1)!.sessionId : null, pendingOperationId: this.pending?.operationId ?? null, lastOperation: this.lastOperation } }
      }
      if (!('sessionId' in request)) throw new Error('INVALID_ARGUMENT')
      const record = request.action === 'STOP' ? this.store.read(request.sessionId) : this.record(request.sessionId)
      if (request.action === 'STOP') return this.mutate('stop:' + record.sessionId, record.operationId, async () => ({ success: true, data: { kind: 'SESSION', session: await this.view(await this.runner.stop(record.sessionId), true), pending: false } }))
      if (request.action === 'EVIDENCE') {
        const evidence = this.store.read(record.sessionId, request.revision)
        const entries = request.section === 'COVERAGE' ? evidence.coverage : request.section === 'SOURCE' ? [{ selection: evidence.selection, source: evidence.sourceObservation?.snapshot ?? evidence.sourceSnapshot, at: evidence.at }] : [{ process: processView(evidence), compatibility: evidence.runtimeEvidence ?? null, termination: evidence.termination ?? null, stopIntent: evidence.stopIntent ?? null, ...(evidence.context ? { data: evidence.context.data, context: { repositoryId: evidence.context.selection.repositoryId, worktreeId: evidence.context.selection.worktreeId, generation: evidence.context.selection.generation, mode: evidence.context.mode } } : {}) }, ...evidence.resourceInventory.map(r => ({ name: r.name, kind: r.kind, state: r.state }))]
        const offset = request.offset ?? 0, page = entries.slice(offset, offset + (request.limit ?? 8))
        return { success: true, data: { kind: 'EVIDENCE', sessionId: record.sessionId, revision: evidence.revision, section: request.section, entries: page, nextOffset: offset + page.length < entries.length ? offset + page.length : null } }
      }
      if (request.action === 'BINDINGS') {
        const service = this.continuum?.getActiveService(), active = this.continuum?.getActiveSession()
        if (!service || active?.repositoryId !== record.selection.repositoryId) return { success: true, data: { kind: 'BINDINGS', bindings: [], reason: 'CONTINUUM_REPOSITORY_UNAVAILABLE' } }
        const page = service.list({ kind: 'OBSERVATION', metadata: { bindingRole: 'EXECUTION_BRANCH', worktreeId: record.selection.worktreeId, worktreeGeneration: record.selection.generation }, limit: 20 })
        const bindings = []
        for (const artifact of page.artifacts) { try { bindings.push(await this.binding(record, artifact.artifactId)) } catch { } }
        return { success: true, data: { kind: 'BINDINGS', bindings, reason: page.nextCursor ? 'PARTIAL_BINDING_COVERAGE' : null } }
      }
      if (this.pending) return { success: true, data: { kind: 'SESSION', session: await this.view(record, false), pending: true, operationId: this.pending.operationId } }
      if (request.action === 'QUALIFY') {
        return this.mutate('qualify:' + previewFingerprint(request), record.operationId, async () => {
          const existing = record.validationLinks?.find(link => link.bindingId === request.bindingId && link.proofId === request.proofId && link.criterionId === request.criterionId)
          if (existing) { const qualification = await this.assess(record, existing); guard(); return { success: true, data: { kind: 'QUALIFICATION', session: await this.view(record, true, qualification), qualification } } }
          const context = await this.repositories.open(record.selection.repositoryId, record.selection.worktreeId)
          const identity = await context.git.getCoordinationIdentity(record.selection.worktreeId)
          const before = await captureValidationSource(identity.record.path, record.selection.repositoryId)
          const observed = await this.runner.inspect(record.sessionId); guard()
          const after = await captureValidationSource(identity.record.path, record.selection.repositoryId)
          const sourceFingerprint = validationSourceFingerprint(before)
          if (sourceFingerprint !== validationSourceFingerprint(after)) throw new Error('VALIDATION_SOURCE_CHANGED')
          context.guard()
          const binding = await this.binding(observed, request.bindingId), link = { ...binding, criterionId: request.criterionId, proofId: request.proofId, evidenceRevision: observed.revision, sourceFingerprint }
          let qualification = await this.assess(observed, link); guard()
          const linked = await this.runner.linkValidation(record.sessionId, link, observed.revision, async () => { guard(); qualification = await this.assess(observed, link) })
          return { success: true, data: { kind: 'QUALIFICATION', session: await this.view(linked, true, qualification), qualification } }
        })
      }
      return this.mutate('inspect:' + record.sessionId, record.operationId, async () => {
        const observed = await this.runner.inspect(record.sessionId); guard()
        return { success: true, data: { kind: 'SESSION', session: await this.view(observed, true), pending: false } }
      })
    } catch (error) { return failure(error) }
  }
  async pendingResult() { return this.pending?.work }
}
