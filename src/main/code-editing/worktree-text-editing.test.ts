import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { focalDiff } from './focal-diff'
import { executeWorktreeTextEditing, WORKTREE_TEXT_EDITING_TOOLS } from './worktree-text-editing-mcp'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import { GitOperationsService } from '../git-operations/git-operations-service'
import type { GitService } from '../core/git-service'
import type { GitRemoteTransport } from '../core/git-remote-transport'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'

const hex64 = (ch: string) => ch.repeat(64)
const validArgs = () => ({
  worktreeId: hex64('a'),
  generation: hex64('b'),
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
      { ...validArgs(), leaseId: 'only-one-half' },
      { ...validArgs(), leaseCredential: hex64('c') },
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
    expect(tool!.inputSchema.required).not.toContain('leaseId')
    expect(tool!.inputSchema.required).not.toContain('leaseCredential')

    const args = validArgs()
    await adapter.callTool('edit_worktree_text', args)
    expect(executeWorktreeEdit).toHaveBeenCalledTimes(1)
    const [, fingerprintArgs] = executeWorktreeEdit.mock.calls[0]
    expect(fingerprintArgs).not.toHaveProperty('leaseCredential')
    expect(createHash('sha256').update(JSON.stringify(fingerprintArgs)).digest('hex')).toHaveLength(64)
  })

  it('revalidates only the target worktree across 30 siblings and separates deadline/authority/repo causes', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'wt-siblings-'))
    try {
      const common = join(temp, 'repo/.git')
      const targetRoot = join(temp, 'wt-target')
      const targetAdmin = join(common, 'worktrees/wt-target')
      mkdirSync(common, { recursive: true })
      mkdirSync(targetAdmin, { recursive: true })
      mkdirSync(join(targetRoot, 'src'), { recursive: true })
      writeFileSync(join(targetRoot, 'src/a.ts'), 'const a = 1\n')
      writeFileSync(join(targetRoot, 'src/b.ts'), 'const b = 1\n')

      const siblings = Array.from({ length: 30 }, (_, idx) => {
        const wtPath = join(temp, `wt-sibling-${idx}`)
        const wtAdmin = join(common, `worktrees/wt-sibling-${idx}`)
        mkdirSync(wtPath, { recursive: true })
        mkdirSync(wtAdmin, { recursive: true })
        return { path: wtPath, admin: wtAdmin, branch: `sibling-${idx}` }
      })

      const porcelain = [
        `worktree ${targetRoot}\0HEAD ${'1'.repeat(40)}\0branch refs/heads/feat/target`,
        ...siblings.map(s => `worktree ${s.path}\0HEAD ${'2'.repeat(40)}\0branch refs/heads/${s.branch}`)
      ].join('\0\0') + '\0\0'

      const dirLookups = new Map<string, number>()
      const receipts = new Map<string, any>()
      let currentForeignRevision = hex64('7')
      const getUpstreamState = vi.fn(async () => ({ upstream: null, ahead: 0, behind: 0 }))
      const getWorktreeRevision = vi.fn(async () => hex64('4'))
      const getOperationsStatus = vi.fn(async () => '')
      const captureWorktreeEditObservation = vi.fn(async (_dir: string, _excluded: string[], opts?: { includeWorktreeRevision?: boolean }) => ({
        snapshot: {
          branch: 'feat/target',
          head: '1'.repeat(40),
          indexRevision: hex64('3'),
          worktreeRevision: opts?.includeWorktreeRevision === false ? '' : hex64('4'),
          operation: null
        },
        foreignRevision: currentForeignRevision
      }))
      const fakeGit = {
        getCommonDirectory: async () => common,
        getWorktreeDirectory: async () => targetAdmin,
        getWorktreeRoot: async () => targetRoot,
        getUpstreamState,
        getRepositoryDirectories: async (p: string) => {
          dirLookups.set(p, (dirLookups.get(p) ?? 0) + 1)
          if (p === targetRoot) return { common, admin: targetAdmin }
          const sib = siblings.find(s => s.path === p)
          return { common, admin: sib ? sib.admin : common }
        },
        listWorktreeRecords: async () => porcelain,
        getCurrentCommitHash: async () => '1'.repeat(40),
        getCurrentBranch: async () => 'feat/target',
        getGitOperation: async () => null,
        getIndexRevision: async () => hex64('3'),
        getOperationsStatus,
        getWorktreeRevision,
        getWorktreeRevisionExcluding: async () => currentForeignRevision,
        captureWorktreeEditObservation,
        isGitRepository: async () => true,
        readOperationReceipt: async (_root: string, id: string) => receipts.get(id) ?? null,
        prepareOperationReceipt: async (_root: string, r: any) => {
          const entry = { receipt: r, sha: hex64('5') }
          receipts.set(r.operationId, entry)
          return { created: true, ...entry }
        },
        completeOperationReceipt: async (_root: string, r: any) => {
          receipts.set(r.operationId, { receipt: r, sha: hex64('6') })
        }
      } as unknown as GitService

      let repoActive = true
      const service = new GitOperationsService(
        targetRoot,
        fakeGit,
        {} as GitRemoteTransport,
        { repositoryId: 'repo-sib', isActive: () => repoActive }
      )

      const discovered = await service.discoverWorktrees()
      expect(discovered.worktrees).toHaveLength(31)
      dirLookups.clear() // Measure ONLY edit_worktree_text revalidations after discovery

      const shaA = createHash('sha256').update('const a = 1\n').digest('hex')
      const shaB = createHash('sha256').update('const b = 1\n').digest('hex')
      const targetWt = discovered.worktrees.find(w => w.path === targetRoot)!
      const snapshot = {
        branch: 'feat/target',
        head: '1'.repeat(40),
        indexRevision: hex64('3'),
        worktreeRevision: hex64('4'),
        operation: null
      }

      let authorityActive = true
      const authority = authorizeArtifactAgent(
        authenticatedAgentPrincipal('MCP', () => authorityActive),
        'repo-sib',
        () => authorityActive
      )

      const ok = await executeWorktreeTextEditing(service, {
        worktreeId: targetWt.worktreeId,
        generation: targetWt.generation,
        operationId: 'op-sib-ok',
        snapshot,
        intent: { description: '3-file edit with 30 siblings' },
        changes: [
          { operation: 'EDIT', path: 'src/a.ts', expectedSha256: shaA, replacements: [{ oldText: '= 1', newText: '= 2' }] },
          { operation: 'EDIT', path: 'src/b.ts', expectedSha256: shaB, replacements: [{ oldText: '= 1', newText: '= 2' }] },
          { operation: 'CREATE', path: 'src/c.ts', text: 'export const c = 3\n' }
        ]
      }, authority, Date.now() + 20_000)
      expect(ok.isError).toBeUndefined()
      expect(JSON.parse(ok.content[0].text)).toMatchObject({ state: 'APPLIED' })

      // Sibling directory lookups, upstream queries, getChanges/status and legacy getWorktreeRevision must be ZERO during edit_worktree_text
      for (const sib of siblings) {
        expect(dirLookups.get(sib.path) ?? 0).toBe(0)
      }
      expect(getUpstreamState).not.toHaveBeenCalled()
      expect(getWorktreeRevision).not.toHaveBeenCalled()
      expect(getOperationsStatus).not.toHaveBeenCalled()
      expect(captureWorktreeEditObservation).toHaveBeenCalledTimes(5) // 1 entry + 3 beforePublish + 1 finalCheck (which also yields snapshotAfter)
      expect(readFileSync(join(targetRoot, 'src/c.ts'), 'utf8')).toBe('export const c = 3\n')

      // Expired deadline -> REQUEST_TIMEOUT (not REPOSITORY_CONTEXT_CHANGED)
      const timedOut = await executeWorktreeTextEditing(service, {
        worktreeId: targetWt.worktreeId,
        generation: targetWt.generation,
        operationId: 'op-sib-timeout',
        snapshot,
        intent: { description: 'Expired deadline' },
        changes: [{ operation: 'CREATE', path: 'src/d.ts', text: 'x' }]
      }, authority, Date.now() - 1)
      expect(timedOut.isError).toBe(true)
      expect(JSON.parse(timedOut.content[0].text)).toMatchObject({ code: 'REQUEST_TIMEOUT', reason: 'DEADLINE_EXCEEDED' })

      // Authority closed -> AGENT_UNAUTHORIZED (not REPOSITORY_CONTEXT_CHANGED)
      authorityActive = false
      const lostAuth = await executeWorktreeTextEditing(service, {
        worktreeId: targetWt.worktreeId,
        generation: targetWt.generation,
        operationId: 'op-sib-auth',
        snapshot,
        intent: { description: 'Closed authority' },
        changes: [{ operation: 'CREATE', path: 'src/d.ts', text: 'x' }]
      }, authority, Date.now() + 20_000)
      expect(lostAuth.isError).toBe(true)
      expect(JSON.parse(lostAuth.content[0].text)).toMatchObject({ code: 'AGENT_UNAUTHORIZED', reason: 'AUTHORITY_INACTIVE' })

      // Repo context changed -> REPOSITORY_CONTEXT_CHANGED
      authorityActive = true
      repoActive = false
      const lostRepo = await executeWorktreeTextEditing(service, {
        worktreeId: targetWt.worktreeId,
        generation: targetWt.generation,
        operationId: 'op-sib-repo',
        snapshot,
        intent: { description: 'Inactive repo' },
        changes: [{ operation: 'CREATE', path: 'src/d.ts', text: 'x' }]
      }, authority, Date.now() + 20_000)
      expect(lostRepo.isError).toBe(true)
      expect(JSON.parse(lostRepo.content[0].text)).toMatchObject({ code: 'WORKTREE_REPOSITORY_CHANGED' })
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }, 30_000)
})
