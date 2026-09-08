import { Tiktoken } from 'js-tiktoken/lite'
import cl100kBase from 'js-tiktoken/ranks/cl100k_base'

export interface TokenizerIdentity {
  tokenCount: number
  tokenizerId: string
  tokenizerEncoding: string
}

export interface TokenizerPort {
  readonly id: string
  readonly encoding: string
  count(content: string): number
}

export class CanonicalTokenizer implements TokenizerPort {
  readonly id = 'js-tiktoken@1.0.21'
  readonly encoding = 'cl100k_base'
  private readonly tokenizer = new Tiktoken(cl100kBase)

  count(content: string): number {
    return this.tokenizer.encode(content).length
  }
}

let canonicalTokenizer: TokenizerPort | undefined

export function getCanonicalTokenizer(): TokenizerPort {
  canonicalTokenizer ??= new CanonicalTokenizer()
  return canonicalTokenizer
}

export function countCanonicalTokens(content: string): TokenizerIdentity {
  const tokenizer = getCanonicalTokenizer()
  return {
    tokenCount: tokenizer.count(content),
    tokenizerId: tokenizer.id,
    tokenizerEncoding: tokenizer.encoding
  }
}
