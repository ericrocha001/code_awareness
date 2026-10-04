import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AcademyService } from './academy-service'

const roots: string[] = []
const root = () => { const value = mkdtempSync(join(tmpdir(), 'academy-sync-')); roots.push(value); return value }
const text = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`

afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }) })

describe('Academy projection, import and ingestion', () => {
  it('projects GLOBAL and PROJECT skills, propagates updates and avoids identical rewrites', async () => {
    const data = root(); const repoA = root(); const repoB = root()
    const service = new AcademyService(join(data, 'academy.db'))
    const a = await service.registerDestination(repoA, 'A')
    const b = await service.registerDestination(repoB, 'B')
    const global = await service.create({ package: { skillMd: text('global-skill', '# v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
    const project = await service.create({ package: { skillMd: text('project-skill', '# project'), artifacts: {} }, scope: 'PROJECT', projectIds: [a.id], origin: 'UI' })
    expect(readFileSync(join(repoA, '.skills/global-skill/SKILL.md'), 'utf8')).toContain('# v1')
    expect(readFileSync(join(repoB, '.skills/global-skill/SKILL.md'), 'utf8')).toContain('# v1')
    expect(readFileSync(join(repoA, '.skills/project-skill/SKILL.md'), 'utf8')).toContain('# project')
    expect(() => statSync(join(repoB, '.skills/project-skill'))).toThrow()
    const before = statSync(join(repoA, '.skills/global-skill/SKILL.md')).mtimeMs
    await service.projections.reconcileAll()
    expect(statSync(join(repoA, '.skills/global-skill/SKILL.md')).mtimeMs).toBe(before)
    await service.update({ skillId: global.id, expectedVersion: 1, package: { skillMd: text('global-skill', '# v2'), artifacts: {} }, origin: 'MCP' })
    expect(readFileSync(join(repoA, '.skills/global-skill/SKILL.md'), 'utf8')).toContain('# v2')
    expect(readFileSync(join(repoB, '.skills/global-skill/SKILL.md'), 'utf8')).toContain('# v2')
    await service.archive(project.id, 1)
    expect(() => statSync(join(repoA, '.skills/project-skill'))).toThrow()
    expect(service.history(project.id)).toHaveLength(1)
    service.close()
  })

  it('imports byte-exact packages with partial failure and idempotence', async () => {
    const data = root(); const source = join(root(), '.skills')
    mkdirSync(join(source, 'valid', 'references'), { recursive: true })
    mkdirSync(join(source, 'invalid'), { recursive: true })
    const skillMd = text('valid', '# exact\r\nUnicode á')
    writeFileSync(join(source, 'valid/SKILL.md'), skillMd, 'utf8')
    writeFileSync(join(source, 'valid/references/a.md'), 'artifact β\r\n', 'utf8')
    writeFileSync(join(source, 'invalid/README.md'), 'missing', 'utf8')
    const service = new AcademyService(join(data, 'academy.db'))
    const first = await service.import(source)
    expect(first.map((item) => item.result)).toEqual(['INVALID', 'IMPORTED'])
    const detail = service.store.findByName('valid')!
    expect(detail.current.package.skillMd).toBe(skillMd)
    expect(detail.current.package.artifacts['references/a.md']).toBe('artifact β\r\n')
    expect((await service.import(source)).map((item) => item.result)).toEqual(['INVALID', 'UNCHANGED'])
    service.close()
  })

  it('reports duplicate names in one analyzed import batch before persisting the duplicate', async () => {
    const data = root(); const source = join(root(), '.skills')
    for (const directory of ['one', 'two']) {
      mkdirSync(join(source, directory), { recursive: true })
      writeFileSync(join(source, directory, 'SKILL.md'), text('same-name', `# ${directory}`), 'utf8')
    }
    const service = new AcademyService(join(data, 'academy.db'))
    const result = await service.import(source)
    expect(result.map((item) => item.result)).toEqual(['IMPORTED', 'DUPLICATE'])
    expect(service.list()).toHaveLength(1)
    service.close()
  })

  it('renames the managed projection by stable identity when frontmatter name changes', async () => {
    const data = root(); const repo = root()
    const service = new AcademyService(join(data, 'academy.db'))
    await service.registerDestination(repo, 'repo')
    const skill = await service.create({ package: { skillMd: text('old-name', '# v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
    await service.update({ skillId: skill.id, expectedVersion: 1, package: { skillMd: text('new-name', '# v2'), artifacts: {} }, origin: 'UI' })
    expect(() => statSync(join(repo, '.skills/old-name'))).toThrow()
    expect(readFileSync(join(repo, '.skills/new-name/SKILL.md'), 'utf8')).toContain('# v2')
    expect(service.get(skill.id).id).toBe(skill.id)
    service.close()
  })

  it('ingests stabilized filesystem edits and preserves stale concurrent divergence', async () => {
    const data = root(); const repo = root()
    const service = new AcademyService(join(data, 'academy.db'))
    const destination = await service.registerDestination(repo, 'repo')
    const skill = await service.create({ package: { skillMd: text('editable', '# v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
    writeFileSync(join(repo, '.skills/editable/SKILL.md'), text('editable', '# filesystem v2'), 'utf8')
    await service.watcher.ingest(destination.id, 'editable')
    expect(service.get(skill.id).currentVersion).toBe(2)
    expect(service.get(skill.id).current.origin).toBe('FILESYSTEM')
    service.store.update({ skillId: skill.id, expectedVersion: 2, package: { skillMd: text('editable', '# canonical v3'), artifacts: {} }, origin: 'MCP' })
    writeFileSync(join(repo, '.skills/editable/SKILL.md'), text('editable', '# stale local'), 'utf8')
    await service.watcher.ingest(destination.id, 'editable')
    expect(service.get(skill.id).currentVersion).toBe(3)
    expect(service.store.listConflicts()).toHaveLength(1)
    expect(readFileSync(join(repo, '.skills/editable/SKILL.md'), 'utf8')).toContain('# stale local')
    service.close()
  })

  it('versions artifact additions and removals while invalid packages never replace canonical content', async () => {
    const data = root(); const repo = root()
    const service = new AcademyService(join(data, 'academy.db'))
    const destination = await service.registerDestination(repo, 'repo')
    const skill = await service.create({ package: { skillMd: text('artifacts', '# v1'), artifacts: { 'old.md': 'old' } }, scope: 'GLOBAL', origin: 'UI' })
    rmSync(join(repo, '.skills/artifacts/old.md'))
    mkdirSync(join(repo, '.skills/artifacts/references'), { recursive: true })
    writeFileSync(join(repo, '.skills/artifacts/references/new.md'), 'new β', 'utf8')
    await service.watcher.ingest(destination.id, 'artifacts')
    const changed = service.get(skill.id)
    expect(changed.currentVersion).toBe(2)
    expect(changed.current.package.artifacts).toEqual({ 'references/new.md': 'new β' })
    writeFileSync(join(repo, '.skills/artifacts/SKILL.md'), '# invalid', 'utf8')
    await service.watcher.ingest(destination.id, 'artifacts')
    expect(service.get(skill.id).currentVersion).toBe(2)
    expect(service.store.listConflicts()).toHaveLength(1)
    service.close()
  })

  it('treats folder deletion as divergence and never deletes canonical history', async () => {
    const data = root(); const repo = root()
    const service = new AcademyService(join(data, 'academy.db'))
    const destination = await service.registerDestination(repo, 'repo')
    const skill = await service.create({ package: { skillMd: text('survivor', '# v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
    rmSync(join(repo, '.skills/survivor'), { recursive: true })
    await service.watcher.ingest(destination.id, 'survivor')
    expect(service.get(skill.id).currentVersion).toBe(1)
    expect(service.history(skill.id)).toHaveLength(1)
    expect(service.store.listConflicts()[0].divergentHash).toBe('DELETED')
    service.close()
  })

  it('rejects symbolic-link escapes and isolates a failing destination', async () => {
    const data = root(); const good = root(); const badRoot = root(); const outside = root()
    const badPath = join(badRoot, 'not-a-directory'); writeFileSync(badPath, 'x')
    const service = new AcademyService(join(data, 'academy.db'))
    const goodDestination = await service.registerDestination(good, 'good')
    await service.registerDestination(badPath, 'bad')
    const skill = await service.create({ package: { skillMd: text('safe', '# v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
    expect(readFileSync(join(good, '.skills/safe/SKILL.md'), 'utf8')).toContain('# v1')
    expect(service.store.listDestinations().find((item) => item.name === 'bad')?.reconciliationStatus).toBe('ERROR')
    writeFileSync(join(outside, 'secret.md'), 'secret', 'utf8')
    symlinkSync(outside, join(good, '.skills/safe/linked'), 'junction')
    await service.watcher.ingest(goodDestination.id, 'safe')
    expect(service.get(skill.id).currentVersion).toBe(1)
    expect(service.store.listConflicts()).toHaveLength(1)
    service.close()
  })

  it('coalesces a burst of watcher events into one filesystem version', async () => {
    const data = root(); const repo = root()
    const service = new AcademyService(join(data, 'academy.db'))
    await service.registerDestination(repo, 'repo')
    const skill = await service.create({ package: { skillMd: text('burst', '# v1'), artifacts: {} }, scope: 'GLOBAL', origin: 'UI' })
    const path = join(repo, '.skills/burst/SKILL.md')
    writeFileSync(path, text('burst', '# edit 1'), 'utf8')
    writeFileSync(path, text('burst', '# edit 2'), 'utf8')
    writeFileSync(path, text('burst', '# final'), 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(service.get(skill.id).currentVersion).toBe(2)
    expect(service.get(skill.id).current.package.skillMd).toContain('# final')
    service.close()
  })
})
