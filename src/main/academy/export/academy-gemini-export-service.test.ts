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
  buildGeminiCoverage,
  adaptGeminiPackage,
  preflightGeminiPackage,
  generateMarkdownFence,
  formatAdaptedReferenceMarkdown,
  GEMINI_ADAPTATION_PROFILE_VERSION
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

    it('approves native shell scripts (.sh), python (.py), and javascript (.js)', () => {
      const skill = store.create({
        package: makePackage('script-runner', 'Helper with native scripts', {
          'scripts/run.sh': '#!/bin/bash\necho hi',
          'scripts/calc.py': 'print("hello")',
          'scripts/main.js': 'console.log("js")'
        }),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      const result = validateGeminiSkill(skill)
      expect(result.valid).toBe(true)
    })

    it('rejects skill with non-convertible binary files like .exe or .bin', () => {
      const skill = store.create({
        package: makePackage('binary-helper', 'Helper with binary', {
          'bin/run.exe': 'fake-exe-bytes'
        }),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      const result = validateGeminiSkill(skill)
      expect(result.valid).toBe(false)
      expect(result.details).toContain('.exe')
      expect(result.details).toContain('binário ou não conversível')
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
        package: makePackage('incompatible-tool', 'Tool with binary executable', {
          'run.exe': 'fake-binary-bytes'
        }),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      store.approvePublicSkill(incompatibleSkill.id, incompatibleSkill.currentVersion)
      expect(geminiInclusion(store, incompatibleSkill).status).toBe('EXCLUDED')
      expect(geminiInclusion(store, incompatibleSkill).reason).toBe('INCOMPATIBLE')
    })
  })

  describe('Non-Destructive In-Memory Script Adaptation', () => {
    it('guarantees absolute canonical immutability: store is never altered by export', async () => {
      const canonicalPackage = makePackage('immutable-skill', 'Skill that must not be altered', {
        'scripts/worker.ts': 'export const run = () => true;',
        'scripts/query.sql': 'SELECT * FROM users;'
      })
      const skill = store.create({
        package: canonicalPackage,
        scope: 'GLOBAL',
        origin: 'UI'
      })
      store.approvePublicSkill(skill.id, skill.currentVersion)

      const detailBefore = store.get(skill.id)
      const packageHashBefore = detailBefore.current.packageHash
      const skillMdBefore = detailBefore.current.package.skillMd
      const artifactsBefore = { ...detailBefore.current.package.artifacts }

      // Perform full export
      const service = new AcademyGeminiExportService(store, dbPath)
      const receipt = await service.prepareExport()

      // Verify receipt shows 1 skill exported, 1 adapted
      expect(receipt.skillCount).toBe(1)
      expect(receipt.convertedCount).toBe(1)
      expect(receipt.skills[0].adaptedFiles).toHaveLength(2)

      // Verify canonical store state is 100% byte-for-byte identical
      const detailAfter = store.get(skill.id)
      expect(detailAfter.current.packageHash).toBe(packageHashBefore)
      expect(detailAfter.currentVersion).toBe(detailBefore.currentVersion)
      expect(detailAfter.current.package.skillMd).toBe(skillMdBefore)
      expect(detailAfter.current.package.artifacts).toEqual(artifactsBefore)
    })

    it('adapts .ts, .sql, and .cjs into Markdown references under references/ with warnings and fences', () => {
      const canonical = makePackage('multi-script-skill', 'Skill with scripts', {
        'scripts/build.cjs': 'const x = require("fs");',
        'src/handler.ts': 'export function handle() { return 42; }',
        'db/schema.sql': 'CREATE TABLE test (id INT);'
      })
      canonical.skillMd = `---\nname: multi-script-skill\n---\n\n# Multi Script\n\nExecute [build script](scripts/build.cjs) or [handler](./src/handler.ts).`

      const adaptation = adaptGeminiPackage(canonical)
      expect(adaptation.rejectionReason).toBeUndefined()
      expect(adaptation.adaptedFiles).toHaveLength(3)

      const adaptedPaths = Object.keys(adaptation.package.artifacts).sort()
      expect(adaptedPaths).toEqual([
        'references/db/schema.sql.md',
        'references/scripts/build.cjs.md',
        'references/src/handler.ts.md'
      ])

      // Original scripts are not in derived artifacts
      expect(adaptation.package.artifacts['scripts/build.cjs']).toBeUndefined()
      expect(adaptation.package.artifacts['src/handler.ts']).toBeUndefined()
      expect(adaptation.package.artifacts['db/schema.sql']).toBeUndefined()

      // Derived markdown content has execution warning and language
      const buildMd = adaptation.package.artifacts['references/scripts/build.cjs.md']
      expect(buildMd).toContain('# Referência: scripts/build.cjs')
      expect(buildMd).toContain('Aviso de Compatibilidade Gemini')
      expect(buildMd).toContain('não é executável')
      expect(buildMd).toContain('const x = require("fs");')

      // Derived SKILL.md has updated links and compatibility notes
      expect(adaptation.package.skillMd).toContain('[build script](references/scripts/build.cjs.md)')
      expect(adaptation.package.skillMd).toContain('[handler](references/src/handler.ts.md)')
      expect(adaptation.package.skillMd).toContain('## Compatibilidade Gemini — Scripts Adaptados')

      // Canonical package was not modified in-place
      expect(canonical.skillMd).toContain('scripts/build.cjs')
      expect(canonical.artifacts['scripts/build.cjs']).toBeDefined()
    })

    it('generates resilient Markdown fences when source code contains internal backticks', () => {
      const codeWithTripleBackticks = `
const template = \`\`\`
hello world
\`\`\`;
console.log(template);
`
      const fence = generateMarkdownFence(codeWithTripleBackticks)
      expect(fence.length).toBeGreaterThanOrEqual(4)

      const formatted = formatAdaptedReferenceMarkdown('scripts/test.ts', codeWithTripleBackticks, 'typescript')
      expect(formatted).toContain(fence)
      expect(formatted.endsWith(`${fence}\n`)).toBe(true)
    })

    it('detects and rejects collisions with existing files', () => {
      const collisionPackage = makePackage('colliding-skill', 'Colliding paths', {
        'scripts/tool.ts': 'export const a = 1;',
        'references/scripts/tool.ts.md': '# Existing file'
      })
      const adaptation = adaptGeminiPackage(collisionPackage)
      expect(adaptation.rejectionReason).toBeDefined()
      expect(adaptation.rejectionReason).toContain('Colisão de caminho')
    })

    it('detects case-insensitive collisions between original files', () => {
      const collisionPackage = makePackage('case-collision', 'Colliding case', {
        'scripts/runner.js': 'console.log(1);',
        'scripts/RUNNER.JS': 'console.log(2);'
      })
      const adaptation = adaptGeminiPackage(collisionPackage)
      expect(adaptation.rejectionReason).toBeDefined()
      expect(adaptation.rejectionReason).toContain('Colisão de caminho')
    })

    it('detects case-insensitive collision with SKILL.md', () => {
      const collisionPackage = makePackage('skill-collision', 'Colliding skill.md', {
        'skill.md': '# Overwrite attempt'
      })
      const adaptation = adaptGeminiPackage(collisionPackage)
      expect(adaptation.rejectionReason).toBeDefined()
      expect(adaptation.rejectionReason).toContain("Artefato não pode sobrescrever 'SKILL.md'")
    })

    it('detects case-insensitive collisions between adapted script and original Markdown', () => {
      // 1. Script then Markdown with differing case
      const collision1 = makePackage('case-collision-1', 'Test', {
        'scripts/Tool.ts': 'export const a = 1;',
        'references/scripts/tool.ts.md': '# Existing lowercase'
      })
      const adaptation1 = adaptGeminiPackage(collision1)
      expect(adaptation1.rejectionReason).toBeDefined()
      expect(adaptation1.rejectionReason).toContain('Colisão de caminho')

      // 2. Markdown first then Script with differing case
      const collision2 = makePackage('case-collision-2', 'Test', {
        'references/scripts/TOOL.ts.md': '# Existing uppercase',
        'scripts/tool.ts': 'export const a = 1;'
      })
      const adaptation2 = adaptGeminiPackage(collision2)
      expect(adaptation2.rejectionReason).toBeDefined()
      expect(adaptation2.rejectionReason).toContain('Colisão de caminho')
    })

    it('detects case-insensitive collisions between two adapted scripts', () => {
      const collisionPackage = makePackage('script-collision', 'Colliding script targets', {
        'src/Worker.ts': 'export const a = 1;',
        'src/worker.ts': 'export const b = 2;'
      })
      const adaptation = adaptGeminiPackage(collisionPackage)
      expect(adaptation.rejectionReason).toBeDefined()
      expect(adaptation.rejectionReason).toContain('Colisão de caminho')
    })

    it('preflightGeminiPackage performs lightweight validation without string allocations', () => {
      const canonical = makePackage('preflight-skill', 'Preflight check', {
        'src/handler.ts': 'export const h = 1;',
        'assets/info.txt': 'info text',
        'run.sh': '#!/bin/sh\necho hi'
      })

      const preflight = preflightGeminiPackage(canonical)
      expect(preflight.valid).toBe(true)
      expect(preflight.adaptedFileCount).toBe(1)
      expect(preflight.totalBytes).toBeGreaterThan(0)
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
        package: makePackage('delta-binary', 'Delta with exe', { 'test.exe': 'binary-payload' }),
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

    it('detects drift when receipt has a different profile version', async () => {
      const service = new AcademyGeminiExportService(store, dbPath, downloadsDir)

      const skill = store.create({
        package: makePackage('versioned-skill', 'Test profile versioning'),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      store.approvePublicSkill(skill.id, skill.currentVersion)

      const receipt = await service.prepareExport()
      expect(receipt.profileVersion).toBe(GEMINI_ADAPTATION_PROFILE_VERSION)
      expect(service.getState().drifted).toBe(false)

      // Manually tamper the disk receipt to simulate legacy receipt from before adaptation
      const diskReceipt = JSON.parse(readFileSync(service.receiptPath, 'utf8'))
      diskReceipt.profileVersion = 'v0-legacy'
      const { writeFile } = await import('node:fs/promises')
      await writeFile(service.receiptPath, JSON.stringify(diskReceipt, null, 2))

      // New service instance loading the legacy receipt
      const serviceLegacy = new AcademyGeminiExportService(store, dbPath, downloadsDir)
      const legacyState = serviceLegacy.getState()
      expect(legacyState.drifted).toBe(true)
      expect(legacyState.coverage.awaitingZip).toBe(1)
    })

    it('calculates state and coverage quickly on the main thread without script conversion', () => {
      const service = new AcademyGeminiExportService(store, dbPath, downloadsDir)

      // Create skill with script that requires adaptation
      const skill1 = store.create({
        package: makePackage('script-skill', 'Skill with typescript', {
          'src/index.ts': 'export const run = () => true;',
          'docs/readme.md': '# Readme'
        }),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      store.approvePublicSkill(skill1.id, skill1.currentVersion)

      // Create skill with native files only
      const skill2 = store.create({
        package: makePackage('native-skill', 'Skill with native files', {
          'run.sh': '#!/bin/sh\necho ok',
          'docs/guide.txt': 'guidance'
        }),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      store.approvePublicSkill(skill2.id, skill2.currentVersion)

      // Create skill with incompatible binary (excluded)
      const skill3 = store.create({
        package: makePackage('binary-skill', 'Skill with binary', {
          'tool.exe': 'MZ-binary'
        }),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      store.approvePublicSkill(skill3.id, skill3.currentVersion)

      const state = service.getState()
      expect(state.coverage.eligible).toBe(2)
      expect(state.coverage.adaptedCount).toBe(1)
      expect(state.coverage.excluded.some((e) => e.name === 'binary-skill')).toBe(true)
      expect(state.coverage.awaitingZip).toBe(2)
      expect(state.drifted).toBe(true)
    })
  })
})
