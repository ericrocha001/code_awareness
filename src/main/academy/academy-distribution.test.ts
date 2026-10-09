import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AcademyService } from './academy-service'

const roots: string[] = []
const root = () => { const value = mkdtempSync(join(tmpdir(), 'academy-distribution-')); roots.push(value); return value }
const md = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} distribution\n---\n\n${body}\n`
const normalized = (path: string) => process.platform === 'win32' ? realpathSync(path).toLowerCase() : realpathSync(path)

afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }) })

describe('Academy distribution domain', () => {
  it('shares one physical package through a current idempotent Claude bridge', async () => {
    const data = root(); const repo = root(); const service = new AcademyService(join(data, 'academy.db'))
    try {
      await service.registerDestination(repo, 'repo')
      service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('shared', '# v1'), artifacts: { 'guide.md': 'guide' } }, scope: 'GLOBAL', origin: 'UI' })
      const physical = join(repo, '.skills/shared')
      const bridge = join(repo, '.claude/skills/shared')
      expect(lstatSync(physical).isSymbolicLink()).toBe(false)
      expect(lstatSync(bridge).isSymbolicLink()).toBe(true)
      expect(normalized(bridge)).toBe(normalized(physical))
      expect(readFileSync(join(bridge, 'guide.md'), 'utf8')).toBe('guide')
      expect(service.distribution.states(skill.id).map((state) => [state.target, state.status])).toEqual([
        ['CLAUDE_CODE', 'CURRENT'], ['FILESYSTEM_NATIVE', 'CURRENT']
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
      rmSync(join(repo, '.claude/skills/health'))
      await service.distribution.verifyAll()
      expect(service.store.getDistributionState(skill.id, service.store.listDestinations()[0].id, 'CLAUDE_CODE')?.status).toBe('MISSING')
      await service.reconcileAll()
      writeFileSync(join(repo, '.skills/health/SKILL.md'), md('health', '# drift'), 'utf8')
      await service.distribution.verifyAll()
      const states = service.distribution.states(skill.id)
      expect(states.find((state) => state.target === 'FILESYSTEM_NATIVE')?.status).toBe('DRIFTED')
      expect(states.find((state) => state.target === 'CLAUDE_CODE')).toMatchObject({ status: 'DRIFTED', errorCode: 'FILESYSTEM_NOT_CURRENT' })
      await service.reconcileAll()
      expect(service.distribution.states(skill.id).some((state) => state.status === 'DRIFTED')).toBe(true)
      const review = await service.reviewConflict(service.store.listConflicts()[0].id)
      await service.resolveConflict(review.conflict.id, 'CANONICAL', undefined, { token: review.token, confirmed: true })
      expect(service.distribution.states(skill.id).every((state) => state.status === 'CURRENT')).toBe(true)
    } finally { service.close() }
  })

  it('isolates Claude conflicts without changing the canonical version or .skills projection', async () => {
    const data = root(); const repo = root()
    mkdirSync(join(repo, '.claude/skills/conflict'), { recursive: true })
    writeFileSync(join(repo, '.claude/skills/conflict/private.md'), 'user content')
    mkdirSync(join(repo, '.claude/skills/private-skill'), { recursive: true })
    writeFileSync(join(repo, '.claude/skills/private-skill/SKILL.md'), 'private')
    const service = new AcademyService(join(data, 'academy.db'))
    try {
      await service.registerDestination(repo, 'repo'); service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('conflict', '# canonical'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      expect(service.get(skill.id).currentVersion).toBe(1)
      expect(readFileSync(join(repo, '.skills/conflict/SKILL.md'), 'utf8')).toContain('# canonical')
      expect(readFileSync(join(repo, '.claude/skills/conflict/private.md'), 'utf8')).toBe('user content')
      expect(readFileSync(join(repo, '.claude/skills/private-skill/SKILL.md'), 'utf8')).toBe('private')
      expect(service.distribution.states(skill.id).find((state) => state.target === 'CLAUDE_CODE')).toMatchObject({ status: 'ERROR', errorCode: 'DIRECTORY_CONFLICT' })
      expect(service.distribution.states(skill.id).find((state) => state.target === 'FILESYSTEM_NATIVE')?.status).toBe('CURRENT')
    } finally { service.close() }
  })

  it('rejects an external bridge target and never replaces it', async () => {
    const data = root(); const repo = root(); const outside = root()
    mkdirSync(join(repo, '.claude/skills'), { recursive: true })
    symlinkSync(outside, join(repo, '.claude/skills/external'), process.platform === 'win32' ? 'junction' : 'dir')
    const service = new AcademyService(join(data, 'academy.db'))
    try {
      await service.registerDestination(repo, 'repo'); service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('external', '# safe'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      expect(service.distribution.states(skill.id).find((state) => state.target === 'CLAUDE_CODE')).toMatchObject({ status: 'ERROR', errorCode: 'LINK_TARGET_INCORRECT' })
      expect(normalized(join(repo, '.claude/skills/external'))).toBe(normalized(outside))
    } finally { service.close() }
  })

  it('converges archive, restore, project scope and stable-identity rename without orphan bridges', async () => {
    const data = root(); const repoA = root(); const repoB = root(); const service = new AcademyService(join(data, 'academy.db'))
    try {
      const a = await service.registerDestination(repoA, 'A'); await service.registerDestination(repoB, 'B'); service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('old-name', '# v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      await service.update({ skillId: skill.id, expectedVersion: 1, package: { skillMd: md('new-name', '# v2'), artifacts: {} }, scope: 'PROJECT', projectIds: [a.id], origin: 'UI' })
      expect(() => lstatSync(join(repoA, '.claude/skills/old-name'))).toThrow()
      expect(lstatSync(join(repoA, '.claude/skills/new-name')).isSymbolicLink()).toBe(true)
      expect(() => lstatSync(join(repoB, '.claude/skills/new-name'))).toThrow()
      await service.archive(skill.id, 2)
      expect(() => lstatSync(join(repoA, '.claude/skills/new-name'))).toThrow()
      await service.restore(skill.id, 2)
      expect(lstatSync(join(repoA, '.claude/skills/new-name')).isSymbolicLink()).toBe(true)
      expect(service.get(skill.id).id).toBe(skill.id)
    } finally { service.close() }
  })

  it('detects a managed broken bridge and repairs it without filesystem copies', async () => {
    const data = root(); const repo = root(); const service = new AcademyService(join(data, 'academy.db'))
    try {
      await service.registerDestination(repo, 'repo'); service.watcher.stop()
      const skill = await service.create({ package: { skillMd: md('repair', '# v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
      const bridge = join(repo, '.claude/skills/repair')
      const missingTarget = join(repo, '.claude/missing-target')
      rmSync(bridge)
      mkdirSync(missingTarget, { recursive: true })
      symlinkSync(missingTarget, bridge, process.platform === 'win32' ? 'junction' : 'dir')
      rmSync(missingTarget, { recursive: true })
      await service.distribution.verifyAll()
      expect(service.distribution.states(skill.id).find((state) => state.target === 'FILESYSTEM_NATIVE')?.status).toBe('CURRENT')
      expect(service.distribution.states(skill.id).find((state) => state.target === 'CLAUDE_CODE')).toMatchObject({ status: 'MISSING', errorCode: 'LINK_BROKEN' })
      await service.reconcileAll()
      expect(lstatSync(bridge).isSymbolicLink()).toBe(true)
      expect(normalized(bridge)).toBe(normalized(join(repo, '.skills/repair')))
      expect(service.distribution.states(skill.id).every((state) => state.status === 'CURRENT')).toBe(true)
    } finally { service.close() }
  })
})
