import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ValidationProfileCatalog } from './validation-profile-catalog'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'validation-catalog-'))
  roots.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'unit.test.ts'), '')
  writeFileSync(join(root, 'src', 'git.git.test.ts'), '')
  mkdirSync(join(root, 'src', 'main', 'validation-ledger'), { recursive: true })
  writeFileSync(join(root, 'src', 'main', 'validation-ledger', 'validation-ledger.test.ts'), '')
  return root
}

describe('ValidationProfileCatalog', () => {
  it('exposes only fixed profiles and constructs commands internally', () => {
    const catalog = new ValidationProfileCatalog()
    expect(catalog.list().map((profile) => profile.id)).toEqual([
      'typecheck', 'test-node', 'test-git', 'test-native', 'validate-codemap',
      'test-node-targeted', 'test-git-targeted', 'test-native-targeted'
    ])
    const resolved = catalog.resolve(fixture(), 'test-node-targeted', ['src/unit.test.ts'])
    expect(resolved.command.args.slice(-4)).toEqual(['run', 'test:node', '--', 'src/unit.test.ts'])

    const native = catalog.resolve(fixture(), 'test-native-targeted', ['src/main/validation-ledger/validation-ledger.test.ts'])
    expect(native.command.args.slice(-4)).toEqual(['run', 'test:native', '--', 'src/main/validation-ledger/validation-ledger.test.ts'])
  })

  it('rejects targets outside the repository, missing targets, and lane mismatches', () => {
    const root = fixture()
    const catalog = new ValidationProfileCatalog()
    expect(() => catalog.resolve(root, 'test-node-targeted', ['../escape.test.ts'])).toThrow('INVALID_TARGET')
    expect(() => catalog.resolve(root, 'test-node-targeted')).toThrow('TARGETS_REQUIRED')
    expect(() => catalog.resolve(root, 'test-node-targeted', ['src/git.git.test.ts'])).toThrow('TARGET_LANE_MISMATCH')
    expect(() => catalog.resolve(root, 'typecheck', ['src/unit.test.ts'])).toThrow('TARGETS_NOT_ALLOWED')
  })
})
