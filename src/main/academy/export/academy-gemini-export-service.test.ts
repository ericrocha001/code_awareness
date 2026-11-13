import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSync } from 'esbuild'
import { AcademyStore } from '../academy-store'
import { AcademyGeminiExportService } from './academy-gemini-export-service'
import {
  createGeminiSkillZip,
  createGeminiMasterZip,
  validateGeminiSkill,
  geminiInclusion,
  buildGeminiCoverage
} from './gemini-export-model'
import { readZipEntries } from '../publication/deterministic-zip'
import { AcademyPluginExecutor } from '../publication/academy-plugin-executor'
import type { AcademyPackage, AcademySkillDetail } from '../../../shared/types/academy-types'

function makePackage(name: string, description: string, artifacts: Record<string, string> = {}): AcademyPackage {
  return {
    skillMd: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nProcedural skill documentation.`,
    artifacts
  }
}

describe('Gemini Export Packager & Service', () => {
  let tempDir: string
  let dbPath: string
  let downloadsDir: string
  let store: AcademyStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gemini-export-test-'))
    dbPath = join(tempDir, 'academy.db')
    downloadsDir = join(tempDir, 'downloads')
    mkdirSync(downloadsDir, { recursive: true })
    store = new AcademyStore(dbPath)
  })

  afterEach(() => {
    store.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('Compatibility Validation', () => {
    it('approves compliant skill with kebab-case name and valid extensions', () => {
      const skill = store.create({
        package: makePackage('code-reviewer', 'Reviews code changes', {
          'references/checklist.md': '# Checklist\nReview items',
          'data/config.json': '{"maxLines": 500}'
        }),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      const result = validateGeminiSkill(skill)
      expect(result.valid).toBe(true)
    })

    it('approves code, document, spreadsheet, and modern image extensions per Gemini Web documentation', () => {
      const skill = store.create({
        package: makePackage('full-stack-assistant', 'Full stack assistant', {
          'src/index.ts': 'export const a = 1',
          'src/app.js': 'console.log("hi")',
          'scripts/calc.py': 'def run(): pass',
          'db/schema.sql': 'SELECT 1;',
          'data/metrics.xlsx': 'fake-xlsx-bytes',
          'slides/pitch.pptx': 'fake-pptx-bytes',
          'images/screenshot.heic': 'fake-heic-bytes'
        }),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      const result = validateGeminiSkill(skill)
      expect(result.valid).toBe(true)
    })

    it('rejects skill with invalid non-kebab-case name', () => {
      const skill: AcademySkillDetail = {
        id: 'skill-1',
        name: 'Invalid_Name_123',
        description: 'Test',
        status: 'ACTIVE',
        scope: 'GLOBAL',
        stateRevision: 1,
        currentVersion: 1,
        projectIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        current: {
          skillId: 'skill-1',
          version: 1,
          package: makePackage('Invalid_Name_123', 'Test'),
          packageHash: 'abc',
          origin: 'UI',
          createdAt: new Date().toISOString()
        }
      }
      const result = validateGeminiSkill(skill)
      expect(result.valid).toBe(false)
      expect(result.details).toContain('kebab-case')
    })

    it('rejects skill with unsupported executable artifact extensions like .sh, .exe, or .bin', () => {
      const skill = store.create({
        package: makePackage('shell-helper', 'Helper with script', {
          'scripts/run.sh': '#!/bin/bash\necho hi'
        }),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      const result = validateGeminiSkill(skill)
      expect(result.valid).toBe(false)
      expect(result.details).toContain('.sh')
      expect(result.details).toContain('não suportada pelo Gemini Web')
    })

    it('rejects skill with audio or video files not allowed in ZIPs', () => {
      const audioSkill = store.create({
        package: makePackage('audio-skill', 'Has audio', {
          'assets/intro.mp3': 'fake-mp3'
        }),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      const audioResult = validateGeminiSkill(audioSkill)
      expect(audioResult.valid).toBe(false)
      expect(audioResult.details).toContain('.mp3')
      expect(audioResult.details).toContain('áudio/vídeo')

      const videoSkill = store.create({
        package: makePackage('video-skill', 'Has video', {
          'assets/demo.mp4': 'fake-mp4'
        }),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      const videoResult = validateGeminiSkill(videoSkill)
      expect(videoResult.valid).toBe(false)
      expect(videoResult.details).toContain('.mp4')
      expect(videoResult.details).toContain('áudio/vídeo')
    })

    it('identifies exclusion reasons accurately in geminiInclusion', () => {
      const privateSkill = store.create({
        package: makePackage('private-tool', 'Private tool'),
        scope: 'GLOBAL',
        origin: 'UI',
        keepPrivate: true
      })
      expect(geminiInclusion(store, privateSkill).status).toBe('EXCLUDED')
      expect(geminiInclusion(store, privateSkill).reason).toBe('PRIVATE')

      const disabledSkill = store.create({
        package: makePackage('disabled-tool', 'Disabled tool'),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      store.approvePublicSkill(disabledSkill.id, disabledSkill.currentVersion)
      store.setEnabled(disabledSkill.id, false, disabledSkill.stateRevision)
      const disabledSummary = store.list().find((s) => s.id === disabledSkill.id)!
      expect(geminiInclusion(store, disabledSummary).status).toBe('EXCLUDED')
      expect(geminiInclusion(store, disabledSummary).reason).toBe('DISABLED')

      const projectSkill = store.create({
        package: makePackage('project-tool', 'Project tool'),
        scope: 'PROJECT',
        origin: 'UI'
      })
      expect(geminiInclusion(store, projectSkill).status).toBe('NOT_APPLICABLE')

      const incompatibleSkill = store.create({
        package: makePackage('incompatible-tool', 'Tool with shell script', {
          'run.sh': '#!/bin/bash\necho hi'
        }),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      store.approvePublicSkill(incompatibleSkill.id, incompatibleSkill.currentVersion)
      expect(geminiInclusion(store, incompatibleSkill).status).toBe('EXCLUDED')
      expect(geminiInclusion(store, incompatibleSkill).reason).toBe('INCOMPATIBLE')
    })
  })

  describe('Deterministic Zip Generation', () => {
    it('creates skill zip with SKILL.md strictly at the root', () => {
      const skill = store.create({
        package: makePackage('my-skill', 'My Skill Description', {
          'docs/intro.md': '# Intro',
          'assets/diagram.png': 'synthetic-png-bytes'
        }),
        scope: 'GLOBAL',
        origin: 'UI'
      })

      const generated = createGeminiSkillZip(skill)
      expect(generated.name).toBe('my-skill')
      expect(generated.entryCount).toBe(3)
      expect(generated.zipBuffer.length).toBeGreaterThan(0)

      const entries = readZipEntries(generated.zipBuffer)
      const paths = entries.map((e) => e.path)
      expect(paths).toEqual(['assets/diagram.png', 'docs/intro.md', 'SKILL.md'])

      const rootSkillMd = entries.find((e) => e.path === 'SKILL.md')
      expect(rootSkillMd).toBeDefined()
      expect(rootSkillMd!.data.toString('utf8')).toContain('My Skill Description')
    })

    it('ensures determinism across multiple runs', () => {
      const skill = store.create({
        package: makePackage('deterministic-skill', 'Checks byte determinism', {
          'guide.md': 'content A'
        }),
        scope: 'GLOBAL',
        origin: 'UI'
      })

      const run1 = createGeminiSkillZip(skill)
      const run2 = createGeminiSkillZip(skill)
      expect(run1.zipSha256).toBe(run2.zipSha256)
      expect(run1.zipBuffer.equals(run2.zipBuffer)).toBe(true)
    })

    it('creates master zip containing individual skill zips at root', () => {
      const skillA = store.create({
        package: makePackage('skill-alpha', 'Alpha'),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      const skillB = store.create({
        package: makePackage('skill-beta', 'Beta'),
        scope: 'GLOBAL',
        origin: 'UI'
      })

      const zipA = createGeminiSkillZip(skillA)
      const zipB = createGeminiSkillZip(skillB)

      const master = createGeminiMasterZip([zipB, zipA]) // purposefully unsorted
      const entries = readZipEntries(master.masterBuffer)
      expect(entries.map((e) => e.path)).toEqual(['skill-alpha.zip', 'skill-beta.zip'])

      const alphaInnerEntries = readZipEntries(entries[0].data)
      expect(alphaInnerEntries.some((e) => e.path === 'SKILL.md')).toBe(true)
    })
  })

  describe('AcademyGeminiExportService', () => {
    it('manages full lifecycle: coverage, export generation, persistence, and receipt', async () => {
      const service = new AcademyGeminiExportService(store, dbPath, downloadsDir)

      const valid1 = store.create({
        package: makePackage('alpha-skill', 'Alpha skill'),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      const valid2 = store.create({
        package: makePackage('beta-skill', 'Beta skill'),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      const excludedPrivate = store.create({
        package: makePackage('gamma-private', 'Gamma private'),
        scope: 'GLOBAL',
        origin: 'UI',
        keepPrivate: true
      })
      const excludedIncompatible = store.create({
        package: makePackage('delta-script', 'Delta with sh', { 'test.sh': '#!/bin/bash\nexit 0' }),
        scope: 'GLOBAL',
        origin: 'UI'
      })

      store.approvePublicSkill(valid1.id, valid1.currentVersion)
      store.approvePublicSkill(valid2.id, valid2.currentVersion)
      store.approvePublicSkill(excludedIncompatible.id, excludedIncompatible.currentVersion)

      const initialState = service.getState()
      expect(initialState.latestExport).toBeNull()
      expect(initialState.artifactAvailable).toBe(false)
      expect(initialState.drifted).toBe(true)
      expect(initialState.coverage.eligible).toBe(2) // alpha and beta
      expect(initialState.coverage.excluded.length).toBe(2) // gamma (PRIVATE) and delta (INCOMPATIBLE)
      expect(initialState.coverage.awaitingZip).toBe(2)

      const receipt = await service.prepareExport()
      expect(receipt.skillCount).toBe(2)
      expect(receipt.skills.map((s) => s.name)).toEqual(['alpha-skill', 'beta-skill'])
      expect(existsSync(receipt.artifactPath)).toBe(true)
      expect(existsSync(service.receiptPath)).toBe(true)

      const afterState = service.getState()
      expect(afterState.latestExport).not.toBeNull()
      expect(afterState.artifactAvailable).toBe(true)
      expect(afterState.drifted).toBe(false)
      expect(afterState.coverage.awaitingZip).toBe(0)

      const diskReceipt = JSON.parse(readFileSync(service.receiptPath, 'utf8'))
      expect(diskReceipt.exportId).toBe(receipt.exportId)
      expect(diskReceipt.artifactHash).toBe(receipt.artifactHash)
    })

    it('detects drift when eligible skills are updated', async () => {
      const service = new AcademyGeminiExportService(store, dbPath)

      const skill = store.create({
        package: makePackage('evolving-skill', 'Initial version'),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      store.approvePublicSkill(skill.id, skill.currentVersion)

      await service.prepareExport()
      expect(service.getState().drifted).toBe(false)

      store.update({
        skillId: skill.id,
        expectedVersion: skill.currentVersion,
        package: makePackage('evolving-skill', 'Updated version 2'),
        origin: 'UI'
      })

      const stateAfterUpdate = service.getState()
      expect(stateAfterUpdate.drifted).toBe(true)
      expect(stateAfterUpdate.coverage.awaitingZip).toBe(1)
    })

    it('supports sequential regeneration after skills change', async () => {
      const service = new AcademyGeminiExportService(store, dbPath, downloadsDir)

      const skill = store.create({
        package: makePackage('evolving-skill', 'Initial version 1', {
          'notes.md': '# Notes V1'
        }),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      store.approvePublicSkill(skill.id, skill.currentVersion)

      const receipt1 = await service.prepareExport()
      expect(receipt1.skillCount).toBe(1)
      expect(service.getState().drifted).toBe(false)

      // Update skill with modified content
      store.update({
        skillId: skill.id,
        expectedVersion: skill.currentVersion,
        package: makePackage('evolving-skill', 'Updated version 2', {
          'notes.md': '# Notes V2 updated'
        }),
        origin: 'UI'
      })

      const driftedState = service.getState()
      expect(driftedState.drifted).toBe(true)
      expect(driftedState.coverage.awaitingZip).toBe(1)

      // Sequential regeneration
      const receipt2 = await service.prepareExport()
      expect(receipt2.skillCount).toBe(1)
      expect(receipt2.snapshotHash).not.toBe(receipt1.snapshotHash)
      expect(receipt2.artifactHash).not.toBe(receipt1.artifactHash)

      const settledState = service.getState()
      expect(settledState.drifted).toBe(false)
      expect(settledState.coverage.awaitingZip).toBe(0)

      // Verify that master zip on disk contains updated content
      const masterEntries = readZipEntries(readFileSync(receipt2.artifactPath))
      const innerZipEntry = masterEntries.find((e) => e.path === 'evolving-skill.zip')
      expect(innerZipEntry).toBeDefined()
      const innerEntries = readZipEntries(innerZipEntry!.data)
      const notesEntry = innerEntries.find((e) => e.path === 'notes.md')
      expect(notesEntry).toBeDefined()
      expect(notesEntry!.data.toString('utf8')).toContain('Notes V2 updated')
    })

    it('joins concurrent prepareExport flights', async () => {
      const service = new AcademyGeminiExportService(store, dbPath)

      const skill = store.create({
        package: makePackage('flight-skill', 'Flight test'),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      store.approvePublicSkill(skill.id, skill.currentVersion)

      const [r1, r2] = await Promise.all([service.prepareExport(), service.prepareExport()])
      expect(r1.exportId).toBe(r2.exportId)
      expect(r1.artifactHash).toBe(r2.artifactHash)
    })

    it('offloads compression and writing to worker thread via AcademyPluginExecutor when available', async () => {
      const workerPath = join(tempDir, 'gemini-worker.cjs')
      buildSync({
        entryPoints: ['src/main/academy/publication/academy-plugin-worker.ts'],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: workerPath
      })

      const executor = new AcademyPluginExecutor(workerPath)
      expect(executor.hasWorker()).toBe(true)

      const service = new AcademyGeminiExportService(store, dbPath, downloadsDir, executor)

      const skill = store.create({
        package: makePackage('worker-tested-skill', 'Tested with worker thread', {
          'code.ts': 'export const workerTest = true'
        }),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      store.approvePublicSkill(skill.id, skill.currentVersion)

      const receipt = await service.prepareExport()
      expect(receipt.skillCount).toBe(1)
      expect(existsSync(receipt.artifactPath)).toBe(true)
      expect(existsSync(join(downloadsDir, 'academy-gemini.zip'))).toBe(true)

      const masterEntries = readZipEntries(readFileSync(receipt.artifactPath))
      expect(masterEntries.map((e) => e.path)).toEqual(['worker-tested-skill.zip'])
    })

    it('manages flight rejection cleanly without unhandled rejection and recovers on retry', async () => {
      const service = new AcademyGeminiExportService(store, dbPath, downloadsDir)

      const skill = store.create({
        package: makePackage('resilient-skill', 'Tests failure and recovery'),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      store.approvePublicSkill(skill.id, skill.currentVersion)

      const unhandledRejections: unknown[] = []
      const onUnhandled = (reason: unknown) => {
        unhandledRejections.push(reason)
      }
      process.on('unhandledRejection', onUnhandled)

      try {
        // 1. Success validation
        const receipt1 = await service.prepareExport()
        expect(receipt1.skillCount).toBe(1)
        expect(service.getState().lastError).toBeNull()

        // 2. Failure validation: simulated failure during staging phase
        await expect(service.prepareExport({ _failStage: 'stage-receipt' })).rejects.toThrow('SIMULATED_STAGE_RECEIPT_FAILURE')

        // Allow microtasks to complete to detect any stray unhandled rejection
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(unhandledRejections).toHaveLength(0)

        // Error registered in state, but latestExport remains intact
        const stateAfterFail = service.getState()
        expect(stateAfterFail.lastError).toContain('SIMULATED_STAGE_RECEIPT_FAILURE')
        expect(stateAfterFail.latestExport?.exportId).toBe(receipt1.exportId)

        // 3. Recovery validation: consecutive call succeeds and clears lastError
        const receiptRecovered = await service.prepareExport()
        expect(receiptRecovered.skillCount).toBe(1)
        expect(service.getState().lastError).toBeNull()
        expect(unhandledRejections).toHaveLength(0)
      } finally {
        process.removeListener('unhandledRejection', onUnhandled)
      }
    })

    it('preserves previous valid export on intermediate write and promotion failures', async () => {
      const service = new AcademyGeminiExportService(store, dbPath, downloadsDir)

      const skill = store.create({
        package: makePackage('preserved-skill', 'Version 1 baseline content'),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      store.approvePublicSkill(skill.id, skill.currentVersion)

      // 1. Establish initial valid export
      const initialReceipt = await service.prepareExport()
      const initialZipBytes = readFileSync(initialReceipt.artifactPath)
      const initialReceiptBytes = readFileSync(service.receiptPath)

      // 2. Update skill in store so a new export will be generated
      store.update({
        skillId: skill.id,
        expectedVersion: skill.currentVersion,
        package: makePackage('preserved-skill', 'Version 2 updated content'),
        origin: 'UI'
      })

      // 3. Simulate failure at staging phase
      await expect(service.prepareExport({ _failStage: 'stage-receipt' })).rejects.toThrow('SIMULATED_STAGE_RECEIPT_FAILURE')

      // Verify previous valid zip and receipt are 100% UNTOUCHED
      expect(readFileSync(initialReceipt.artifactPath)).toEqual(initialZipBytes)
      expect(readFileSync(service.receiptPath)).toEqual(initialReceiptBytes)
      expect(service.getState().latestExport?.exportId).toBe(initialReceipt.exportId)
      expect(service.getState().artifactAvailable).toBe(true)

      // 4. Simulate failure at promotion phase (after backup created)
      await expect(service.prepareExport({ _failStage: 'promote' })).rejects.toThrow('SIMULATED_PROMOTE_FAILURE')

      // Verify rollback restored the previous valid zip and receipt
      expect(readFileSync(initialReceipt.artifactPath)).toEqual(initialZipBytes)
      expect(readFileSync(service.receiptPath)).toEqual(initialReceiptBytes)
      expect(service.getState().latestExport?.exportId).toBe(initialReceipt.exportId)
      expect(service.getState().artifactAvailable).toBe(true)

      // 5. Recovery: normal export succeeds and cleanly replaces artifact
      const recoveredReceipt = await service.prepareExport()
      expect(recoveredReceipt.snapshotHash).not.toBe(initialReceipt.snapshotHash)
      expect(recoveredReceipt.artifactHash).not.toBe(initialReceipt.artifactHash)
      expect(service.getState().lastError).toBeNull()
      expect(service.getState().drifted).toBe(false)

      // Content inside updated master zip reflects Version 2
      const masterEntries = readZipEntries(readFileSync(recoveredReceipt.artifactPath))
      const innerZip = masterEntries.find((e) => e.path === 'preserved-skill.zip')
      expect(innerZip).toBeDefined()
      const innerEntries = readZipEntries(innerZip!.data)
      const skillMd = innerEntries.find((e) => e.path === 'SKILL.md')
      expect(skillMd!.data.toString('utf8')).toContain('Version 2 updated content')
    })
  })
})
