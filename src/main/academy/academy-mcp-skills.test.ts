import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcademyService } from './academy-service'
import { AcademyMcpSkillsProvider, MAX_SKILL_RESOURCES } from './academy-mcp-skills'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import { McpLifecycle } from '../mcp/mcp-lifecycle'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'

const tempDirs: string[] = []
const services: AcademyService[] = []
const cleanups: Array<() => void | Promise<void>> = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function sha256UriDigest(text: string): { digest: string; size: number } {
  const buf = Buffer.from(text, 'utf8')
  return {
    digest: `sha256:${createHash('sha256').update(buf).digest('hex')}`,
    size: buf.byteLength
  }
}

function stubNavigation(tag: string): ProjectContextNavigation {
  return {
    discoverRepository: vi.fn(async () => ({ directories: [{ relativePath: '.', children: [tag] }] })),
    getRelationships: vi.fn(async () => ({ files: [] })),
    inspectFiles: vi.fn(async () => ({ files: [] })),
    getReferences: vi.fn(async () => ({ targets: [] })),
    getSymbolDependencies: vi.fn(async () => ({ sources: [] })),
    getSymbolHierarchy: vi.fn(async () => ({ targets: [] })),
    readCode: vi.fn(async () => [])
  }
}

interface RpcTestBody {
  result?: any
  error?: { code?: number; message?: string; data?: any }
}

