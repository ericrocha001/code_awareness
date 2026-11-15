import { isAbsolute, resolve } from 'node:path'
import { nativeEventType, nativeGapReason, nativeHookLimits, normalizeNativeHook, resolveNativeHookBinding, recordNativeGap, sameNativePath, spoolNativeHook, type NativeGapPhase, type NativeGap } from './native-hooks'
import { stampNativeCapture } from './native-capture-window'

function executionBinding() {
  try {
    if (process.argv.length === 3) return resolveNativeHookBinding(process.argv[2], process.cwd())
  } catch {}
}

const timer = setTimeout(() => { recordReadGap('TIMEOUT'); process.exit(0) }, nativeHookLimits.timeoutMs)
let bytes = 0
const chunks: Buffer[] = []
function recordReadGap(reason: 'TIMEOUT' | 'READ_FAILURE' | 'INPUT_LIMIT') {
  const binding = executionBinding()
  if (binding) recordNativeGap(binding.spool, reason, 'READ')
}
process.stdin.on('error', () => { recordReadGap('READ_FAILURE'); process.exit(0) })
process.stdin.on('data', (chunk: Buffer) => {
  bytes += chunk.length
  if (bytes > nativeHookLimits.inputBytes) {
    recordReadGap('INPUT_LIMIT')
    process.exit(0)
  }
  chunks.push(chunk)
})
process.stdin.on('end', () => {
  const binding = executionBinding()
  let phase: NativeGapPhase = 'PARSE', eventType: NativeGap['eventType'] = 'UNKNOWN'
  try {
    if (!binding) return
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const cwd = (payload as { cwd?: unknown } | null)?.cwd
    if (typeof cwd === 'string' && (!isAbsolute(cwd) || !sameNativePath(resolve(cwd), binding.root))) return
    eventType = nativeEventType(payload)
    phase = 'NORMALIZE'
    const envelope = stampNativeCapture(normalizeNativeHook(payload, binding), binding)
    phase = 'WRITE'
    if (spoolNativeHook(envelope, binding.spool) === 'FULL') recordNativeGap(binding.spool, 'SPOOL_FULL', phase, eventType)
  } catch (error) { if (binding) recordNativeGap(binding.spool, phase === 'PARSE' ? 'JSON_SYNTAX' : nativeGapReason(error), phase, eventType) }
  finally { clearTimeout(timer) }
})
