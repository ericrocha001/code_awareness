import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { AcademyService } from './academy-service'
import { hashAcademyPackage } from './academy-package'
import Database from 'better-sqlite3'

const pkg = (body: string) => ({ skillMd: `---\nname: protected\ndescription: Protected skill\n---\n${body}\n`, artifacts: {} })

async function fixture(run: (service: AcademyService, root: string, destinationId: string, skillId: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'academy-conflicts-'))
  const service = new AcademyService(join(root, 'academy.db'))
  try {
    const destination = await service.registerDestination(root, 'Test')
    const skill = await service.create({ package: pkg('canonical'), scope: 'GLOBAL', origin: 'UI' })
    expect(service.store.listDestinations()[0].lastError).toBeNull()
    await run(service, root, destination.id, skill.id)
  } finally { service.close(); rmSync(root, { recursive: true, force: true }) }
}

describe('Academy conflict safety', () => {
  it('preserves external edits during reconcile and never adopts them automatically', () => fixture(async (service, root, destination, skill) => {
    const file = join(root, '.skills/protected/SKILL.md')
    writeFileSync(file, pkg('external').skillMd)
    await service.watcher.ingest(destination, 'protected')
    await service.projections.reconcileAll()
    expect(service.get(skill).currentVersion).toBe(1)
    expect(readFileSync(file, 'utf8')).toContain('external')
    expect(service.store.listConflicts()).toHaveLength(1)
  }))

  it('deduplicates stable absence and preserves recurrence after resolution', () => fixture(async (service, root, destination, skill) => {
    const directory = join(root, '.skills/protected')
    rmSync(directory, { recursive: true })
    await service.watcher.ingest(destination, 'protected')
    await service.watcher.ingest(destination, 'protected')
    expect(service.store.listConflicts()).toHaveLength(1)
    const first = service.store.listConflicts()[0]
    const review = await service.reviewConflict(first.id)
    await service.resolveConflict(first.id, 'CANONICAL', undefined, { token: review.token, confirmed: true })
    rmSync(directory, { recursive: true })
    await service.watcher.ingest(destination, 'protected')
    expect(service.store.listConflicts()).toHaveLength(1)
    expect(service.store.listConflicts()[0].id).not.toBe(first.id)
    expect(service.history(skill)).toHaveLength(1)
  }))

  it('waits for SKILL.md after a directory is created', () => fixture(async (service, root, destination) => {
    const directory = join(root, '.skills/protected')
    rmSync(directory, { recursive: true }); mkdirSync(directory)
    const pending = service.watcher.ingest(destination, 'protected')
    const timer = setTimeout(() => writeFileSync(join(directory, 'SKILL.md'), pkg('canonical').skillMd), 80)
    try { await pending } finally { clearTimeout(timer) }
    expect(service.store.listConflicts()).toEqual([])
  }))

  it('requires confirmation and rejects changed filesystem after inspection', () => fixture(async (service, root, destination, skill) => {
    const path = join(root, '.skills/protected/SKILL.md')
    writeFileSync(path, pkg('external').skillMd)
    await service.watcher.ingest(destination, 'protected')
    const conflict = service.store.listConflicts()[0]
    await expect(service.resolveConflict(conflict.id, 'DIVERGENT')).rejects.toThrow('CONFIRMED_CONFLICT_REVIEW_REQUIRED')
    const review = await service.reviewConflict(conflict.id)
    expect(review.diff).toContain('+external')
    writeFileSync(path, pkg('new edit').skillMd)
    await expect(service.resolveConflict(conflict.id, 'DIVERGENT', undefined, { token: review.token, confirmed: true })).rejects.toThrow('CONFLICT_STATE_CHANGED')
    expect(service.history(skill)).toHaveLength(1)
    expect(readFileSync(path, 'utf8')).toContain('new edit')
  }))

  it('preserves the reconciled-package API with inspection of the exact proposed content', () => fixture(async (service, root, destination, skill) => {
    writeFileSync(join(root, '.skills/protected/SKILL.md'), pkg('external').skillMd)
    await service.watcher.ingest(destination, 'protected')
    const conflict = service.store.listConflicts()[0]
    const first = await service.reviewConflict(conflict.id)
    await expect(service.resolveConflict(conflict.id, 'DIVERGENT', pkg('merged'), { token: first.token, confirmed: true })).rejects.toThrow('CONFLICT_STATE_CHANGED')
    const review = await service.reviewConflict(conflict.id, pkg('merged'))
    expect(review.diff).toContain('+merged')
    await service.resolveConflict(conflict.id, 'DIVERGENT', pkg('merged'), { token: review.token, confirmed: true })
    expect(service.get(skill).current.package).toEqual(pkg('merged'))
    expect(service.history(skill)).toHaveLength(2)
  }))

  it('certifies legacy duplicates against immutable history without regressing canonical versions', () => fixture(async (service, root, destination, skill) => {
    const historical = service.get(skill).current
    await service.update({ skillId: skill, expectedVersion: 1, package: pkg('latest'), origin: 'MCP' })
    service.watcher.stop()
    const db = new Database(service.store.databasePath)
    try {
      const insert = db.prepare("INSERT INTO academy_conflicts VALUES(?,?, 'FILESYSTEM',1,1,?,?,?,?, 'OPEN',?,NULL)")
      for (let index = 0; index < 200; index++) insert.run(`legacy-${index}`, skill, index < 174 ? null : JSON.stringify(historical.package), index < 174 ? `INVALID:SKILL.md not found in ${join(root, '.skills/protected')}` : historical.packageHash, destination, join(root, '.skills/protected'), new Date().toISOString())
      const summaries = service.snapshot().conflicts
      expect(summaries).toHaveLength(2)
      expect(summaries.reduce((sum, summary) => sum + summary.occurrenceCount, 0)).toBe(200)
      expect(JSON.stringify(summaries)).not.toContain('skillMd')
      const batch = await service.previewConflictBatch()
      expect(batch.entries).toHaveLength(2)
      await service.resolveConflictBatch(batch.token, true)
      expect(service.store.listConflicts()).toEqual([])
      expect(service.get(skill).current.package).toEqual(pkg('latest'))
      expect(service.history(skill)).toHaveLength(2)
      expect(db.prepare("SELECT count(*) total FROM academy_conflicts WHERE status='RESOLVED'").get()).toEqual({ total: 200 })
    } finally { db.close() }
  }))

  it('excludes actual missing packages and novel divergence from bulk sanitation', () => fixture(async (service, root, destination, skill) => {
    rmSync(join(root, '.skills/protected'), { recursive: true })
    await service.watcher.ingest(destination, 'protected')
    const batch = await service.previewConflictBatch()
    expect(batch.entries).toEqual([])
    expect(batch.excluded).toBe(1)
    expect(service.get(skill).currentVersion).toBe(1)
    mkdirSync(join(root, '.skills/protected'))
    writeFileSync(join(root, '.skills/protected/SKILL.md'), pkg('novel external').skillMd)
    await service.watcher.ingest(destination, 'protected')
    expect((await service.previewConflictBatch()).entries).toEqual([])
    expect((await service.previewConflictBatch()).excluded).toBe(2)
  }))

  it('rejects a batch after canonical or filesystem preconditions change', () => fixture(async (service, root, destination, skill) => {
    const first = service.get(skill).current
    await service.update({ skillId: skill, expectedVersion: 1, package: pkg('latest'), origin: 'UI' })
    service.store.createConflict(skill, 'FILESYSTEM', 1, first.package, first.packageHash, destination, join(root, '.skills/protected'))
    const batch = await service.previewConflictBatch()
    expect(batch.entries).toHaveLength(1)
    writeFileSync(join(root, '.skills/protected/SKILL.md'), pkg('later external').skillMd)
    await expect(service.resolveConflictBatch(batch.token, true)).rejects.toThrow('CONFLICT_STATE_CHANGED')
    expect(readFileSync(join(root, '.skills/protected/SKILL.md'), 'utf8')).toContain('later external')
  }))

  it('allows shared-path historical occurrences to converge within the same batch', () => fixture(async (service, root, destination, skill) => {
    const first = service.get(skill).current
    await service.update({ skillId: skill, expectedVersion: 1, package: pkg('latest'), origin: 'UI' })
    const directory = join(root, '.skills/protected')
    writeFileSync(join(directory, 'SKILL.md'), first.package.skillMd)
    service.store.createConflict(skill, 'FILESYSTEM', 1, first.package, first.packageHash, destination, directory)
    service.store.createConflict(skill, 'FILESYSTEM', 1, null, `INVALID:SKILL.md not found in ${directory}`, destination, directory)
    const batch = await service.previewConflictBatch()
    expect(batch.entries).toHaveLength(2)
    await service.resolveConflictBatch(batch.token, true)
    expect(service.store.listConflicts()).toEqual([])
    expect(service.get(skill).currentVersion).toBe(2)
    expect(readFileSync(join(directory, 'SKILL.md'), 'utf8')).toContain('latest')
  }))

  it('preserves an external edit made while a new projection is being staged', () => fixture(async (service, root, destination, skill) => {
    const path = join(root, '.skills/protected/SKILL.md')
    let edited = false
    const watcher = watch(join(root, '.skills'), (_event, filename) => {
      if (!edited && filename?.toString().startsWith('.academy-stage-')) { edited = true; writeFileSync(path, pkg('concurrent external').skillMd) }
    })
    try {
      service.store.update({ skillId: skill, expectedVersion: 1, package: { ...pkg('new canonical'), artifacts: Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`reference-${index}.md`, 'staging'])) }, origin: 'UI' })
      await service.projections.reconcileDestination(destination)
      expect(edited).toBe(true)
      expect(readFileSync(path, 'utf8')).toContain('concurrent external')
      expect(service.store.listConflicts()[0].divergentHash).toBe(hashAcademyPackage(pkg('concurrent external')))
      expect(service.get(skill).currentVersion).toBe(2)
    } finally { watcher.close() }
  }))

  it('detects stable deletion after restart and preserves immutable history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'academy-restart-'))
    let service = new AcademyService(join(root, 'academy.db'))
    try {
      await service.registerDestination(root, 'Test')
      const skill = await service.create({ package: pkg('canonical'), scope: 'GLOBAL', origin: 'UI' })
      service.close()
      rmSync(join(root, '.skills/protected'), { recursive: true })
      service = new AcademyService(join(root, 'academy.db'))
      await service.reconcileAll(); await service.reconcileAll()
      expect(service.store.listConflicts()).toHaveLength(1)
      expect(service.store.listConflicts()[0].divergentHash).toBe('DELETED')
      expect(service.history(skill.id)).toHaveLength(1)
    } finally { service.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
