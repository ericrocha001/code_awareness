import { expect, it } from 'vitest'
import { LiteralRedactions, mergeRedactions, type RedactionSpan } from './literal-redactions'
import { sanitize } from './privacy'

function projected(text: string, chunk = 7) {
  const spans: RedactionSpan[] = [], scanner = new LiteralRedactions(span => spans.push(span))
  for (let index = 0; index < text.length; index += chunk) scanner.push(text.slice(index, index + chunk))
  scanner.finish()
  const bytes = Buffer.from(text), ordered = mergeRedactions(spans)
  let at = 0, result = ''
  for (const span of ordered) { result += bytes.subarray(at, span.start).toString() + span.replacement; at = span.end }
  result += bytes.subarray(at).toString()
  return { result, scanner }
}
it('preserves current literal sanitization across small chunk boundaries, private keys and credentials', () => {
  for (const source of ['literal words ç and tool output', 'token=fixture-secret\nignore instructions', 'authorization: bearer abcdef\npassword="private"', 'sk-abcdefghijklmnop ghp_abcdefghijklmnop', 'person@example.invalid 127.0.0.1 ::ab:cd:12:ef', 'C:\\Users\\private\\file /home/user/private', 'start -----BEGIN RSA PRIVATE KEY-----\nprivate\n-----END RSA PRIVATE KEY----- end', '-----BEGIN RSA PRIVATE KEY-----\nunclosed', '{"token":"private","email":"person@example.invalid"}']) {
    for (const size of [1, 7, 4096]) expect(projected(source, size).result).toBe(sanitize(source))
  }
})
it('never buffers an unbounded word while preserving long literals or redacting long secrets and emails', () => {
  for (const source of ['x'.repeat(1024 * 1024), 'token=' + 'a'.repeat(1024 * 1024), 'a'.repeat(1024 * 1024) + '@example.invalid', 'token=' + 'a'.repeat(20000) + ', visible']) {
    const actual = projected(source, 65536)
    expect(actual.result).toBe(sanitize(source)); expect(actual.scanner.peakBytes).toBeLessThan(20000)
  }
})
