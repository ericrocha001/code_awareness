import { textContent } from '../mcp/mcp-test-content'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcademyService } from './academy-service'
import { ACADEMY_MCP_TOOLS, executeAcademyTool } from './academy-mcp'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { hashAcademyPackage } from './academy-package'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('Academy MCP administration', () => {
  it('selects history depth without changing legacy results or accepting contradictory/unsafe selectors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'academy-mcp-history-')); roots.push(root)
    const service = new AcademyService(join(root, 'academy.db'))
    try {
      const first = { skillMd: '---\nname: history\ndescription: Literal historical package\n---\nç 漢字 ` ${x} $(cmd)\r\n', artifacts: { 'scripts/literal.sh': 'do not execute' } }
      const skill = service.store.create({ package: first, scope: 'GLOBAL', origin: 'UI' })
      service.store.update({ skillId: skill.id, expectedVersion: 1, package: { ...first, skillMd: first.skillMd + 'second' }, origin: 'MCP' })
      const before = service.history(skill.id), snapshot = service.snapshot()
      const history = vi.spyOn(service.store, 'history'), distribution = vi.spyOn(service, 'scheduleReconciliationForSkill')
      const invoke = (args: object) => executeAcademyTool(service, 'get_academy_skill_history', args)
      const full = await invoke({ skillId: skill.id })
      expect(JSON.parse(full.content[0].text)).toEqual(before)
      const metadata = await invoke({ skillId: skill.id, metadataOnly: true })
      expect(JSON.parse(metadata.content[0].text)).toEqual(before.map(({ package: _, ...rest }) => rest))
      expect(history).toHaveBeenLastCalledWith(skill.id, { metadataOnly: true })
      const selected = await invoke({ skillId: skill.id, version: 1 })
      expect(JSON.parse(selected.content[0].text)).toEqual(skill.current)
      expect(history).toHaveBeenLastCalledWith(skill.id, { version: 1 })
      expect(JSON.parse((await invoke({ skillId: skill.id, metadataOnly: false })).content[0].text)).toEqual(before)
      for (const options of [{ version: 0 }, { version: -1 }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 }, { version: '1' }, { version: null }, { version: 1, metadataOnly: true }, { version: 1, metadataOnly: false }, { metadataOnly: 'true' }, { unknown: true }]) {
        const result = await invoke({ skillId: skill.id, ...options })
        expect(result.isError).toBe(true)
        expect(JSON.parse(result.content[0].text).error).toBe('INVALID_ARGUMENT')
      }
      expect(JSON.parse((await invoke({ skillId: skill.id, version: 3 })).content[0].text).error).toBe('VERSION_NOT_FOUND')
      expect(JSON.parse((await invoke({ skillId: 'absent', version: 1 })).content[0].text).error).toBe('SKILL_NOT_FOUND')
      expect(service.snapshot()).toEqual(snapshot)
      expect(service.history(skill.id)).toEqual(before)
      expect(distribution).not.toHaveBeenCalled()
      service.store.archive(skill.id, 2)
      expect(JSON.parse((await invoke({ skillId: skill.id, version: 1 })).content[0].text)).toEqual(skill.current)
      expect(ACADEMY_MCP_TOOLS.find(t => t.name === 'get_academy_skill_history')!.description).toContain('metadataOnly:true')
      history.mockRestore(); distribution.mockRestore()
    } finally { await service.close() }
  })
  it('requires a confirmed review and preserves exact reconciled-content inspection through MCP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'academy-mcp-review-')); roots.push(root)
    const service = new AcademyService(join(root, 'academy.db'))
    const pkg = (body: string) => ({ skillMd: `---\nname: reviewed\ndescription: Reviewed package\n---\n${body}\n`, artifacts: {} })
    try {
      const skill = service.store.create({ package: pkg('canonical'), scope: 'GLOBAL', origin: 'UI' })
      const conflict = service.store.createConflict(skill.id, 'IMPORT', 1, pkg('external'), hashAcademyPackage(pkg('external')), null, null)
      const listed = await executeAcademyTool(service, 'list_academy_conflicts', {})
      expect(listed.content[0].text).not.toContain('skillMd')
      expect((await executeAcademyTool(service, 'resolve_academy_conflict', { conflictId: conflict.id, resolution: 'DIVERGENT' })).isError).toBe(true)
      const reviewed = await executeAcademyTool(service, 'review_academy_conflict', { conflictId: conflict.id, reconciledPackage: pkg('merged') })
      const review = JSON.parse(reviewed.content[0].text)
      expect(review.diff).toContain('+merged')
      const adopted = await executeAcademyTool(service, 'resolve_academy_conflict', { conflictId: conflict.id, resolution: 'DIVERGENT', reconciledPackage: pkg('merged'), token: review.token, confirmed: true })
      expect(adopted.isError).toBeUndefined()
      expect(service.get(skill.id).current.package).toEqual(pkg('merged'))
      expect(service.history(skill.id)).toHaveLength(2)
    } finally { service.close() }
  })
  it('publishes the bounded administration catalog and enforces expectedVersion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'academy-mcp-')); roots.push(root)
    const service = new AcademyService(join(root, 'academy.db'))
    expect(ACADEMY_MCP_TOOLS.map((item) => item.name)).toContain('update_academy_skill')
    expect(ACADEMY_MCP_TOOLS.map((item) => item.name)).toEqual(expect.arrayContaining([
      'get_openai_plugin_publication', 'prepare_openai_plugin_release', 'get_openai_plugin_release', 'confirm_openai_plugin_upload', 'get_academy_skill_delivery_status'
    ]))
    const packageValue = { skillMd: '---\nname: via-mcp\ndescription: MCP skill\n---\n# v1\n', artifacts: {} }
    const created = await executeAcademyTool(service, 'create_academy_skill', { package: packageValue, scope: 'GLOBAL' })
    expect(created.isError).toBeUndefined()
    const skill = JSON.parse(created.content[0].text)
    const stale = await executeAcademyTool(service, 'update_academy_skill', { skillId: skill.id, expectedVersion: 99, package: packageValue })
    expect(stale.isError).toBe(true)
    expect(JSON.parse(stale.content[0].text).error).toBe('VERSION_CONFLICT')
    const updated = await executeAcademyTool(service, 'update_academy_skill', { skillId: skill.id, expectedVersion: 1, package: { ...packageValue, skillMd: packageValue.skillMd.replace('# v1', '# v2') } })
    expect(JSON.parse(updated.content[0].text).current.origin).toBe('MCP')
    const delivery = await executeAcademyTool(service, 'get_academy_skill_delivery_status', { skillId: skill.id })
    expect(delivery.isError).toBeUndefined()
    expect(JSON.parse(delivery.content[0].text)).toMatchObject({ skillId: skill.id, version: 2, status: 'NOT_APPLICABLE' })
    const invalidDelivery = await executeAcademyTool(service, 'get_academy_skill_delivery_status', { skillId: skill.id, expectedVersion: 999 })
    expect(invalidDelivery.isError).toBe(true)
    expect(invalidDelivery.content[0].text).toContain('VERSION_NOT_FOUND')
    service.close()
  })

  it('is injected globally into the active MCP adapter without entering project context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'academy-mcp-adapter-')); roots.push(root)
    const service = new AcademyService(join(root, 'academy.db'))
    const navigation = {
      discoverRepository: async () => ({ entries: [] }), getRelationships: async () => ({ relationships: [] }),
      inspectFiles: async () => ({ files: [] }), readCode: async () => [], getReferences: async () => ({ references: [] }),
      getSymbolDependencies: async () => ({ dependencies: [] }), getSymbolHierarchy: async () => ({ relationships: [] })
    } as any
    const adapter = new ChannelMcpAdapter({ projectId: 'project', repoRoot: root, navigation }, undefined, undefined, undefined, service)
    expect(adapter.listTools().map((item) => item.name)).toContain('list_academy_skills')
    expect(adapter.listTools().map((item) => item.name)).toContain('prepare_openai_plugin_release')
    const listed = await adapter.callTool('list_academy_skills', {})
    expect(JSON.parse(textContent(listed.content[0]))).toEqual([])
    service.close()
  })

  it('enforces single-consent publication preference and batch CAS approval across MCP without exposing preference override', async () => {
    const root = mkdtempSync(join(tmpdir(), 'academy-mcp-pub-')); roots.push(root)
    const service = new AcademyService(join(root, 'academy.db'))
    try {
      const toolNames = ACADEMY_MCP_TOOLS.map((tool) => tool.name)
      expect(toolNames).not.toContain('set_academy_publication_preference')
      expect(toolNames).toContain('approve_academy_publications')

      const createdPrivate = JSON.parse(textContent((await executeAcademyTool(service, 'create_academy_skill', {
        package: { skillMd: '---\nname: mcp-priv\ndescription: Private\n---\n# Priv\n', artifacts: {} },
        scope: 'GLOBAL'
      })).content[0]))
      expect(createdPrivate.publication).toMatchObject({ included: false, reason: 'PRIVATE_NO_AUTHORIZATION', action: 'APPROVE_PUBLICATION' })

      expect(service.setPublicationPreference(true, true).autoIncludeGlobal).toBe(true)

      const createdAuto = JSON.parse(textContent((await executeAcademyTool(service, 'create_academy_skill', {
        package: { skillMd: '---\nname: mcp-auto\ndescription: Auto\n---\n# Auto\n', artifacts: {} },
        scope: 'GLOBAL'
      })).content[0]))
      expect(createdAuto.publication).toMatchObject({ included: true, reason: 'APPROVED_BY_PREFERENCE' })

      const createdKeepPrivate = JSON.parse(textContent((await executeAcademyTool(service, 'create_academy_skill', {
        package: { skillMd: '---\nname: mcp-keep\ndescription: Keep\n---\n# Keep\n', artifacts: {} },
        scope: 'GLOBAL',
        keepPrivate: true
      })).content[0]))
      expect(createdKeepPrivate.publication).toMatchObject({ included: false, reason: 'PRIVATE_BY_CHOICE', action: 'APPROVE_PUBLICATION' })

      const approved = JSON.parse(textContent((await executeAcademyTool(service, 'approve_academy_publications', {
        items: [
          { skillId: createdPrivate.id, expectedVersion: 1 },
          { skillId: createdKeepPrivate.id, expectedVersion: 1 }
        ],
        confirmed: true
      })).content[0]))
      expect(approved).toHaveLength(2)
      expect(approved.every((item: { publicationEligibility: string }) => item.publicationEligibility === 'APPROVED')).toBe(true)
    } finally { await service.close() }
  })

  it('exposes list_academy_changes across MCP dispatcher and global adapter without package bodies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'academy-mcp-changes-')); roots.push(root)
    const service = new AcademyService(join(root, 'academy.db'))
    try {
      const def = ACADEMY_MCP_TOOLS.find(t => t.name === 'list_academy_changes')
      expect(def).toBeDefined()
      expect(def!.inputSchema.additionalProperties).toBe(false)

      const first = { skillMd: '---\nname: change-alpha\ndescription: Change alpha\n---\nSECRET_BODY_ALPHA\n', artifacts: { 'references/ref.md': 'SECRET_REF_ALPHA' } }
      const skill = service.store.create({ package: first, scope: 'GLOBAL', origin: 'UI' })
      service.store.update({ skillId: skill.id, expectedVersion: 1, package: { ...first, skillMd: first.skillMd + 'v2' }, origin: 'MCP' })

      const adapter = ChannelMcpAdapter.createGlobalOnly(service)
      expect(adapter.listTools().map(t => t.name)).toContain('list_academy_changes')
      expect(adapter.capabilityForTool('list_academy_changes')).toBe('Academy')

      const res = await adapter.callTool('list_academy_changes', { limit: 1 })
      expect(res.isError).toBeUndefined()
      const payloadText = textContent(res.content[0])
      expect(payloadText).not.toContain('SECRET_BODY_ALPHA')
      expect(payloadText).not.toContain('SECRET_REF_ALPHA')
      const page1 = JSON.parse(payloadText)
      expect(page1.changes).toHaveLength(1)
      expect(page1.changes[0]).toMatchObject({ skillId: skill.id, skillName: 'change-alpha', version: 2, previousVersion: 1, origin: 'MCP' })
      expect(page1.nextCursor).toBeTruthy()

      const page2 = JSON.parse(textContent((await adapter.callTool('list_academy_changes', { cursor: page1.nextCursor })).content[0]))
      expect(page2.changes).toHaveLength(1)
      expect(page2.changes[0]).toMatchObject({ skillId: skill.id, version: 1, previousVersion: null, origin: 'UI' })
      expect(page2.nextCursor).toBeUndefined()

      for (const bad of [{ limit: 51 }, { extra: 1 }, { after: 'invalid-date' }, { cursor: 'bad-cursor' }]) {
        const err = await executeAcademyTool(service, 'list_academy_changes', bad)
        expect(err.isError).toBe(true)
        expect(JSON.parse(err.content[0].text).error).toBe('INVALID_ARGUMENT')
      }
    } finally { await service.close() }
  })

  it('supports composed list -> selective literal diff -> full history -> CAS rollback without catalog scans or side effects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'academy-mcp-diff-')); roots.push(root)
    const service = new AcademyService(join(root, 'academy.db'))
    try {
      const diffTool = ACADEMY_MCP_TOOLS.find(t => t.name === 'get_academy_change_diff')
      expect(diffTool).toBeDefined()
      expect(diffTool!.inputSchema.additionalProperties).toBe(false)
      expect(diffTool!.description).toContain('get_academy_skill_history')
      expect(diffTool!.description).toContain('analyze_academy_change_impact')

      const v1Pkg = {
        skillMd: '---\nname: change-flow\ndescription: Initial flow\n---\nLine 1\r\nLine 2 🧪\r\n',
        artifacts: { 'references/keep.md': 'unchanged', 'references/remove.md': 'bye' }
      }
      const v2Pkg = {
        skillMd: '---\nname: change-flow\ndescription: Updated flow\n---\nLine 1\r\nLine  2 🧪\r\nLine 3 𠀋\r\n',
        artifacts: { 'references/keep.md': 'unchanged', 'references/empty.md': '' }
      }
      const v3Pkg = {
        skillMd: '---\nname: change-flow\ndescription: Updated flow\n---\nLine 1\r\nLine  2  🧪\r\nLine 3 𠀋\r\n',
        artifacts: { 'references/keep.md': 'unchanged', 'references/empty.md': '' }
      }

      const skill = service.store.create({ package: v1Pkg, scope: 'GLOBAL', origin: 'UI' })
      service.store.create({ package: { skillMd: '---\nname: unrelated\ndescription: Mentions change-flow\n---\nchange-flow\n', artifacts: {} }, scope: 'GLOBAL', origin: 'IMPORT' })
      service.store.update({ skillId: skill.id, expectedVersion: 1, package: v2Pkg, origin: 'MCP' })
      service.store.update({ skillId: skill.id, expectedVersion: 2, package: v3Pkg, origin: 'MCP' })

      // Prepare local authority for tombstone + reintroduction transition with equal packageHash
      service.store.acceptGitSnapshots([{
        schema: 1, repositoryId: 'academy', remoteUrl: 'https://example.com/academy.git', branch: 'main',
        sourceCommitSha: 'commit-1', firstParentSha: null, managedTreeHash: 'tree-1', authoredFiles: {},
        observedAt: '2026-11-01T00:00:00Z',
        skills: [
          { path: 'skills/change-flow', name: 'change-flow', package: v3Pkg, packageHash: hashAcademyPackage(v3Pkg) },
          { path: 'skills/unrelated', name: 'unrelated', package: { skillMd: '---\nname: unrelated\ndescription: Mentions change-flow\n---\nchange-flow\n', artifacts: {} }, packageHash: hashAcademyPackage({ skillMd: '---\nname: unrelated\ndescription: Mentions change-flow\n---\nchange-flow\n', artifacts: {} }) }
        ]
      }], null)
      service.store.enableLocalAuthority('commit-1')
      service.store.deleteGlobalSkill(skill.id, 3) // v4 DELETED (hash === v3)
      service.store.restoreDeletedGlobalSkill(skill.id, 4) // v5 PRESENT (hash === v3)

      const adapter = ChannelMcpAdapter.createGlobalOnly(service)
      expect(adapter.listTools().map(t => t.name)).toEqual(expect.arrayContaining(['list_academy_changes', 'get_academy_change_diff']))
      expect(adapter.capabilityForTool('get_academy_change_diff')).toBe('Academy')

      const beforeSnapshot = service.snapshot()
      const beforeHistory = service.history(skill.id)
      const catalogSpy = vi.spyOn(service.store, 'readImpactCatalog')
      const reconcileSpy = vi.spyOn(service, 'scheduleReconciliationForSkill')

      // 1. Discover chronological events via list_academy_changes
      const listed = JSON.parse(textContent((await adapter.callTool('list_academy_changes', { skillId: skill.id, limit: 10 })).content[0]))
      expect(listed.changes.map((c: { version: number }) => c.version)).toEqual([5, 4, 3, 2, 1])

      // 2. Diff creation v1 (baseVersion omitted -> null)
      const diffV1 = JSON.parse(textContent((await adapter.callTool('get_academy_change_diff', { skillId: skill.id, targetVersion: 1 })).content[0]))
      expect(diffV1).toMatchObject({
        skillId: skill.id,
        skillName: 'change-flow',
        baseVersion: null,
        targetVersion: 1,
        basePackageHash: null,
        baseContentState: null,
        targetContentState: 'PRESENT',
        semanticEffect: 'NOT_ASSESSED'
      })
      expect(diffV1.frontmatter.changedProperties.items).toEqual(['description', 'name'])
      expect(diffV1.changes.items.map((c: { path: string; kind: string }) => [c.path, c.kind])).toEqual([
        ['SKILL.md', 'ADDED'],
        ['references/keep.md', 'ADDED'],
        ['references/remove.md', 'ADDED']
      ])

      // 3. Diff v1 -> v2 (frontmatter, body, empty file added, file removed) + payload purity
      const diffV2Raw = textContent((await adapter.callTool('get_academy_change_diff', { skillId: skill.id, targetVersion: 2, limit: 2, textLimit: 10 })).content[0])
      expect(diffV2Raw).not.toMatch(/consumers|unrelated|eligibleSkills|distribution/)
      const diffV2 = JSON.parse(diffV2Raw)
      expect(diffV2).toMatchObject({ baseVersion: 1, targetVersion: 2, changes: { total: 6, nextOffset: 2 } })
      expect(diffV2.frontmatter.changedProperties.items).toEqual(['description'])

      // Single change block isolation & literal reconstruction with Unicode + CRLF
      let blockText = ''
      let textOffset: number | null = 0
      while (textOffset !== null) {
        const page = JSON.parse(textContent((await adapter.callTool('get_academy_change_diff', {
          skillId: skill.id, targetVersion: 2, path: 'SKILL.md', offset: 3, limit: 1, textOffset, textLimit: 5
        })).content[0]))
        blockText += page.changes.items[0].content.text
        textOffset = page.changes.items[0].content.nextOffset
      }
      expect(blockText).toBe('Line  2 🧪\r\nLine 3 𠀋\r\n')

      // Whitespace-only edit v2 -> v3
      const diffV3 = JSON.parse(textContent((await adapter.callTool('get_academy_change_diff', { skillId: skill.id, targetVersion: 3 })).content[0]))
      expect(diffV3.changes.items.every((c: { literalEffect: string }) => c.literalEffect === 'WHITESPACE_ONLY')).toBe(true)

      // Tombstone v3 -> v4 and reintroduction v4 -> v5 with equal hashes
      const diffDelete = JSON.parse(textContent((await adapter.callTool('get_academy_change_diff', { skillId: skill.id, targetVersion: 4 })).content[0]))
      expect(diffDelete).toMatchObject({
        baseVersion: 3,
        targetVersion: 4,
        baseContentState: 'PRESENT',
        targetContentState: 'DELETED',
        contentState: 'DELETED',
        changes: { total: 0, items: [] }
      })
      expect(diffDelete.basePackageHash).toBe(diffDelete.targetPackageHash)

      const diffReintro = JSON.parse(textContent((await adapter.callTool('get_academy_change_diff', { skillId: skill.id, targetVersion: 5 })).content[0]))
      expect(diffReintro).toMatchObject({
        baseVersion: 4,
        targetVersion: 5,
        baseContentState: 'DELETED',
        targetContentState: 'PRESENT',
        changes: { total: 0, items: [] }
      })
      expect(diffReintro.contentState).toBeUndefined()

      // Reverse comparison v5 -> v1 for rollback evaluation & equal version v2 -> v2
      const reverseDiff = JSON.parse(textContent((await adapter.callTool('get_academy_change_diff', { skillId: skill.id, baseVersion: 5, targetVersion: 1 })).content[0]))
      expect(reverseDiff.changes.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'references/empty.md', kind: 'REMOVED' }),
        expect.objectContaining({ path: 'references/remove.md', kind: 'ADDED' })
      ]))
      const equalDiff = JSON.parse(textContent((await adapter.callTool('get_academy_change_diff', { skillId: skill.id, baseVersion: 2, targetVersion: 2 })).content[0]))
      expect(equalDiff.changes.total).toBe(0)

      // Error handling
      for (const [args, expectedError] of [
        [{ skillId: 'missing', targetVersion: 1 }, 'SKILL_NOT_FOUND'],
        [{ skillId: skill.id, targetVersion: 99 }, 'VERSION_NOT_FOUND'],
        [{ skillId: skill.id, baseVersion: 99, targetVersion: 2 }, 'VERSION_NOT_FOUND'],
        [{ skillId: skill.id, targetVersion: 2, path: 'references/missing.md' }, 'PATH_NOT_FOUND'],
        [{ skillId: skill.id, targetVersion: 2, path: '../escape' }, 'INVALID_ARGUMENT'],
        [{ skillId: skill.id, targetVersion: 0 }, 'INVALID_ARGUMENT'],
        [{ skillId: skill.id, targetVersion: 2, extra: true }, 'INVALID_ARGUMENT']
      ] as const) {
        const err = await adapter.callTool('get_academy_change_diff', args)
        expect(err.isError).toBe(true)
        expect(JSON.parse(textContent(err.content[0])).error).toBe(expectedError)
      }

      // Read-only invariant before rollback
      expect(catalogSpy).not.toHaveBeenCalled()
      expect(reconcileSpy).not.toHaveBeenCalled()
      expect(service.snapshot()).toEqual(beforeSnapshot)
      expect(service.history(skill.id)).toEqual(beforeHistory)

      // 4. Full package retrieval via get_academy_skill_history + authorized CAS rollback via update_academy_skill
      const fullV1 = JSON.parse(textContent((await adapter.callTool('get_academy_skill_history', { skillId: skill.id, version: 1 })).content[0]))
      expect(fullV1.package).toEqual(v1Pkg)

      const eligibilityBefore = service.store.publicationEligibility(skill.id)
      const scopeBefore = service.get(skill.id).scope

      const staleRollback = await adapter.callTool('update_academy_skill', { skillId: skill.id, expectedVersion: 4, package: fullV1.package })
      expect(staleRollback.isError).toBe(true)
      expect(JSON.parse(textContent(staleRollback.content[0])).error).toBe('VERSION_CONFLICT')

      const rollback = await adapter.callTool('update_academy_skill', { skillId: skill.id, expectedVersion: 5, package: fullV1.package })
      expect(rollback.isError).toBeUndefined()
      const rolledBackSkill = JSON.parse(textContent(rollback.content[0]))
      expect(rolledBackSkill.currentVersion).toBe(6)
      expect(rolledBackSkill.current.package).toEqual(v1Pkg)
      expect(rolledBackSkill.scope).toBe(scopeBefore)
      expect(service.store.publicationEligibility(skill.id)).toBe(eligibilityBefore)

      // Tombstone cannot be silently reactivated via update_academy_skill
      service.store.deleteGlobalSkill(skill.id, 6)
      const blockedOnTombstone = await adapter.callTool('update_academy_skill', { skillId: skill.id, expectedVersion: 7, package: fullV1.package })
      expect(blockedOnTombstone.isError).toBe(true)
      expect(JSON.parse(textContent(blockedOnTombstone.content[0])).error).toBe('SKILL_DELETED_RECONCILIATION_REQUIRED')
      expect(service.store.isDeleted(skill.id)).toBe(true)
    } finally { await service.close() }
  })
})
