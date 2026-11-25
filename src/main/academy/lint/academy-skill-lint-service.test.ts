import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../../continuum/agent-authority'
import { getCanonicalTokenizer, type TokenizerPort } from '../../core/tokenizer'
import { AcademyService } from '../academy-service'
import { executeAcademyTool } from '../academy-mcp'
import { AcademySkillLintService } from './academy-skill-lint-service'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('AcademySkillLintService & U1 opt-in list/history', () => {
  it('preserves legacy list and history without tokenizing or reading full packages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'academy-lint-u1-legacy-'))
    roots.push(root)
    const service = new AcademyService(join(root, 'academy.db'))
    try {
      const pkg = {
        skillMd: '---\nname: legacy-check\ndescription: Legacy description\n---\n# Body\nHello.\n',
        artifacts: { 'references/a.md': 'Ref A' }
      }
      const skill = await service.create({ package: pkg, scope: 'GLOBAL', origin: 'UI' })
      await service.update({
        skillId: skill.id,
        expectedVersion: 1,
        package: { ...pkg, skillMd: pkg.skillMd + '\nMore text\n' },
        origin: 'MCP'
      })

      const tokSpy = vi.spyOn(getCanonicalTokenizer(), 'count')
      const historySpy = vi.spyOn(service.store, 'history')

      const listRes = await executeAcademyTool(service, 'list_academy_skills', {})
      expect(listRes.isError).toBeUndefined()
      expect(Array.isArray(JSON.parse(listRes.content[0].text))).toBe(true)
      expect(tokSpy).not.toHaveBeenCalled()

      const histRes = await executeAcademyTool(service, 'get_academy_skill_history', {
        skillId: skill.id,
        metadataOnly: true
      })
      expect(histRes.isError).toBeUndefined()
      expect(tokSpy).not.toHaveBeenCalled()
      expect(historySpy).toHaveBeenCalledWith(skill.id, { metadataOnly: true })
    } finally {
      vi.restoreAllMocks()
      await service.close()
    }
  })

  it('computes opt-in paged list/history efficiency with predecessor outside page, cache hit, tombstone, and tokenizer change', async () => {
    const root = mkdtempSync(join(tmpdir(), 'academy-lint-u1-eff-'))
    roots.push(root)
    const service = new AcademyService(join(root, 'academy.db'))
    try {
      const v1 = {
        skillMd: '---\nname: eff-skill\ndescription: Short desc\n---\n# v1\nAlpha beta\n',
        artifacts: {}
      }
      const v2 = {
        skillMd: '---\nname: eff-skill\ndescription: Short desc\n---\n# v2\nAlpha beta gamma delta\n',
        artifacts: { 'references/extra.md': 'Extra content' }
      }
      const created = await service.create({ package: v1, scope: 'GLOBAL', origin: 'UI' })
      await service.update({ skillId: created.id, expectedVersion: 1, package: v2, origin: 'MCP' })

      // Opt-in history page 1 (limit 1 -> only v2 on page, but delta uses v1 outside page)
      const histPage1Res = await executeAcademyTool(service, 'get_academy_skill_history', {
        skillId: created.id,
        metadataOnly: true,
        includeEfficiency: true,
        limit: 1
      })
      expect(histPage1Res.isError).toBeUndefined()
      const histPage1 = JSON.parse(histPage1Res.content[0].text)
      expect(histPage1.items).toHaveLength(1)
      expect(histPage1.items[0].version).toBe(2)
      expect(histPage1.items[0].efficiency.delta.predecessorVersion).toBe(1)
      expect(histPage1.items[0].efficiency.delta.comparable).toBe(true)
      expect(histPage1.items[0].efficiency.delta.packageTokensDelta).toBeGreaterThan(0)
      expect(histPage1.nextCursor).toBeTruthy()

      const histPage2Res = await executeAcademyTool(service, 'get_academy_skill_history', {
        skillId: created.id,
        metadataOnly: true,
        includeEfficiency: true,
        limit: 1,
        cursor: histPage1.nextCursor
      })
      const histPage2 = JSON.parse(histPage2Res.content[0].text)
      expect(histPage2.items).toHaveLength(1)
      expect(histPage2.items[0].version).toBe(1)
      expect(histPage2.items[0].efficiency.delta).toEqual({
        predecessorVersion: null,
        comparable: false,
        reason: 'INITIAL_VERSION'
      })

      // Cache hit check on second call: tokenizer should NOT be called again
      const tokSpy = vi.spyOn(getCanonicalTokenizer(), 'count')
      const listEff = await executeAcademyTool(service, 'list_academy_skills', {
        includeEfficiency: true,
        limit: 10
      })
      expect(listEff.isError).toBeUndefined()
      expect(tokSpy).not.toHaveBeenCalled()
      tokSpy.mockRestore()

      // Stale cursor detection after update
      await service.update({
        skillId: created.id,
        expectedVersion: 2,
        package: { ...v2, skillMd: v2.skillMd + '\nv3\n' },
        origin: 'MCP'
      })
      const staleRes = await executeAcademyTool(service, 'get_academy_skill_history', {
        skillId: created.id,
        metadataOnly: true,
        includeEfficiency: true,
        limit: 1,
        cursor: histPage1.nextCursor
      })
      expect(staleRes.isError).toBe(true)
      expect(JSON.parse(staleRes.content[0].text).error).toBe('LINT_CURSOR_STALE')

      // Fake tokenizer -> NOT_COMPARABLE against cached canonical facts, separate cache namespace
      const fakeTokenizer: TokenizerPort = {
        id: 'fake-tok@0.0.1',
        encoding: 'char-count',
        count: (text: string) => text.length
      }
      const fakeLint = new AcademySkillLintService(service.store, fakeTokenizer)
      const v2Canonical = service.lint.factsFor(created.id, 2).facts!
      const v3Fake = fakeLint.factsFor(created.id, 3).facts!
      expect(v3Fake.tokenizerId).toBe('fake-tok@0.0.1')
      expect(v2Canonical.tokenizerId).toBe(getCanonicalTokenizer().id)

      // Tombstone -> UNAVAILABLE without invented numbers
      service.store.acceptGitSnapshots(
        [
          {
            schema: 1,
            repositoryId: 'repo-1',
            remoteUrl: 'https://example.com/repo.git',
            branch: 'main',
            sourceCommitSha: 'commit-1',
            firstParentSha: null,
            managedTreeHash: 'tree-1',
            authoredFiles: {},
            observedAt: '2026-11-25T00:00:00Z',
            skills: [
              {
                path: 'skills/eff-skill',
                name: 'eff-skill',
                package: { ...v2, skillMd: v2.skillMd + '\nv3\n' },
                packageHash: service.get(created.id).current.packageHash
              }
            ]
          }
        ],
        null
      )
      service.store.enableLocalAuthority('commit-1')
      service.store.deleteGlobalSkill(created.id, 3)

      const deletedFacts = service.lint.factsFor(created.id, 4)
      expect(deletedFacts.coverage).toBe('UNAVAILABLE')
      expect(deletedFacts.facts).toBeNull()
    } finally {
      await service.close()
    }
  })

  it('supports U2 focal/catalog lint reports, authenticated review lifecycle, HIGH priority pinning, stagnation, and recurrence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'academy-lint-u2-'))
    roots.push(root)
    const service = new AcademyService(join(root, 'academy.db'))
    const principal = authenticatedAgentPrincipal('MCP', () => true)
    const authority = authorizeArtifactAgent(principal, 'repo-1', () => true)
    try {
      const makePkg = (bodyExtra: string, refExtra = '') => ({
        skillMd: [
          '---',
          'name: u2-skill',
          'description: ' + 'Trigger activation keyword phrase '.repeat(35) + 'end',
          '---',
          '# Main',
          '[broken](references/missing.md)',
          bodyExtra
        ].join('\n'),
        artifacts: {
          'scripts/old.sh': '#!/bin/sh\necho old\n',
          ...(refExtra ? { 'references/other.md': refExtra } : {})
        }
      })

      const s = await service.create({ package: makePkg('v1'), scope: 'GLOBAL', origin: 'MCP' })
      // v2 edits SKILL.md without fixing metadata or broken ref, and adds a new script -> HIGH priority capability + unchanged transitions
      await service.update({
        skillId: s.id,
        expectedVersion: 1,
        package: {
          ...makePkg('v2'),
          artifacts: {
            'scripts/old.sh': '#!/bin/sh\necho old\n',
            'scripts/new.py': 'print(1)\n'
          }
        },
        origin: 'MCP'
      })
      // v3 edits SKILL.md again without fixing metadata -> 2nd consecutive unchanged transition -> stagnationNotice
      await service.update({
        skillId: s.id,
        expectedVersion: 2,
        package: {
          ...makePkg('v3'),
          artifacts: {
            'scripts/old.sh': '#!/bin/sh\necho old\n',
            'scripts/new.py': 'print(1)\n'
          }
        },
        origin: 'MCP'
      })
      // v4 edits ONLY unrelated reference file -> skipped for SKILL.md findings, series NOT broken
      await service.update({
        skillId: s.id,
        expectedVersion: 3,
        package: {
          ...makePkg('v3', 'unrelated note'),
          artifacts: {
            'scripts/old.sh': '#!/bin/sh\necho old\n',
            'scripts/new.py': 'print(1)\n',
            'references/other.md': 'unrelated note'
          }
        },
        origin: 'MCP'
      })

      // Focal report with limit 1 still keeps HIGH findings visible on page 0 when present (test on v2 where new.py was added)
      const v2RepRes = await executeAcademyTool(service, 'get_academy_skill_lint', {
        skillId: s.id,
        version: 2,
        limit: 1,
        includeInventory: true
      })
      const v2Rep = JSON.parse(v2RepRes.content[0].text)
      expect(v2Rep.findings[0].ruleId).toBe('CAPABILITY_SURFACE_CHANGE')
      expect(v2Rep.findings[0].priority).toBe('HIGH')
      expect(v2Rep.counts.total).toBeGreaterThan(1)
      expect(v2Rep.inventory.scripts.map((x: { path: string }) => x.path)).toEqual([
        'scripts/new.py',
        'scripts/old.sh'
      ])

      // Focal report on v4 shows stagnationNotice for SKILL.md findings even after unrelated v4 edit
      const v4RepRes = await executeAcademyTool(service, 'get_academy_skill_lint', { skillId: s.id })
      const v4Rep = JSON.parse(v4RepRes.content[0].text)
      expect(v4Rep.lintHealth).toBe('REVIEW_OPEN')
      expect(v4Rep.stagnationNotice).toBeDefined()
      expect(v4Rep.stagnationNotice.message).toContain('Do not repeat the same strategy')

      // Unauthenticated review is rejected
      const metaFinding = v4Rep.findings.find((f: { ruleId: string }) => f.ruleId === 'METADATA_REVIEW')
      const unauth = await executeAcademyTool(service, 'review_academy_skill_lint', {
        skillId: s.id,
        expectedVersion: 4,
        findingId: metaFinding.findingId,
        evidenceFingerprint: metaFinding.evidenceFingerprint,
        action: 'RECORD',
        rationale: 'Keep descriptive triggers'
      })
      expect(unauth.isError).toBe(true)
      expect(JSON.parse(unauth.content[0].text).error).toBe('AUTHENTICATION_REQUIRED')

      // Authenticated review records all open REVIEWs -> REVIEWED without changing skill version
      for (const f of v4Rep.findings.filter((x: { category: string }) => x.category === 'REVIEW')) {
        const rec = await executeAcademyTool(
          service,
          'review_academy_skill_lint',
          {
            skillId: s.id,
            expectedVersion: 4,
            findingId: f.findingId,
            evidenceFingerprint: f.evidenceFingerprint,
            action: 'RECORD',
            rationale: 'Reviewed explicitly'
          },
          { authority }
        )
        expect(rec.isError).toBeUndefined()
      }
      expect(service.get(s.id).currentVersion).toBe(4)

      const reviewedRep = JSON.parse(
        (await executeAcademyTool(service, 'get_academy_skill_lint', { skillId: s.id })).content[0].text
      )
      expect(reviewedRep.lintHealth).toBe('REVIEWED')

      // Catalog mode analyzes page only and exposes catalogPressure
      const catRes = await executeAcademyTool(service, 'get_academy_skill_lint', { limit: 10 })
      const cat = JSON.parse(catRes.content[0].text)
      expect(cat.pageAnalyzed).toBe(1)
      expect(cat.items[0].lintHealth).toBe('REVIEWED')
      expect(cat.catalogPressure.ruleId).toBe('CATALOG_PRESSURE')

      // Recurrence cycle A -> B -> A detected (v2 -> v3 -> v2)
      const v2Pkg = service.history(s.id, { version: 2 }).package
      await service.update({ skillId: s.id, expectedVersion: 4, package: v2Pkg, origin: 'MCP' })
      const v5Rep = JSON.parse(
        (await executeAcademyTool(service, 'get_academy_skill_lint', { skillId: s.id })).content[0].text
      )
      expect(v5Rep.recurrence).toMatchObject({ state: 'CYCLE_DETECTED', matchedVersion: 2 })
    } finally {
      await service.close()
    }
  })
})
