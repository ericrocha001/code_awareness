import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import {
  boundedFile, nativeEventType, nativeGapReason, nativeGitDirectories, nativeHookLimits, nativeWorktreeIdentity,
  normalizeNativeHook, readNativeBinding, readScopedNativeBinding, recordNativeGap, resolveNativeHookBinding,
  sameNativePath, spoolNativeHook, type NativeGap, type NativeGapPhase, type NativeHookBinding
} from './native-hooks'
import { stampNativeCapture } from './native-capture-window'
import {
  authorizeDistributedBinding, distributedHelperIdentity, openNativeHookCatalog, readNativeEnrollment,
  readUserCodexProfile, resolveEnrolledRepositoryByCommonDir
} from './native-hook-catalog'
import { bootstrapUserCodexWorktreeBinding } from './native-hook-profile'

declare const __CODE_AWARENESS_DISTRIBUTED_CAPTURE__: boolean
const distributed = typeof __CODE_AWARENESS_DISTRIBUTED_CAPTURE__ !== 'undefined' && __CODE_AWARENESS_DISTRIBUTED_CAPTURE__

if (distributed && process.argv[2] === 'prepare') {
  const repositoryId = process.argv.find(arg => arg.startsWith('--repository='))?.slice('--repository='.length)
  const provider = process.argv.find(arg => arg.startsWith('--provider='))?.slice('--provider='.length)
  const { profile } = distributedHelperIdentity(__filename)
  if (!repositoryId || provider !== 'codex') throw new Error('HOOK_PREPARATION_SCOPE_REQUIRED')
  const { prepareExternalNativeHooks } = require('./native-hook-enrollment') as typeof import('./native-hook-enrollment')
  prepareExternalNativeHooks(profile, repositoryId, process.cwd()).then(
    result => {
      if (result.state === 'NOT_ENROLLED') { console.error('HOOK_ENROLLMENT_REQUIRED'); process.exitCode = 1 }
      else console.log(JSON.stringify(result))
    },
    error => {
      const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'HOOK_PREPARATION_BLOCKED'
      console.error(code)
      process.exitCode = 1
    }
  )
} else {
  runHook()
}

function authorizeExistingUserBinding(binding: NativeHookBinding, profile: string, helperDigest: string): boolean {
  const db = openNativeHookCatalog(profile, true)
  try {
    const profileRow = readUserCodexProfile(db, 'codex')
    if (!profileRow?.enabled || profileRow.helperDigest !== helperDigest || !binding.configPath ||
      !sameNativePath(profileRow.configPath, binding.configPath)) return false
    const row = db.prepare(`SELECT checkout_path FROM repository_catalog_records
      WHERE id=? AND status='ACTIVE' AND availability='AVAILABLE' AND git_state='GIT'`).get(binding.repositoryId) as { checkout_path?: unknown } | undefined
    if (typeof row?.checkout_path !== 'string') return false
    const catalogRoot = realpathSync(row.checkout_path)
    if (!sameNativePath(catalogRoot, resolve(row.checkout_path))) return false
    const enrollment = readNativeEnrollment(db, binding.repositoryId, 'codex')
    if (!enrollment || enrollment.catalogRoot !== catalogRoot || enrollment.commonDirectory !== binding.commonDirectory) return false
    if (enrollment.helperDigest !== undefined && enrollment.helperDigest !== helperDigest) return false
    if (enrollment.gitCommitTool !== binding.gitCommitTool) return false
    if (enrollment.worktrees[binding.worktreeId] !== binding.generation && !enrollment.externalPreparation) return false
    return true
  } catch { return false }
  finally { db.close() }
}

