import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { digest } from './privacy'
import { sourceFingerprint, type SessionTargetSelection } from './target'
import type { SessionStore } from './store'
import type { EntireProvider, CommandRunner } from './entire-provider'
import { observeCheckpoint } from './checkpoint-observation'
import { captureHealthSources, type CaptureHealthObservation } from './capture-health-types'
import { nativeHookProviders, nativeHookSource, type NativeHookProvider } from './native-hooks'
import { nativeCaptureDiagnostics } from './native-hook-diagnostics'
import { nativeHookReadiness } from './native-hook-readiness'
import type { CapturedRuntimeHelperState } from './native-hook-profile'
import type { NativeTrustObservation } from './native-hook-preflight'

export const captureHealthQuery = z.object({ worktreeId: z.string().regex(/^[a-f0-9]{64}$/).optional(), generation: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  source: z.enum(captureHealthSources).optional(),
  inspectNativeTrust: z.boolean().default(false),
  cycleId: z.string().min(1).max(200).default('worktree'), trigger: z.enum(['INSPECT', 'RECHECK', 'BEGIN', 'LOCAL_COMMIT']).default('INSPECT'),
  agent: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/).optional(),
  sessionId: z.string().min(1).max(200).optional(),
  executionId: z.string().min(1).max(200).optional(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/).optional() }).strict().refine(q => !q.worktreeId === !q.generation)
  .refine(q => q.source !== 'native' || (!q.commitSha && (q.trigger === 'INSPECT' || q.trigger === 'RECHECK') &&
    (!q.agent || nativeHookProviders.some(provider => provider === q.agent))))
type Query = z.infer<typeof captureHealthQuery>
export const nativeCaptureAgent = (query: Query): NativeHookProvider =>
  query.agent === 'antigravity' ? 'antigravity' : 'codex'

export interface NativeCaptureBoundaryDiagnostic {
  stage: 'HELPER_BUNDLE' | 'HOOK_INSTALLATION' | 'SCOPE_BINDING' | 'HOST_EXECUTION' | 'SPOOL' | 'REGISTRY_INGESTION' | 'PROVENANCE_ASSOCIATION'
  boundary: string
  reasonCode: string
  ownership: 'CODE_AWARENESS' | 'EXTERNAL_CLIENT'
  recommendedAction: string
  nextEvidence: string
}

const SCOPE_BINDING_REASONS = new Set(['WORKTREE_STALE', 'HOOK_BINDING_DRIFT', 'NATIVE_CAPTURE_DISABLED', 'INSTALLATION_OWNERSHIP_UNPROVEN'])

