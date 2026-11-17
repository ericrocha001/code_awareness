import { execFile, spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  linkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  cleanupTempRepo,
  cloneTempGitRepoIsolated,
  commit,
  createTempDir,
  createTempGitRepo,
  gitExec,
  registerTempDir,
  stageAll,
  type GitExecError
} from './git-test-helpers'
import { cleanupTestDir, createTempRepo } from './test-helpers'
import { safeCleanupTempDir } from './temp-cleanup'

const manualRoots: Array<{ path: string; onCleanup?: () => void }> = []

afterEach(async () => {
  for (const entry of manualRoots.splice(0).reverse()) {
    try { entry.onCleanup?.() } catch {}
    try {
      rmSync(entry.path, { recursive: true, force: true, maxRetries: 5 })
    } catch {}
  }
})

function makeManualDir(prefix: string, onCleanup?: () => void): string {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), prefix))
  manualRoots.push({ path: dir, onCleanup })
  return dir
}

async function waitPidDead(pid: number, maxChecks = 40): Promise<boolean> {
  for (let i = 0; i < maxChecks; i++) {
    try {
      process.kill(pid, 0)
      await new Promise(resolveWait => setTimeout(resolveWait, 40))
    } catch {
      return true
    }
  }
  return false
}

describe('U1/C2 gitExec tree termination confirmation and fixture lock guard', () => {
  it('kills leader and descendant holding a fixture handle on timeout and cancellation before allowing cleanup', async () => {
    const repo = await createTempGitRepo()
    try {
      const parentPidFile = join(repo, 'parent.pid')
      const grandchildPidFile = join(repo, 'grandchild.pid')
      const lockedSubdir = join(repo, 'held-dir')
      mkdirSync(lockedSubdir)

      const runnerScript = join(repo, 'parent-runner.cjs')
      const grandchildScript = join(repo, 'grandchild-runner.cjs')
      writeFileSync(
        grandchildScript,
        `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(grandchildPidFile)},String(process.pid));setTimeout(()=>{},30000)`
      )
      writeFileSync(
        runnerScript,
        `const fs=require('node:fs');const{spawn}=require('node:child_process');fs.writeFileSync(${JSON.stringify(parentPidFile)},String(process.pid));spawn(process.execPath,[${JSON.stringify(grandchildScript)}],{cwd:${JSON.stringify(lockedSubdir)},stdio:'ignore',windowsHide:true});setTimeout(()=>{},30000)`
      )
      const aliasCmd = `!"${process.execPath.replace(/\\/g, '/')}" "${runnerScript.replace(/\\/g, '/')}"`

      let caughtTimeout: GitExecError | undefined
      try {
        await gitExec(repo, ['-c', `alias.hang=${aliasCmd}`, 'hang'], {
          timeoutMs: 700,
          terminationWaitMs: 4000
        })
      } catch (error) {
        caughtTimeout = error as GitExecError
      }

      expect(caughtTimeout, caughtTimeout?.message).toBeDefined()
      expect(caughtTimeout?.timedOut, caughtTimeout?.message).toBe(true)
      expect(caughtTimeout?.terminatedConfirmed, caughtTimeout?.message).toBe(true)
      expect(caughtTimeout?.message).toContain('encerramento confirmado')

      if (existsSync(parentPidFile)) {
        const parentPid = Number(readFileSync(parentPidFile, 'utf8').trim())
        expect(() => process.kill(parentPid, 0)).toThrow()
      }
      if (existsSync(grandchildPidFile)) {
        const grandchildPid = Number(readFileSync(grandchildPidFile, 'utf8').trim())
        expect(() => process.kill(grandchildPid, 0)).toThrow()
      }

      const cleanupAfterTimeout = await safeCleanupTempDir(repo)
      expect(cleanupAfterTimeout.ok).toBe(true)
      expect(cleanupAfterTimeout.status).toBe('REMOVED')
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
  }, 25_000)

  it('distinguishes leader close from tree confirmation and blocks cleanup until real tree confirmation', async () => {
    const repo = await createTempGitRepo()
    const independent = await createTempGitRepo()
    writeFileSync(join(repo, 'keep.txt'), 'protected-during-unconfirmed')

    let releaseFakeTree!: () => void
    const treeGate = new Promise<void>(resolveGate => { releaseFakeTree = resolveGate })
    let caughtWaitTimeout: GitExecError | undefined
    const shortPidFile = join(repo, 'short.pid')
    const shortScript = join(repo, 'short-runner.cjs')
    writeFileSync(
      shortScript,
      `require('node:fs').writeFileSync(${JSON.stringify(shortPidFile)},String(process.pid));setTimeout(()=>{},10000)`
    )
    const aliasShortExit = `!"${process.execPath.replace(/\\/g, '/')}" "${shortScript.replace(/\\/g, '/')}"`
    const abortCtrl = new AbortController()

    const execPromise = gitExec(repo, ['-c', `alias.hang=${aliasShortExit}`, 'hang'], {
      timeoutMs: 10_000,
      terminationWaitMs: 20,
      signal: abortCtrl.signal,
      terminateTree: async (pid, waitMs) => {
        await treeGate
        if (process.platform === 'win32') {
          return new Promise(resolveTerm => {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: Math.max(2000, waitMs) }, err => {
              resolveTerm({ confirmed: !err, reason: err?.message })
            })
          })
        }
        try { process.kill(-pid, 'SIGKILL') } catch {}
        return { confirmed: true }
      }
    })

    // Garante que a árvore git->sh->node iniciou antes do cancelamento.
    for (let i = 0; i < 60 && !existsSync(shortPidFile); i++) {
      await new Promise(resolveWait => setTimeout(resolveWait, 30))
    }
    expect(existsSync(shortPidFile)).toBe(true)
    abortCtrl.abort()

    try {
      await execPromise
    } catch (error) {
      caughtWaitTimeout = error as GitExecError
    }

    expect(caughtWaitTimeout).toBeDefined()
    expect(caughtWaitTimeout?.cancelled).toBe(true)
    expect(caughtWaitTimeout?.terminatedConfirmed).toBe(false)
    expect(caughtWaitTimeout?.message).toContain('término não confirmado')

    // Enquanto tree confirmation e leader close não forem confirmados, cleanup da fixture deve recusar.
    const refusedDuringPending = await safeCleanupTempDir(repo)
    expect(refusedDuringPending).toMatchObject({
      ok: false,
      status: 'REFUSED',
      reason: 'ACTIVE_PROCESS_UNCONFIRMED'
    })
    expect(readFileSync(join(repo, 'keep.txt'), 'utf8')).toBe('protected-during-unconfirmed')

    // Outra fixture independente continua limpando normalmente.
    expect(await safeCleanupTempDir(independent)).toMatchObject({ ok: true, status: 'REMOVED' })

    // Após confirmação real do encerramento (árvore confirmada + processo líder fechado), cleanup é liberado.
    releaseFakeTree()
    const shortPid = Number(readFileSync(shortPidFile, 'utf8').trim())
    await waitPidDead(shortPid)
    let released = await safeCleanupTempDir(repo, { maxAttempts: 6, maxDurationMs: 2500 })
    if (!released.ok) {
      await new Promise(resolveWait => setTimeout(resolveWait, 150))
      released = await safeCleanupTempDir(repo, { maxAttempts: 6, maxDurationMs: 2500 })
    }
    expect(released).toMatchObject({ ok: true, status: 'REMOVED' })

    // Caso de falha ao sinalizar árvore mesmo quando processo líder emite close: deve recusar cleanup permanentemente.
    const ownedProtected = createTempDir('git-signal-fail-owned-')
    manualRoots.push({ path: ownedProtected })
    writeFileSync(join(ownedProtected, 'keep.txt'), 'must-stay-intact')

    const failLeaderScript = join(ownedProtected, 'fail-leader.cjs')
    const failPidFile = join(ownedProtected, 'fail.pid')
    writeFileSync(
      failLeaderScript,
      `require('node:fs').writeFileSync(${JSON.stringify(failPidFile)},String(process.pid));setTimeout(()=>{},120)`
    )
    const failAlias = `!"${process.execPath.replace(/\\/g, '/')}" "${failLeaderScript.replace(/\\/g, '/')}"`

    let caughtSignalFail: GitExecError | undefined
    try {
      await gitExec(ownedProtected, ['-c', `alias.quick=${failAlias}`, 'quick'], {
        timeoutMs: 80,
        terminationWaitMs: 500,
        terminateTree: async () => ({ confirmed: false, reason: 'TASKKILL_FAILED' })
      })
    } catch (error) {
      caughtSignalFail = error as GitExecError
    }

    expect(caughtSignalFail).toBeDefined()
    expect(caughtSignalFail?.terminatedConfirmed).toBe(false)
    expect(await safeCleanupTempDir(ownedProtected)).toMatchObject({
      ok: false,
      status: 'REFUSED',
      reason: 'ACTIVE_PROCESS_UNCONFIRMED'
    })
    expect(readFileSync(join(ownedProtected, 'keep.txt'), 'utf8')).toBe('must-stay-intact')
    if (existsSync(failPidFile)) {
      await waitPidDead(Number(readFileSync(failPidFile, 'utf8').trim()))
    }
  }, 20_000)

  it('handles unconfirmed real termination wait budget and spawn failure without pid separately', async () => {
    const repo = await createTempGitRepo()
    const pidFile = join(repo, 'slow-child.pid')
    const slowScript = join(repo, 'slow-child.cjs')
    try {
      writeFileSync(
        slowScript,
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},15000)`
      )
      const aliasCmd = `!"${process.execPath.replace(/\\/g, '/')}" "${slowScript.replace(/\\/g, '/')}"`

      let caught: GitExecError | undefined
      try {
        await gitExec(repo, ['-c', `alias.hang=${aliasCmd}`, 'hang'], {
          timeoutMs: 600,
          terminationWaitMs: 1
        })
      } catch (error) {
        caught = error as GitExecError
      }

      expect(caught).toBeDefined()
      expect(caught?.timedOut).toBe(true)
      expect(caught?.terminatedConfirmed).toBe(false)
      expect(caught?.message).toContain('término não confirmado')
      // Antes da confirmação tardia do taskkill real, o cleanup também recusa.
      expect(await safeCleanupTempDir(repo)).toMatchObject({
        ok: false,
        status: 'REFUSED',
        reason: 'ACTIVE_PROCESS_UNCONFIRMED'
      })

      if (existsSync(pidFile)) {
        await waitPidDead(Number(readFileSync(pidFile, 'utf8').trim()))
      }
      // Após o encerramento real ser confirmado pelo taskkill/close pendente, cleanup é liberado.
      let res = await safeCleanupTempDir(repo, { maxAttempts: 6, maxDurationMs: 2500 })
      for (let i = 0; !res.ok && i < 10; i++) {
        await new Promise(resolveWait => setTimeout(resolveWait, 100))
        res = await safeCleanupTempDir(repo, { maxAttempts: 6, maxDurationMs: 2500 })
      }
      expect(res.ok).toBe(true)
    } finally {
      await cleanupTempRepo(repo)
    }

    // Spawn failure sem processo efetivo (cwd inexistente -> !proc.pid) não trava cleanup futuro.
    const missingCwd = join(realpathSync.native(tmpdir()), `missing-cwd-${Date.now()}`)
    let spawnErr: GitExecError | undefined
    try {
      await gitExec(missingCwd, ['status'])
    } catch (error) {
      spawnErr = error as GitExecError
    }
    expect(spawnErr).toBeDefined()
    expect(spawnErr?.terminatedConfirmed).toBe(true)
  }, 20_000)
})

describe('U2/C1 safe temp repo, hardlink isolation, and revalidation', () => {
  it('cleans real git repos with ReadOnly objects cleanly, isolates clones, and supports cleanupTestDir', async () => {
    const repo = await createTempGitRepo()
    writeFileSync(join(repo, 'file.txt'), 'hello readonly\n')
    await stageAll(repo)
    await commit(repo, 'add file')

    const readOnlySentinel = join(repo, '.git', 'objects', 'readonly-sentinel')
    writeFileSync(readOnlySentinel, 'locked-by-attr')
    chmodSync(readOnlySentinel, 0o444)

    const cloneParent = createTempDir('isolated-clone-parent-')
    const isolatedClone = await cloneTempGitRepoIsolated(repo, cloneParent, 'clone')
    const isolatedCloneRes = await safeCleanupTempDir(cloneParent)
    expect(isolatedCloneRes.ok).toBe(true)
    expect(isolatedCloneRes.status).toBe('REMOVED')
    expect(existsSync(isolatedClone)).toBe(false)
    expect(readFileSync(readOnlySentinel, 'utf8')).toBe('locked-by-attr')

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

  it('never chmods hard-linked external files, refuses readonly hard links cleanly, and removes writable hard links safely', async () => {
    const externalDir = makeManualDir('hardlink-external-', () => {
      try { chmodSync(externalReadOnly, 0o644) } catch {}
    })
    const externalReadOnly = join(externalDir, 'external-ro.txt')
    writeFileSync(externalReadOnly, 'immutable-external-ro')
    chmodSync(externalReadOnly, 0o444)

    const roModeBefore = statSync(externalReadOnly).mode

    const ownedWithRoHardLink = createTempDir('ro-hardlink-fixture-')
    const linkRoPath = join(ownedWithRoHardLink, 'link-to-ro.txt')
    linkSync(externalReadOnly, linkRoPath)
    manualRoots.push({
      path: ownedWithRoHardLink,
      onCleanup: () => { try { chmodSync(linkRoPath, 0o644) } catch {} }
    })

    const roRes = await safeCleanupTempDir(ownedWithRoHardLink)
    if (process.platform === 'win32') {
      expect(roRes).toMatchObject({
        ok: false,
        status: 'REFUSED',
        reason: 'SHARED_HARDLINK_READONLY'
      })
      expect(existsSync(ownedWithRoHardLink)).toBe(true)
    } else {
      expect(roRes).toMatchObject({ ok: true, status: 'REMOVED' })
    }
    expect(readFileSync(externalReadOnly, 'utf8')).toBe('immutable-external-ro')
    expect(statSync(externalReadOnly).mode & 0o200).toBe(roModeBefore & 0o200)

    const externalWritable = join(externalDir, 'external-rw.txt')
    writeFileSync(externalWritable, 'writable-external-content')
    const ownedWithRwHardLink = createTempDir('rw-hardlink-fixture-')
    linkSync(externalWritable, join(ownedWithRwHardLink, 'link-to-rw.txt'))

    const rwRes = await safeCleanupTempDir(ownedWithRwHardLink)
    expect(rwRes).toMatchObject({ ok: true, status: 'REMOVED' })
    expect(existsSync(ownedWithRwHardLink)).toBe(false)
    expect(readFileSync(externalWritable, 'utf8')).toBe('writable-external-content')
    expect(statSync(externalWritable).mode & 0o200).not.toBe(0)
  })

  it('protects real git local clone hard-linked objects without mutating source repo objects', async () => {
    const sourceRepo = await createTempGitRepo()
    writeFileSync(join(sourceRepo, 'alpha.txt'), 'alpha-content\n')
    await stageAll(sourceRepo)
    await commit(sourceRepo, 'alpha')

    const cloneParent = createTempDir('local-clone-parent-')
    const cloneTarget = join(cloneParent, 'local-clone')
    // Clone local sem --no-hardlinks cria hard links em .git/objects/ quando no mesmo volume.
    await gitExec(cloneParent, ['clone', sourceRepo, cloneTarget])
    manualRoots.push({
      path: cloneParent,
      onCleanup: () => { try { rmSync(cloneParent, { recursive: true, force: true }) } catch {} }
    })

    const cloneObjectsDir = join(cloneTarget, '.git', 'objects')
    const sampleSourceEntries = readFileSync(join(sourceRepo, 'alpha.txt'), 'utf8')
    const cloneRes = await safeCleanupTempDir(cloneParent)
    // Em Windows com hard links read-only em .git/objects, deve recusar entrada compartilhada ou remover só se nlink===1; nunca mutar sourceRepo.
    if (!cloneRes.ok) {
      expect(cloneRes).toMatchObject({ status: 'REFUSED', reason: 'SHARED_HARDLINK_READONLY' })
    } else {
      expect(cloneRes.status).toBe('REMOVED')
      expect(existsSync(cloneObjectsDir)).toBe(false)
    }
    expect(readFileSync(join(sourceRepo, 'alpha.txt'), 'utf8')).toBe(sampleSourceEntries)
    expect(await gitExec(sourceRepo, ['rev-list', '--count', 'HEAD'])).toContain('1')
    // Enquanto o clone local com hard links ainda existe, sourceRepo também mantém nlink > 1 read-only.
    expect(await safeCleanupTempDir(sourceRepo)).toMatchObject({ ok: false, status: 'REFUSED', reason: 'SHARED_HARDLINK_READONLY' })
    rmSync(cloneParent, { recursive: true, force: true })
    expect(await safeCleanupTempDir(sourceRepo)).toMatchObject({ ok: true, status: 'REMOVED' })
  })

  it('revalidates root identity after beforeRemove and during retry interval, rejecting root swaps', async () => {
    const swappedBefore = createTempDir('swap-before-remove-')
    manualRoots.push({ path: swappedBefore })
    const beforeSwapRes = await safeCleanupTempDir(swappedBefore, {
      beforeRemove: targetPath => {
        rmSync(targetPath, { recursive: true, force: true })
        mkdirSync(targetPath)
        writeFileSync(join(targetPath, 'substitute.txt'), 'brand-new-dir-after-callback')
      }
    })
    expect(beforeSwapRes).toMatchObject({
      ok: false,
      status: 'REFUSED',
      reason: 'IDENTITY_MISMATCH'
    })
    expect(readFileSync(join(swappedBefore, 'substitute.txt'), 'utf8')).toBe('brand-new-dir-after-callback')

    const swappedRetry = createTempDir('swap-during-retry-')
    manualRoots.push({ path: swappedRetry })
    const holder = spawn(
      process.execPath,
      ['-e', "process.stdout.write('H');setTimeout(()=>{}, 110)"],
      { cwd: swappedRetry, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
    )
    const holderClosed = new Promise<void>(resolveClose => holder.once('close', () => resolveClose()))
    await new Promise<void>(resolveReady => holder.stdout.once('data', () => resolveReady()))

    holder.once('close', () => {
      try {
        rmSync(swappedRetry, { recursive: true, force: true })
        mkdirSync(swappedRetry)
        writeFileSync(join(swappedRetry, 'retry-sub.txt'), 'substituted-between-retries')
      } catch {}
    })

    const retrySwapRes = await safeCleanupTempDir(swappedRetry, { maxAttempts: 6, maxDurationMs: 2500 })
    await holderClosed
    expect(retrySwapRes).toMatchObject({
      ok: false,
      status: 'REFUSED',
      reason: 'IDENTITY_MISMATCH'
    })
    expect(readFileSync(join(swappedRetry, 'retry-sub.txt'), 'utf8')).toBe('substituted-between-retries')
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

  it('refuses paths outside temp root, temp root itself, unowned dirs, unanchored registrations, and recycled identities', async () => {
    const external = resolve(process.cwd(), 'src')
    expect(await safeCleanupTempDir(external)).toMatchObject({ ok: false, status: 'REFUSED', reason: 'OUTSIDE_TEMP_ROOT' })
    expect(existsSync(external)).toBe(true)

    expect(await safeCleanupTempDir(tmpdir())).toMatchObject({ ok: false, status: 'REFUSED', reason: 'TEMP_ROOT_FORBIDDEN' })

    const unowned = makeManualDir('unowned-fixture-')
    const unownedSentinel = join(unowned, 'keep.txt')
    writeFileSync(unownedSentinel, 'do-not-delete')
    expect(await safeCleanupTempDir(unowned)).toMatchObject({ ok: false, status: 'REFUSED', reason: 'UNOWNED_FIXTURE' })
    expect(readFileSync(unownedSentinel, 'utf8')).toBe('do-not-delete')

    // registerTempDir nunca adota diretório arbitrário sem uma fixture pai já possuída.
    const unanchoredSub = join(unowned, 'sub')
    mkdirSync(unanchoredSub)
    expect(() => registerTempDir(unanchoredSub, unowned)).toThrow()
    expect(await safeCleanupTempDir(unanchoredSub)).toMatchObject({ ok: false, status: 'REFUSED', reason: 'UNOWNED_FIXTURE' })

    const recycled = createTempDir('recycled-fixture-')
    expect(await safeCleanupTempDir(recycled)).toMatchObject({ ok: true, status: 'REMOVED' })
    mkdirSync(recycled)
    manualRoots.push({ path: recycled })
    const recycledSentinel = join(recycled, 'recreated.txt')
    writeFileSync(recycledSentinel, 'recreated-by-other')
    expect(await safeCleanupTempDir(recycled)).toMatchObject({ ok: false, status: 'REFUSED', reason: 'IDENTITY_MISMATCH' })
    expect(readFileSync(recycledSentinel, 'utf8')).toBe('recreated-by-other')
  })

  it('never follows root/ancestor/nested junctions/symlinks or external gitdir pointers', async () => {
    const externalTarget = makeManualDir('external-target-')
    const externalSentinel = join(externalTarget, 'precious.txt')
    writeFileSync(externalSentinel, 'untouched')

    const tempBase = realpathSync.native(tmpdir())
    const rootLink = join(tempBase, `root-link-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    symlinkSync(externalTarget, rootLink, process.platform === 'win32' ? 'junction' : 'dir')
    manualRoots.push({ path: rootLink })
    expect(lstatSync(rootLink).isSymbolicLink()).toBe(true)
    expect(await safeCleanupTempDir(rootLink)).toMatchObject({
      ok: false,
      status: 'REFUSED',
      reason: 'SYMLINK_OR_JUNCTION_REJECTED'
    })
    expect(readFileSync(externalSentinel, 'utf8')).toBe('untouched')

    // Ancestral redirecionado dentro do temp: junction -> externalTarget/sub.
    const subInsideExternal = join(externalTarget, 'nested-real')
    mkdirSync(subInsideExternal)
    writeFileSync(join(subInsideExternal, 'keep-via-ancestor.txt'), 'do-not-touch')
    const viaRedirectedAncestor = join(rootLink, 'nested-real')
    expect(await safeCleanupTempDir(viaRedirectedAncestor)).toMatchObject({
      ok: false,
      status: 'REFUSED',
      reason: 'SYMLINK_OR_JUNCTION_REJECTED'
    })
    expect(readFileSync(join(subInsideExternal, 'keep-via-ancestor.txt'), 'utf8')).toBe('do-not-touch')

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
