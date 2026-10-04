import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcademyService } from './academy-service'
import { readZipEntries } from './publication/deterministic-zip'

const enabled = process.env.ACADEMY_REAL_OPENAI_RELEASE === '1'

describe.skipIf(!enabled)('Academy real OpenAI plugin release', () => {
  it('bootstraps the existing plugin and produces the first complete READY_TO_UPLOAD artifact from canonical Academy state', async () => {
    const appData = process.env.APPDATA
    if (!appData) throw new Error('APPDATA_REQUIRED')
    const databasePath = join(appData, 'code-awareness', 'academy', 'academy.db')
    if (!existsSync(databasePath)) throw new Error(`ACADEMY_DATABASE_MISSING:${databasePath}`)
    const service = new AcademyService(databasePath)
    try {
      if (!service.store.getOpenAiPluginProfile() || !service.listOpenAiReleases().some((release) => release.baseline)) await service.bootstrapOpenAiPlugin()
      let release = service.listOpenAiReleases().find((item) => !item.baseline && item.status === 'READY_TO_UPLOAD')
      if (!release || service.getOpenAiPublicationState().drifted) release = service.prepareOpenAiRelease()
      expect(release.status).toBe('READY_TO_UPLOAD')
      expect(release.snapshot.length).toBeGreaterThan(0)
      expect(release.artifactPath && existsSync(release.artifactPath)).toBe(true)
      expect(resolve(release.artifactPath!)).not.toContain(resolve(process.cwd()))
      const entries = readZipEntries(readFileSync(release.artifactPath!))
      const packagedSkills = entries.filter((entry) => /\/skills\/[^/]+\/SKILL\.md$/.test(entry.path))
      expect(packagedSkills).toHaveLength(release.snapshot.length)
      for (const name of ['engineering-evidence-economy', 'validacao-de-implementacoes', 'validation-evidence-channels']) {
        expect(release.snapshot.some((entry) => entry.name === name && entry.academyVersion >= 2)).toBe(true)
      }
      console.log('ACADEMY_OPENAI_RELEASE', JSON.stringify({
        releaseId: release.id, pluginVersion: release.pluginVersion, skills: release.snapshot.length,
        snapshotHash: release.snapshotHash, artifactHash: release.artifactHash,
        artifactPath: release.artifactPath, status: release.status
      }))
    } finally { service.close() }
  }, 60_000)
})
