import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  cleanupTempRepo,
  commit,
  createTempDir,
  createTempGitRepo,
  gitExec,
  stageAll,
  type GitExecError
} from './git-test-helpers'
import { cleanupTestDir, createTempRepo } from './test-helpers'
import { safeCleanupTempDir } from './temp-cleanup'

const manualRoots: string[] = []

afterEach(async () => {
  for (const dir of manualRoots.splice(0).reverse()) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    } catch {}
  }
})

function makeManualDir(prefix: string): string {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), prefix))
  manualRoots.push(dir)
  return dir
}

describe('U1 gitExec confirmed termination', () => {
  it('waits for child termination on timeout and cancellation before allowing cleanup', async () => {
    const repo = await createTempGitRepo()
    try {
      const pidFile = join(repo, 'child.pid')
      const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setTimeout(()=>{}, 30000)`
      const aliasCmd = `!"${process.execPath.replace(/\\/g, '/')}" -e "${script.replace(/"/g, '\\"')}"`

      let caughtTimeout: GitExecError | undefined
      try {
        await gitExec(repo, ['-c', `alias.hang=${aliasCmd}`, 'hang'], {
          timeoutMs: 120,
          terminationWaitMs: 3000
        })
      } catch (error) {
        caughtTimeout = error as GitExecError
      }

      expect(caughtTimeout).toBeDefined()
      expect(caughtTimeout?.timedOut).toBe(true)
      expect(caughtTimeout?.terminatedConfirmed).toBe(true)
      expect(caughtTimeout?.message).toContain('encerramento confirmado')

      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8').trim())
        expect(() => process.kill(pid, 0)).toThrow()
      }

      const cleanupAfterTimeout = await safeCleanupTempDir(repo)
      expect(cleanupAfterTimeout.ok).toBe(true)
      expect(existsSync(repo)).toBe(false)
    } finally {
      await cleanupTempRepo(repo)
    }

    const repo2 = await createTempGitRepo()
    try {
      const controller = new AbortController()
      const aliasCmd = `!"${process.execPath.replace(/\\/g, '/')}" -e "setTimeout(()=>{}, 30000)"`
      setTimeout(() => controller.abort(), 80)

      let caughtAbort: GitExecError | undefined
      try {
        await gitExec(repo2, ['-c', `alias.hang=${aliasCmd}`, 'hang'], {
          timeoutMs: 10_000,
          terminationWaitMs: 3000,
          signal: controller.signal
        })
      } catch (error) {
        caughtAbort = error as GitExecError
      }

      expect(caughtAbort).toBeDefined()
      expect(caughtAbort?.cancelled).toBe(true)
      expect(caughtAbort?.terminatedConfirmed).toBe(true)
    } finally {
      const res = await safeCleanupTempDir(repo2)
      expect(res.ok).toBe(true)
    }
  }, 20_000)

  it('reports unconfirmed termination honestly when child close exceeds terminationWaitMs', async () => {
    const repo = await createTempGitRepo()
    const pidFile = join(repo, 'slow-child.pid')
    let spawnedPid: number | undefined
    try {
      const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setTimeout(()=>{}, 400)`
      const aliasCmd = `!"${process.execPath.replace(/\\/g, '/')}" -e "${script.replace(/"/g, '\\"')}"`

      let caught: GitExecError | undefined
      try {
        await gitExec(repo, ['-c', `alias.hang=${aliasCmd}`, 'hang'], {
          timeoutMs: 40,
          terminationWaitMs: 1
        })
      } catch (error) {
        caught = error as GitExecError
      }

      expect(caught).toBeDefined()
      expect(caught?.timedOut).toBe(true)
      expect(caught?.terminatedConfirmed).toBe(false)
      expect(caught?.message).toContain('término não confirmado')
      if (existsSync(pidFile)) {
        spawnedPid = Number(readFileSync(pidFile, 'utf8').trim())
      }
    } finally {
      if (spawnedPid) {
        for (let i = 0; i < 40; i++) {
          try {
            process.kill(spawnedPid, 0)
            await new Promise(resolveWait => setTimeout(resolveWait, 30))
          } catch {
            break
          }
        }
      }
      const res = await safeCleanupTempDir(repo, { maxAttempts: 6, maxDurationMs: 2500 })
      expect(res.ok).toBe(true)
    }
  }, 20_000)
})

