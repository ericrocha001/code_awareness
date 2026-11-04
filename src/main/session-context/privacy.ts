import { createHash } from 'node:crypto'

export function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
export const SANITIZATION_RULES: readonly { pattern: RegExp; replacement: string }[] = [
  { pattern: /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16})\b/g, replacement: '[REDACTED_TOKEN]' },
  { pattern: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, replacement: '[REDACTED_KEY]' },
  { pattern: /\b(authorization["']?\s*[:=]\s*["']?(?:bearer\s+)?)[^\s"',}]+/gi, replacement: '$1[REDACTED]' },
  { pattern: /\b((?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, replacement: '$1[REDACTED]' },
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: '[REDACTED_EMAIL]' },
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: '[REDACTED_IP]' },
  { pattern: /\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){3,7}\b/gi, replacement: '[REDACTED_IP]' },
  { pattern: /[A-Za-z]:[\\/](?:[^\s"'<>|]+[\\/])*[^\s"'<>|]*/g, replacement: '[REDACTED_PATH]' },
  { pattern: /\/(?:Users|home|private|tmp|var|etc|opt)\/[^\s"'<>]*/g, replacement: '[REDACTED_PATH]' },
  { pattern: /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, replacement: '' },
]
export function sanitize(text: string): string {
  return SANITIZATION_RULES.reduce((value, rule) => value.replace(rule.pattern, rule.replacement), text)
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
