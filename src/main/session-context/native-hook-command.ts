import { nativeEventType, nativeGapReason, nativeHookLimits, normalizeNativeHook, readNativeBinding, recordNativeGap, spoolNativeHook, type NativeHookBinding, type NativeGapPhase, type NativeGap } from './native-hooks'

const timer = setTimeout(() => { if (binding?.enabled) recordNativeGap(binding.spool, 'TIMEOUT', 'READ'); process.exit(0) }, nativeHookLimits.timeoutMs)
let bytes = 0
const chunks: Buffer[] = []
let binding: NativeHookBinding | undefined
try { if (process.argv.length === 3) binding = readNativeBinding(process.argv[2]) } catch {}
process.stdin.on('error', () => { if (binding?.enabled) recordNativeGap(binding.spool, 'READ_FAILURE', 'READ'); process.exit(0) })
process.stdin.on('data', (chunk: Buffer) => {
  bytes += chunk.length
  if (bytes > nativeHookLimits.inputBytes) {
    if (binding?.enabled) recordNativeGap(binding.spool, 'INPUT_LIMIT')
    process.exit(0)
  }
  chunks.push(chunk)
})
process.stdin.on('end', () => {
  let phase: NativeGapPhase = 'PARSE', eventType: NativeGap['eventType'] = 'UNKNOWN'
  try {
    if (!binding?.enabled) return
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    eventType = nativeEventType(payload)
    phase = 'NORMALIZE'
    const envelope = normalizeNativeHook(payload, binding)
    phase = 'WRITE'
    if (spoolNativeHook(envelope, binding.spool) === 'FULL') recordNativeGap(binding.spool, 'SPOOL_FULL', phase, eventType)
  } catch (error) { if (binding?.enabled) recordNativeGap(binding.spool, phase === 'PARSE' ? 'JSON_SYNTAX' : nativeGapReason(error), phase, eventType) }
  finally { clearTimeout(timer) }
})
