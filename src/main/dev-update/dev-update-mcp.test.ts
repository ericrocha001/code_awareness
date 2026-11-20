import { describe, expect, it, vi } from 'vitest'
import { REQUEST_DEV_UPDATE_TOOL, executeRequestDevUpdate } from './dev-update-mcp'
import type { DevUpdateService } from './dev-update-service'
import type { AgentAuthority, AgentPrincipal } from '../continuum/agent-authority'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import type { McpProjectContext } from '../mcp/project-mcp-context'
import type { McpTextContent } from '../mcp/mcp-types'
import type { RuntimeRestartController } from '../runtime-restart/runtime-restart-controller'

function textOf(content: unknown[]): string {
  const item = content[0] as McpTextContent | undefined
  return item?.text ?? ''
}

function createMockAuthority(repoId = 'repo-code-awareness', active = true): AgentAuthority {
  const principal: AgentPrincipal = {
    principalId: 'MCP:test-principal',
    transport: 'MCP',
    isActive: () => active
  }
  return {
    principal,
    repositoryId: repoId,
    isActive: () => active
  }
}

describe('request_dev_update MCP tool', () => {
  it('defines valid tool schema requiring operationId and expectedInstanceId', () => {
    expect(REQUEST_DEV_UPDATE_TOOL.name).toBe('request_dev_update')
    expect(REQUEST_DEV_UPDATE_TOOL.inputSchema.required).toEqual(['operationId', 'expectedInstanceId'])
    expect(REQUEST_DEV_UPDATE_TOOL.inputSchema.properties).toHaveProperty('operationId')
    expect(REQUEST_DEV_UPDATE_TOOL.inputSchema.properties).toHaveProperty('expectedInstanceId')
    expect(REQUEST_DEV_UPDATE_TOOL.inputSchema.properties).toHaveProperty('expectedIntegratedCommit')
  })

  it('rejects invalid or missing arguments', async () => {
    const mockService = {} as unknown as DevUpdateService
    const authority = createMockAuthority()

    const noArgs = await executeRequestDevUpdate(mockService, null, authority)
    expect(noArgs.isError).toBe(true)
    expect(textOf(noArgs.content)).toContain('INVALID_ARGUMENT')

    const missingInstance = await executeRequestDevUpdate(mockService, { operationId: 'op-1' }, authority)
    expect(missingInstance.isError).toBe(true)
    expect(textOf(missingInstance.content)).toContain('expectedInstanceId is required')

    const missingOp = await executeRequestDevUpdate(mockService, { expectedInstanceId: 'inst-1' }, authority)
    expect(missingOp.isError).toBe(true)
    expect(textOf(missingOp.content)).toContain('operationId is required')

    const unknownArg = await executeRequestDevUpdate(mockService, { operationId: 'op-1', expectedInstanceId: 'inst-1', force: true }, authority)
    expect(unknownArg.isError).toBe(true)
    expect(textOf(unknownArg.content)).toContain("Unknown argument 'force'")

    const invalidCommit = await executeRequestDevUpdate(mockService, { operationId: 'op-1', expectedInstanceId: 'inst-1', expectedIntegratedCommit: 'short' }, authority)
    expect(invalidCommit.isError).toBe(true)
    expect(textOf(invalidCommit.content)).toContain('expectedIntegratedCommit must be a valid git commit SHA')
  })

  it('rejects when agent authority is missing or inactive', async () => {
    const mockService = {} as unknown as DevUpdateService

    const noAuth = await executeRequestDevUpdate(mockService, { operationId: 'op-1', expectedInstanceId: 'inst-1' }, undefined)
    expect(noAuth.isError).toBe(true)
    expect(textOf(noAuth.content)).toContain('AGENT_UNAUTHORIZED')

    const inactiveAuth = createMockAuthority('repo-code-awareness', false)
    const inactive = await executeRequestDevUpdate(mockService, { operationId: 'op-1', expectedInstanceId: 'inst-1' }, inactiveAuth)
    expect(inactive.isError).toBe(true)
    expect(textOf(inactive.content)).toContain('AGENT_UNAUTHORIZED')
  })

  it('rejects repository mismatch when authority repo differs from target repo', async () => {
    const mockService = {} as unknown as DevUpdateService
    const otherRepoAuth = createMockAuthority('repo-other')

    const mismatch = await executeRequestDevUpdate(
      mockService,
      { operationId: 'op-1', expectedInstanceId: 'inst-1' },
      otherRepoAuth,
      'repo-code-awareness'
    )
    expect(mismatch.isError).toBe(true)
    expect(textOf(mismatch.content)).toContain('REPOSITORY_MISMATCH')
  })

  it('delegates to DevUpdateService and preserves postResponse before shutdown', async () => {
    const postResponseFn = vi.fn(async () => {})
    const mockService = {
      executeDevUpdate: vi.fn(async () => ({
        operationId: 'op-valid',
        status: 'SCHEDULED' as const,
        head: 'target-head-sha',
        oldInstanceId: 'inst-1',
        message: 'DevUpdate agendado com sucesso.',
        postResponse: postResponseFn
      }))
    } as unknown as DevUpdateService

    const authority = createMockAuthority('repo-code-awareness')
    const result = await executeRequestDevUpdate(
      mockService,
      {
        operationId: 'op-valid',
        expectedInstanceId: 'inst-1',
        expectedIntegratedCommit: 'abc1234567'
      },
      authority,
      'repo-code-awareness'
    )

    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(textOf(result.content))
    expect(payload.status).toBe('SCHEDULED')
    expect(payload.head).toBe('target-head-sha')
    expect(result.postResponse).toBeTypeOf('function')

    await result.postResponse?.()
    expect(postResponseFn).toHaveBeenCalled()

    expect(mockService.executeDevUpdate).toHaveBeenCalledWith({
      operationId: 'op-valid',
      expectedInstanceId: 'inst-1',
      expectedIntegratedCommit: 'abc1234567',
      caller: 'MCP'
    })
  })

  it('integrates with ChannelMcpAdapter: exposes unique request_dev_update tool without duplicating request_dev_sync and preserves request_runtime_restart', async () => {
    const mockDevUpdate = {
      executeDevUpdate: vi.fn(async () => ({
        operationId: 'op-adapter',
        status: 'ALREADY_CURRENT' as const,
        head: 'head-same',
        oldInstanceId: 'inst-1',
        message: 'Already up to date'
      }))
    } as unknown as DevUpdateService

    const mockRestart = {} as unknown as RuntimeRestartController

    const context: McpProjectContext = {
      projectId: 'p1',
      repoRoot: '/app',
      navigation: {} as any,
      devUpdateService: mockDevUpdate,
      runtimeRestart: mockRestart,
      continuum: { repositoryId: 'repo-code-awareness' } as any
    }

    const adapter = new ChannelMcpAdapter(context)
    const tools = adapter.listTools()
    expect(tools.filter(t => t.name === 'request_dev_update')).toHaveLength(1)
    expect(tools.some(t => t.name === 'request_dev_sync')).toBe(false)
    expect(tools.some(t => t.name === 'request_runtime_restart')).toBe(true)
    expect(adapter.capabilityForTool('request_dev_update')).toBe('Runtime Identity/Restart')
    expect(adapter.capabilityForTool('request_runtime_restart')).toBe('Runtime Identity/Restart')

    const authority = createMockAuthority('repo-code-awareness')
    const callResult = await adapter.callTool(
      'request_dev_update',
      { operationId: 'op-adapter', expectedInstanceId: 'inst-1' },
      undefined,
      authority
    )

    expect(callResult.isError).toBeFalsy()
    const data = JSON.parse(textOf(callResult.content))
    expect(data.status).toBe('ALREADY_CURRENT')
  })
})
