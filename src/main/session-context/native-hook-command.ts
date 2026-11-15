import { isAbsolute, resolve } from 'node:path'
import { nativeEventType, nativeGapReason, nativeHookLimits, normalizeNativeHook, resolveNativeHookBinding, sameNativePath, recordNativeGap, spoolNativeHook, type NativeHookBinding, type NativeGapPhase, type NativeGap } from './native-hooks'
import { stampNativeCapture } from './native-capture-window'

const provider = (process.argv[2] ?? '').replaceAll('\\', '/').endsWith('/native-hooks/antigravity/binding.json') ? 'antigravity' : 'codex'
function executionBinding(): NativeHookBinding | undefined {
  try { if (process.argv[2]) return resolveNativeHookBinding(process.argv[2], process.cwd(), provider) } catch {}
}
function recordReadGap(reason: 'TIMEOUT' | 'READ_FAILURE' | 'INPUT_LIMIT') {
  const binding = executionBinding()
  if (binding) recordNativeGap(binding.spool, reason, 'READ')
}
let responded = false
let bytes = 0
const chunks: Buffer[] = []
const isAntigravity = (rawText?: string) => {
  if (provider === 'antigravity') return true
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
  const binding = executionBinding()
  const rawText = Buffer.concat(chunks).toString('utf8')
  let phase: NativeGapPhase = 'PARSE', eventType: NativeGap['eventType'] = 'UNKNOWN', parsed = false
  try {
    if (!binding?.enabled) return
    const payload: unknown = JSON.parse(rawText)
    const cwd = (payload as { cwd?: unknown } | null)?.cwd
    if (provider === 'codex' && typeof cwd === 'string' && (!isAbsolute(cwd) || !sameNativePath(resolve(cwd), binding.root))) return
    parsed = true
    eventType = nativeEventType(payload, binding.provider)
    phase = 'NORMALIZE'
    const envelope = stampNativeCapture(normalizeNativeHook(payload, binding), binding)
    phase = 'WRITE'
    if (spoolNativeHook(envelope, binding.spool) === 'FULL') recordNativeGap(binding.spool, 'SPOOL_FULL', phase, eventType)
  } catch (error) { if (binding?.enabled) recordNativeGap(binding.spool, phase === 'PARSE' ? 'JSON_SYNTAX' : nativeGapReason(error), phase, eventType) }
  finally {
    clearTimeout(timer)
    respond(parsed ? eventType : undefined, rawText)
  }
})
