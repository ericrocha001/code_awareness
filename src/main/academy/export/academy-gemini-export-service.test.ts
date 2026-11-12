import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

    it('rejects skill with incompatible artifact extensions like .ts or .py', () => {
      const skill = store.create({
        package: makePackage('python-helper', 'Helper with script', {
          'scripts/run.py': 'print("hello")'
        }),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      const result = validateGeminiSkill(skill)
      expect(result.valid).toBe(false)
      expect(result.details).toContain('.py')
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

      // verify that unpacking skill-alpha.zip yields SKILL.md at its root
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
        package: makePackage('delta-script', 'Delta with py', { 'test.py': 'pass' }),
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

      // Verify receipt on disk matches
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
  })
})