describe('U2 safe temp repo and fixture cleanup', () => {
  it('cleans real git repos with ReadOnly objects cleanly, is idempotent, and supports cleanupTestDir', async () => {
    const repo = await createTempGitRepo()
    writeFileSync(join(repo, 'file.txt'), 'hello readonly\n')
    await stageAll(repo)
    await commit(repo, 'add file')

    const readOnlySentinel = join(repo, '.git', 'objects', 'readonly-sentinel')
    writeFileSync(readOnlySentinel, 'locked-by-attr')
    chmodSync(readOnlySentinel, 0o444)

    const removed = await safeCleanupTempDir(repo)
    expect(removed.ok).toBe(true)
    expect(removed.status).toBe('REMOVED')
    expect(removed.clearedReadOnlyCount).toBeGreaterThanOrEqual(1)
    expect(existsSync(repo)).toBe(false)

    const second = await safeCleanupTempDir(repo)
    expect(second).toMatchObject({ ok: true, status: 'ALREADY_ABSENT' })

    const plain = createTempRepo()
    writeFileSync(join(plain, 'a.ts'), 'export const x = 1\n')
    await cleanupTestDir(plain)
    expect(existsSync(plain)).toBe(false)
  })

  it('recovers from transient locks and preserves original errors on persistent lock failure', async () => {
    const transientDir = createTempDir('cleanup-transient-')
    const holder = spawn(
      process.execPath,
      ['-e', "process.stdout.write('R');setTimeout(()=>{},120)"],
      { cwd: transientDir, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
    )
    const holderClosed = new Promise<void>(resolveClose => holder.once('close', () => resolveClose()))
    await new Promise<void>(resolveReady => holder.stdout.once('data', () => resolveReady()))

    const recovered = await safeCleanupTempDir(transientDir, { maxAttempts: 6, maxDurationMs: 2500 })
    await holderClosed
    expect(recovered.ok).toBe(true)
    expect(recovered.status).toBe('REMOVED')
    expect(recovered.attempts).toBeGreaterThanOrEqual(2)

    const persistentDir = createTempDir('cleanup-persistent-')
    const persistentHolder = spawn(
      process.execPath,
      ['-e', "process.stdout.write('L');setTimeout(()=>{},15000)"],
      { cwd: persistentDir, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
    )
    const persistentClosed = new Promise<void>(resolveClose => persistentHolder.once('close', () => resolveClose()))
    await new Promise<void>(resolveReady => persistentHolder.stdout.once('data', () => resolveReady()))

    const runFailingTest = async () => {
      try {
        throw new Error('ORIGINAL_TEST_FAILURE')
      } finally {
        await cleanupTempRepo(persistentDir, { maxAttempts: 2, maxDurationMs: 120 })
      }
    }

    try {
      await expect(runFailingTest()).rejects.toThrow('ORIGINAL_TEST_FAILURE')
      expect(existsSync(persistentDir)).toBe(true)

      const failedResult = await safeCleanupTempDir(persistentDir, { maxAttempts: 2, maxDurationMs: 120 })
      expect(failedResult.ok).toBe(false)
      expect(failedResult.status).toBe('FAILED')

      await expect(
        cleanupTempRepo(persistentDir, { maxAttempts: 2, maxDurationMs: 120, strict: true })
      ).rejects.toThrow(/Cleanup failed/)
    } finally {
      persistentHolder.kill('SIGKILL')
      await persistentClosed
      await cleanupTempRepo(persistentDir)
    }
  })

  it('refuses paths outside temp root, temp root itself, unowned dirs, and recycled identities', async () => {
    const external = resolve(process.cwd(), 'src')
    expect(await safeCleanupTempDir(external)).toMatchObject({ ok: false, status: 'REFUSED', reason: 'OUTSIDE_TEMP_ROOT' })
    expect(existsSync(external)).toBe(true)

    expect(await safeCleanupTempDir(tmpdir())).toMatchObject({ ok: false, status: 'REFUSED', reason: 'TEMP_ROOT_FORBIDDEN' })

    const unowned = makeManualDir('unowned-fixture-')
    const unownedSentinel = join(unowned, 'keep.txt')
    writeFileSync(unownedSentinel, 'do-not-delete')
    expect(await safeCleanupTempDir(unowned)).toMatchObject({ ok: false, status: 'REFUSED', reason: 'UNOWNED_FIXTURE' })
    expect(readFileSync(unownedSentinel, 'utf8')).toBe('do-not-delete')

    const recycled = createTempDir('recycled-fixture-')
    expect(await safeCleanupTempDir(recycled)).toMatchObject({ ok: true, status: 'REMOVED' })
    mkdirSync(recycled)
    manualRoots.push(recycled)
    const recycledSentinel = join(recycled, 'recreated.txt')
    writeFileSync(recycledSentinel, 'recreated-by-other')
    expect(await safeCleanupTempDir(recycled)).toMatchObject({ ok: false, status: 'REFUSED', reason: 'IDENTITY_MISMATCH' })
    expect(readFileSync(recycledSentinel, 'utf8')).toBe('recreated-by-other')
  })

  it('never follows root or nested junctions/symlinks or external gitdir pointers', async () => {
    const externalTarget = makeManualDir('external-target-')
    const externalSentinel = join(externalTarget, 'precious.txt')
    writeFileSync(externalSentinel, 'untouched')

    const tempBase = realpathSync.native(tmpdir())
    const rootLink = join(tempBase, `root-link-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    symlinkSync(externalTarget, rootLink, process.platform === 'win32' ? 'junction' : 'dir')
    manualRoots.push(rootLink)
    expect(await safeCleanupTempDir(rootLink)).toMatchObject({
      ok: false,
      status: 'REFUSED',
      reason: 'SYMLINK_OR_JUNCTION_REJECTED'
    })
    expect(readFileSync(externalSentinel, 'utf8')).toBe('untouched')

    const ownedWithNested = createTempDir('nested-junction-')
    symlinkSync(externalTarget, join(ownedWithNested, 'link-out'), process.platform === 'win32' ? 'junction' : 'dir')
    const nestedRes = await safeCleanupTempDir(ownedWithNested)
    expect(nestedRes).toMatchObject({ ok: true, status: 'REMOVED' })
    expect(existsSync(ownedWithNested)).toBe(false)
    expect(readFileSync(externalSentinel, 'utf8')).toBe('untouched')

    const fakeWorktree = createTempDir('external-gitdir-')
    writeFileSync(join(fakeWorktree, '.git'), `gitdir: ${externalTarget}\n`)
    writeFileSync(join(fakeWorktree, 'work.txt'), 'local-work')
    expect(await safeCleanupTempDir(fakeWorktree)).toMatchObject({ ok: true, status: 'REMOVED' })
    expect(existsSync(fakeWorktree)).toBe(false)
    expect(readFileSync(externalSentinel, 'utf8')).toBe('untouched')
  })
})
