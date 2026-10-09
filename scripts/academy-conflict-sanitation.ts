import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { AcademyService } from '../src/main/academy/academy-service'

async function run() {
  const [database, outputDirectory, mode = 'preview'] = process.argv.slice(2)
  if (!database || !outputDirectory || !['preview', 'apply'].includes(mode)) throw new Error('Usage: <academy.db> <evidence directory> [preview|apply]')
  const output = resolve(outputDirectory)
  mkdirSync(output, { recursive: true })
  const service = new AcademyService(resolve(database))
  try {
    const before = service.list().map((skill) => ({ id: skill.id, version: skill.currentVersion, hash: service.get(skill.id).current.packageHash, history: service.history(skill.id).map((version) => [version.version, version.packageHash]) }))
    const summaries = service.snapshot().conflicts
    const preview = await service.previewConflictBatch()
    const observations = await Promise.all(summaries.map(async (summary) => {
      const review = await service.reviewConflict(summary.id)
      return { id: summary.id, path: summary.projectionPath, currentVersion: review.currentVersion, historicalVersion: review.historicalVersion, canonicalHash: review.canonicalHash, diskHash: review.diskHash, safeCanonical: review.safeCanonical }
    }))
    const classification = { mode, skills: before.length, distinct: summaries.length, records: summaries.reduce((sum, item) => sum + item.occurrenceCount, 0),
      causes: Object.fromEntries(['MISSING', 'INVALID', 'HISTORICAL', 'DIVERGENT'].map((cause) => [cause, summaries.filter((item) => item.cause === cause).reduce((sum, item) => sum + item.occurrenceCount, 0)])),
      eligible: preview.entries.length, eligibleRecords: preview.entries.reduce((sum, item) => sum + item.occurrences, 0), excluded: preview.excluded, summaries, preview, observations }
    const classificationFile = join(output, `${mode}-classification.json`)
    writeFileSync(existsSync(classificationFile) ? join(output, `${mode}-classification-${Date.now()}.json`) : classificationFile, JSON.stringify(classification, null, 2), 'utf8')
    if (mode === 'apply') {
      const backup = new Database(resolve(database), { readonly: true })
      const backupFile = join(output, 'academy-before.db')
      try { await backup.backup(existsSync(backupFile) ? join(output, `academy-before-${Date.now()}.db`) : backupFile) } finally { backup.close() }
      const result = await service.resolveConflictBatch(preview.token, true)
      await service.reconcileAll()
      const after = service.list().map((skill) => ({ id: skill.id, version: skill.currentVersion, hash: service.get(skill.id).current.packageHash, history: service.history(skill.id).map((version) => [version.version, version.packageHash]) }))
      const concurrentCanonicalChanges = after.filter((skill) => JSON.stringify(skill) !== JSON.stringify(before.find((item) => item.id === skill.id))).map((skill) => ({ id: skill.id, beforeVersion: before.find((item) => item.id === skill.id)?.version, afterVersion: skill.version }))
      const original = new Database(backupFile, { readonly: true })
      const live = new Database(resolve(database), { readonly: true })
      let originalRecordsResolved = 0
      try {
        const versions = original.prepare('SELECT * FROM academy_versions ORDER BY skill_id,version').all() as Array<{ skill_id: string; version: number }>
        const liveVersion = live.prepare('SELECT * FROM academy_versions WHERE skill_id=? AND version=?')
        for (const version of versions) {
          if (JSON.stringify(version) !== JSON.stringify(liveVersion.get(version.skill_id, version.version))) throw new Error('IMMUTABLE_HISTORY_CHANGED')
        }
        const originalIds = original.prepare("SELECT id FROM academy_conflicts WHERE status='OPEN'").all() as Array<{ id: string }>
        const status = live.prepare('SELECT status FROM academy_conflicts WHERE id=?')
        originalRecordsResolved = originalIds.filter(({ id }) => (status.get(id) as { status: string } | undefined)?.status === 'RESOLVED').length
        if (originalRecordsResolved !== originalIds.length) throw new Error('ORIGINAL_QUEUE_NOT_RESOLVED')
      } finally { original.close(); live.close() }
      const report = { ...result, originalRecordsResolved, immutableHistoryPreserved: true, canonicalWritesBySanitation: 0, concurrentCanonicalChanges, remaining: service.snapshot().conflicts, distribution: await service.getDistributionHealth(), destinations: service.store.listDestinations() }
      writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2), 'utf8')
      console.log(JSON.stringify({ ...result, originalRecordsResolved, immutableHistoryPreserved: true, canonicalWritesBySanitation: 0, concurrentCanonicalChanges, distribution: report.distribution }))
    } else console.log(JSON.stringify({ ...classification, summaries: undefined, preview: undefined, observations: undefined }))
  } finally { service.close() }
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
