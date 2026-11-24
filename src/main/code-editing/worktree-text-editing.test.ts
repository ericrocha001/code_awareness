import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { focalDiff } from './focal-diff'
import { executeWorktreeTextEditing, WORKTREE_TEXT_EDITING_TOOLS } from './worktree-text-editing-mcp'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import type { GitOperationsService } from '../git-operations/git-operations-service'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'

const hex64 = (ch: string) => ch.repeat(64)
const validArgs = () => ({
  worktreeId: hex64('a'),
  generation: hex64('b'),
  leaseId: 'lease-1',
  leaseCredential: hex64('c'),
  operationId: 'op-1',
  snapshot: {
    branch: 'feat/test',
    head: 'd'.repeat(40),
    indexRevision: hex64('e'),
    worktreeRevision: hex64('f'),
    operation: null
  },
  intent: { description: 'Surgical fix' },
  changes: [
    { operation: 'CREATE', path: 'src/new.ts', text: 'export const x = 1\n' }
  ]
})

describe('code editing unit contracts', () => {
  it('bounds focal unified diff strictly at 8 KiB with explicit truncation flag', () => {
    const small = focalDiff([{ path: 'a.ts', before: 'const a = 1\n', after: 'const a = 2\n' }])
    expect(small.truncated).toBe(false)
    expect(small.bytes).toBeLessThanOrEqual(8192)
    expect(small.patch).toContain('--- a.ts')
    expect(small.patch).toContain('-const a = 1')
    expect(small.patch).toContain('+const a = 2')

    const largeText = Array.from({ length: 400 }, (_, i) => `export const line_${i} = "ação_${i}"`).join('\n')
    const large = focalDiff([{ path: 'big.ts', before: '', after: largeText }])
    expect(large.truncated).toBe(true)
    expect(large.bytes).toBeLessThanOrEqual(8192)
    expect(Buffer.byteLength(large.patch, 'utf8')).toBe(large.bytes)
  })

  it('rejects malformed inputs, extra keys, oversized payloads, and authority worktree conflicts before calling GitOperationsService', async () => {
    const executeWorktreeEdit = vi.fn()
    const service = { executeWorktreeEdit } as unknown as GitOperationsService

    const badPayloads: unknown[] = [
      null,
      [],
      { ...validArgs(), extra: true },
      { ...validArgs(), worktreeId: 'bad' },
      { ...validArgs(), intent: { description: 'ok', explicitUserAuthorization: true } },
      { ...validArgs(), changes: [] },
      { ...validArgs(), changes: [{ operation: 'DELETE', path: 'a.ts' }] },
      { ...validArgs(), changes: [{ operation: 'EDIT', path: 'a.ts', expectedSha256: hex64('1'), replacements: [{ oldText: '', newText: 'x' }] }] },
      { ...validArgs(), changes: [{ operation: 'CREATE', path: 'a.ts', text: 'x', overwrite: true }] }
    ]
    for (const payload of badPayloads) {
      const res = await executeWorktreeTextEditing(service, payload)
      expect(res.isError).toBe(true)
      expect(JSON.parse(res.content[0].text)).toMatchObject({ code: 'INVALID_ARGUMENT' })
    }

    const tooLarge = validArgs()
    tooLarge.changes = [{ operation: 'CREATE', path: 'a.ts', text: 'x'.repeat(1024 * 1024 + 1) }]
    const largeRes = await executeWorktreeTextEditing(service, tooLarge)
    expect(largeRes.isError).toBe(true)
    expect(JSON.parse(largeRes.content[0].text)).toMatchObject({ code: 'REQUEST_TOO_LARGE' })

    const authority = authorizeArtifactAgent(authenticatedAgentPrincipal('MCP', () => true), 'repo-1', () => true, hex64('9'))
    const conflictRes = await executeWorktreeTextEditing(service, validArgs(), authority)
    expect(conflictRes.isError).toBe(true)
    expect(JSON.parse(conflictRes.content[0].text)).toMatchObject({ code: 'DELIVERY_CONTEXT_INVALID', reason: 'WORKTREE_SCOPE_CONFLICT' })
    expect(executeWorktreeEdit).not.toHaveBeenCalled()
  })

  it('registers edit_worktree_text under Code Editing capability in ChannelMcpAdapter without exposing credentials', async () => {
    const executeWorktreeEdit = vi.fn(async (_request: unknown, _fingerprintArgs: Record<string, unknown>) => ({ value: { code: 'WORKTREE_OWNERSHIP_REQUIRED' }, isError: true as const }))
    const adapter = new ChannelMcpAdapter({
      projectId: 'p',
      repoRoot: 'r',
      navigation: {} as ProjectContextNavigation,
      gitOperations: { executeWorktreeEdit } as unknown as GitOperationsService
    })
    expect(adapter.capabilityForTool('edit_worktree_text')).toBe('Code Editing')
    const tool = adapter.listTools().find(item => item.name === 'edit_worktree_text')
    expect(tool).toEqual(WORKTREE_TEXT_EDITING_TOOLS[0])
    expect(tool!.inputSchema.additionalProperties).toBe(false)

    const args = validArgs()
    await adapter.callTool('edit_worktree_text', args)
    expect(executeWorktreeEdit).toHaveBeenCalledTimes(1)
    const [, fingerprintArgs] = executeWorktreeEdit.mock.calls[0]
    expect(fingerprintArgs).not.toHaveProperty('leaseCredential')
    expect(createHash('sha256').update(JSON.stringify(fingerprintArgs)).digest('hex')).toHaveLength(64)
  })
})
