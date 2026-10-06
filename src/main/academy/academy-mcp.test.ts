import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AcademyService } from './academy-service'
import { ACADEMY_MCP_TOOLS, executeAcademyTool } from './academy-mcp'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('Academy MCP administration', () => {
  it('publishes the bounded administration catalog and enforces expectedVersion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'academy-mcp-')); roots.push(root)
    const service = new AcademyService(join(root, 'academy.db'))
    expect(ACADEMY_MCP_TOOLS.map((item) => item.name)).toContain('update_academy_skill')
    expect(ACADEMY_MCP_TOOLS.map((item) => item.name)).toEqual(expect.arrayContaining([
      'get_openai_plugin_publication', 'prepare_openai_plugin_release', 'get_openai_plugin_release', 'confirm_openai_plugin_upload'
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
    expect(JSON.parse(listed.content[0].text)).toEqual([])
    service.close()
  })
})
