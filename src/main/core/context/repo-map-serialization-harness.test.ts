import { describe, expect, it } from 'vitest'
import { benchmarkRepoMapSerialization, createSerializationSnapshot } from './repo-map-serialization-harness'

describe('AI-native Repo Map serialization harness', () => {
  it.each([
    ['small', ['src/a.ts', 'src/b.ts'], false],
    ['medium', Array.from({ length: 80 }, (_, index) => `src/features/feature-${index}/service.ts`), false],
    ['dense', Array.from({ length: 80 }, (_, index) => `src/domain/unit-${index}/index.ts`), true],
    ['deep', Array.from({ length: 40 }, (_, index) => `packages/product/src/modules/area-${index}/internal/service.ts`), false]
  ] as const)('keeps every %s candidate resolvable and records canonical tokens', (_name, paths, dense) => {
    const report = benchmarkRepoMapSerialization(createSerializationSnapshot([...paths], dense), 'C:/workspace/repository')
    console.log(`SERIALIZATION_BENCHMARK ${_name} ${JSON.stringify(report)}`)
    expect(report.candidates.every((candidate) => candidate.valid)).toBe(true)
    expect(report.candidates.every((candidate) => candidate.tokens > 0)).toBe(true)
    expect(report.candidates.find((candidate) => candidate.name === 'flat-full')!.tokens)
      .toBeGreaterThan(report.candidates.find((candidate) => candidate.name === 'flat-minimal')!.tokens)
    if (_name !== 'small') expect(report.winner).toBe('trie-refs')
  })
})
