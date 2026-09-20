import { describe, expect, it, vi } from 'vitest'
import { ContextNavigationError } from '../../../src/shared/types/context-navigation-types'
import type { ContextNavigationPort } from '../../../src/main/core/context/context-navigation-port'
import { ContextNavigationMcpAdapter, contextNavigationTools } from './context-navigation-mcp'

function createNavigation(): ContextNavigationPort {
  return {
    discoverRepository: vi.fn(async () => ({
      repoPath: 'bound', layer: 2, format: 'rm2' as const, content: 'RM2 EXACT', metrics: {} as never
    })),
    inspectScope: vi.fn(async (_repoPath, relativePaths) => ({
      files: relativePaths.map((relativePath) => ({ fileId: relativePath, relativePath, language: 'typescript', elements: [] }))
    })),
    readCode: vi.fn(async (_repoPath, targetIds) => targetIds.map((targetId) => ({
      targetId,
      elementId: targetId,
      relativePath: 'src/target.ts',
      language: 'typescript',
      location: { start: { line: 1, column: 0, byte: 0 }, end: { line: 1, column: 1, byte: 1 } },
      source: 'X'
    })))
  }
}

describe('ContextNavigationMcpAdapter', () => {
  it('registers only the four read-only spike tools with constrained schemas', () => {
    expect(contextNavigationTools.map((tool) => tool.name)).toEqual([
      'ping', 'discover_repository', 'inspect_scope', 'read_code'
    ])
    expect(contextNavigationTools.find((tool) => tool.name === 'inspect_scope')?.inputSchema).toMatchObject({
      required: ['relativePaths'], additionalProperties: false
    })
    expect(contextNavigationTools.find((tool) => tool.name === 'read_code')?.inputSchema).toMatchObject({
      required: ['targetIds'], additionalProperties: false
    })
  })

  it('binds every operation to the configured repository and preserves results', async () => {
    const navigation = createNavigation()
    const adapter = new ContextNavigationMcpAdapter(navigation, 'C:/bound-repository')

    const discovery = await adapter.callTool('discover_repository', {})
    const scope = await adapter.callTool('inspect_scope', { relativePaths: ['src/a.ts'] })
    const code = await adapter.callTool('read_code', { targetIds: ['target:a:full'] })

    expect(navigation.discoverRepository).toHaveBeenCalledWith('C:/bound-repository')
    expect(navigation.inspectScope).toHaveBeenCalledWith('C:/bound-repository', ['src/a.ts'])
    expect(navigation.readCode).toHaveBeenCalledWith('C:/bound-repository', ['target:a:full'])
    expect(JSON.parse(discovery.content[0].text).content).toBe('RM2 EXACT')
    expect(JSON.parse(scope.content[0].text).files[0].relativePath).toBe('src/a.ts')
    expect(JSON.parse(code.content[0].text)[0].source).toBe('X')
  })

  it('validates arguments and propagates domain errors as structured MCP tool errors', async () => {
    const navigation = createNavigation()
    vi.mocked(navigation.inspectScope).mockRejectedValueOnce(
      new ContextNavigationError('UNKNOWN_FILE', 'Unknown CodeMap file: missing.ts', 'missing.ts')
    )
    const adapter = new ContextNavigationMcpAdapter(navigation, 'C:/bound-repository')

    const invalid = await adapter.callTool('read_code', { targetIds: 'not-an-array' })
    const domainFailure = await adapter.callTool('inspect_scope', { relativePaths: ['missing.ts'] })

    expect(invalid.isError).toBe(true)
    expect(JSON.parse(invalid.content[0].text).error.code).toBe('EMPTY_TARGETS')
    expect(domainFailure.isError).toBe(true)
    expect(JSON.parse(domainFailure.content[0].text).error).toEqual({
      name: 'ContextNavigationError',
      code: 'UNKNOWN_FILE',
      message: 'Unknown CodeMap file: missing.ts',
      reference: 'missing.ts'
    })
  })
})
