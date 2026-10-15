import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { inventoryRemovalContent } from './worktree-removal-content'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }) })
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'removal-content-')); roots.push(path); return path }
it('rejects nested repositories and never follows junctions to external valuable data', () => {
  const root = temporary(), external = temporary()
  writeFileSync(join(external, 'valuable.txt'), 'preserve')
  symlinkSync(external, join(root, 'external'), 'junction')
  expect(() => inventoryRemovalContent(root, [], [])).toThrow('REMOVAL_LINK_NOT_ALLOWED')
  expect(readFileSync(join(external, 'valuable.txt'), 'utf8')).toBe('preserve')
  const nested = temporary()
  mkdirSync(join(nested, 'child')); mkdirSync(join(nested, 'child', '.git'))
  expect(() => inventoryRemovalContent(nested, [], [])).toThrow('REMOVAL_NESTED_REPOSITORY')
})
it('invalidates the content fingerprint even when a file keeps its length', () => {
  const root = temporary(); writeFileSync(join(root, 'evidence.cache'), '1234')
  const first = inventoryRemovalContent(root, [], ['evidence.cache'])
  writeFileSync(join(root, 'evidence.cache'), '5678')
  const second = inventoryRemovalContent(root, [], ['evidence.cache'])
  expect(first[0].kind).toBe('IGNORED'); expect(second[0].sha256).not.toBe(first[0].sha256)
})