function inspectNativeBoundary(
  readiness: ReturnType<typeof nativeHookReadiness>,
  diagnostics: ReturnType<typeof nativeCaptureDiagnostics>,
  causalityBoundary: 'CONTEXTUAL_ONLY_NO_HOST_WITNESS' | 'RECEIPT_CORRELATION_SUPPORTED'
): NativeCaptureBoundaryDiagnostic {
  const { helperVersion, installation, bootstrap, trust, execution, captureReadiness } = readiness
  const pendingSpoolCount = typeof (diagnostics as { pendingSpoolCount?: unknown }).pendingSpoolCount === 'number'
    ? (diagnostics as { pendingSpoolCount: number }).pendingSpoolCount : 0
  const historicalCoverage = (diagnostics as { historicalCoverage?: { state?: string } }).historicalCoverage
  const lastIngestion = (diagnostics as { lastIngestion?: { state?: string; deferredByBudget?: boolean } }).lastIngestion

  if (helperVersion.reasonCode === 'RUNTIME_SOURCE_STALE') {
    return {
      stage: 'HELPER_BUNDLE',
      boundary: 'RUNTIME_HELPER_BUNDLE',
      reasonCode: 'RUNTIME_SOURCE_STALE',
      ownership: 'CODE_AWARENESS',
      recommendedAction: 'RESTART_CODE_AWARENESS_RUNTIME',
      nextEvidence: 'RESTART_RUNTIME_TO_RELOAD_HELPER_BUNDLE'
    }
  }
  if (installation.state === 'MISSING') {
    if (bootstrap?.state === 'UNAVAILABLE' && bootstrap.reasonCode === 'HOOK_ENROLLMENT_REQUIRED') {
      return {
        stage: 'SCOPE_BINDING',
        boundary: 'SCOPE_BINDING',
        reasonCode: 'HOOK_ENROLLMENT_REQUIRED',
        ownership: 'CODE_AWARENESS',
        recommendedAction: 'ENROLL_NATIVE_HOOKS',
        nextEvidence: 'ENROLL_REPOSITORY_FOR_NATIVE_HOOKS'
      }
    }
    return {
      stage: 'HOOK_INSTALLATION',
      boundary: 'HOOK_INSTALLATION',
      reasonCode: installation.reasonCode,
      ownership: 'CODE_AWARENESS',
      recommendedAction: 'INSTALL_NATIVE_HOOKS',
      nextEvidence: 'REQUEST_INSTALLATION_APPROVAL'
    }
  }
  if (installation.state !== 'CONFIGURED') {
    const scopeError = SCOPE_BINDING_REASONS.has(installation.reasonCode)
    return {
      stage: scopeError ? 'SCOPE_BINDING' : 'HOOK_INSTALLATION',
      boundary: scopeError ? 'SCOPE_BINDING' : 'HOOK_INSTALLATION',
      reasonCode: installation.reasonCode,
      ownership: 'CODE_AWARENESS',
      recommendedAction: installation.repairability === 'REPAIRABLE' ? 'REPAIR_NATIVE_HOOKS'
        : scopeError ? 'INSPECT_INSTALLATION_READ_ONLY' : 'RESOLVE_NATIVE_HOOK_INSTALLATION',
      nextEvidence: readiness.nextEvidence
    }
  }
  if (helperVersion.state === 'STALE') {
    return {
      stage: 'HOOK_INSTALLATION',
      boundary: 'INSTALLED_HELPER_VERSION',
      reasonCode: 'HOOK_HELPER_STALE',
      ownership: 'CODE_AWARENESS',
      recommendedAction: 'REINSTALL_NATIVE_HOOKS',
      nextEvidence: 'REINSTALL_HELPER_AND_RELOAD_CLIENT'
    }
  }
  if (helperVersion.state === 'UNKNOWN') {
    return {
      stage: 'HELPER_BUNDLE',
      boundary: 'RUNTIME_HELPER_BUNDLE',
      reasonCode: helperVersion.reasonCode,
      ownership: 'CODE_AWARENESS',
      recommendedAction: 'VERIFY_RUNTIME_HELPER_BUNDLE',
      nextEvidence: 'VERIFY_RUNTIME_HELPER_BUNDLE'
    }
  }
  if (bootstrap?.state === 'UNAVAILABLE') {
    return {
      stage: 'SCOPE_BINDING',
      boundary: 'SCOPE_BINDING',
      reasonCode: bootstrap.reasonCode,
      ownership: 'CODE_AWARENESS',
      recommendedAction: bootstrap.reasonCode === 'HOOK_ENROLLMENT_REQUIRED' ? 'ENROLL_NATIVE_HOOKS' : 'INSPECT_INSTALLATION_READ_ONLY',
      nextEvidence: readiness.nextEvidence
    }
  }
  if (captureReadiness.state === 'OBSERVED') {
    if (pendingSpoolCount > 0) {
      return {
        stage: 'SPOOL',
        boundary: 'SPOOL_BACKLOG',
        reasonCode: lastIngestion?.deferredByBudget ? 'SPOOL_BACKPRESSURE' : 'INGESTION_PENDING',
        ownership: 'CODE_AWARENESS',
        recommendedAction: 'RECONCILE_CHECKPOINT_REGISTRY',
        nextEvidence: 'DRAIN_NATIVE_SPOOL'
      }
    }
    if (historicalCoverage?.state === 'PARTIAL') {
      return {
        stage: 'REGISTRY_INGESTION',
        boundary: 'REGISTRY_INGESTION',
        reasonCode: 'CAPTURE_PARTIAL',
        ownership: 'CODE_AWARENESS',
        recommendedAction: 'INSPECT_AND_ACKNOWLEDGE_GAPS',
        nextEvidence: 'ACKNOWLEDGE_HISTORICAL_GAPS'
      }
    }
    return {
      stage: 'PROVENANCE_ASSOCIATION',
      boundary: 'PROVENANCE_ASSOCIATION',
      reasonCode: causalityBoundary === 'CONTEXTUAL_ONLY_NO_HOST_WITNESS' ? 'CONTEXTUAL_ONLY_NO_HOST_WITNESS' : 'CURRENT_WINDOW_INGESTED',
      ownership: causalityBoundary === 'CONTEXTUAL_ONLY_NO_HOST_WITNESS' ? 'EXTERNAL_CLIENT' : 'CODE_AWARENESS',
      recommendedAction: causalityBoundary === 'CONTEXTUAL_ONLY_NO_HOST_WITNESS' ? 'CONTEXTUAL_PROVENANCE_ONLY' : 'NONE',
      nextEvidence: 'NONE'
    }
  }
  if (pendingSpoolCount > 0) {
    return {
      stage: 'SPOOL',
      boundary: 'SPOOL_BACKLOG',
      reasonCode: lastIngestion?.deferredByBudget ? 'SPOOL_BACKPRESSURE' : 'INGESTION_PENDING',
      ownership: 'CODE_AWARENESS',
      recommendedAction: 'RECONCILE_CHECKPOINT_REGISTRY',
      nextEvidence: 'DRAIN_NATIVE_SPOOL'
    }
  }
  if (captureReadiness.state === 'PARTIAL' || lastIngestion?.state === 'PARTIAL') {
    return {
      stage: 'REGISTRY_INGESTION',
      boundary: 'REGISTRY_INGESTION',
      reasonCode: 'CAPTURE_PARTIAL',
      ownership: 'CODE_AWARENESS',
      recommendedAction: 'INSPECT_AND_ACKNOWLEDGE_GAPS',
      nextEvidence: 'ACKNOWLEDGE_HISTORICAL_GAPS'
    }
  }
  if (execution.state === 'FAILED') {
    return {
      stage: 'HOST_EXECUTION',
      boundary: 'HOST_EXECUTION',
      reasonCode: execution.reasonCode,
      ownership: 'EXTERNAL_CLIENT',
      recommendedAction: 'INSPECT_FAILED_EVENT_READ_ONLY',
      nextEvidence: 'INSPECT_FAILED_EVENT_READ_ONLY'
    }
  }
  if (trust.state === 'UNTRUSTED' || trust.state === 'PARTIAL') {
    return {
      stage: 'HOST_EXECUTION',
      boundary: 'HOST_EXECUTION',
      reasonCode: trust.reasonCode,
      ownership: 'EXTERNAL_CLIENT',
      recommendedAction: 'CLIENT_REVIEW_REQUIRED',
      nextEvidence: 'REQUEST_CLIENT_AUTHORIZATION_REVIEW'
    }
  }
  return {
    stage: 'HOST_EXECUTION',
    boundary: 'HOST_EXECUTION',
    reasonCode: 'WAITING_FOR_REAL_CLIENT_EVENT',
    ownership: 'EXTERNAL_CLIENT',
    recommendedAction: 'CLIENT_REVIEW_REQUIRED',
    nextEvidence: 'OBSERVE_REAL_WORKFLOW_WITH_CONSENT'
  }
}

