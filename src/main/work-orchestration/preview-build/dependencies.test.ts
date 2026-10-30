import { expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dependencyClosure, packageInput } from './dependencies'

it('freezes the actual transitive runtime/build closure, including nested versions, and skips absent optional packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pvo-dependencies-'))
  const pkg = async (path: string, value: object) => { await mkdir(join(root, path), { recursive: true }); await writeFile(join(root, path, 'package.json'), JSON.stringify(value)) }
  try {
    await pkg('application', { dependencies: { shared: '1', nested: '2' }, optionalDependencies: { absent: '1' } })
    await pkg('shared', {})
    await pkg('application/node_modules/nested', { dependencies: { shared: '2' } })
    await pkg('application/node_modules/nested/node_modules/shared', {})
    const closure = await dependencyClosure(root, ['application'])
    expect([...closure].sort()).toEqual(['application', 'application/node_modules/nested', 'application/node_modules/nested/node_modules/shared', 'shared'])
    expect(packageInput('application/node_modules/nested/index.js', closure)).toBe(true)
    expect(packageInput('application/node_modules/unrelated/index.js', closure)).toBe(false)
    expect(packageInput('unrelated/index.js', closure)).toBe(false)
    expect(packageInput('application/build/Release/module.node', closure)).toBe(true)
    expect(packageInput('application/build/Release/module.obj', closure)).toBe(false)
    expect(packageInput('application/.npmrc', closure)).toBe(false)
    await expect(dependencyClosure(root, ['missing-required'])).rejects.toThrow('BUILD_DEPENDENCY_MISSING')
  } finally { await rm(root, { recursive: true }) }
})