function tryBootstrapUserBinding(payload: unknown, cwd: string, profile: string, helperDigest: string): NativeHookBinding | undefined {
  const event = nativeEventType(payload, 'codex')
  if (event !== 'SessionStart' && event !== 'PreToolUse') return undefined
  const envelope = payload as { cwd?: unknown; session_id?: unknown; tool_use_id?: unknown }
  const validId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)
  if (typeof envelope.cwd !== 'string' || !isAbsolute(envelope.cwd) || !validId(envelope.session_id) ||
    (event === 'PreToolUse' && !validId(envelope.tool_use_id))) return undefined
  let payloadRoot: string
  const resolvedEnvelopeCwd = resolve(envelope.cwd)
  try {
    if (lstatSync(resolvedEnvelopeCwd).isSymbolicLink()) return undefined
    payloadRoot = realpathSync(resolvedEnvelopeCwd)
  } catch { return undefined }
  if (!sameNativePath(resolvedEnvelopeCwd, payloadRoot) || !sameNativePath(payloadRoot, cwd)) return undefined

  let wt: ReturnType<typeof nativeWorktreeIdentity>
  try { wt = nativeWorktreeIdentity(cwd, true) } catch { return undefined }
  try {
    if (!boundedFile(joinSafe(wt.admin, 'HEAD'), 4096).trim()) return undefined
  } catch { return undefined }

  let configPath = ''
  let matchedRepoId = ''
  let gitCommitTool: string | undefined
  const db = openNativeHookCatalog(profile, true)
  try {
    const profileRow = readUserCodexProfile(db, 'codex')
    if (!profileRow?.enabled || profileRow.helperDigest !== helperDigest || !existsSync(profileRow.configPath)) return undefined
    const matched = resolveEnrolledRepositoryByCommonDir(db, wt.commonDirectory, helperDigest, 'codex')
    if (!matched) return undefined
    configPath = profileRow.configPath
    matchedRepoId = matched.repositoryId
    gitCommitTool = matched.enrollment.gitCommitTool ?? profileRow.gitCommitTool
  } catch { return undefined }
  finally { db.close() }

  try {
    return bootstrapUserCodexWorktreeBinding({
      profile,
      repositoryId: matchedRepoId,
      root: cwd,
      configPath,
      gitCommitTool,
      helperDigest
    }).binding
  } catch {
    return undefined
  }
}

function joinSafe(dir: string, file: string): string {
  return resolve(dir, file)
}