export function inspectNativeCaptureHealth(
  store: SessionStore,
  root: string,
  target: SessionTargetSelection,
  agent: NativeHookProvider,
  trust?: NativeTrustObservation,
  profile?: string,
  runtimeHelper?: CapturedRuntimeHelperState
) {
  const { registry, repositoryId } = store
  const readinessOptions = {
    ...(profile ? { profile } : {}),
    ...(runtimeHelper ? { runtimeHelper } : {})
  }
  const readiness = nativeHookReadiness(registry, root, target, trust, agent, Object.keys(readinessOptions).length ? readinessOptions : undefined)
  const diagnostics = nativeCaptureDiagnostics(registry, root, agent, target)
  const helperStale = readiness.helperVersion.state === 'STALE'
  const runtimeSourceStale = readiness.helperVersion.reasonCode === 'RUNTIME_SOURCE_STALE'
  const partial = diagnostics.historicalCoverage?.state === 'PARTIAL' || readiness.captureReadiness.state === 'PARTIAL'
  const state = helperStale ? 'UNAVAILABLE'
    : runtimeSourceStale ? 'UNKNOWN'
    : partial ? 'PARTIAL'
    : readiness.captureReadiness.state === 'OBSERVED' ? 'OBSERVED'
    : readiness.installation.state === 'CONFIGURED' ? 'CONFIGURED'
    : readiness.installation.state === 'UNKNOWN' ? 'UNKNOWN' : 'UNAVAILABLE'
  const reason = helperStale ? 'HOOK_HELPER_STALE'
    : runtimeSourceStale ? 'RUNTIME_SOURCE_STALE'
    : partial ? 'CAPTURE_PARTIAL'
    : readiness.installation.state === 'CONFIGURED' ? readiness.captureReadiness.reasonCode : readiness.installation.reasonCode
  const discovery = readiness.trust.loadedSource
    ? { state: 'OBSERVED', loadedSource: readiness.trust.loadedSource }
    : { state: 'UNKNOWN', reasonCode: readiness.trust.reasonCode }
  const causalityBoundary = agent === 'antigravity' ? 'CONTEXTUAL_ONLY_NO_HOST_WITNESS' : 'RECEIPT_CORRELATION_SUPPORTED'
  const boundary = inspectNativeBoundary(readiness, diagnostics, causalityBoundary)
  return { feature: 'session_context', source: 'native', version: 1, repositoryId, ...target, agent, state, reason,
    nativeCapture: { source: nativeHookSource(agent), independentOfEntire: true, ...diagnostics, readiness, boundary, discovery, causality: 'NOT_EVALUATED', causalityBoundary } }
}
const pathsCache = new Map<string, { base: string; hooks: string[] }>()
function smallText(path: string): string {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('CAPTURE_FILE_UNSAFE')
  return readFileSync(path, 'utf8')
}
function marker(path: string): string {
  try {
    const stat = lstatSync(path, { bigint: true })
    return digest(JSON.stringify([path, String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs),
      stat.isFile() && stat.size <= 65536n ? smallText(path) : null]))
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'MISSING'; throw error }
}
function gitDirectories(root: string) {
  const pointer = join(root, '.git')
  const admin = lstatSync(pointer).isDirectory() ? realpathSync(pointer) : realpathSync(resolve(root, smallText(pointer).trim().replace(/^gitdir: /, '')))
  let common = admin
  try { common = realpathSync(resolve(admin, smallText(join(admin, 'commondir')).trim())) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return { admin, common }
}
function codexHooks(root: string, common: string): { path: string; state: CaptureHealthObservation['hooks']['codex'] } {
  for (const path of [join(root, '.codex/hooks.json'), join(dirname(common), '.codex/hooks.json')]) {
    let text: string
    try {
      const directory = lstatSync(dirname(path))
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('CAPTURE_FILE_UNSAFE')
      text = smallText(path)
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; return { path, state: 'HOOK_INCOMPATIBLE' } }
    try {
      const hooks = JSON.parse(text).hooks
      const commands = (event: string) => Array.isArray(hooks?.[event]) ? hooks[event].flatMap((entry: { hooks?: { command?: unknown }[] }) => entry.hooks ?? []).map((entry: { command?: unknown }) => entry.command).filter((command: unknown): command is string => typeof command === 'string') : []
      const valid = ['SessionStart', 'UserPromptSubmit'].every(event => commands(event).some((command: string) =>
        command.match(/entire\s+hooks\s+codex\s+([a-z-]+)/)?.[1] === (event === 'SessionStart' ? 'session-start' : 'user-prompt-submit') &&
        (!/where(?:\.exe)?\s+entire.*>nul/i.test(command) || /cmd(?:\.exe)?\s+\/d\s+\/s\s+\/c/i.test(command))))
      return { path, state: valid ? 'READY' : 'HOOK_INCOMPATIBLE' }
    } catch { return { path, state: 'HOOK_INCOMPATIBLE' } }
  }
  return { path: join(root, '.codex/hooks.json'), state: 'HOOK_MISSING' }
}
type GitHookHandler = 'prepare-commit-msg' | 'post-commit'
function isStaticEntireExecutablePath(candidate: string): boolean {
  if (!candidate || candidate.length > 512 || /[\0-\x1f"$`;&|<>?*']/.test(candidate)) return false
  const windowsDrive = /^[A-Za-z]:[\\/]/.test(candidate)
  const posixRoot = candidate.startsWith('/') && !candidate.startsWith('//')
  if (!windowsDrive && !posixRoot) return false
  const rest = windowsDrive ? candidate.slice(3) : candidate.slice(1)
  if (!rest || /[\\/]$/.test(rest)) return false
  const segments = rest.split(/[\\/]/)
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(segment))) return false
  return /^entire(?:\.exe)?$/i.test(segments[segments.length - 1])
}
function isEntireGitHookLine(line: string, handler: GitHookHandler): boolean {
  const simple = line.match(/^\s*(?:exec\s+)?entire(?:\.exe)?\s+hooks\s+git\s+(prepare-commit-msg|post-commit)((?:\s+"\$1"\s+"\$2"(?:\s+"\$3")?|\s+"\$@")?)(?:\s+2>\/dev\/null\s+\|\|\s+true)?\s*$/)
  if (simple) return simple[1] === handler && (handler === 'prepare-commit-msg' || simple[2] === '' || simple[2] === ' "$@"')
  const conditional = line.match(/^\s*if\s+\[\s+-f\s+'([^'\r\n]+)'\s+\];\s+then\s+'([^'\r\n]+)'\s+hooks\s+git\s+(prepare-commit-msg|post-commit)((?:\s+"\$1"\s+"\$2"(?:\s+"\$3")?|\s+"\$@")?)\s+2>\/dev\/null\s+\|\|\s+true;\s+else\s+:;\s+fi\s*$/)
  if (!conditional || conditional[3] !== handler || conditional[1] !== conditional[2]) return false
  if (handler === 'prepare-commit-msg' ? !conditional[4] : conditional[4] !== '' && conditional[4] !== ' "$@"') return false
  return isStaticEntireExecutablePath(conditional[1])
}
export function hasEntireGitHook(text: string, handler: GitHookHandler): boolean {
  return text.split(/\r?\n/).some(line => !/^\s*#/.test(line) && isEntireGitHookLine(line, handler))
}
export async function inspectCaptureHealth(store: SessionStore, provider: Pick<EntireProvider, 'inspectCapture'>, runner: CommandRunner, root: string, target: SessionTargetSelection, query: Query, assertActive: () => void): Promise<object> {
  assertActive()
  const dirs = gitDirectories(root), codex = codexHooks(root, dirs.common)
  const providerPath = join(dirname(store.path), 'session-context.provider.json')
  let executable = ''
  try {
    const config = JSON.parse(smallText(providerPath))
    if (config.enabled === true && config.repositoryId === store.repositoryId && typeof config.executable === 'string' && /^entire(?:\.exe)?$/i.test(basename(config.executable)) && /^[a-f0-9]{64}$/.test(config.sha256)) executable = config.executable
  } catch {}
  const files = [providerPath, join(root, '.entire/settings.local.json'), join(dirs.common, 'config'), join(dirs.admin, 'config.worktree'),
    join(homedir(), '.gitconfig'), join(homedir(), '.config/git/config'), codex.path, ...(executable && isAbsolute(executable) ? [executable] : [])]
  const base = digest(JSON.stringify([files.map(marker), query.agent ?? 'all']))
  const key = JSON.stringify([store.repositoryId, target.worktreeId, target.generation])
  const prior = store.captureHealth(target, query.cycleId)
  let cached = pathsCache.get(key)
  const git = async (args: string[]) => {
    assertActive()
    const result = await runner('git', ['-c', 'core.fsmonitor=false', ...args], root, 8192)
    assertActive()
    if (result.code !== 0 || result.limited || result.timedOut) throw new Error('CAPTURE_GIT_UNAVAILABLE')
    return result.text.trim()
  }
  if (!cached || cached.base !== base) {
    const hooks = await Promise.all(['prepare-commit-msg', 'post-commit'].map(async hook => resolve(root, await git(['rev-parse', '--git-path', 'hooks/' + hook]))))
    cached = { base, hooks }
    if (pathsCache.size >= 64) pathsCache.clear()
    pathsCache.set(key, cached)
  }
  const headText = smallText(join(dirs.admin, 'HEAD')).trim()
  if (headText.startsWith('ref: ') && (!headText.slice(5).startsWith('refs/') || headText.slice(5).split('/').includes('..'))) throw new Error('CAPTURE_GIT_UNAVAILABLE')
  const headFile = headText.startsWith('ref: ') ? join(dirs.common, headText.slice(5)) : join(dirs.admin, 'HEAD')
  const signature = () => digest(JSON.stringify([base, ...cached!.hooks.map(marker), marker(headFile), marker(join(dirs.common, 'packed-refs')), marker(join(dirs.admin, 'index')),
    ...(prior?.checkpoint.checkpointId ? [marker(join(dirs.common, 'refs/entire/checkpoints', prior.checkpoint.checkpointId.slice(-2), prior.checkpoint.checkpointId))] : [])]))
  const source = sourceFingerprint(root), fingerprint = signature()
  const policyDigest = digest(JSON.stringify([base, ...cached.hooks.map(marker)]))
  if (query.trigger === 'INSPECT' && !query.commitSha && prior?.configurationDigest === fingerprint && prior.sourceFingerprint === source) return { feature: 'session_context', ...prior, source: 'entire', freshness: 'OBSERVED_SNAPSHOT', replay: true }
  const head = await git(['rev-parse', 'HEAD'])
  const hooks = { git: 'READY' as CaptureHealthObservation['hooks']['git'], codex: codex.state }
  for (let index = 0; index < cached.hooks.length; index++) {
    try {
      const text = smallText(cached.hooks[index])
      const handler = index === 0 ? 'prepare-commit-msg' : 'post-commit'
      if (!hasEntireGitHook(text, handler)) hooks.git = 'HOOK_INCOMPATIBLE'
    } catch (error) { hooks.git = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'HOOK_MISSING' : 'HOOK_INCOMPATIBLE' }
  }
  const capture = await provider.inspectCapture()
  const agent = query.agent ?? capture.agent ?? 'codex'
  const integration = capture.integrations?.find(item => item.agent === agent)
  const integrationReady = (capture.integrations ? integration?.hooks === 'READY' : agent === 'codex') && (agent !== 'codex' || codex.state === 'READY')
  const integrationReason = capture.integrations && !integration ? 'INTEGRATION_UNAVAILABLE' : agent === 'codex' && codex.state !== 'READY' ? codex.state : integrationReady ? capture.reason : 'HOOKS_MISSING'
  const configured = capture.configured && hooks.git === 'READY' && integrationReady
  const reason = !capture.configured ? marker(providerPath) === 'MISSING' ? 'NOT_CONFIGURED' : capture.reason : hooks.git !== 'READY' ? hooks.git : integrationReason
  const checkpoint: CaptureHealthObservation['checkpoint'] = { state: 'PENDING', reason: 'CHECKPOINT_PENDING' }
  const selectedCommit = query.commitSha ?? (prior && prior.head !== head ? head : undefined)
  if (selectedCommit) {
    const observation = await observeCheckpoint(runner, root, { commitSha: selectedCommit }, assertActive)
    const reflog = await git(['reflog', '-1', '--format=%H%x00%gs', 'HEAD'])
    const local = selectedCommit === head && /^(?:commit|commit \(initial\)|commit \(amend\)):/.test(reflog.split('\0')[1] ?? '')
    const expected = configured && local && prior?.capture.state === 'OBSERVED' && prior.state === 'CAPTURE_OBSERVED' && prior.generation === target.generation && prior.policyDigest === policyDigest &&
      (prior.head !== selectedCommit || prior.checkpoint.commitSha === selectedCommit && prior.checkpoint.state === 'CHECKPOINT_MISSING')
    checkpoint.state = observation.state === 'VERIFIED' ? 'CHECKPOINT_VERIFIED' : observation.state === 'MISSING' ? expected ? 'CHECKPOINT_MISSING' : 'NOT_APPLICABLE' : observation.state === 'PENDING' || observation.state === 'PARTIAL' ? 'PENDING' : 'UNAVAILABLE'
    checkpoint.reason = observation.state === 'MISSING' ? expected ? 'CHECKPOINT_MISSING' : 'CAPTURE_NOT_EXPECTED' : observation.reason
    checkpoint.commitSha = selectedCommit
    if (observation.checkpointId) checkpoint.checkpointId = observation.checkpointId
    if (observation.refRevision) checkpoint.refRevision = observation.refRevision
    if (observation.metadataDigest) checkpoint.metadataDigest = observation.metadataDigest
    if (observation.sessionIds.length) checkpoint.sessionIds = observation.sessionIds
    if (observation.sessionRefs?.length) checkpoint.sessionRefs = observation.sessionRefs
  }
  assertActive()
  if (sourceFingerprint(root) !== source || signature() !== fingerprint || digest(JSON.stringify([files.map(marker), query.agent ?? 'all'])) !== base) throw new Error('WORKTREE_STALE')
  const observation: CaptureHealthObservation = { version: 1, repositoryId: store.repositoryId, ...target, cycleId: query.cycleId, head, configurationDigest: fingerprint,
    policyDigest,
    agent, integrations: capture.integrations?.map(item => ({ ...item, state: checkpoint.state === 'CHECKPOINT_VERIFIED' && checkpoint.sessionRefs?.some(session => session.agent === item.agent) ? 'CHECKPOINT_VERIFIED' : item.hooks !== 'READY' ? 'HOOKS_MISSING' : item.agent === capture.agent && capture.providerSessionId ? 'CAPTURE_OBSERVED' : 'READY_CONFIGURED', coverage: 'OBSERVED_SNAPSHOT' })),
    integrationState: !integration && capture.integrations ? 'UNSUPPORTED' : integrationReady ? 'READY_CONFIGURED' : 'HOOKS_MISSING',
    nextEvidence: !capture.configured ? 'INSPECT_PROVIDER_CONFIGURATION' : hooks.git !== 'READY' ? 'INSPECT_GIT_HOOKS' : !integrationReady ? 'INSPECT_ENTIRE_INTEGRATION' :
      checkpoint.state === 'CHECKPOINT_MISSING' || checkpoint.state === 'UNAVAILABLE' ? 'INSPECT_CHECKPOINT_METADATA' : !capture.providerSessionId ? 'OBSERVE_SESSION_EVENTS' : 'NONE',
    repairRequiresApproval: !configured,
    ...(capture.diagnostic && !capture.configured ? { providerDiagnostic: capture.diagnostic } : {}),
    sourceFingerprint: source, observedAt: new Date().toISOString(), state: !configured ? 'UNAVAILABLE' : capture.providerSessionId && capture.agent === agent ? 'CAPTURE_OBSERVED' : 'READY_CONFIGURED',
    reason, hooks, capture: capture.providerSessionId && capture.agent === agent ? { state: 'OBSERVED', providerSessionId: capture.providerSessionId, agent } : { state: 'UNOBSERVED' }, checkpoint }
  return { feature: 'session_context', ...store.recordCaptureHealth(observation, assertActive), source: 'entire', freshness: 'OBSERVED_SNAPSHOT', replay: false }
}
