import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActiveProject, ActiveProjectState } from '../../shared/types/active-project-types'
import type { CodeMapService } from '../core/code-map-service'
import { ActiveProjectService } from '../core/active-project-service'
import { bindProjectNavigation } from '../core/context/project-context-navigation'
import { McpLifecycle } from '../mcp/mcp-lifecycle'
import type { McpToolResult } from '../mcp/channel-mcp-adapter'
import { registerActiveProjectHandlers } from './active-project-handler'
import { registerCodeMapHandlers } from './code-map-handler'

const { handlers, send } = vi.hoisted(() => ({ handlers: new Map<string, Function>(), send: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, callback: Function) => handlers.set(channel, callback) },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }] }
}))

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
  handlers.clear()
  send.mockClear()
})

function setup(failMcp = false) {
  const open = new Map<string, ActiveProject>()
  const registry = {
    getOpenProjects: () => [...open.values()],
    openRepository: vi.fn(async (path: string) => {
      const name = path.split('/').at(-1)!
      open.set(path, { id: `id-${name}`, path, name })
    }),
    closeRepository: vi.fn((path: string) => { open.delete(path) })
  }
  const projects = new ActiveProjectService(registry)
  const mcp = new McpLifecycle({
    log: () => {},
    ...(failMcp ? { createServer: () => { throw new Error('Private infrastructure detail') } } : {})
  })
  const navigation = {
    discoverRepository: vi.fn(async (repoPath: string) => ({ directories: [{ relativePath: '.', children: [repoPath] }] })),
    getRelationships: vi.fn(async () => ({ files: [] })), inspectFiles: vi.fn(async () => ({ files: [] })),
    readCode: vi.fn(async () => [])
  }
  projects.onChanged(({ project }) => project
    ? mcp.activate(project.id, bindProjectNavigation(navigation, project.path))
    : mcp.deactivate())
  registerActiveProjectHandlers(projects)
  registerCodeMapHandlers(registry as unknown as CodeMapService, projects)
  cleanup.push(async () => { await projects.dispose(); await mcp.dispose() })
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  return { projects, mcp, registry, navigation, invoke }
}

async function discover(mcp: McpLifecycle) {
  const state = mcp.getState()
  if (state.status !== 'RUNNING') throw new Error('MCP is not running')
  const response = await fetch(state.endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'discover_repository', arguments: {} } })
  })
  return (await response.json() as { result: McpToolResult }).result.content[0].text
}

describe('active project authority and MCP integration', () => {
  it('opens without selecting, confirms A then B, and rehydrates the same canonical state', async () => {
    const { invoke, projects, mcp, navigation } = setup()
    expect(invoke('project:get-active')).toEqual({ revision: 0, project: null })
    const a = await invoke('code-map:open-repository', '/projects/A')
    const b = await invoke('code-map:open-repository', '/projects/B')
    expect(a.projectId).toBe('id-A')
    expect(projects.getState().project).toBeNull()
    expect(mcp.getState().status).toBe('STOPPED')
    await invoke('project:activate', a.projectId)
    expect(await discover(mcp)).toBe('[.]\n/projects/A')
    await invoke('project:activate', b.projectId)
    expect(await discover(mcp)).toBe('[.]\n/projects/B')
    expect(navigation.discoverRepository).toHaveBeenLastCalledWith('/projects/B', undefined)
    const confirmed = invoke('project:get-active') as ActiveProjectState
    expect(confirmed.project?.id).toBe('id-B')
    expect(send).toHaveBeenLastCalledWith('project:active-changed', confirmed)
    expect(invoke('project:get-active')).toEqual(confirmed)
    await invoke('code-map:open-repository', '/projects/C')
    expect(projects.getState()).toEqual(confirmed)
  })

  it('rejects unknown, unopened and malformed identities without opening a project', async () => {
    const { invoke, mcp, registry } = setup()
    for (const id of ['missing', '/projects/A', '', undefined, {}, 1]) {
      expect((await invoke('project:activate', id)).success).toBe(false)
    }
    expect(registry.openRepository).not.toHaveBeenCalled()
    expect(mcp.getState().status).toBe('STOPPED')
  })

  it('keeps inactive projects open and stops MCP before closing the active project', async () => {
    const { invoke, projects, mcp, registry } = setup()
    await invoke('code-map:open-repository', '/projects/A')
    await invoke('code-map:open-repository', '/projects/B')
    await invoke('project:activate', 'id-A')
    const running = mcp.getState()
    await invoke('code-map:close-repository', '/projects/B')
    expect(projects.getState().project?.id).toBe('id-A')
    expect(mcp.getState()).toEqual(running)
    registry.closeRepository.mockImplementation((path) => {
      expect(path).toBe('/projects/A')
      expect(mcp.getState().status).toBe('STOPPED')
    })
    await invoke('code-map:close-repository', '/projects/A')
    expect(projects.getState().project).toBeNull()
    expect(mcp.getState().status).toBe('STOPPED')
    if (running.status === 'RUNNING') await expect(fetch(running.endpoint)).rejects.toThrow()
  })

  it('serializes rapid intentions and isolates MCP failure from canonical selection', async () => {
    const { invoke, projects, mcp, registry } = setup(true)
    for (const id of ['A', 'B', 'C']) await invoke('code-map:open-repository', `/projects/${id}`)
    const results = await Promise.all(['A', 'B', 'C'].map((id) => invoke('project:activate', `id-${id}`)))
    expect(results.every((result) => result.success)).toBe(true)
    expect(projects.getState().project?.id).toBe('id-C')
    expect(mcp.getState().status).toBe('ERROR')
    expect(registry.getOpenProjects()).toHaveLength(3)
    expect((await invoke('project:activate', null)).success).toBe(true)
    expect(mcp.getState().status).toBe('STOPPED')
  })
})
