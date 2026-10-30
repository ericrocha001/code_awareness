import { createHash } from 'node:crypto'

export function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
export function sanitize(text: string): string {
  return text
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16})\b/g, '[REDACTED_TOKEN]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED_KEY]')
    .replace(/\b(authorization["']?\s*[:=]\s*["']?(?:bearer\s+)?)[^\s"',}]+/gi, '$1[REDACTED]')
    .replace(/\b((?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED_IP]')
    .replace(/\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){3,7}\b/gi, '[REDACTED_IP]')
    .replace(/[A-Za-z]:[\\/](?:[^\s"'<>|]+[\\/])*[^\s"'<>|]*/g, '[REDACTED_PATH]')
    .replace(/\/(?:Users|home|private|tmp|var|etc|opt)\/[^\s"'<>]*/g, '[REDACTED_PATH]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}
export function utf8Prefix(text: string, bytes: number): string {
  const buffer = Buffer.from(text)
  if (buffer.length <= bytes) return text
  let end = bytes
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--
  return buffer.subarray(0, end).toString('utf8')
}
export function safeFile(file: string): string | null {
  if (file.length > 240 || file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split(/[\\/]/).includes('..')) return null
  const clean = sanitize(file.replace(/\\/g, '/'))
  return clean === file.replace(/\\/g, '/') ? clean : null
}
