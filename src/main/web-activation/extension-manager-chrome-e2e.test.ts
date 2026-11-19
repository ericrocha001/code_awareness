import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import { LocalChannelHost } from '../local-agent-channel/local-channel-host'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import { ExtensionManagerService } from './extension-manager-service'
import {
  installNativeMessagingHost,
  uninstallNativeMessagingHost
} from './native-host-registration'
import { WebActivationLocalAdapter } from './web-activation-local-adapter'

const requireFromHere = createRequire(__filename)
const { buildWebActivationArtifacts } = requireFromHere(
  resolve(process.cwd(), 'scripts', 'web-activation', 'build.cjs')
) as {
  buildWebActivationArtifacts: (options: Record<string, unknown>) => Promise<{
    buildId: string
    manifestVersion: string
    extOutDir: string
    hostOutDir: string
  }>
}

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const HAS_CHROME = process.platform === 'win32' && existsSync(CHROME_PATH)

class CdpPipeClient {
  private readonly proc: ChildProcess
  private readonly readStream: NodeJS.ReadableStream
  private readonly writeStream: NodeJS.WritableStream
  private buf = Buffer.alloc(0)
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private readonly eventListeners = new Set<(method: string, params: unknown, sessionId?: string) => void>()

  constructor(proc: ChildProcess, writeStream: NodeJS.WritableStream, readStream: NodeJS.ReadableStream) {
    this.proc = proc
    this.writeStream = writeStream
    this.readStream = readStream

    this.readStream.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk])
      while (true) {
        const idx = this.buf.indexOf(0)
        if (idx === -1) break
        const msgRaw = this.buf.subarray(0, idx).toString('utf8')
        this.buf = this.buf.subarray(idx + 1)
        if (!msgRaw.trim()) continue
        const msg = JSON.parse(msgRaw) as {
          id?: number
          result?: unknown
          error?: { message?: string }
          method?: string
          params?: unknown
          sessionId?: string
        }
        if (typeof msg.id === 'number') {
          const entry = this.pending.get(msg.id)
          if (entry) {
            this.pending.delete(msg.id)
            if (msg.error) {
              entry.reject(new Error(`CDP_${msg.error.message ?? 'ERROR'}`))
            } else {
              entry.resolve(msg.result)
            }
          }
        } else if (msg.method) {
          for (const listener of this.eventListeners) {
            listener(msg.method, msg.params, msg.sessionId)
          }
        }
      }
    })
  }

  onEvent(listener: (method: string, params: unknown, sessionId?: string) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.nextId
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP_TIMEOUT:${method}`))
        }
      }, 15_000)
      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer)
          resolve(val as T)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        }
      })
      this.writeStream.write(Buffer.from(`${JSON.stringify(payload)}\0`, 'utf8'))
    })
  }

  async close(): Promise<void> {
    try {
      await this.send('Browser.close')
    } catch {
      // Ignore if already exiting
    }
    await new Promise<void>((resolve) => {
      if (this.proc.exitCode !== null) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        try {
          this.proc.kill('SIGKILL')
        } catch {}
        resolve()
      }, 4000)
      this.proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

function launchIsolatedChrome(userDataDir: string): CdpPipeClient {
  const proc = spawn(
    CHROME_PATH,
    [
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
      'about:blank'
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  )
  const writeStream = proc.stdio[3] as NodeJS.WritableStream
  const readStream = proc.stdio[4] as NodeJS.ReadableStream
  return new CdpPipeClient(proc, writeStream, readStream)
}

function createTempSourceGitRepo(repoDir: string, rootCheckout: string): string {
  mkdirSync(join(repoDir, 'src'), { recursive: true })
  mkdirSync(join(repoDir, 'scripts', 'web-activation'), { recursive: true })

  cpSync(join(rootCheckout, 'src', 'web-extension'), join(repoDir, 'src', 'web-extension'), {
    recursive: true,
    filter: (src) => !src.endsWith('.test.ts')
  })
  cpSync(join(rootCheckout, 'src', 'main', 'web-activation'), join(repoDir, 'src', 'main', 'web-activation'), {
    recursive: true,
    filter: (src) => !src.endsWith('.test.ts')
  })
  cpSync(join(rootCheckout, 'src', 'shared', 'web-activation'), join(repoDir, 'src', 'shared', 'web-activation'), {
    recursive: true
  })
  cpSync(join(rootCheckout, 'src', 'shared', 'desktop-profile.cjs'), join(repoDir, 'src', 'shared', 'desktop-profile.cjs'))
  cpSync(join(rootCheckout, 'scripts', 'web-activation', 'build.cjs'), join(repoDir, 'scripts', 'web-activation', 'build.cjs'))
  cpSync(join(rootCheckout, 'scripts', 'web-activation', 'native-host.cjs'), join(repoDir, 'scripts', 'web-activation', 'native-host.cjs'))
  cpSync(join(rootCheckout, 'package.json'), join(repoDir, 'package.json'))

  const runGit = (args: string[]) =>
    execFileSync('git', args, { cwd: repoDir, windowsHide: true, stdio: 'pipe' }).toString('utf8').trim()

  runGit(['init'])
  runGit(['config', 'user.email', 'test@codeawareness.local'])
  runGit(['config', 'user.name', 'Code Awareness Test'])
  runGit(['add', '.'])
  runGit(['commit', '-m', 'Generation A'])
  return runGit(['rev-parse', 'HEAD'])
}

async function callMcpTool(endpoint: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args }
    })
  })
  const json = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } }
  const text = json.result?.content?.[0]?.text ?? '{}'
  return {
    isError: Boolean(json.result?.isError),
    payload: JSON.parse(text) as Record<string, unknown>
  }
}

describe.skipIf(!HAS_CHROME)('Real Isolated Chrome 157 Extension Manager E2E Proof (U3)', () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!
      try {
        await fn()
      } catch {}
    }
  })

  it(
    'executes full A->B UPDATE via MCP HTTP + LocalChannelHost + real Native Messaging + real chrome.runtime.reload() and reaches VERIFIED',
    async () => {
      const rootCheckout = process.cwd()
      const isolatedRoot = mkdtempSync(join(tmpdir(), 'ca-ext-e2e-'))
      cleanups.push(() => rmSync(isolatedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }))

      const appDataDir = join(isolatedRoot, 'desktop-userdata')
      const chromeUserDataDir = join(isolatedRoot, 'chrome-userdata')
      const sourceRepoDir = join(isolatedRoot, 'source-repo')
      const liveExtDir = join(isolatedRoot, 'live-unpacked')
      const hostInstallDir = join(isolatedRoot, 'host-install')
      const testHostName = `com.ericrocha.codeawareness.web_activation_test_${randomBytes(4).toString('hex')}`

      mkdirSync(appDataDir, { recursive: true })
      mkdirSync(chromeUserDataDir, { recursive: true })
      mkdirSync(hostInstallDir, { recursive: true })

      const headA = createTempSourceGitRepo(sourceRepoDir, rootCheckout)

      // Build generation A directly into live unpacked + host dir
      const metaA = await buildWebActivationArtifacts({
        repoRoot: sourceRepoDir,
        extOutDir: liveExtDir,
        hostOutDir: hostInstallDir,
        metaOutPath: join(isolatedRoot, 'build-a-meta.json'),
        buildId: `build-a-${headA.slice(0, 8)}`,
        sourceHead: headA,
        nativeHostApplication: testHostName,
        nodePaths: [join(rootCheckout, 'node_modules')]
      })
      const liveHostScript = join(hostInstallDir, 'native-host.bundle.cjs')
      cpSync(join(hostInstallDir, 'native-host.cjs'), liveHostScript)

      // Start ExtensionManagerService + LocalChannelHost + MCP HTTP Server
      const manager = new ExtensionManagerService({ userDataPath: appDataDir })
      const localChannel = new LocalChannelHost(
        [
          new WebActivationLocalAdapter(
            async () => ({ status: 'UNAVAILABLE', observedAt: new Date().toISOString() }),
            manager
          )
        ],
        appDataDir
      )
      cleanups.push(() => localChannel.dispose())
      await localChannel.start()

      const adapter = new ChannelMcpAdapter({
        projectId: 'proj-e2e',
        repoRoot: sourceRepoDir,
        navigation: {
          discoverRepository: async () => ({ directories: [] }),
          getRelationships: async () => ({ files: [] }),
          inspectFiles: async () => ({ files: [] }),
          getReferences: async () => ({ targets: [] }),
          getSymbolDependencies: async () => ({ sources: [] }),
          getSymbolHierarchy: async () => ({ targets: [] }),
          readCode: async () => ({ files: [] })
        } as unknown as ProjectContextNavigation,
        webExtensionManager: manager
      })

      const mcpServer = createMcpHttpServer(adapter, () => {})
      await new Promise<void>((resolve) => mcpServer.listen(0, '127.0.0.1', resolve))
      const mcpPort = (mcpServer.address() as { port: number }).port
      const mcpEndpoint = `http://127.0.0.1:${mcpPort}/mcp`
      cleanups.push(
        () =>
          new Promise<void>((resolve) => {
            mcpServer.close(() => resolve())
            mcpServer.closeIdleConnections()
          })
      )

      // Launch isolated Chrome 157
      const cdp = launchIsolatedChrome(chromeUserDataDir)
      cleanups.push(() => cdp.close())

      await cdp.send('Target.setDiscoverTargets', { discover: true })

      // Enable Developer Mode on isolated profile BEFORE loading unpacked (so runtime.reload stays ENABLED)
      const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>(
        'Target.getTargets'
      )
      const extPageTarget = await cdp.send<{ targetId: string }>('Target.createTarget', {
        url: 'chrome://extensions'
      })
      const extPageSession = (
        await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
          targetId: extPageTarget.targetId,
          flatten: true
        })
      ).sessionId
      await cdp.send(
        'Runtime.evaluate',
        {
          expression: `new Promise((r) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => r(true)))`,
          awaitPromise: true,
          returnByValue: true
        },
        extPageSession
      )

      // Load unpacked extension generation A
      const loaded = await cdp.send<{ id: string }>('Extensions.loadUnpacked', { path: liveExtDir })
      const extensionId = loaded.id
      expect(extensionId).toMatch(/^[a-z]{32}$/)

      // Register exclusive temporary HKCU Native Messaging Host pointing to test userDataPath
      installNativeMessagingHost({
        extensionIds: [extensionId],
        hostScriptPath: liveHostScript,
        hostName: testHostName,
        installDir: hostInstallDir,
        userDataPath: appDataDir,
        browsers: ['chrome']
      })
      cleanups.push(() =>
        uninstallNativeMessagingHost({
          hostName: testHostName,
          installDir: hostInstallDir,
          browsers: ['chrome']
        })
      )

      // Wait for Service Worker A target and inspect its persistent identity
      const attachExtensionSw = async (expectedBuildId?: string) => {
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const res = await cdp.send<{
            targetInfos: Array<{ targetId: string; type: string; url: string }>
          }>('Target.getTargets')
          const sw = res.targetInfos.find(
            (t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`)
          )
          if (sw) {
            try {
              const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
                targetId: sw.targetId,
                flatten: true
              })
              const evalRes = await cdp.send<{ result?: { value?: Record<string, string> } }>(
                'Runtime.evaluate',
                {
                  expression: `globalThis.__codeAwarenessMaintenance ? globalThis.__codeAwarenessMaintenance.getIdentity() : null`,
                  awaitPromise: true,
                  returnByValue: true
                },
                sessionId
              )
              const val = evalRes.result?.value
              if (val && (!expectedBuildId || val.buildId === expectedBuildId)) {
                return { sessionId, identity: val }
              }
            } catch {
              // Service worker restarting during reload; retry
            }
          }
          await new Promise((r) => setTimeout(r, 150))
        }
        throw new Error('TIMED_OUT_WAITING_FOR_SW_IDENTITY')
      }

      const swA = await attachExtensionSw(metaA.buildId)
      expect(swA.identity.installType).toBe('development')
      expect(swA.identity.buildId).toBe(metaA.buildId)
      const bootIdA = swA.identity.bootId

      // Enroll installation in Desktop
      manager.enrollInstallation({
        installationId: swA.identity.installationId,
        extensionId,
        installType: 'development',
        profileId: swA.identity.profileId,
        profileLabel: 'isolated-chrome-e2e',
        unpackedPath: liveExtDir,
        hostInstallDir,
        hostScriptPath: liveHostScript,
        sourceRepoPath: sourceRepoDir,
        nativeHostApplication: testHostName
      })

      // Trigger an initial tick so SW A confirms managed=true and arms the real MV3 alarm
      const tickDiag = await cdp.send<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        {
          expression: `(async () => {
            await globalThis.__codeAwarenessMaintenance.runTick('manual');
            const alarms = await new Promise((r) => chrome.alarms.getAll(r));
            return { alarms };
          })()`,
          awaitPromise: true,
          returnByValue: true
        },
        swA.sessionId
      )
      const diagValue = tickDiag.result?.value as {
        alarms?: Array<{ name: string; periodInMinutes?: number }>
      }
      const foundAlarm = diagValue?.alarms?.find((a) => a.name === 'code_awareness.extension_maintenance')
      expect(foundAlarm?.periodInMinutes, JSON.stringify(diagValue)).toBe(1)

      // Commit Generation B inside isolated temp git repo
      const extConfigPath = join(sourceRepoDir, 'src', 'web-extension', 'runtime-config.ts')
      const origConfig = readFileSync(extConfigPath, 'utf8')
      writeFileSync(extConfigPath, `${origConfig}\nexport const GENERATION_MARKER = 'B'\n`, 'utf8')
      execFileSync('git', ['add', '.'], { cwd: sourceRepoDir, windowsHide: true, stdio: 'pipe' })
      execFileSync('git', ['commit', '-m', 'Generation B'], { cwd: sourceRepoDir, windowsHide: true, stdio: 'pipe' })
      const headB = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRepoDir, windowsHide: true })
        .toString('utf8')
        .trim()

      // Call real MCP HTTP tool: start_web_extension_operation(UPDATE)
      const started = await callMcpTool(mcpEndpoint, 'start_web_extension_operation', {
        action: 'UPDATE',
        operationId: 'e2e-chrome-update-1',
        expectedSourceHead: headB
      })
      expect(started.isError, JSON.stringify(started.payload)).toBe(false)
      expect(started.payload.accepted).toBe(true)
      const opRecord = started.payload.operation as { operationId: string; state: string; targetBuildId: string }
      expect(opRecord.state).toBe('WAITING_BROWSER')
      const buildIdB = opRecord.targetBuildId
      expect(buildIdB).not.toBe(metaA.buildId)

      // Dispatch the alarm handler inside SW A (simulating alarm firing without sleeping 60s)
      await cdp.send(
        'Runtime.evaluate',
        {
          expression: `void globalThis.__codeAwarenessMaintenance.runTick('alarm'); true`,
          returnByValue: true
        },
        swA.sessionId
      )

      // Wait organically for Chrome to call runtime.reload(), boot Generation B, spawn new native host B, and report VERIFIED
      let finalOp: Record<string, unknown> | null = null
      let lastObservedOp: Record<string, unknown> | null = null
      const pollDeadline = Date.now() + 20_000
      while (Date.now() < pollDeadline) {
        const opRes = await callMcpTool(mcpEndpoint, 'get_web_extension_operation', {
          operationId: 'e2e-chrome-update-1'
        })
        const op = opRes.payload.operation as { state?: string } | undefined
        if (op) lastObservedOp = op as Record<string, unknown>
        if (op?.state && ['VERIFIED', 'PARTIAL', 'NOT_ATTESTED', 'FAILED', 'EXPIRED'].includes(op.state)) {
          finalOp = op as Record<string, unknown>
          break
        }
        await new Promise((r) => setTimeout(r, 150))
      }

      if (!finalOp) {
        const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets')
        const mgmt = await cdp.send<{ result?: { value?: unknown } }>(
          'Runtime.evaluate',
          { expression: `chrome.management.get('${extensionId}')`, awaitPromise: true, returnByValue: true },
          extPageSession
        )
        const swAfter = targets.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extensionId))
        let swInfo: unknown = null
        if (swAfter) {
          const s = (await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: swAfter.targetId, flatten: true })).sessionId
          swInfo = (
            await cdp.send<{ result?: { value?: unknown } }>(
              'Runtime.evaluate',
              {
                expression: `(async () => ({
                  ident: globalThis.__codeAwarenessMaintenance ? await globalThis.__codeAwarenessMaintenance.getIdentity() : null,
                  storage: await new Promise((r) => chrome.storage.local.get(null, r))
                }))()`,
                awaitPromise: true,
                returnByValue: true
              },
              s
            )
          ).result?.value
        }
        throw new Error(`POLL_TIMEOUT: ${JSON.stringify({ lastObservedOp, mgmt: mgmt.result?.value, targets: targets.targetInfos.filter(t => t.url.includes(extensionId)), swInfo })}`)
      }
      expect(finalOp!.state, JSON.stringify(finalOp)).toBe('VERIFIED')

      // Double check extension remained ENABLED in chrome.management and SW B runs with rotated bootId + buildIdB
      const swB = await attachExtensionSw(buildIdB)
      expect(swB.identity.buildId).toBe(buildIdB)
      expect(swB.identity.bootId).not.toBe(bootIdA)

      const mgmtState = await cdp.send<{ result?: { value?: { enabled?: boolean; installType?: string } } }>(
        'Runtime.evaluate',
        {
          expression: `chrome.management.get('${extensionId}')`,
          awaitPromise: true,
          returnByValue: true
        },
        extPageSession
      )
      expect(mgmtState.result?.value?.enabled).toBe(true)
      expect(mgmtState.result?.value?.installType).toBe('development')

      const statusRes = await callMcpTool(mcpEndpoint, 'get_web_extension_status', {})
      const attestation = statusRes.payload.lastAttestation as {
        bootId: string
        buildId: string
        hostBuildId: string
      }
      expect(attestation.bootId).toBe(swB.identity.bootId)
      expect(attestation.buildId).toBe(buildIdB)
      expect(attestation.hostBuildId).toBe(buildIdB)
    },
    60_000
  )
})
