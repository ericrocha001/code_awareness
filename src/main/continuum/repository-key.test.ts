import { describe, expect, it } from 'vitest'
import { deriveRepositoryKey } from './repository-key'

// Import CJS publisher's derivation function
const publisher = require('../../../scripts/continuum/publish-artifact.cjs')

describe('Repository Key — Parity and Determinism', () => {
  it('1. TypeScript runtime e CJS publisher geram a mesma key para o mesmo root', () => {
    const testRoots = [
      'C:\\Users\\developer\\Projects\\code-awareness',
      'c:/users/developer/projects/code-awareness',
      'D:\\Projects\\another-project\\',
      '/home/user/workspace/repo',
      '/var/projects/sub/app/'
    ]

    for (const root of testRoots) {
      const tsKey = deriveRepositoryKey(root)
      const cjsKey = publisher.deriveRepositoryKey(root)
      expect(tsKey).toBe(cjsKey)
    }
  })

  it('2. Normaliza caminhos Windows com barras invertidas, barras normais e trailing slashes', () => {
    const rawA = 'C:\\Projects\\MyApp'
    const rawB = 'c:/projects/myapp/'
    const rawC = 'C:/Projects/MyApp///'
    const rawD = 'c:\\projects\\myapp\\\\'

    const keyA = deriveRepositoryKey(rawA)
    const keyB = deriveRepositoryKey(rawB)
    const keyC = deriveRepositoryKey(rawC)
    const keyD = deriveRepositoryKey(rawD)

    expect(keyA).toBe(keyB)
    expect(keyB).toBe(keyC)
    expect(keyC).toBe(keyD)
  })

  it('3. Raízes diferentes geram keys diferentes', () => {
    const key1 = deriveRepositoryKey('C:\\Projects\\Alpha')
    const key2 = deriveRepositoryKey('C:\\Projects\\Beta')
    expect(key1).not.toBe(key2)
  })

  it('4. Key possui 32 caracteres hexadecimais determinísticos', () => {
    const key = deriveRepositoryKey('C:\\Test\\Repo')
    expect(key).toMatch(/^[0-9a-f]{32}$/)
  })
})
