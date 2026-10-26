import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AcademyService } from './academy-service'
import { SkillBridgeDistributionAdapter } from './distribution/skill-bridge-distribution-adapter'
import { AcademyDistributionService } from './distribution/academy-distribution-service'

const roots: string[] = []
const root = () => { const value = mkdtempSync(join(tmpdir(), 'academy-distribution-')); roots.push(value); return value }
const md = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} distribution\n---\n\n${body}\n`
const normalized = (path: string) => process.platform === 'win32' ? realpathSync(path).toLowerCase() : realpathSync(path)

afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }) })

it('does not persist delivery results from an activation revision superseded during reconciliation', async () => {
  const service = new AcademyService(join(root(), 'academy.db'))
  try {
    const destination = service.store.upsertDestination(root(), 'isolated')
    const skill = service.store.create({ package: { skillMd: md('in-flight', '# original'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
    let started!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const current = { status: 'CURRENT' as const, distributedVersion: 1, distributedHash: skill.current.packageHash, errorCode: null, errorMessage: null, exposureName: skill.name, linkMechanism: null }
    const adapters = (['FILESYSTEM_NATIVE', 'CLAUDE_CODE', 'ANTIGRAVITY'] as const).map(target => ({
      target,
      reconcile: async () => { if (target === 'FILESYSTEM_NATIVE') { started(); await gate }; return current },
      inspect: async () => current,
      remove: async () => null
    }))
    const distribution = new AcademyDistributionService(service.store, adapters)
    const pending = distribution.reconcileDestination(destination.id)
    await entered
    service.store.setEnabled(skill.id, false, 1)
    service.store.setDistributionState({ skillId: skill.id, destinationId: destination.id, target: 'FILESYSTEM_NATIVE', canonicalVersion: 1, canonicalHash: skill.current.packageHash, ...current })
    expect(distribution.states(skill.id)[0].status).toBe('PENDING')
    expect(distribution.health().targets.find(item => item.target === 'FILESYSTEM_NATIVE')).toMatchObject({ current: 0, pending: 1 })
    service.store.removeDistributionState(skill.id, destination.id, 'FILESYSTEM_NATIVE')
    release()
    await pending
    expect(service.store.listDistributionStates(skill.id).some(state => state.status === 'CURRENT')).toBe(false)
  } finally { await service.close() }
})

describe.each([{ target: 'CLAUDE_CODE' as const, directory: '.claude' }, { target: 'ANTIGRAVITY' as const, directory: '.agents' }])('Academy distribution domain: $target', ({ target, directory }) => {
  it('withdraws disabled skills, keeps edited versions private across restart and restores the latest package', async () => {
    const data = root(), repo = root(), source = root(), path = join(data, 'academy.db')
    let service = new AcademyService(path)
    try {
      await service.registerDestination(repo, 'isolated'); service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('reversible', '# v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      await service.waitForReconciliation()
      expect(service.distribution.states(skill.id)).toHaveLength(3)
      await service.setEnabled(skill.id, false, 1)
      expect(service.getDeliveryStatus(skill.id).status).not.toBe('CONVERGED')
      await service.waitForReconciliation()
      for (const base of ['.skills', '.claude/skills', '.agents/skills']) expect(() => lstatSync(join(repo, base, skill.name))).toThrow()
      await service.update({ skillId: skill.id, expectedVersion: 1, package: { skillMd: md(skill.name, '# private v2'), artifacts: {} }, origin: 'MCP' })
      await service.waitForReconciliation()
      mkdirSync(join(source, skill.name))
      writeFileSync(join(source, skill.name, 'SKILL.md'), md(skill.name, '# private v2'))
      expect(await service.importer.import(source)).toMatchObject([{ result: 'UNCHANGED', skillId: skill.id }])
      writeFileSync(join(source, skill.name, 'SKILL.md'), md(skill.name, '# divergent import'))
      expect(await service.importer.import(source)).toMatchObject([{ result: 'CONFLICT', skillId: skill.id }])
      expect(service.list()).toHaveLength(1)
      await service.close()
      service = new AcademyService(path)
      await service.reconcileAll(); service.watcher.stop()
      expect(service.get(skill.id)).toMatchObject({ status: 'DISABLED', stateRevision: 2, currentVersion: 2 })
      expect(() => lstatSync(join(repo, '.skills', skill.name))).toThrow()
      await service.setEnabled(skill.id, true, 2)
      await service.waitForReconciliation()
      expect(readFileSync(join(repo, directory, 'skills', skill.name, 'SKILL.md'), 'utf8')).toContain('# private v2')
      expect(service.distribution.states(skill.id).every(state => state.status === 'CURRENT' && state.distributedVersion === 2)).toBe(true)
      expect(service.history(skill.id, { version: 1 })).toEqual(skill.current)
    } finally { await service.close() }
  }, 60000)

  it('preserves a divergent managed package and records conflict when disabled', async () => {
    const service = new AcademyService(join(root(), 'academy.db')), repo = root()
    try {
      await service.registerDestination(repo, 'isolated'); service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('divergent-disabled', '# canonical'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      await service.waitForReconciliation()
      const file = join(repo, '.skills', skill.name, 'SKILL.md')
      writeFileSync(file, md(skill.name, '# preserve local edit'))
      await service.setEnabled(skill.id, false, 1)
      await service.waitForReconciliation()
      expect(readFileSync(file, 'utf8')).toContain('# preserve local edit')
      expect(service.store.listConflicts()).toMatchObject([expect.objectContaining({ skillId: skill.id })])
      expect(service.get(skill.id).status).toBe('DISABLED')
      expect(service.getDeliveryStatus(skill.id).status).not.toBe('CONVERGED')
    } finally { await service.close() }
  }, 60000)

  it('rejects a package name escaping the physical projection root', async () => {
    const data = root(); const repo = root(); const service = new AcademyService(join(data, 'academy.db'))
    try {
      const destination = await service.registerDestination(repo, 'repo'); service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('safe', '# v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      await service.waitForReconciliation()
      const adapter = new SkillBridgeDistributionAdapter(target, directory as '.claude' | '.agents', target)
      expect(await adapter.reconcile({ destination, skill: { ...skill, name: '../../escape' }, previous: null })).toMatchObject({ status: 'ERROR', errorCode: 'PATH_ESCAPE' })
      expect(() => lstatSync(join(repo, 'escape'))).toThrow()
    } finally { service.close() }
  })

  it('recovers an owned broken bridge after its physical package is restored', async () => {
    const data = root(); const repo = root(); const service = new AcademyService(join(data, 'academy.db'))
    try {
      await service.registerDestination(repo, 'repo'); service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('broken-own', '# v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      await service.waitForReconciliation()
      const physical = join(repo, '.skills', skill.name)
      const bridge = join(repo, directory, 'skills', skill.name)
      rmSync(physical, { recursive: true })
      expect(lstatSync(bridge).isSymbolicLink()).toBe(true)
      await service.distribution.verifyAll()
      expect(service.distribution.states(skill.id).find((state) => state.target === target)?.status).toBe('MISSING')
      mkdirSync(physical)
      writeFileSync(join(physical, 'SKILL.md'), skill.current.package.skillMd)
      await service.reconcileAll()
      expect(normalized(bridge)).toBe(normalized(physical))
      expect(service.distribution.states(skill.id).every((state) => state.status === 'CURRENT')).toBe(true)
    } finally { service.close() }
  })

  it('preserves a conflicting regular file', async () => {
    const data = root(); const repo = root()
    mkdirSync(join(repo, directory, 'skills'), { recursive: true })
    const path = join(repo, directory, 'skills', 'file-conflict')
    writeFileSync(path, 'private file')
    const service = new AcademyService(join(data, 'academy.db'))
    try {
      await service.registerDestination(repo, 'repo'); service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('file-conflict', '# v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      await service.waitForReconciliation()
      expect(service.distribution.states(skill.id).find((state) => state.target === target)).toMatchObject({ status: 'ERROR', errorCode: 'ENTRY_CONFLICT' })
      await service.archive(skill.id, 1)
      await service.waitForReconciliation()
      expect(readFileSync(path, 'utf8')).toBe('private file')
    } finally { service.close() }
  })

  it('preserves a replaced external link when archiving and disabling its project', async () => {
    const data = root(); const repo = root(); const outside = root(); const service = new AcademyService(join(data, 'academy.db'))
    try {
      const destination = await service.registerDestination(repo, 'repo'); service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('protected', '# v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      await service.waitForReconciliation()
      const bridge = join(repo, directory, 'skills', 'protected')
      rmSync(bridge)
      symlinkSync(outside, bridge, process.platform === 'win32' ? 'junction' : 'dir')
      await service.archive(skill.id, 1)
      await service.waitForReconciliation()
      expect(normalized(bridge)).toBe(normalized(outside))
      await service.setDestinationEnabled(destination.id, false)
      await service.waitForReconciliation()
      expect(normalized(bridge)).toBe(normalized(outside))
      expect(service.distribution.states(skill.id).find((state) => state.target === target)?.errorCode).toBe('LINK_TARGET_INCORRECT')
    } finally { service.close() }
  })

  it('rejects linked parent directories without creating entries outside the project', async () => {
    const data = root(); const repo = root(); const outside = root()
    symlinkSync(outside, join(repo, directory), process.platform === 'win32' ? 'junction' : 'dir')
    const service = new AcademyService(join(data, 'academy.db'))
    try {
      await service.registerDestination(repo, 'repo'); service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('escape', '# v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      await service.waitForReconciliation()
      expect(service.distribution.states(skill.id).find((state) => state.target === target)).toMatchObject({ status: 'ERROR', errorCode: 'PATH_ESCAPE' })
      expect(() => lstatSync(join(outside, 'skills'))).toThrow()
      expect(service.distribution.states(skill.id).filter((state) => state.target !== target).every((state) => state.status === 'CURRENT')).toBe(true)
    } finally { service.close() }
  })

  it('removes owned bridges on project disable and reconciles them after restart', async () => {
    const data = root(); const repo = root(); const path = join(data, 'academy.db'); const service = new AcademyService(path)
    let skillId: string
    try {
      const destination = await service.registerDestination(repo, 'repo'); service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('restart', '# v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      await service.waitForReconciliation()
      skillId = skill.id
      await service.setDestinationEnabled(destination.id, false)
      await service.waitForReconciliation()
      expect(() => lstatSync(join(repo, directory, 'skills', 'restart'))).toThrow()
      await service.setDestinationEnabled(destination.id, true)
    } finally { service.close() }
    const reopened = new AcademyService(path)
    try {
      await reopened.reconcileAll(); reopened.watcher.stop()
      expect(reopened.distribution.states(skillId!).every((state) => state.status === 'CURRENT')).toBe(true)
      expect(normalized(join(repo, directory, 'skills', 'restart'))).toBe(normalized(join(repo, '.skills', 'restart')))
    } finally { reopened.close() }
  })

  it('shares one physical package through a current idempotent consumer bridge', async () => {
    const data = root(); const repo = root(); const service = new AcademyService(join(data, 'academy.db'))
    try {
      await service.registerDestination(repo, 'repo')
      service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('shared', '# v1'), artifacts: { 'guide.md': 'guide' } }, scope: 'GLOBAL', origin: 'UI' })
      await service.waitForReconciliation()
      const physical = join(repo, '.skills/shared')
      const bridge = join(repo, directory + '/skills/shared')
      expect(lstatSync(physical).isSymbolicLink()).toBe(false)
      expect(lstatSync(bridge).isSymbolicLink()).toBe(true)
      expect(normalized(bridge)).toBe(normalized(physical))
      expect(readFileSync(join(bridge, 'guide.md'), 'utf8')).toBe('guide')
      expect(service.distribution.states(skill.id).map((state) => [state.target, state.status])).toEqual([
        ['ANTIGRAVITY', 'CURRENT'], ['CLAUDE_CODE', 'CURRENT'], ['FILESYSTEM_NATIVE', 'CURRENT']
      ])
      expect(service.distribution.health().targets.every((target) => target.convergence === 'CONVERGED')).toBe(true)
      const before = statSync(bridge).mtimeMs
      await service.reconcileAll(); await service.reconcileAll()
      expect(statSync(bridge).mtimeMs).toBe(before)
      expect(lstatSync(bridge).isSymbolicLink()).toBe(true)
    } finally { service.close() }
  })

  it('reports missing and drift independently before reconciliation restores convergence', async () => {
    const data = root(); const repo = root(); const service = new AcademyService(join(data, 'academy.db'))
    try {
      await service.registerDestination(repo, 'repo'); service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('health', '# v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      await service.waitForReconciliation()
      rmSync(join(repo, directory + '/skills/health'))
      await service.distribution.verifyAll()
      expect(service.store.getDistributionState(skill.id, service.store.listDestinations()[0].id, target)?.status).toBe('MISSING')
      await service.reconcileAll()
      writeFileSync(join(repo, '.skills/health/SKILL.md'), md('health', '# drift'), 'utf8')
      await service.distribution.verifyAll()
      const states = service.distribution.states(skill.id)
      expect(states.find((state) => state.target === 'FILESYSTEM_NATIVE')?.status).toBe('DRIFTED')
      expect(states.find((state) => state.target === target)).toMatchObject({ status: 'DRIFTED', errorCode: 'FILESYSTEM_NOT_CURRENT' })
      await service.reconcileAll()
      expect(service.distribution.states(skill.id).some((state) => state.status === 'DRIFTED')).toBe(true)
      const review = await service.reviewConflict(service.store.listConflicts()[0].id)
      await service.resolveConflict(review.conflict.id, 'CANONICAL', undefined, { token: review.token, confirmed: true })
      expect(service.distribution.states(skill.id).every((state) => state.status === 'CURRENT')).toBe(true)
    } finally { service.close() }
  })

  it('isolates consumer conflicts without changing the canonical version or .skills projection', async () => {
    const data = root(); const repo = root()
    mkdirSync(join(repo, directory + '/skills/conflict'), { recursive: true })
    writeFileSync(join(repo, directory + '/skills/conflict/private.md'), 'user content')
    mkdirSync(join(repo, directory + '/skills/private-skill'), { recursive: true })
    writeFileSync(join(repo, directory + '/skills/private-skill/SKILL.md'), 'private')
    const service = new AcademyService(join(data, 'academy.db'))
    try {
      await service.registerDestination(repo, 'repo'); service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('conflict', '# canonical'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      await service.waitForReconciliation()
      expect(service.get(skill.id).currentVersion).toBe(1)
      expect(readFileSync(join(repo, '.skills/conflict/SKILL.md'), 'utf8')).toContain('# canonical')
      expect(readFileSync(join(repo, directory + '/skills/conflict/private.md'), 'utf8')).toBe('user content')
      expect(readFileSync(join(repo, directory + '/skills/private-skill/SKILL.md'), 'utf8')).toBe('private')
      expect(service.distribution.states(skill.id).find((state) => state.target === target)).toMatchObject({ status: 'ERROR', errorCode: 'DIRECTORY_CONFLICT' })
      expect(service.distribution.states(skill.id).find((state) => state.target === 'FILESYSTEM_NATIVE')?.status).toBe('CURRENT')
    } finally { service.close() }
  })

  it('rejects an external bridge target and never replaces it', async () => {
    const data = root(); const repo = root(); const outside = root()
    mkdirSync(join(repo, directory, 'skills'), { recursive: true })
    symlinkSync(outside, join(repo, directory + '/skills/external'), process.platform === 'win32' ? 'junction' : 'dir')
    const service = new AcademyService(join(data, 'academy.db'))
    try {
      await service.registerDestination(repo, 'repo'); service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('external', '# safe'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      await service.waitForReconciliation()
      expect(service.distribution.states(skill.id).find((state) => state.target === target)).toMatchObject({ status: 'ERROR', errorCode: 'LINK_TARGET_INCORRECT' })
      expect(normalized(join(repo, directory + '/skills/external'))).toBe(normalized(outside))
    } finally { service.close() }
  })

  it('converges archive, restore, project scope and stable-identity rename without orphan bridges', async () => {
    const data = root(); const repoA = root(); const repoB = root(); const service = new AcademyService(join(data, 'academy.db'))
    try {
      const a = await service.registerDestination(repoA, 'A'); await service.registerDestination(repoB, 'B'); service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('old-name', '# v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      await service.update({ skillId: skill.id, expectedVersion: 1, package: { skillMd: md('new-name', '# v2'), artifacts: {} }, scope: 'PROJECT', projectIds: [a.id], origin: 'UI' })
      await service.waitForReconciliation()
      expect(() => lstatSync(join(repoA, directory + '/skills/old-name'))).toThrow()
      expect(lstatSync(join(repoA, directory + '/skills/new-name')).isSymbolicLink()).toBe(true)
      expect(() => lstatSync(join(repoB, directory + '/skills/new-name'))).toThrow()
      await service.archive(skill.id, 2)
      await service.waitForReconciliation()
      expect(() => lstatSync(join(repoA, directory + '/skills/new-name'))).toThrow()
      await service.restore(skill.id, 2)
      await service.waitForReconciliation()
      expect(lstatSync(join(repoA, directory + '/skills/new-name')).isSymbolicLink()).toBe(true)
      expect(service.get(skill.id).id).toBe(skill.id)
    } finally { service.close() }
  })

  it('handles broken links according to consumer ownership requirements', async () => {
    const data = root(); const repo = root(); const service = new AcademyService(join(data, 'academy.db'))
    try {
      await service.registerDestination(repo, 'repo'); service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('repair', '# v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      await service.waitForReconciliation()
      const bridge = join(repo, directory + '/skills/repair')
      const missingTarget = join(repo, directory, 'missing-target')
      rmSync(bridge)
      mkdirSync(missingTarget, { recursive: true })
      symlinkSync(missingTarget, bridge, process.platform === 'win32' ? 'junction' : 'dir')
      rmSync(missingTarget, { recursive: true })
      if (target === 'ANTIGRAVITY') {
        await service.reconcileAll()
        expect(service.distribution.states(skill.id).find((state) => state.target === target)).toMatchObject({ status: 'ERROR', errorCode: 'LINK_TARGET_INCORRECT' })
        expect(lstatSync(bridge).isSymbolicLink()).toBe(true)
        return
      }
      await service.distribution.verifyAll()
      expect(service.distribution.states(skill.id).find((state) => state.target === 'FILESYSTEM_NATIVE')?.status).toBe('CURRENT')
      expect(service.distribution.states(skill.id).find((state) => state.target === target)).toMatchObject({ status: 'MISSING', errorCode: 'LINK_BROKEN' })
      await service.reconcileAll()
      expect(lstatSync(bridge).isSymbolicLink()).toBe(true)
      expect(normalized(bridge)).toBe(normalized(join(repo, '.skills/repair')))
      expect(service.distribution.states(skill.id).every((state) => state.status === 'CURRENT')).toBe(true)
    } finally { service.close() }
  })
})
