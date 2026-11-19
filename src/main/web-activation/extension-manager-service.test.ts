import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcademyService } from '../academy/academy-service'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import { LocalChannelHost } from '../local-agent-channel/local-channel-host'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { ConsentStore } from './consent-store'
import { writeJsonAtomic } from './extension-enrollment-store'
import {
  ExtensionManagerService,
  type StagingBuildRunner
} from './extension-manager-service'
import type { BuildArtifactMetadata } from './extension-manager-types'
import { NativeMessagingBridge } from './native-messaging-bridge'
import { WebActivationLocalAdapter } from './web-activation-local-adapter'
import {
  validateReadOnlyWebMcpRequest,
  WEB_EXTENSION_MANAGER_TOOL_NAMES
} from './web-activation-types'

const tempRoots: string[] = []
const channels: LocalChannelHost[] = []
const academies: AcademyService[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

function sha256(content: string): { sha256: string; bytes: number } {
  const buf = Buffer.from(content, 'utf8')
  return {
    sha256: createHash('sha256').update(buf).digest('hex'),
    bytes: buf.length
  }
}

function stubNavigation(): ProjectContextNavigation {
  return {
    discoverRepository: vi.fn(async () => ({ directories: [{ relativePath: '.', children: ['src'] }] })),
    getRelationships: vi.fn(async () => ({ files: [] })),
    inspectFiles: vi.fn(async () => ({ files: [] })),
    getReferences: vi.fn(async () => ({ targets: [] })),
    getSymbolDependencies: vi.fn(async () => ({ sources: [] })),
    getSymbolHierarchy: vi.fn(async () => ({ targets: [] })),
    readCode: vi.fn(async () => ({ files: [] }))
  } as unknown as ProjectContextNavigation
}

function createFakeWorkspaceAndInstall(root: string, options: { wrapperHost?: boolean } = {}) {
  const userDataPath = join(root, 'user-data')
  const sourceRepoPath = join(root, 'source-repo')
  const unpackedPath = join(root, 'live-unpacked')
  const hostInstallDir = join(root, 'host-install')
  const hostScriptPath = options.wrapperHost
    ? join(hostInstallDir, 'native-host.cjs')
    : join(hostInstallDir, 'native-host.bundle.cjs')

  mkdirSync(join(sourceRepoPath, 'scripts', 'web-activation'), { recursive: true })
  mkdirSync(unpackedPath, { recursive: true })
  mkdirSync(hostInstallDir, { recursive: true })

  writeFileSync(join(sourceRepoPath, 'scripts', 'web-activation', 'build.cjs'), '// mock build\n', 'utf8')
  writeFileSync(
    join(unpackedPath, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, name: 'Code Awareness', version: '1.0.0' }),
    'utf8'
  )
  writeFileSync(join(unpackedPath, 'background.js'), '// live v0\n', 'utf8')
  writeFileSync(join(unpackedPath, 'marker-untouched.txt'), 'keep-me', 'utf8')

  if (options.wrapperHost) {
    writeFileSync(
      hostScriptPath,
      "const sibling = 'native-host.bundle.cjs'; module.exports = { sibling };\n",
      'utf8'
    )
    writeFileSync(join(hostInstallDir, 'native-host.bundle.cjs'), '// live host bundle v0\n', 'utf8')
  } else {
    writeFileSync(hostScriptPath, '// live host bundle v0\n', 'utf8')
  }

  writeFileSync(
    join(hostInstallDir, 'com.ericrocha.codeawareness.web_activation.json'),
    JSON.stringify({
      name: 'com.ericrocha.codeawareness.web_activation',
      path: join(hostInstallDir, 'code-awareness-web-host.cmd'),
      type: 'stdio',
      allowed_origins: [
        'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/',
        'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/'
      ]
    }),
    'utf8'
  )

  return { userDataPath, sourceRepoPath, unpackedPath, hostInstallDir, hostScriptPath }
}

