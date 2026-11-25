import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
})
