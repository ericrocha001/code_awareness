import { nativeHookLimits, normalizeNativeHook, readNativeBinding, recordNativeGap, spoolNativeHook, type NativeHookBinding } from './native-hooks'

const timer = setTimeout(() => process.exit(0), nativeHookLimits.timeoutMs)
let bytes = 0
const chunks: Buffer[] = []
let binding: NativeHookBinding | undefined
try { if (process.argv.length === 3) binding = readNativeBinding(process.argv[2]) } catch {}
process.stdin.on('error', () => process.exit(0))
process.stdin.on('data', (chunk: Buffer) => {
  bytes += chunk.length
  if (bytes > nativeHookLimits.inputBytes) {
    if (binding?.enabled) recordNativeGap(binding.spool, 'INPUT_LIMIT')
    process.exit(0)
  }
  chunks.push(chunk)
})
process.stdin.on('end', () => {
  try {
    if (!binding?.enabled) return
    const envelope = normalizeNativeHook(JSON.parse(Buffer.concat(chunks).toString('utf8')), binding)
    if (spoolNativeHook(envelope, binding.spool) === 'FULL') recordNativeGap(binding.spool, 'SPOOL_FULL')
  } catch { if (binding?.enabled) recordNativeGap(binding.spool, 'INVALID_PAYLOAD') }
  finally { clearTimeout(timer) }
})