function createMockBuildRunner(version = '1.0.0'): StagingBuildRunner {
  return async ({ extOutDir, hostOutDir, metaOutPath, buildId, sourceHead, nativeHostApplication }) => {
    mkdirSync(extOutDir, { recursive: true })
    mkdirSync(hostOutDir, { recursive: true })

    const manifest = JSON.stringify({ manifest_version: 3, name: 'Code Awareness', version })
    const bg = `// built bg ${buildId}\n`
    const cs = `// built cs ${buildId}\n`
    const host = `// built host ${buildId}\n`

    writeFileSync(join(extOutDir, 'manifest.json'), manifest, 'utf8')
    writeFileSync(join(extOutDir, 'background.js'), bg, 'utf8')
    writeFileSync(join(extOutDir, 'content-script.js'), cs, 'utf8')
    writeFileSync(join(hostOutDir, 'native-host.cjs'), host, 'utf8')

    const metadata: BuildArtifactMetadata = {
      schemaVersion: 1,
      buildId,
      sourceHead,
      inputsFingerprint: 'fp-' + sourceHead.slice(0, 8),
      manifestVersion: version,
      builtAt: new Date().toISOString(),
      extOutDir,
      hostOutDir,
      candidatePath: extOutDir,
      nativeHostApplication,
      extFiles: {
        'manifest.json': sha256(manifest),
        'background.js': sha256(bg),
        'content-script.js': sha256(cs)
      },
      hostFiles: {
        'native-host.cjs': sha256(host)
      }
    }
    writeFileSync(metaOutPath, JSON.stringify(metadata, null, 2), 'utf8')
    return metadata
  }
}

afterEach(async () => {
  while (academies.length > 0) {
    try {
      await (academies.pop()! as unknown as { close?: () => Promise<void> }).close?.()
    } catch {}
  }
  while (channels.length > 0) {
    try {
      channels.pop()!.dispose()
    } catch {}
  }
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})

