import { SANITIZATION_RULES } from './privacy'

export interface RedactionSpan { start: number; end: number; replacement: string; rule: number }
export class LiteralRedactions {
  private offset = 0
  private start = 0
  private token = ''
  private prefix = ''
  private context = ''
  private head = ''
  private headBytes = 0
  private tokenBytes = 0
  private long = false
  private nextScan = 0
  private pending: RedactionSpan[] = []
  private rolling = ''
  private keyStart?: number
  private keyHeader?: number
  private localStart?: number
  private domainStart?: number
  private emailStart?: number
  private dot = false
  private tld = 0
  private domainValid = true
  peakBytes = 0
  constructor(private readonly span: (span: RedactionSpan) => void) {}
  push(value: string): void {
    for (const run of value.matchAll(/[A-Za-z0-9]+|[^A-Za-z0-9]+/g)) {
      if (/^[A-Za-z0-9]+$/.test(run[0])) this.alphanumeric(run[0])
      else this.punctuation(run[0])
    }
  }
  private alphanumeric(value: string): void {
    if (!this.tokenBytes) { this.start = this.offset; this.prefix = this.context; this.head = ''; this.headBytes = 0; this.pending = [] }
    if (this.emailStart !== undefined) { this.tld += value.length; if (/[^A-Za-z]/.test(value)) this.domainValid = false }
    else this.localStart ??= this.offset
    if (!this.long && this.tokenBytes + value.length <= 8192) { this.token += value; this.head = this.token; this.headBytes = this.tokenBytes + value.length }
    else {
      if (!this.long) {
        this.head = (this.token + value).slice(0, 8192); this.headBytes = Buffer.byteLength(this.head); this.long = true
        this.observeLong(this.prefix + this.head, this.start - Buffer.byteLength(this.prefix))
      }
      this.token = (this.token + value).slice(-512)
    }
    this.rolling = (this.rolling + value).slice(-512)
    this.offset += value.length; this.tokenBytes += value.length
    this.nextScan = this.offset + 256
    this.peakBytes = Math.max(this.peakBytes, Math.min(this.tokenBytes, this.long ? 1536 : 8192) + this.headBytes + 3072)
  }
  private punctuation(value: string): void {
    for (const character of value) {
      const bytes = Buffer.byteLength(character)
      for (const pending of this.pending.filter(span => ((span.rule === 2 || span.rule === 3) && /[,}]/.test(character)) || (span.rule === 7 && character === '|'))) {
        this.span({ ...pending, end: this.offset }); this.pending = this.pending.filter(span => span !== pending)
      }
      this.rolling = (this.rolling + character).slice(-512)
      const header = character === '-' && this.rolling.endsWith('PRIVATE KEY-----') ? /-----BEGIN [^-]*PRIVATE KEY-----$/.exec(this.rolling) : null
      if (header && this.keyStart === undefined) { this.keyStart = this.offset + bytes - Buffer.byteLength(header[0]); this.keyHeader = undefined }
      if (this.keyStart !== undefined && character === '-' && this.rolling.endsWith('PRIVATE KEY-----') && /-----END [^-]*PRIVATE KEY-----$/.test(this.rolling)) {
        this.span({ start: this.keyStart, end: this.offset + bytes, replacement: '[REDACTED_KEY]', rule: 1 }); this.keyStart = undefined
      }
      if (/[\s"'<>]/.test(character)) {
        this.finishToken()
        this.context = (this.context + character).slice(-512)
        this.emailEnd()
      } else {
        if (!this.tokenBytes) { this.start = this.offset; this.prefix = this.context; this.head = ''; this.headBytes = 0; this.pending = [] }
        this.tokenBytes += bytes
        if (!this.long && this.tokenBytes <= 8192) { this.token += character; this.head = this.token; this.headBytes = this.tokenBytes }
        else {
          if (!this.long) { this.long = true; this.nextScan = this.offset + 256; this.observeLong(this.prefix + this.head, this.start - Buffer.byteLength(this.prefix)) }
          this.token = (this.token + character).slice(-512)
        }
        if (this.long && this.offset >= this.nextScan) { this.observeLong(this.token, this.offset + bytes - Buffer.byteLength(this.token)); this.nextScan = this.offset + 256 }
        this.email(character)
      }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(character)) this.span({ start: this.offset, end: this.offset + bytes, replacement: '', rule: 9 })
      this.offset += bytes
      this.peakBytes = Math.max(this.peakBytes, Math.min(this.tokenBytes, this.long ? 1536 : 8192) + this.headBytes + 3072)
    }
  }
  finish(): number {
    this.finishToken(); this.emailEnd()
    if (this.keyStart !== undefined) this.span({ start: this.keyStart, end: this.offset, replacement: '[REDACTED_KEY]', rule: 1 })
    return this.offset
  }
  private finishToken(): void {
    if (!this.tokenBytes) return
    if (this.long) {
      this.observeLong(this.token, this.offset - Buffer.byteLength(this.token))
      for (const pending of this.pending) this.span({ ...pending, end: this.offset })
    } else {
      const source = this.prefix + this.token, prefixBytes = Buffer.byteLength(this.prefix)
      SANITIZATION_RULES.forEach((rule, index) => {
        if (index === 1) return
        for (const match of source.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))) {
          const preserved = rule.replacement.startsWith('$1') ? match[1]?.length ?? 0 : 0
          const start = this.start - prefixBytes + Buffer.byteLength(source.slice(0, match.index! + preserved))
          const end = this.start - prefixBytes + Buffer.byteLength(source.slice(0, match.index! + match[0].length))
          if (start < this.start || end <= start || (index === 2 && this.token.toLowerCase() === 'bearer')) continue
          this.span({ start, end, replacement: rule.replacement.replace('$1', ''), rule: index })
        }
      })
    }
    this.context = (this.prefix + this.token).slice(-512)
    this.token = ''; this.head = ''; this.tokenBytes = 0; this.long = false; this.pending = []
  }
  private observeLong(source: string, base: number): void {
    for (const index of [0, 2, 3, 7, 8]) {
      if (this.pending.some(span => span.rule === index)) continue
      const rule = SANITIZATION_RULES[index]
      const match = new RegExp(rule.pattern.source, rule.pattern.flags).exec(source)
      if (!match) continue
      const preserved = rule.replacement.startsWith('$1') ? match[1]?.length ?? 0 : 0
      const start = base + Buffer.byteLength(source.slice(0, match.index + preserved))
      if (start < this.start) continue
      this.pending.push({ start, end: this.offset, replacement: rule.replacement.replace('$1', ''), rule: index })
    }
  }
  private email(character: string): void {
    if (this.emailStart !== undefined) {
      if (/[A-Za-z0-9.-]/.test(character)) {
        if (character === '.') { this.dot = true; this.tld = 0; this.domainValid = true }
        else { this.tld++; if (!/[A-Za-z]/.test(character)) this.domainValid = false }
        return
      }
      this.emailEnd()
    }
    if (character === '@' && this.localStart !== undefined) {
      this.emailStart = this.localStart; this.localStart = undefined; this.domainStart = this.offset + 1; this.dot = false; this.tld = 0; this.domainValid = true
    } else if (/[A-Za-z0-9._%+-]/.test(character)) {
      if (this.localStart === undefined && /[A-Za-z0-9_]/.test(character)) this.localStart = this.offset
    } else this.localStart = undefined
  }
  private emailEnd(): void {
    if (this.emailStart !== undefined && this.dot && this.domainValid && this.tld >= 2 && this.domainStart !== undefined) this.span({ start: this.emailStart, end: this.offset, replacement: '[REDACTED_EMAIL]', rule: 4 })
    this.emailStart = undefined; this.domainStart = undefined; this.localStart = undefined
  }
}

export function mergeRedactions(spans: Iterable<RedactionSpan>): RedactionSpan[] {
  const result: RedactionSpan[] = []
  for (const span of [...spans].sort((a, b) => a.start - b.start || b.end - a.end || a.rule - b.rule)) {
    const prior = result.at(-1)
    if (prior && span.start < prior.end) {
      if (span.end > prior.end) { prior.end = span.end; if (span.rule === 1) { prior.replacement = span.replacement; prior.rule = span.rule } }
    } else result.push({ ...span })
  }
  return result
}
