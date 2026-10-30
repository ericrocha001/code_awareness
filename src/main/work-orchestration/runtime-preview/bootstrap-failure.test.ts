import { it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PreviewSessionStore } from './session-store'
import { RuntimePreviewRunner } from './runner'
import { bytesFingerprint, previewFingerprint } from '../preview-profile'

async function launchFailure(content: (sessionId: string) => string | undefined) {
  const root = await mkdtemp(join(tmpdir(), 'bootstrap-durable-')), worktree = join(root, 'checkout')
  await mkdir(worktree)
  const store = new PreviewSessionStore(join(root, 'sessions'))
  const profile = { profileId: 'profile', repositoryId: 'repo', revision: 1, runtime: 'ELECTRON_DEV', env: {}, resources: [],
    command: { executable: process.execPath, executableHash: bytesFingerprint(await readFile(process.execPath)), cwd: '.', args: [], inputs: [] },
    security: { mode: 'profile_only', requirements: [] }, shutdown: { spawn: 'JOB_LIST_AT_CREATE', graceMs: 0, forceMs: 1000 } }
  const selection = { repositoryId: 'repo', worktreeId: 'tree', generation: 'generation', profileId: profile.profileId, fingerprint: previewFingerprint(profile) }
  const drained = { pid: 42, created: '123', rootSignaled: true, knownHandlesClosed: true, activeProcesses: 0, jobClosed: true, eventClosed: true, assignedAtCreation: true, ownerOutsideJob: true, phase: 'DRAINED' }
  const owner = { start: async (input: { sessionId: string; operationId: string; directory: string }) => {
    const value = content(input.sessionId)
    if (value !== undefined) await writeFile(join(store.runtime(input.sessionId), 'bootstrap-failure.json'), value)
    await writeFile(join(input.directory, 'native.jsonl'), JSON.stringify({ schemaVersion: 1, sessionId: input.sessionId, operationId: input.operationId,
      ownerPid: process.pid, ownerCreated: '123', phase: 'DRAINED', evidence: drained }) + '\n')
    throw Error('BOOTSTRAP_FAILURE')
  }, stop: vi.fn(async () => drained), shutdown: vi.fn(async () => {}) }
  const authority = { prepare: async () => ({ profile, worktree, gitFingerprint: 'source', preflight: { selection, profileRevision: 1, status: 'SUPPORTED' }, guard: async () => {} }) }
  const runner = new RuntimePreviewRunner(store, authority as any, {} as any)
  vi.spyOn(runner as any, 'owner').mockResolvedValue(owner)
  try {
    const result = await runner.start({ selection, operationId: randomUUID() })
    const persisted = new PreviewSessionStore(store.root).read(result.sessionId)
    expect(result).toMatchObject({ state: 'FAILED', resources: 'RELEASED' })
    expect(owner.stop).toHaveBeenCalledOnce()
    expect(owner.shutdown).toHaveBeenCalledOnce()
    expect(store.active()).toBeUndefined()
    await expect(access(store.runtime(result.sessionId))).rejects.toThrow()
    return persisted
  } finally { await rm(root, { recursive: true, force: true }) }
}

it('keeps the verified bootstrap cause and phase after private files are removed', async () => {
  const result = await launchFailure(sessionId => JSON.stringify({ sessionId, code: 'PREVIEW_CAPTURE_IDENTITY_MISMATCH', phase: 'CONTEXT_ACTIVATION' }))
  expect(result.failure).toBe('PREVIEW_CAPTURE_IDENTITY_MISMATCH')
  expect(result.termination).toMatchObject({ kind: 'STARTUP_FAILURE', reasonCode: result.failure, failurePhase: 'CONTEXT_ACTIVATION' })
  expect(result.termination?.supervisor.phase).toBe('DRAINED')
})

it('preserves a legacy verified code without inventing an absent phase', async () => {
  const result = await launchFailure(sessionId => JSON.stringify({ sessionId, code: 'PREVIEW_CONTEXT_IDENTITY_MISMATCH' }))
  expect(result.termination?.reasonCode).toBe('PREVIEW_CONTEXT_IDENTITY_MISMATCH')
  expect(result.termination?.failurePhase).toBeUndefined()
})

it.each([
  () => undefined,
  () => '{bad json',
  () => JSON.stringify({ sessionId: randomUUID(), code: 'PREVIEW_CAPTURE_IDENTITY_MISMATCH', phase: 'ELECTRON_BOOTSTRAP' }),
  (sessionId: string) => JSON.stringify({ sessionId, code: 'C:/PRIVATE_SECRET', phase: 'ELECTRON_BOOTSTRAP' }),
  (sessionId: string) => JSON.stringify({ sessionId, code: 'PREVIEW_CAPTURE_IDENTITY_MISMATCH', phase: 'PRIVATE_SECRET' }),
  (sessionId: string) => JSON.stringify({ sessionId, code: 'PREVIEW_CAPTURE_IDENTITY_MISMATCH', path: 'PRIVATE_SECRET' }),
  () => 'PRIVATE_SECRET'.repeat(1024)
])('ignores absent or invalid diagnostics without blocking cleanup (%#)', async content => {
  const result = await launchFailure(content)
  expect(result.failure).toBe('BOOTSTRAP_FAILURE')
  expect(result.termination?.reasonCode).toBe('BOOTSTRAP_FAILURE')
  expect(result.termination?.failurePhase).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain('PRIVATE_SECRET')
})
