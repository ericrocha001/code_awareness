import { describe, expect, it } from 'vitest'
import { CanonicalTokenizer } from './tokenizer'

describe('CanonicalTokenizer', () => {
  it('produces exact and stable cl100k_base counts', () => {
    const tokenizer = new CanonicalTokenizer()
    expect(tokenizer.count('hello world')).toBe(2)
    expect(tokenizer.count('export function value<T>(input: T): T { return input }')).toBe(14)
    expect(tokenizer.id).toBe('js-tiktoken@1.0.21')
    expect(tokenizer.encoding).toBe('cl100k_base')
  })
})
