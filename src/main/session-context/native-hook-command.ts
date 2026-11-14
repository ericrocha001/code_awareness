import { nativeEventType, nativeGapReason, nativeHookLimits, normalizeNativeHook, readNativeBinding, recordNativeGap, spoolNativeHook, type NativeHookBinding, type NativeGapPhase, type NativeGap } from './native-hooks'
import { stampNativeCapture } from './native-capture-window'

let binding: NativeHookBinding | undefined
try { if (process.argv.length === 3) binding = readNativeBinding(process.argv[2]) } catch {}
let responded = false
let bytes = 0
const chunks: Buffer[] = []
const isAntigravity = (rawText?: string) => {
  if (binding?.provider === 'antigravity') return true
  if (binding) return false
  if ((process.argv[2] ?? '').replaceAll('\\', '/').includes('/native-hooks/antigravity/')) return true
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

const timer = setTimeout(() => { if (binding?.enabled) recordNativeGap(binding.spool, 'TIMEOUT', 'READ'); exitAfterRespond() }, nativeHookLimits.timeoutMs)
process.stdin.on('error', () => { if (binding?.enabled) recordNativeGap(binding.spool, 'READ_FAILURE', 'READ'); exitAfterRespond() })
process.stdin.on('data', (chunk: Buffer) => {
  bytes += chunk.length
  if (bytes > nativeHookLimits.inputBytes) {
    if (binding?.enabled) recordNativeGap(binding.spool, 'INPUT_LIMIT')
    exitAfterRespond()
    return
  }
  chunks.push(chunk)
})
process.stdin.on('end', () => {
  const rawText = Buffer.concat(chunks).toString('utf8')
  let phase: NativeGapPhase = 'PARSE', eventType: NativeGap['eventType'] = 'UNKNOWN', parsed = false
  try {
    if (!binding?.enabled) return
    const payload: unknown = JSON.parse(rawText)
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
