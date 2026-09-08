/*
-T ---
*/

import { describe, it, expect } from 'vitest'
import { computeSourceGenerationIdentity } from './source-generation-identity'
import { DEFAULT_SOURCE_PROFILE } from '../../../../../shared/utils/source-profile'

describe('computeSourceGenerationIdentity', () => {
  const repoPath = 'C:\\projects\\app'
  const filesA = ['src/z.ts', 'src/a.ts', 'src/m.ts']
  const filesB = ['src/a.ts', 'src/m.ts', 'src/z.ts']

  it('produz a mesma identidade independentemente da ordem do array de arquivos', () => {
    const idA = computeSourceGenerationIdentity(repoPath, filesA, 'markdown', DEFAULT_SOURCE_PROFILE)
    const idB = computeSourceGenerationIdentity(repoPath, filesB, 'markdown', DEFAULT_SOURCE_PROFILE)

    expect(idA).toBe(idB)
  })

  it('produz identidades distintas para formatos diferentes', () => {
    const idMd = computeSourceGenerationIdentity(repoPath, filesA, 'markdown', DEFAULT_SOURCE_PROFILE)
    const idXml = computeSourceGenerationIdentity(repoPath, filesA, 'xml', DEFAULT_SOURCE_PROFILE)

    expect(idMd).not.toBe(idXml)
  })

  it('produz identidades distintas para perfis com flags diferentes', () => {
    const idDefault = computeSourceGenerationIdentity(repoPath, filesA, 'markdown', DEFAULT_SOURCE_PROFILE)
    const idCustom = computeSourceGenerationIdentity(repoPath, filesA, 'markdown', {
      ...DEFAULT_SOURCE_PROFILE,
      removeComments: !DEFAULT_SOURCE_PROFILE.removeComments
    })

    expect(idDefault).not.toBe(idCustom)
  })

  it('produz identidades distintas para repositórios diferentes', () => {
    const id1 = computeSourceGenerationIdentity('C:\\repo1', filesA, 'markdown', DEFAULT_SOURCE_PROFILE)
    const id2 = computeSourceGenerationIdentity('C:\\repo2', filesA, 'markdown', DEFAULT_SOURCE_PROFILE)

    expect(id1).not.toBe(id2)
  })
})