describe('ExtensionManagerService (U1/U2/U3)', () => {
  const HEAD_A = 'a'.repeat(40)
  const EXT_ID = 'a'.repeat(32)

  it('enforces canonical non-symlink paths, development installType, and single active enrollment', () => {
    const root = makeTempDir('ext-mgr-enroll-')
    const paths = createFakeWorkspaceAndInstall(root)
    const service = new ExtensionManagerService({ userDataPath: paths.userDataPath })

    expect(() =>
      service.enrollInstallation({
        extensionId: EXT_ID,
        installType: 'normal',
        profileId: 'prof-1',
        unpackedPath: paths.unpackedPath,
        hostInstallDir: paths.hostInstallDir,
        hostScriptPath: paths.hostScriptPath,
        sourceRepoPath: paths.sourceRepoPath
      })
    ).toThrow(/UNSUPPORTED_INSTALL_TYPE/)

    expect(() =>
      service.enrollInstallation({
        extensionId: EXT_ID,
        installType: 'development',
        profileId: 'prof-1',
        unpackedPath: `${root}/../live-unpacked`,
        hostInstallDir: paths.hostInstallDir,
        hostScriptPath: paths.hostScriptPath,
        sourceRepoPath: paths.sourceRepoPath
      })
    ).toThrow(/RELATIVE_PATH_UNSUPPORTED|PATH_TRAVERSAL_UNSUPPORTED/)

    const linkPath = join(root, 'symlink-unpacked')
    symlinkSync(paths.unpackedPath, linkPath, 'junction')
    expect(() =>
      service.enrollInstallation({
        extensionId: EXT_ID,
        installType: 'development',
        profileId: 'prof-1',
        unpackedPath: linkPath,
        hostInstallDir: paths.hostInstallDir,
        hostScriptPath: paths.hostScriptPath,
        sourceRepoPath: paths.sourceRepoPath
      })
    ).toThrow(/SYMLINK_PATH_UNSUPPORTED/)

    const enrolled = service.enrollInstallation({
      installationId: 'inst-1',
      extensionId: EXT_ID,
      installType: 'development',
      profileId: 'prof-1',
      unpackedPath: paths.unpackedPath,
      hostInstallDir: paths.hostInstallDir,
      hostScriptPath: paths.hostScriptPath,
      sourceRepoPath: paths.sourceRepoPath
    })
    expect(enrolled.allowedOrigin).toBe(`chrome-extension://${EXT_ID}/`)
    expect(enrolled.enabled).toBe(true)

    expect(() =>
      service.enrollInstallation({
        installationId: 'inst-2',
        extensionId: EXT_ID,
        installType: 'development',
        profileId: 'prof-2',
        unpackedPath: paths.unpackedPath,
        hostInstallDir: paths.hostInstallDir,
        hostScriptPath: paths.hostScriptPath,
        sourceRepoPath: paths.sourceRepoPath
      })
    ).toThrow(/ACTIVE_ENROLLMENT_EXISTS/)

    service.revokeInstallation()
    const reenrolled = service.enrollInstallation({
      installationId: 'inst-2',
      extensionId: EXT_ID,
      installType: 'development',
      profileId: 'prof-2',
      unpackedPath: paths.unpackedPath,
      hostInstallDir: paths.hostInstallDir,
      hostScriptPath: paths.hostScriptPath,
      sourceRepoPath: paths.sourceRepoPath
    })
    expect(reenrolled.installationId).toBe('inst-2')
  })

  it('builds isolated staging artifacts without mutating live unpacked dir and enforces head/dirty checks', async () => {
    const root = makeTempDir('ext-mgr-build-')
    const paths = createFakeWorkspaceAndInstall(root)
    let dirty = true
    let head = HEAD_A

    const service = new ExtensionManagerService({
      userDataPath: paths.userDataPath,
      inspectGitSource: async () => ({ head, branch: 'feat/test', dirty }),
      computeInputsFingerprint: () => `fp-${head.slice(0, 8)}`,
      buildRunner: createMockBuildRunner('1.0.0')
    })

    service.enrollInstallation({
      installationId: 'inst-build',
      extensionId: EXT_ID,
      profileId: 'prof-build',
      unpackedPath: paths.unpackedPath,
      hostInstallDir: paths.hostInstallDir,
      hostScriptPath: paths.hostScriptPath,
      sourceRepoPath: paths.sourceRepoPath
    })

    const dirtyBlocked = await service.startOperation({ action: 'BUILD' })
    expect(dirtyBlocked.accepted).toBe(false)
    expect(dirtyBlocked.code).toBe('DIRTY_SOURCE_WORKTREE')

    dirty = false
    const headMismatch = await service.startOperation({
      action: 'BUILD',
      expectedSourceHead: 'f'.repeat(40)
    })
    expect(headMismatch.accepted).toBe(false)
    expect(headMismatch.code).toBe('SOURCE_HEAD_MISMATCH')

    const built = await service.startOperation({
      action: 'BUILD',
      operationId: 'op-build-1',
      expectedSourceHead: HEAD_A
    })
    expect(built.accepted).toBe(true)
    expect(built.operation?.state).toBe('STAGED')
    expect(built.operation?.candidateMetadata?.buildId).toBe(built.operation?.targetBuildId)

    // Live unpacked dir MUST remain untouched on BUILD
    expect(readFileSync(join(paths.unpackedPath, 'background.js'), 'utf8')).toBe('// live v0\n')
    expect(existsSync(join(paths.unpackedPath, 'marker-untouched.txt'))).toBe(true)

    // Idempotent replay with same operationId
    const replay = await service.startOperation({
      action: 'BUILD',
      operationId: 'op-build-1',
      expectedSourceHead: HEAD_A
    })
    expect(replay.accepted).toBe(true)
    expect(replay.operation?.operationId).toBe('op-build-1')

    // Reject conflicting args on existing operationId
    const mismatchReplay = await service.startOperation({
      action: 'UPDATE',
      operationId: 'op-build-1'
    })
    expect(mismatchReplay.accepted).toBe(false)
    expect(mismatchReplay.code).toBe('INVALID_ARGUMENT')
  })

  it('enforces single-flight concurrency, quiescence deferral, transactional swap preserving allowed_origins, and convergence to VERIFIED / PARTIAL', async () => {
    const root = makeTempDir('ext-mgr-update-')
    const paths = createFakeWorkspaceAndInstall(root, { wrapperHost: true })
    let nowMs = 1_700_000_000_000
    let fingerprint = `fp-${HEAD_A.slice(0, 8)}`

    const service = new ExtensionManagerService({
      userDataPath: paths.userDataPath,
      operationTtlMs: 60_000,
      now: () => nowMs,
      inspectGitSource: async () => ({ head: HEAD_A, branch: 'main', dirty: false }),
      computeInputsFingerprint: () => fingerprint,
      buildRunner: createMockBuildRunner('1.0.0')
    })

    service.enrollInstallation({
      installationId: 'inst-up',
      extensionId: EXT_ID,
      profileId: 'prof-up',
      unpackedPath: paths.unpackedPath,
      hostInstallDir: paths.hostInstallDir,
      hostScriptPath: paths.hostScriptPath,
      sourceRepoPath: paths.sourceRepoPath
    })

    const started = await service.startOperation({
      action: 'UPDATE',
      operationId: 'op-up-1',
      expectedSourceHead: HEAD_A
    })
    expect(started.accepted).toBe(true)
    expect(started.operation?.state).toBe('WAITING_BROWSER')
    const targetBuildId = started.operation!.targetBuildId!

    // Second concurrent operation returns BUSY
    const concurrent = await service.startOperation({ action: 'RELOAD' })
    expect(concurrent.accepted).toBe(false)
    expect(concurrent.code).toBe('BUSY')
    expect(concurrent.activeOperationId).toBe('op-up-1')

    // Check discovers pending authorization
    const check = service.handleMaintenanceCheck({
      installationId: 'inst-up',
      extensionId: EXT_ID,
      profileId: 'prof-up',
      bootId: 'boot-a',
      buildId: 'old-build',
      manifestVersion: '1.0.0',
      installType: 'development'
    })
    expect(check.managed).toBe(true)
    expect(check.pendingOperation?.operationId).toBe('op-up-1')

    // Quiescence busy defers to WAITING_IDLE
    const deferred = await service.handleMaintenanceClaim({
      ...check.pendingOperation!,
      extensionId: EXT_ID,
      profileId: 'prof-up',
      bootId: 'boot-a',
      buildId: 'old-build',
      readyToReload: false,
      activeBusyReason: 'ASSISTANT_STREAMING'
    })
    expect(deferred.decision).toBe('DEFER')
    expect(service.getOperation('op-up-1')?.state).toBe('WAITING_IDLE')

    // Idle claim triggers atomic promotion preserving allowed_origins and wrapper host
    const claimed = await service.handleMaintenanceClaim({
      ...check.pendingOperation!,
      extensionId: EXT_ID,
      profileId: 'prof-up',
      bootId: 'boot-a',
      buildId: 'old-build',
      readyToReload: true
    })
    expect(claimed.decision).toBe('RELOAD_NOW')
    expect(readFileSync(join(paths.unpackedPath, 'background.js'), 'utf8')).toContain(targetBuildId)
    expect(readFileSync(join(paths.hostInstallDir, 'native-host.bundle.cjs'), 'utf8')).toContain(targetBuildId)

    const hostManifest = JSON.parse(
      readFileSync(join(paths.hostInstallDir, 'com.ericrocha.codeawareness.web_activation.json'), 'utf8')
    )
    expect(hostManifest.allowed_origins).toEqual([
      'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/',
      'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/'
    ])

    // Post-reload rejection when bootId did not rotate
    const sameBoot = await service.handleMaintenanceReport({
      phase: 'BOOT_ATTESTATION',
      report: {
        installationId: 'inst-up',
        extensionId: EXT_ID,
        profileId: 'prof-up',
        bootId: 'boot-a',
        buildId: targetBuildId,
        manifestVersion: '1.0.0',
        installType: 'development',
        hostBuildId: targetBuildId,
        hostCompatible: true,
        reloadedOperationId: 'op-up-1',
        reloadedNonce: check.pendingOperation!.nonce,
        reloadedEpoch: check.pendingOperation!.epoch,
        reportedAt: new Date(nowMs).toISOString()
      }
    })
    expect(sameBoot.accepted).toBe(false)
    expect(sameBoot.operation?.state).toBe('NOT_ATTESTED')

    // Run another UPDATE to test happy path VERIFIED and PARTIAL
    const op2 = await service.startOperation({ action: 'UPDATE', operationId: 'op-up-2' })
    const auth2 = service.handleMaintenanceCheck({
      installationId: 'inst-up',
      extensionId: EXT_ID,
      profileId: 'prof-up',
      bootId: 'boot-b1',
      buildId: targetBuildId,
      manifestVersion: '1.0.0',
      installType: 'development'
    }).pendingOperation!
    const claim2 = await service.handleMaintenanceClaim({
      ...auth2,
      extensionId: EXT_ID,
      profileId: 'prof-up',
      bootId: 'boot-b1',
      buildId: targetBuildId,
      readyToReload: true
    })
    expect(claim2.decision).toBe('RELOAD_NOW')

    const bootOk = await service.handleMaintenanceReport({
      phase: 'BOOT_ATTESTATION',
      report: {
        installationId: 'inst-up',
        extensionId: EXT_ID,
        profileId: 'prof-up',
        bootId: 'boot-b2',
        buildId: op2.operation!.targetBuildId!,
        manifestVersion: '1.0.0',
        installType: 'development',
        hostBuildId: op2.operation!.targetBuildId!,
        hostCompatible: true,
        reloadedOperationId: 'op-up-2',
        reloadedNonce: auth2.nonce,
        reloadedEpoch: auth2.epoch,
        reportedAt: new Date(nowMs).toISOString()
      }
    })
    expect(bootOk.accepted).toBe(true)
    expect(bootOk.operation?.state).toBe('REINJECTING')

    const verified = await service.handleMaintenanceReport({
      phase: 'REINJECT_RESULT',
      report: {
        installationId: 'inst-up',
        extensionId: EXT_ID,
        profileId: 'prof-up',
        bootId: 'boot-b2',
        buildId: op2.operation!.targetBuildId!,
        manifestVersion: '1.0.0',
        installType: 'development',
        hostBuildId: op2.operation!.targetBuildId!,
        hostCompatible: true,
        reloadedOperationId: 'op-up-2',
        reloadedNonce: auth2.nonce,
        reloadedEpoch: auth2.epoch,
        tabStates: [
          { tabId: 7, urlPrefix: 'https://chat.deepseek.com', status: 'REINJECTED', buildId: op2.operation!.targetBuildId! }
        ],
        reportedAt: new Date(nowMs).toISOString()
      }
    })
    expect(verified.accepted).toBe(true)
    expect(verified.verified).toBe(true)
    expect(verified.operation?.state).toBe('VERIFIED')

    // PARTIAL if a tab failed re-injection on another RELOAD
    const reloadOp = await service.startOperation({ action: 'RELOAD', operationId: 'op-reload-partial' })
    expect(reloadOp.accepted).toBe(true)
    const auth3 = service.handleMaintenanceCheck({
      installationId: 'inst-up',
      extensionId: EXT_ID,
      profileId: 'prof-up',
      bootId: 'boot-b2',
      buildId: op2.operation!.targetBuildId!,
      manifestVersion: '1.0.0',
      installType: 'development'
    }).pendingOperation!
    await service.handleMaintenanceClaim({
      ...auth3,
      extensionId: EXT_ID,
      profileId: 'prof-up',
      bootId: 'boot-b2',
      buildId: op2.operation!.targetBuildId!,
      readyToReload: true
    })
    const partial = await service.handleMaintenanceReport({
      phase: 'REINJECT_RESULT',
      report: {
        installationId: 'inst-up',
        extensionId: EXT_ID,
        profileId: 'prof-up',
        bootId: 'boot-b3',
        buildId: op2.operation!.targetBuildId!,
        manifestVersion: '1.0.0',
        installType: 'development',
        hostBuildId: op2.operation!.targetBuildId!,
        hostCompatible: true,
        reloadedOperationId: 'op-reload-partial',
        reloadedNonce: auth3.nonce,
        reloadedEpoch: auth3.epoch,
        tabStates: [
          { tabId: 8, urlPrefix: 'https://chat.qwen.ai', status: 'FAILED', reason: 'TAB_CLOSED' }
        ],
        reportedAt: new Date(nowMs).toISOString()
      }
    })
    expect(partial.accepted).toBe(true)
    expect(partial.verified).toBe(false)
    expect(partial.operation?.state).toBe('PARTIAL')

    // Expiry blocks late execution
    const opExpire = await service.startOperation({ action: 'RELOAD', operationId: 'op-expire' })
    expect(opExpire.accepted).toBe(true)
    const authExp = service.handleMaintenanceCheck({
      installationId: 'inst-up',
      extensionId: EXT_ID,
      profileId: 'prof-up',
      bootId: 'boot-b3',
      buildId: op2.operation!.targetBuildId!,
      manifestVersion: '1.0.0',
      installType: 'development'
    }).pendingOperation!
    nowMs += 120_000
    const claimLate = await service.handleMaintenanceClaim({
      ...authExp,
      extensionId: EXT_ID,
      profileId: 'prof-up',
      bootId: 'boot-b3',
      buildId: op2.operation!.targetBuildId!,
      readyToReload: true
    })
    expect(claimLate.decision).toBe('REJECT')
    expect(claimLate.reason).toBe('OPERATION_EXPIRED')
    expect(service.getOperation('op-expire')?.state).toBe('EXPIRED')
  })

  it('rejects source drift at promotion time and recovers interrupted swap journals on restart', async () => {
    const root = makeTempDir('ext-mgr-recovery-')
    const paths = createFakeWorkspaceAndInstall(root)
    let fingerprint = `fp-${HEAD_A.slice(0, 8)}`

    const service = new ExtensionManagerService({
      userDataPath: paths.userDataPath,
      inspectGitSource: async () => ({ head: HEAD_A, branch: 'main', dirty: false }),
      computeInputsFingerprint: () => fingerprint,
      buildRunner: createMockBuildRunner('1.0.0')
    })

    service.enrollInstallation({
      installationId: 'inst-rec',
      extensionId: EXT_ID,
      profileId: 'prof-rec',
      unpackedPath: paths.unpackedPath,
      hostInstallDir: paths.hostInstallDir,
      hostScriptPath: paths.hostScriptPath,
      sourceRepoPath: paths.sourceRepoPath
    })

    const op = await service.startOperation({ action: 'UPDATE', operationId: 'op-drift' })
    const auth = service.handleMaintenanceCheck({
      installationId: 'inst-rec',
      extensionId: EXT_ID,
      profileId: 'prof-rec',
      bootId: 'boot-1',
      buildId: 'old',
      manifestVersion: '1.0.0',
      installType: 'development'
    }).pendingOperation!

    // Simulate source edit between staging and claim
    fingerprint = 'fp-drifted'
    const claimDrift = await service.handleMaintenanceClaim({
      ...auth,
      extensionId: EXT_ID,
      profileId: 'prof-rec',
      bootId: 'boot-1',
      buildId: 'old',
      readyToReload: true
    })
    expect(claimDrift.decision).toBe('REJECT')
    expect(claimDrift.reason).toContain('SOURCE_DRIFT_DETECTED')
    expect(service.getOperation(op.operation!.operationId)?.state).toBe('FAILED')
    expect(readFileSync(join(paths.unpackedPath, 'background.js'), 'utf8')).toBe('// live v0\n')

    // Simulate an interrupted swap journal on startup -> auto rollback
    const managerDir = join(paths.userDataPath, 'web-activation', 'manager')
    const backupDir = join(root, '.ca-ext-prev')
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(join(backupDir, 'background.js'), '// recovered backup\n', 'utf8')
    rmSync(paths.unpackedPath, { recursive: true, force: true })
    writeJsonAtomic(join(managerDir, 'swap-journal.json'), {
      schemaVersion: 1,
      operationId: 'crashed-op',
      targetBuildId: 'b-crash',
      phase: 'SWAPPING_EXT',
      unpackedPath: paths.unpackedPath,
      nextExtTempDir: join(root, '.ca-ext-next-crashed'),
      backupExtDir: backupDir,
      targetHostFile: paths.hostScriptPath,
      nextHostTempFile: join(paths.hostInstallDir, 'none.cjs'),
      backupHostFile: join(paths.hostInstallDir, 'none.prev'),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })

    new ExtensionManagerService({ userDataPath: paths.userDataPath })
    expect(readFileSync(join(paths.unpackedPath, 'background.js'), 'utf8')).toBe('// recovered backup\n')
  })

  it('exposes the 3 manager tools only on Code Awareness Channel and blocks web origins from maintenance actions', async () => {
    const root = makeTempDir('ext-mgr-mcp-')
    const paths = createFakeWorkspaceAndInstall(root)
    const service = new ExtensionManagerService({
      userDataPath: paths.userDataPath,
      inspectGitSource: async () => ({ head: HEAD_A, branch: 'main', dirty: false }),
      computeInputsFingerprint: () => `fp-${HEAD_A.slice(0, 8)}`,
      buildRunner: createMockBuildRunner('1.0.0')
    })

    const channel = new LocalChannelHost(
      [new WebActivationLocalAdapter(async () => ({ status: 'UNAVAILABLE', observedAt: new Date().toISOString() }), service)],
      paths.userDataPath
    )
    channels.push(channel)
    await channel.start()

    const academy = new AcademyService(join(paths.userDataPath, 'academy'), join(paths.userDataPath, 'downloads'))
    academies.push(academy)
    const globalOnly = ChannelMcpAdapter.createGlobalOnly(academy)
    const globalToolNames = globalOnly.listTools().map((t) => t.name)
    for (const toolName of WEB_EXTENSION_MANAGER_TOOL_NAMES) {
      expect(globalToolNames).not.toContain(toolName)
      const webValidation = validateReadOnlyWebMcpRequest('tools/call', { name: toolName, arguments: {} })
      expect(webValidation.ok).toBe(false)
      if (!webValidation.ok) {
        expect(webValidation.code).toBe('TOOL_NOT_ALLOWED')
      }
    }

    const projectAdapter = new ChannelMcpAdapter({
      projectId: 'proj-1',
      repoRoot: paths.sourceRepoPath,
      navigation: stubNavigation(),
      webExtensionManager: service
    })
    const projectToolNames = projectAdapter.listTools().map((t) => t.name)
    for (const toolName of WEB_EXTENSION_MANAGER_TOOL_NAMES) {
      expect(projectToolNames).toContain(toolName)
      expect(projectAdapter.capabilityForTool(toolName)).toBe('Web Extension Manager')
    }

    // NativeMessagingBridge forbids web origins and caller mismatch on maintenance actions
    const bridge = new NativeMessagingBridge({
      consentStore: new ConsentStore(join(paths.userDataPath, 'web-activation')),
      callerOrigin: `chrome-extension://${EXT_ID}/`,
      allowedExtensionOrigins: [`chrome-extension://${EXT_ID}/`],
      userDataPath: paths.userDataPath,
      hostBuildId: 'host-build-1'
    })

    const webAttempt = await bridge.handle({
      id: 'm1',
      action: 'maintenance_check',
      webOrigin: 'https://chat.deepseek.com',
      installationId: 'inst-1',
      extensionId: EXT_ID,
      profileId: 'prof-1',
      bootId: 'b1',
      buildId: 'v1',
      manifestVersion: '1.0.0',
      installType: 'development'
    } as unknown)
    expect(webAttempt.ok).toBe(false)
    expect(webAttempt.error?.code).toBe('MAINTENANCE_UNAUTHORIZED')

    const spoofedExt = await bridge.handle({
      id: 'm2',
      action: 'maintenance_check',
      installationId: 'inst-1',
      extensionId: 'c'.repeat(32),
      profileId: 'prof-1',
      bootId: 'b1',
      buildId: 'v1',
      manifestVersion: '1.0.0',
      installType: 'development'
    })
    expect(spoofedExt.ok).toBe(false)
    expect(spoofedExt.error?.code).toBe('MAINTENANCE_UNAUTHORIZED')

    // Enroll and test MCP status + BUILD via projectAdapter + NativeMessagingBridge check through LocalChannelHost
    service.enrollInstallation({
      installationId: 'inst-mcp',
      extensionId: EXT_ID,
      profileId: 'prof-mcp',
      unpackedPath: paths.unpackedPath,
      hostInstallDir: paths.hostInstallDir,
      hostScriptPath: paths.hostScriptPath,
      sourceRepoPath: paths.sourceRepoPath
    })

    const mcpBuild = await projectAdapter.callTool('start_web_extension_operation', {
      action: 'BUILD',
      operationId: 'mcp-op-1',
      expectedSourceHead: HEAD_A
    })
    expect(mcpBuild.isError).toBeFalsy()
    const opPayload = JSON.parse((mcpBuild.content[0] as { text: string }).text)
    expect(opPayload.accepted).toBe(true)
    expect(opPayload.operation.state).toBe('STAGED')

    const mcpGetOp = await projectAdapter.callTool('get_web_extension_operation', { operationId: 'mcp-op-1' })
    expect(JSON.parse((mcpGetOp.content[0] as { text: string }).text).operation.targetBuildId).toBe(
      opPayload.operation.targetBuildId
    )

    const mcpStatus = await projectAdapter.callTool('get_web_extension_status', {})
    const statusJson = JSON.parse((mcpStatus.content[0] as { text: string }).text)
    expect(statusJson.managed).toBe(true)
    expect(statusJson.lastValidBuild.buildId).toBe(opPayload.operation.targetBuildId)

    const validCheck = await bridge.handle({
      id: 'm3',
      action: 'maintenance_check',
      installationId: 'inst-mcp',
      extensionId: EXT_ID,
      profileId: 'prof-mcp',
      bootId: 'boot-1',
      buildId: 'v0',
      manifestVersion: '1.0.0',
      installType: 'development'
    })
    expect(validCheck.ok).toBe(true)
    expect((validCheck.result as { hostBuildId?: string }).hostBuildId).toBe('host-build-1')
  })
})
