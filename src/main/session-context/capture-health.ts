import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { digest } from './privacy'
import { sourceFingerprint, type SessionTargetSelection } from './target'
import type { SessionStore } from './store'
import type { EntireProvider, CommandRunner } from './entire-provider'
import { observeCheckpoint } from './checkpoint-observation'
import type { CaptureHealthObservation } from './capture-health-types'

export const captureHealthQuery = z.object({ worktreeId: z.string().regex(/^[a-f0-9]{64}$/).optional(), generation: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  inspectNativeTrust: z.boolean().default(false),
  cycleId: z.string().min(1).max(200).default('worktree'), trigger: z.enum(['INSPECT', 'RECHECK', 'BEGIN', 'LOCAL_COMMIT']).default('INSPECT'),
  agent: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/).optional(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/).optional() }).strict().refine(q => !q.worktreeId === !q.generation)
type Query = z.infer<typeof captureHealthQuery>
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
  const signature = () => digest(JSON.stringify([base, ...cached!.hooks.map(marker), marker(headFile), marker(join(dirs.common, 'packed-refs')),
    ...(prior?.checkpoint.checkpointId ? [marker(join(dirs.common, 'refs/entire/checkpoints', prior.checkpoint.checkpointId.slice(-2), prior.checkpoint.checkpointId))] : [])]))
  const source = sourceFingerprint(root), fingerprint = signature()
  const policyDigest = digest(JSON.stringify([base, ...cached.hooks.map(marker)]))
  if (query.trigger === 'INSPECT' && !query.commitSha && prior?.configurationDigest === fingerprint && prior.sourceFingerprint === source) return { feature: 'session_context', ...prior, freshness: 'OBSERVED_SNAPSHOT', replay: true }
  const head = await git(['rev-parse', 'HEAD'])
  const hooks = { git: 'READY' as CaptureHealthObservation['hooks']['git'], codex: codex.state }
  for (let index = 0; index < cached.hooks.length; index++) {
    try {
      const text = smallText(cached.hooks[index])
      const invocation = text.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n')
      const handler = index === 0 ? 'prepare-commit-msg' : 'post-commit'
      if (!invocation.split('\n').some(line => /^\s*(?:exec\s+)?entire(?:\.exe)?\s+hooks\s+git\s+/.test(line) && line.includes(handler))) hooks.git = 'HOOK_INCOMPATIBLE'
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
    sourceFingerprint: source, observedAt: new Date().toISOString(), state: !configured ? 'UNAVAILABLE' : capture.providerSessionId && capture.agent === agent ? 'CAPTURE_OBSERVED' : 'READY_CONFIGURED',
    reason, hooks, capture: capture.providerSessionId && capture.agent === agent ? { state: 'OBSERVED', providerSessionId: capture.providerSessionId, agent } : { state: 'UNOBSERVED' }, checkpoint }
  return { feature: 'session_context', ...store.recordCaptureHealth(observation, assertActive), freshness: 'OBSERVED_SNAPSHOT', replay: false }
}