async function rpc(
  endpoint: string,
  id: number,
  method: string,
  params?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: RpcTestBody }> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  })
  return { status: response.status, body: (await response.json()) as RpcTestBody }
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).reverse().map((fn) => fn()))
  await Promise.all(services.splice(0).map((svc) => svc.close().catch(() => {})))
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Academy MCP Skills extension (io.modelcontextprotocol/skills 2026-07-28)', () => {
  it('serves modern discovery while keeping the Academy extension on the legacy handshake', async () => {
    const dataDir = makeTempDir('academy-mcp-skills-')
    const repoDir = makeTempDir('academy-repo-')
    const service = new AcademyService(join(dataDir, 'academy.db'))
    services.push(service)
    const dest = service.store.upsertDestination(repoDir, 'repo')

    const adapter = new ChannelMcpAdapter(
      { projectId: dest.id, repoRoot: repoDir, navigation: stubNavigation('repo') },
      undefined,
      undefined,
      undefined,
      service
    )
    const server = createMcpHttpServer(adapter, () => {})
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const addr = server.address() as { port: number }
    const endpoint = `http://127.0.0.1:${addr.port}/mcp`

    const version = '2026-07-28'
    const discovered = await rpc(endpoint, 1, 'server/discover', {
      _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {} }
    }, { 'mcp-protocol-version': version, 'mcp-method': 'server/discover' })
    expect(discovered.status).toBe(200)
    expect(discovered.body.result).toEqual({
      resultType: 'complete',
      supportedVersions: [version, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: { tools: { listChanged: false } },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'code-awareness-context-navigation', version: '1.0.0' } },
      ttlMs: 0,
      cacheScope: 'private'
    })

    const dirRead = await rpc(endpoint, 99, 'resources/directory/read', { uri: 'skill://global/' })
    expect(dirRead.body.error?.code).toBe(-32601)

    const legacyInit = await rpc(endpoint, 2, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {} })
    expect(legacyInit.body.result).toMatchObject({
      protocolVersion: '2025-11-25',
      capabilities: {
        tools: { listChanged: false },
        resources: { directoryRead: false },
        extensions: { 'io.modelcontextprotocol/skills': {} }
      }
    })
    expect(legacyInit.body.result.capabilities.extensions['io.modelcontextprotocol/skills']).not.toHaveProperty('directoryRead')
    const listedTools = await rpc(endpoint, 3, 'tools/list', {})
    expect(listedTools.body.result.tools.some((t: { name: string }) => t.name === 'discover_repository')).toBe(true)
    expect(listedTools.body.result.tools.some((t: { name: string }) => t.name === 'list_academy_skills')).toBe(true)
    const toolRes = await rpc(endpoint, 4, 'tools/call', { name: 'discover_repository', arguments: {} })
    expect(toolRes.body.result.content[0].text).toContain('repo')
  })

  it('enforces scope isolation, verbatim frontmatter, per-file digests, traversal blocking, rename invalidation, and no eager reads', async () => {
    const dataDir = makeTempDir('academy-scope-')
    const repoA = makeTempDir('repo-a-')
    const repoB = makeTempDir('repo-b-')
    const service = new AcademyService(join(dataDir, 'academy.db'))
    services.push(service)
    const destA = service.store.upsertDestination(repoA, 'ProjA')
    const destB = service.store.upsertDestination(repoB, 'ProjB')

    const globalSkillMd = [
      '---',
      'name: architecture-review',
      'description: Review module architecture with UTF-8 ç/🚀 precision',
      'license: MIT',
      'allowed-tools: discover_repository inspect_files',
      'metadata:',
      '  owner: platform',
      '  priority: 1',
      '---',
      '',
      '# Architecture Review',
      'Read `references/checklist.md` before finishing.'
    ].join('\n')
    const guideMd = '# Checklist\nCheck boundaries — ç.'
    const scriptPy = 'print("hello")'
    const globalCreated = await service.saveNewSkill({
      package: {
        skillMd: globalSkillMd,
        artifacts: { 'references/checklist.md': guideMd, 'scripts/check.py': scriptPy }
      },
      scope: 'GLOBAL',
      origin: 'UI'
    })
    if (!('id' in globalCreated)) throw new Error('Expected skill detail')

    const projASkillMd = [
      '---',
      'name: proj-a-helper',
      'description: Helper bound to Project A',
      '---',
      '',
      '# Project A helper'
    ].join('\n')
    const projACreated = await service.saveNewSkill({
      package: { skillMd: projASkillMd, artifacts: { 'notes/a.txt': 'only for A' } },
      scope: 'PROJECT',
      projectIds: [destA.id],
      origin: 'UI'
    })
    if (!('id' in projACreated)) throw new Error('Expected skill detail')

    const globalHelper = await service.saveNewSkill({
      package: {
        skillMd: ['---', 'name: global-helper', 'description: Global helper', '---', '', '# Global'].join('\n'),
        artifacts: {}
      },
      scope: 'GLOBAL',
      origin: 'UI'
    })
    if (!('id' in globalHelper)) throw new Error('Expected skill detail')

    const projBCreated = await service.saveNewSkill({
      package: {
        skillMd: ['---', 'name: secret-b', 'description: Project B only', '---', '', '# B'].join('\n'),
        artifacts: {}
      },
      scope: 'PROJECT',
      projectIds: [destB.id],
      origin: 'UI'
    })
    if (!('id' in projBCreated)) throw new Error('Expected skill detail')

    const disabledSkill = await service.saveNewSkill({
      package: {
        skillMd: ['---', 'name: disabled-skill', 'description: Disabled skill', '---', '', '# Disabled'].join('\n'),
        artifacts: {}
      },
      scope: 'GLOBAL',
      origin: 'UI'
    })
    if (!('id' in disabledSkill)) throw new Error('Expected skill detail')
    await service.setEnabled(disabledSkill.id, false, disabledSkill.stateRevision)

    const lifecycle = new McpLifecycle({ academy: service, log: () => {} })
    cleanups.push(() => lifecycle.dispose())
    await lifecycle.activateContext({ projectId: 'arbitrary-codemap-id-a', repoRoot: repoA, navigation: stubNavigation('A') })
    const stateA = lifecycle.getState()
    if (stateA.status !== 'RUNNING') throw new Error('Expected MCP running for repoA')

    const readSpy = vi.spyOn(AcademyMcpSkillsProvider.prototype, 'readSkillResource')
    const listResA = await rpc(stateA.endpoint, 10, 'skills/list', {})
    expect(readSpy).not.toHaveBeenCalled()
    readSpy.mockRestore()

    const skillsA = listResA.body.result.skills as Array<{ uri: string; frontmatter: Record<string, unknown>; resources: Array<{ uri: string; digest: string; size: number }> }>
    const namesA = skillsA.map((s) => s.frontmatter.name)
    expect(namesA).toContain('architecture-review')
    expect(namesA).toContain('proj-a-helper')
    expect(namesA).toContain('global-helper')
    expect(namesA).not.toContain('secret-b')
    expect(namesA).not.toContain('disabled-skill')
    expect(JSON.stringify(skillsA)).not.toContain('Read `references/checklist.md` before finishing.')

    const archEntry = skillsA.find((s) => s.frontmatter.name === 'architecture-review')!
    expect(archEntry.uri).toBe(`skill://global/${globalCreated.id}/architecture-review/SKILL.md`)
    expect(archEntry.frontmatter).toEqual({
      name: 'architecture-review',
      description: 'Review module architecture with UTF-8 ç/🚀 precision',
      license: 'MIT',
      'allowed-tools': 'discover_repository inspect_files',
      metadata: { owner: 'platform', priority: 1 }
    })
    expect(archEntry.resources).toEqual([
      {
        uri: `skill://global/${globalCreated.id}/architecture-review/SKILL.md`,
        ...sha256UriDigest(globalSkillMd)
      },
      {
        uri: `skill://global/${globalCreated.id}/architecture-review/references/checklist.md`,
        ...sha256UriDigest(guideMd)
      },
      {
        uri: `skill://global/${globalCreated.id}/architecture-review/scripts/check.py`,
        ...sha256UriDigest(scriptPy)
      }
    ])
    const byUri = new Map(archEntry.resources.map((r) => [r.uri, r]))
    expect(byUri.get(archEntry.uri)).toEqual({ uri: archEntry.uri, ...sha256UriDigest(globalSkillMd) })
    expect(byUri.get(`skill://global/${globalCreated.id}/architecture-review/references/checklist.md`)).toEqual({
      uri: `skill://global/${globalCreated.id}/architecture-review/references/checklist.md`,
      ...sha256UriDigest(guideMd)
    })
    expect(byUri.get(archEntry.uri)!.digest).not.toBe(`sha256:${globalCreated.current.packageHash}`)

    const gotGlobal = await rpc(stateA.endpoint, 11, 'skills/get', { uri: archEntry.uri })
    expect(gotGlobal.body.result.skill).toEqual(archEntry)

    const projAEntry = skillsA.find((s) => s.uri.startsWith(`skill://project/${destA.id}/`))!
    expect(projAEntry.uri).toBe(`skill://project/${destA.id}/${projACreated.id}/proj-a-helper/SKILL.md`)

    const readSkillMd = await rpc(stateA.endpoint, 12, 'resources/read', { uri: archEntry.uri })
    expect(readSkillMd.body.result.contents).toEqual([
      { uri: archEntry.uri, mimeType: 'text/markdown', text: globalSkillMd }
    ])
    const auxUri = `skill://global/${globalCreated.id}/architecture-review/references/checklist.md`
    const readAux = await rpc(stateA.endpoint, 13, 'resources/read', { uri: auxUri })
    expect(readAux.body.result.contents).toEqual([
      { uri: auxUri, mimeType: 'text/markdown', text: guideMd }
    ])

    for (const badUri of [
      `skill://project/${destB.id}/${projBCreated.id}/secret-b/SKILL.md`,
      `skill://global/${disabledSkill.id}/disabled-skill/SKILL.md`,
      `skill://global/${globalCreated.id}/architecture-review/../secret.txt`,
      `skill://global/${globalCreated.id}/architecture-review/%2e%2e/secret.txt`,
      `skill://global/${globalCreated.id}/architecture-review/nonexistent.md`,
      `skill://global/unknown-id/foo/SKILL.md`
    ]) {
      const badGet = await rpc(stateA.endpoint, 14, 'skills/get', { uri: badUri })
      expect(badGet.body.error?.code).toBe(-32602)
      const badRead = await rpc(stateA.endpoint, 15, 'resources/read', { uri: badUri })
      expect(badRead.body.error?.code).toBe(-32602)
    }

    const oldGlobalUri = archEntry.uri
    await service.saveSkill({
      skillId: globalCreated.id,
      expectedVersion: globalCreated.currentVersion,
      package: {
        skillMd: globalSkillMd.replace('name: architecture-review', 'name: architecture-review-v2'),
        artifacts: {}
      },
      origin: 'UI'
    })
    const staleGet = await rpc(stateA.endpoint, 16, 'skills/get', { uri: oldGlobalUri })
    expect(staleGet.body.error?.code).toBe(-32602)

    await lifecycle.activateContext({ projectId: destB.id, repoRoot: repoB, navigation: stubNavigation('B') })
    const stateB = lifecycle.getState()
    if (stateB.status !== 'RUNNING') throw new Error('Expected MCP running for repoB')
    const crossProjRead = await rpc(stateB.endpoint, 17, 'resources/read', { uri: projAEntry.uri })
    expect(crossProjRead.body.error?.code).toBe(-32602)
    const listB = await rpc(stateB.endpoint, 18, 'skills/list', {})
    const namesB = (listB.body.result.skills as Array<{ frontmatter: { name: string } }>).map((s) => s.frontmatter.name)
    expect(namesB).toContain('secret-b')
    expect(namesB).toContain('global-helper')
    expect(namesB).not.toContain('proj-a-helper')

    await lifecycle.deactivate()
    expect(lifecycle.getState()).toEqual({ status: 'STOPPED', available: false })
    expect(lifecycle.getLocalEndpoint('test-instance')).toMatchObject({ status: 'UNAVAILABLE' })

    const globalTarget = await lifecycle.ensureGlobalSkillsEndpoint()
    expect(globalTarget.status).toBe('RUNNING')
    if (globalTarget.status !== 'RUNNING') throw new Error('Expected running global target')
    expect(globalTarget.mode).toBe('GLOBAL_ONLY')
    const globalList = await rpc(globalTarget.endpoint, 19, 'skills/list', {})
    const globalOnlyNames = (globalList.body.result.skills as Array<{ frontmatter: { name: string } }>).map((s) => s.frontmatter.name)
    expect(globalOnlyNames).toContain('architecture-review-v2')
    expect(globalOnlyNames).not.toContain('secret-b')
    const blockedNav = await rpc(globalTarget.endpoint, 20, 'tools/call', { name: 'discover_repository', arguments: {} })
    expect(blockedNav.body.result.isError).toBe(true)
    expect(blockedNav.body.result.content[0].text).toContain('PROJECT_UNAVAILABLE')
  })

  it('paginates deterministically and rejects packages exceeding spec resource count limit', async () => {
    const dataDir = makeTempDir('academy-limits-')
    const service = new AcademyService(join(dataDir, 'academy.db'))
    services.push(service)

    const oversizedArtifacts: Record<string, string> = {}
    for (let i = 0; i < MAX_SKILL_RESOURCES; i += 1) {
      oversizedArtifacts[`files/f${i}.txt`] = 'x'
    }
    const bigSkill = await service.saveNewSkill({
      package: {
        skillMd: ['---', 'name: oversized-skill', 'description: Too many files', '---', '# Big'].join('\n'),
        artifacts: oversizedArtifacts
      },
      scope: 'GLOBAL',
      origin: 'UI'
    })
    if (!('id' in bigSkill)) throw new Error('Expected skill detail')

    const s1 = await service.saveNewSkill({
      package: { skillMd: ['---', 'name: alpha-skill', 'description: Alpha', '---', '# A'].join('\n'), artifacts: {} },
      scope: 'GLOBAL',
      origin: 'UI'
    })
    const s2 = await service.saveNewSkill({
      package: { skillMd: ['---', 'name: beta-skill', 'description: Beta', '---', '# B'].join('\n'), artifacts: {} },
      scope: 'GLOBAL',
      origin: 'UI'
    })
    if (!('id' in s1) || !('id' in s2)) throw new Error('Expected skill details')

    const provider = new AcademyMcpSkillsProvider(service, {}, 1)
    const page1 = provider.listSkills()
    expect(page1.skills).toHaveLength(1)
    expect(page1.catalogRevision).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(page1.nextCursor).toBeTypeOf('string')
    const page2 = provider.listSkills({ cursor: page1.nextCursor })
    expect(page2.skills).toHaveLength(1)
    expect(page2.catalogRevision).toBe(page1.catalogRevision)
    expect(page2.nextCursor).toBeUndefined()

    const directSecond = provider.getSkill({ uri: `skill://global/${s2.id}/beta-skill/SKILL.md` })
    expect(directSecond.skill.frontmatter.name).toBe('beta-skill')
    expect(directSecond.catalogRevision).toBe(page1.catalogRevision)

    const emptyProvider = new AcademyMcpSkillsProvider(service, { projectId: 'missing-proj' }, 10)
    const filteredList = emptyProvider.listSkills()
    expect(filteredList.skills).toHaveLength(2)
    expect(filteredList.skills.some((s) => s.uri.startsWith('skill://project/'))).toBe(false)
    expect(() => provider.getSkill({ uri: `skill://global/${bigSkill.id}/oversized-skill/SKILL.md` })).toThrow(/limit/i)
  })

  it('disambiguates homonymous skills deterministically by scope and skillId URI without shadowing', () => {
    const fakeService = {
      store: {
        listDestinations: () => [{ id: 'dest-a', path: 'C:/repo-a', name: 'A', enabled: true, reconciliationStatus: 'SYNCED', lastError: null, updatedAt: '2026-01-01T00:00:00Z' }],
        isDeleted: () => false,
        usesLocalAuthority: () => true,
        getGitAuthority: () => null,
        getGitSkillSources: () => []
      },
      list: () => [
        { id: 'skill-g', name: 'deploy-check', description: 'Global deploy check', status: 'ACTIVE', stateRevision: 1, scope: 'GLOBAL', currentVersion: 1, projectIds: [], createdAt: '', updatedAt: '' },
        { id: 'skill-p', name: 'deploy-check', description: 'Project deploy check', status: 'ACTIVE', stateRevision: 1, scope: 'PROJECT', currentVersion: 1, projectIds: ['dest-a'], createdAt: '', updatedAt: '' }
      ],
      get: (id: string) => ({
        id,
        name: 'deploy-check',
        description: id === 'skill-g' ? 'Global deploy check' : 'Project deploy check',
        status: 'ACTIVE',
        stateRevision: 1,
        scope: id === 'skill-g' ? 'GLOBAL' : 'PROJECT',
        currentVersion: 1,
        projectIds: id === 'skill-g' ? [] : ['dest-a'],
        createdAt: '',
        updatedAt: '',
        current: {
          skillId: id,
          version: 1,
          packageHash: `hash-${id}`,
          origin: 'UI',
          createdAt: '',
          package: {
            skillMd: `---\nname: deploy-check\ndescription: ${id === 'skill-g' ? 'Global deploy check' : 'Project deploy check'}\n---\n# Body ${id}`,
            artifacts: {}
          }
        }
      })
    } as unknown as AcademyService

    const provider = new AcademyMcpSkillsProvider(fakeService, { projectId: 'dest-a' })
    const listed = provider.listSkills()
    expect(listed.skills.map((s) => s.uri)).toEqual([
      'skill://global/skill-g/deploy-check/SKILL.md',
      'skill://project/dest-a/skill-p/deploy-check/SKILL.md'
    ])
    expect(provider.readSkillResource({ uri: 'skill://global/skill-g/deploy-check/SKILL.md' }).contents[0].text).toContain('Body skill-g')
    expect(provider.readSkillResource({ uri: 'skill://project/dest-a/skill-p/deploy-check/SKILL.md' }).contents[0].text).toContain('Body skill-p')
  })
})
