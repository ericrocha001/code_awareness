import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleResultHistory } from './bundle-result-history'
import type { BundleResult } from '../../shared/types/continuum-builder-types'

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()))
function setup(quota?: number, count?: number) {
  const root = mkdtempSync(join(tmpdir(), 'bundle-history-'))
  cleanups.push(() => rmSync(root, { force: true, recursive: true }))
  const store = new BundleResultHistory(root, quota, count)
  cleanups.push(() => store.close())
  return { root, store }
}
function metadata(repositoryId = 'A'): Omit<BundleResult, 'id' | 'sha256' | 'bytes'> {
  return { repositoryId, generatedAt: '2026-10-27T19:00:00Z', format: 'copy', count: 1, tokenCount: 4, tokenizerEncoding: 'cl100k_base', hasVisuals: false, composition: { repositoryId, components: [], order: [], excluded: [] } }
}
it('retains exact bytes across database reopen and isolates repositories without recomposition', () => {
  const { store, root } = setup()
  const data = Buffer.from('\uFEFF# Histórico\r\nç 漢字 🚀\t\r\n')
  const first = store.retain(metadata(), data)
  expect(first.retained).toBe(true)
  const reopened = new BundleResultHistory(root)
  try {
    expect(reopened.get('A', first.id!).data).toEqual(data)
    expect(reopened.list('B')).toEqual([])
    expect(() => reopened.get('B', first.id!)).toThrow('BUNDLE_RESULT_NOT_FOUND')
    expect(reopened.list('A')[0].generatedAt).toBe('2026-10-27T19:00:00Z')
  } finally { reopened.close() }
})
it('keeps 15 generations per repository, deduplicates identical payloads and preserves other repository results', () => {
  const { store, root } = setup()
  for (let index = 0; index < 18; index++) store.retain({ ...metadata(), name: String(index) }, Buffer.from('same'))
  store.retain(metadata('B'), Buffer.from('other'))
  expect(store.list('A')).toHaveLength(15)
  expect(store.list('A')[0].name).toBe('17')
  expect(store.list('A')[14].name).toBe('3')
  expect(store.list('B')).toHaveLength(1)
  expect(readdirSync(join(root, 'payloads'))).toHaveLength(2)
})
it('evicts oldest globally by unique byte quota and cleans recoverable orphan/temp files on insertion', () => {
  const { store, root } = setup(10)
  const first = store.retain(metadata('A'), Buffer.from('123456'))
  store.retain(metadata('B'), Buffer.from('abcdef'))
  expect(store.list('A')).toEqual([])
  expect(() => store.get('A', first.id!)).toThrow('BUNDLE_RESULT_NOT_FOUND')
  writeFileSync(join(root, 'payloads', 'a'.repeat(64)), 'orphan')
  writeFileSync(join(root, 'payloads', 'dead-beef.tmp'), 'incomplete')
  store.retain(metadata('B'), Buffer.from('abcdef'))
  expect(readdirSync(join(root, 'payloads'))).toHaveLength(1)
  const before = store.list('B')
  expect(store.retain(metadata('C'), Buffer.alloc(11)).retained).toBe(false)
  expect(store.list('B')).toEqual(before)
})
it('rejects corrupt or missing payloads and never substitutes reconstructed bytes', () => {
  const { store, root } = setup()
  const first = store.retain(metadata(), Buffer.from('exact'))
  const result = store.list('A')[0], file = join(root, 'payloads', result.sha256)
  expect(readFileSync(file).toString()).toBe('exact')
  writeFileSync(file, 'wrong')
  expect(() => store.get('A', first.id!)).toThrow('BUNDLE_HISTORY_INTEGRITY_ERROR')
  expect(() => store.retain(metadata(), Buffer.from('exact'))).toThrow('BUNDLE_HISTORY_INTEGRITY_ERROR')
  rmSync(file)
  expect(() => store.get('A', first.id!)).toThrow('BUNDLE_HISTORY_FILE_UNAVAILABLE')
})