function runHook() {
  const tStart = performance.now()
  const bindingArgument = (process.argv[2] ?? '').replaceAll('\\', '/')
  const userProfileMode = distributed && (!process.argv[2] || process.argv[2] === '--user-profile')
  const provider = bindingArgument.endsWith('/native-hooks/antigravity/binding.json') ? 'antigravity' : 'codex'
  let legacyAntigravity = false
  let cachedProfileIdentity: { profile: string; digest: string } | undefined

  function helperProfile() {
    return cachedProfileIdentity ??= distributedHelperIdentity(__filename)
  }

  function executionBinding(): NativeHookBinding | undefined {
    try {
      if (userProfileMode) {
        const rawCwd = resolve(process.cwd())
        const cwd = realpathSync(rawCwd)
        if (lstatSync(rawCwd).isSymbolicLink() || !sameNativePath(rawCwd, cwd)) return undefined
        const { profile, digest } = helperProfile()
        const binding = readScopedNativeBinding(cwd, 'codex')
        return authorizeExistingUserBinding(binding, profile, digest) ? binding : undefined
      }
      const path = process.argv[2]
      if (!path) return
      if (!distributed) {
        const legacy = readNativeBinding(path)
        if (legacy.provider === 'antigravity') { legacyAntigravity = true; return legacy }
      }
      return resolveNativeHookBinding(path, process.cwd(), provider, distributed ? binding => authorizeDistributedBinding(__filename, binding) : undefined)
    } catch { return undefined }
  }

  function recordReadGap(reason: 'TIMEOUT' | 'READ_FAILURE' | 'INPUT_LIMIT') {
    const binding = executionBinding()
    if (binding) recordNativeGap(binding.spool, reason, 'READ')
  }

  let responded = false
  let bytes = 0
  const chunks: Buffer[] = []
  const isAntigravity = (rawText?: string) => {
    if (userProfileMode) return false
    if (provider === 'antigravity' || legacyAntigravity) return true
    if (bindingArgument.endsWith('/native-hooks/binding.json')) return false
    return rawText !== undefined && /"hookEventName"\s*:/.test(rawText)
  }
  const respond = (eventType?: string, rawText?: string): boolean => {
    if (responded) return false
    const candidate = rawText ?? Buffer.concat(chunks).toString('utf8')
    if (!isAntigravity(candidate)) return false
    responded = true
    const preTool = eventType === 'PreToolUse' || (eventType === undefined && /"hookEventName"\s*:\s*"PreToolUse"/.test(candidate))
    process.stdout.write(preTool ? '{"decision":"allow"}\n' : '{}\n')
    return true
  }
  const exitAfterRespond = () => {
    if (!respond()) process.exit(0)
    process.stdout.once('drain', () => process.exit(0))
    setTimeout(() => process.exit(0), 25).unref()
  }

  const timer = setTimeout(() => { recordReadGap('TIMEOUT'); exitAfterRespond() }, nativeHookLimits.timeoutMs)
  process.stdin.on('error', () => { recordReadGap('READ_FAILURE'); exitAfterRespond() })
  process.stdin.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > nativeHookLimits.inputBytes) {
      recordReadGap('INPUT_LIMIT')
      exitAfterRespond()
      return
    }
    chunks.push(chunk)
  })
  process.stdin.on('end', () => {
    clearTimeout(timer)
    const tStdin = performance.now()
    let binding: NativeHookBinding | undefined
    const rawText = Buffer.concat(chunks).toString('utf8')
    let phase: NativeGapPhase = 'PARSE', eventType: NativeGap['eventType'] = 'UNKNOWN', parsed = false
    let tIdentity = tStdin, tBootstrap = tStdin, tStamp = tStdin, tSpool = tStdin
    let mode = userProfileMode ? 'USER_FAST' : 'LEGACY'
    try {
      if (userProfileMode) {
        const rawCwd = resolve(process.cwd())
        const cwd = realpathSync(rawCwd)
        if (lstatSync(rawCwd).isSymbolicLink() || !sameNativePath(rawCwd, cwd)) return undefined
        const { profile, digest } = helperProfile()
        const payload: unknown = JSON.parse(rawText)
        const payloadCwd = (payload as { cwd?: unknown } | null)?.cwd
        if (typeof payloadCwd !== 'string' || !isAbsolute(payloadCwd)) return
        const resolvedPayloadCwd = resolve(payloadCwd)
        let realPayloadCwd: string
        try {
          if (lstatSync(resolvedPayloadCwd).isSymbolicLink()) return
          realPayloadCwd = realpathSync(resolvedPayloadCwd)
        } catch { return }
        if (!sameNativePath(resolvedPayloadCwd, realPayloadCwd) || !sameNativePath(realPayloadCwd, cwd)) return
        try { nativeGitDirectories(cwd, true) } catch { return }
        tIdentity = performance.now()
        try {
          const candidate = readScopedNativeBinding(cwd, 'codex')
          if (authorizeExistingUserBinding(candidate, profile, digest)) binding = candidate
        } catch {}
        if (!binding) {
          mode = 'USER_BOOTSTRAP'
          binding = tryBootstrapUserBinding(payload, cwd, profile, digest)
        }
        tBootstrap = performance.now()
        if (!binding?.enabled) return
        parsed = true
        eventType = nativeEventType(payload, binding.provider)
        phase = 'NORMALIZE'
        const envelope = stampNativeCapture(normalizeNativeHook(payload, binding), binding)
        tStamp = performance.now()
        phase = 'WRITE'
        if (spoolNativeHook(envelope, binding.spool) === 'FULL') recordNativeGap(binding.spool, 'SPOOL_FULL', phase, eventType)
        tSpool = performance.now()
      } else {
        binding = executionBinding()
        if (!binding?.enabled) return
        const payload: unknown = JSON.parse(rawText)
        const cwd = (payload as { cwd?: unknown } | null)?.cwd
        if ((binding.provider ?? 'codex') === 'codex' && typeof cwd === 'string' && (!isAbsolute(cwd) || !sameNativePath(resolve(cwd), binding.root))) return
        parsed = true
        eventType = nativeEventType(payload, binding.provider)
        phase = 'NORMALIZE'
        const envelope = stampNativeCapture(normalizeNativeHook(payload, binding), binding)
        tStamp = performance.now()
        phase = 'WRITE'
        if (spoolNativeHook(envelope, binding.spool) === 'FULL') recordNativeGap(binding.spool, 'SPOOL_FULL', phase, eventType)
        tSpool = performance.now()
      }
      if (process.env.CA_HOOK_TIMING === '1') {
        console.error(JSON.stringify({
          mode,
          event: eventType,
          stdinMs: +(tStdin - tStart).toFixed(2),
          identityMs: +(tIdentity - tStdin).toFixed(2),
          bootstrapOrAuthMs: +(tBootstrap - tIdentity).toFixed(2),
          stampMs: +(tStamp - tBootstrap).toFixed(2),
          spoolMs: +(tSpool - tStamp).toFixed(2),
          totalMs: +(tSpool - tStart).toFixed(2)
        }))
      }
    } catch (error) {
      if (binding?.enabled) recordNativeGap(binding.spool, phase === 'PARSE' ? 'JSON_SYNTAX' : nativeGapReason(error), phase, eventType)
    } finally {
      clearTimeout(timer)
      respond(parsed ? eventType : undefined, rawText)
    }
  })
}
