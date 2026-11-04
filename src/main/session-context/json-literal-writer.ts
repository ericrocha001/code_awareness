import { Transform, type TransformCallback } from 'node:stream'

export class JsonLiteralWriter extends Transform {
  private previous = ''
  private high = ''
  constructor() { super({ writableObjectMode: true }) }
  override _transform(token: { name: string; value?: string | boolean | number | null }, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      const name = token.name
      if (['startObject', 'startArray', 'startString', 'startNumber', 'startKey', 'trueValue', 'falseValue', 'nullValue'].includes(name)) {
        if (!['', 'startObject', 'startArray', 'endKey'].includes(this.previous)) this.push(',')
      }
      if (name === 'stringChunk') {
        let text = this.high + String(token.value ?? ''); this.high = ''
        const last = text.charCodeAt(text.length - 1)
        if (last >= 0xd800 && last <= 0xdbff) { this.high = text.slice(-1); text = text.slice(0, -1) }
        if (text) this.push(JSON.stringify(text).slice(1, -1))
      } else if (name === 'endString' || name === 'endKey') {
        if (this.high) { this.push(JSON.stringify(this.high).slice(1, -1)); this.high = '' }
        this.push(name === 'endKey' ? '":' : '"')
      } else if (name === 'numberChunk') this.push(String(token.value))
      else {
        const symbol: Record<string, string> = { startObject: '{', endObject: '}', startArray: '[', endArray: ']', startString: '"', startKey: '"', trueValue: 'true', falseValue: 'false', nullValue: 'null' }
        if (symbol[name]) this.push(symbol[name])
      }
      this.previous = name; done()
    } catch (error) { done(error instanceof Error ? error : new Error('SOURCE_SCHEMA_UNSUPPORTED')) }
  }
}
