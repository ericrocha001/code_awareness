import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalChannelHost } from '../local-agent-channel/local-channel-host'
import { ConsentStore } from './consent-store'
import {
  encodeNativeMessage,
  NativeFramingError,
  NativeMessageFrameDecoder,
  runNativeStdioLoop
} from './native-messaging-protocol'
import {
  discoverDesktopWebActivationEndpoint,
  discoverDesktopWebActivationEndpointDetailed,
  NativeMessagingBridge
} from './native-messaging-bridge'
import { createRuntimeMessageTransport } from '../../web-extension/runtime-transport'
import {
  getBrowserNativeMessagingRegistryKey,
  installNativeMessagingHost,
  uninstallNativeMessagingHost,
  type NativeHostRegistryRunner
} from './native-host-registration'
import { WebActivationLocalAdapter } from './web-activation-local-adapter'
import { createChromeNativePortSender } from '../../web-extension/background'
import type { ChromeApi, ChromeNativePortLike } from '../../web-extension/chrome-api'
import {
  GLOBAL_CONSENT_PROJECT_ID,
  WEB_NATIVE_HOST_NAME,
  type DesktopSkillsEndpointInfo
} from './web-activation-types'

const tempDirs: string[] = []
const cleanups: Array<() => void | Promise<void>> = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const VALID_EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/'

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(cleanups.splice(0).reverse().map((fn) => fn()))
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Native Messaging protocol, bridge, consent, and Windows registration', () => {
  it('frames UInt32LE messages across partial/coalesced chunks and enforces inbound/outbound size limits', async () => {
    const decoder = new NativeMessageFrameDecoder(128)
    const msgA = encodeNativeMessage({ id: '1', action: 'ping' }, 128)
    const msgB = encodeNativeMessage({ id: '2', action: 'get_status' }, 128)
    const combined = Buffer.concat([msgA, msgB])

    const parsed: unknown[] = []
    for (let i = 0; i < combined.byteLength; i += 3) {
      parsed.push(...decoder.push(combined.subarray(i, Math.min(combined.byteLength, i + 3))))
    }
    expect(parsed).toEqual([
      { id: '1', action: 'ping' },
      { id: '2', action: 'get_status' }
    ])

    const oversizedHeader = Buffer.alloc(4)
    oversizedHeader.writeUInt32LE(256, 0)
    expect(() => decoder.push(oversizedHeader)).toThrowError(NativeFramingError)

    const zeroHeader = Buffer.alloc(4)
    zeroHeader.writeUInt32LE(0, 0)
    expect(() => new NativeMessageFrameDecoder(128).push(zeroHeader)).toThrowError(NativeFramingError)

    const invalidJsonBody = Buffer.from('{bad', 'utf8')
    const invalidJsonFrame = Buffer.allocUnsafe(4 + invalidJsonBody.byteLength)
    invalidJsonFrame.writeUInt32LE(invalidJsonBody.byteLength, 0)
    invalidJsonBody.copy(invalidJsonFrame, 4)
    expect(() => new NativeMessageFrameDecoder(128).push(invalidJsonFrame)).toThrowError(NativeFramingError)

    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const outChunks: Buffer[] = []
    stdout.on('data', (chunk: Buffer) => outChunks.push(chunk))

    const loopPromise = runNativeStdioLoop(
      stdin,
      stdout,
      async (req) => ({ id: (req as { id: string }).id, ok: true, big: 'x'.repeat(500) }),
      { maxInboundBytes: 1024, maxOutboundBytes: 256 }
    )
    stdin.write(encodeNativeMessage({ id: 'req-big' }, 1024))
    stdin.end()
    await loopPromise

    const outDecoder = new NativeMessageFrameDecoder(1024)
    const outMessages = outDecoder.push(Buffer.concat(outChunks))
    expect(outMessages).toHaveLength(1)
    expect(outMessages[0]).toMatchObject({
      id: 'req-big',
      ok: false,
      error: { code: 'RESPONSE_TOO_LARGE' }
    })
  })

  it('authorizes the picker without granting the same origin MCP execution', async () => {
    const consentStore = new ConsentStore(makeTempDir('picker-consent-'))
    const dispatchLocalAction = vi.fn(async () => ({ ok: true as const, result: { scope: 'fixture' } }))
    const bridge = new NativeMessagingBridge({
      consentStore,
      callerOrigin: VALID_EXT_ORIGIN,
      allowedExtensionOrigins: [VALID_EXT_ORIGIN],
      dispatchLocalAction
    })
    const request = { action: 'catalog', filters: {} }
    const read = { id: 'picker', action: 'context_picker', webOrigin: 'https://chatgpt.com', request }
    expect(await bridge.handle(read)).toMatchObject({ ok: true, result: { scope: 'fixture' } })
    expect(await bridge.handle({ ...read, webOrigin: 'https://chatgpt.com.evil.example' }))
      .toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } })
    expect(await bridge.handle({ ...read, action: 'mcp_request', site: 'chatgpt', method: 'tools/list' }))
      .toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } })
    const anonymous = new NativeMessagingBridge({ consentStore, dispatchLocalAction })
    expect(await anonymous.handle(read)).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } })
    expect(dispatchLocalAction).toHaveBeenCalledExactlyOnceWith('context_picker', { webOrigin: read.webOrigin, request })
  })

  it('authorizes the picker extension UI only for manual operations and binds its caller origin', async () => {
    const consentStore = new ConsentStore(makeTempDir('popup-consent-'))
    const dispatchLocalAction = vi.fn(async () => ({ ok: true as const, result: { scope: 'fixture' } }))
    const bridge = new NativeMessagingBridge({
      consentStore, callerOrigin: VALID_EXT_ORIGIN, allowedExtensionOrigins: [VALID_EXT_ORIGIN], dispatchLocalAction
    })
    const request = { action: 'catalog', filters: {} }
    const command = { id: 'popup', action: 'context_picker', surface: 'extension-ui', request }
    expect(await bridge.handle(command)).toMatchObject({ ok: true })
    expect(dispatchLocalAction).toHaveBeenCalledExactlyOnceWith('context_picker', {
      surface: 'extension-ui', extensionOrigin: VALID_EXT_ORIGIN, request
    })
    for (const action of ['attach', 'text', 'mcp_request', 'publish']) {
      expect(await bridge.handle({ ...command, request: { action } })).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } })
    }
    expect(await bridge.handle({ ...command, webOrigin: 'https://chatgpt.com' }))
      .toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } })
    expect(dispatchLocalAction).toHaveBeenCalledOnce()
  })

  it('validates caller/web origins, read-only allowlists, URI confinement, and revocable consent by site + projectId + dataClass', async () => {
    const dataDir = makeTempDir('web-consent-')
    const store = new ConsentStore(dataDir)

    const unauthorizedOriginBridge = new NativeMessagingBridge({
      consentStore: store,
      callerOrigin: 'https://evil.example.com/',
      allowedExtensionOrigins: [VALID_EXT_ORIGIN],
      resolveDesktopEndpoint: async () => ({
        status: 'RUNNING',
        mode: 'PROJECT',
        endpoint: 'http://127.0.0.1:49999/mcp',
        projectId: 'proj-1',
        instanceId: 'inst-1',
        bindingId: 'bind-1',
        observedAt: new Date().toISOString()
      })
    })
    expect((await unauthorizedOriginBridge.handle({ id: '1', action: 'ping' })).error?.code).toBe('ORIGIN_NOT_ALLOWED')

    let activeProjectId: string | null = 'proj-1'
    const mcpTransport = vi.fn(async (_endpoint, _headers, payload) => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: (payload as { id: number }).id,
        result: (payload as { method: string }).method === 'tools/list'
          ? { tools: [{ name: 'list_artifacts' }, { name: 'read_code' }, { name: 'publish_artifact' }] }
          : { ok: true }
      }
    }))

    const bridge = new NativeMessagingBridge({
      consentStore: store,
      callerOrigin: VALID_EXT_ORIGIN,
      allowedExtensionOrigins: [VALID_EXT_ORIGIN],
      resolveDesktopEndpoint: async () => ({
        status: 'RUNNING',
        mode: activeProjectId ? 'PROJECT' : 'GLOBAL_ONLY',
        endpoint: 'http://127.0.0.1:49999/mcp',
        projectId: activeProjectId,
        instanceId: 'inst-1',
        bindingId: 'bind-1',
        observedAt: new Date().toISOString()
      }),
      mcpTransport
    })

    // Reject disallowed web origins and mismatched site bindings
    const badWebOrigin = await bridge.handle({
      id: 'bad-origin',
      action: 'mcp_request',
      site: 'deepseek',
      webOrigin: 'https://chat.evil.example',
      method: 'skills/list'
    })
    expect(badWebOrigin.error?.code).toBe('ORIGIN_NOT_ALLOWED')

    const mismatchSite = await bridge.handle({
      id: 'mismatch-site',
      action: 'mcp_request',
      site: 'deepseek',
      webOrigin: 'https://chat.qwen.ai',
      method: 'skills/list'
    })
    expect(mismatchSite.error?.code).toBe('ORIGIN_NOT_ALLOWED')

    // Reject disallowed methods, mutation tools, and non-skill:// URIs before any MCP call
    const forbiddenMethod = await bridge.handle({
      id: 'm-1',
      action: 'mcp_request',
      site: 'deepseek',
      webOrigin: 'https://chat.deepseek.com',
      method: 'tools/execute'
    })
    expect(forbiddenMethod.error?.code).toBe('METHOD_NOT_ALLOWED')

    for (const forbiddenTool of ['create_academy_skill', 'commit_git_changes', 'prepare_cli_execution', 'publish_artifact']) {
      const res = await bridge.handle({
        id: `t-${forbiddenTool}`,
        action: 'mcp_request',
        site: 'deepseek',
        webOrigin: 'https://chat.deepseek.com',
        method: 'tools/call',
        params: { name: forbiddenTool, arguments: {} }
      })
      expect(res.error?.code).toBe('TOOL_NOT_ALLOWED')
    }

    const forbiddenUri = await bridge.handle({
      id: 'u-1',
      action: 'mcp_request',
      site: 'deepseek',
      webOrigin: 'https://chat.deepseek.com',
      method: 'resources/read',
      params: { uri: 'file:///C:/Windows/win.ini' }
    })
    expect(forbiddenUri.error?.code).toBe('METHOD_NOT_ALLOWED')
    expect(mcpTransport).not.toHaveBeenCalled()

    // Require METADATA consent first
    const noMetaConsent = await bridge.handle({
      id: 'c-1',
      action: 'mcp_request',
      site: 'deepseek',
      webOrigin: 'https://chat.deepseek.com',
      method: 'tools/list'
    })
    expect(noMetaConsent.error?.code).toBe('CONSENT_REQUIRED')
    expect(noMetaConsent.error?.details).toMatchObject({
      site: 'deepseek',
      projectId: 'proj-1',
      dataClass: 'METADATA'
    })

    // Grant METADATA consent for deepseek + proj-1
    const grantedMeta = await bridge.handle({
      id: 'g-1',
      action: 'set_consent',
      site: 'deepseek',
      projectId: 'proj-1',
      dataClass: 'METADATA',
      granted: true,
      webOrigin: 'https://chat.deepseek.com'
    })
    expect(grantedMeta.ok).toBe(true)

    const allowedMeta = await bridge.handle({
      id: 'c-2',
      action: 'mcp_request',
      site: 'deepseek',
      webOrigin: 'https://chat.deepseek.com',
      method: 'tools/list'
    })
    expect(allowedMeta.ok).toBe(true)
    expect(allowedMeta.result).toMatchObject({ mcp: { result: { tools: [{ name: 'list_artifacts' }] } } })
    expect(mcpTransport).toHaveBeenCalledTimes(1)

    for (const method of ['server/discover', 'skills/list', 'skills/get', 'resources/list', 'resources/read']) {
      const denied = await bridge.handle({
        id: method, action: 'mcp_request', site: 'deepseek', webOrigin: 'https://chat.deepseek.com', method
      })
      expect(denied.error?.code).toBe('METHOD_NOT_ALLOWED')
    }
    const deniedTool = await bridge.handle({
      id: 'deny-tool', action: 'mcp_request', site: 'deepseek', webOrigin: 'https://chat.deepseek.com',
      method: 'tools/call', params: { name: 'publish_artifact', arguments: { name: 'list_artifacts' } }
    })
    expect(deniedTool.error?.code).toBe('TOOL_NOT_ALLOWED')
    expect(mcpTransport).toHaveBeenCalledTimes(1)

    // LITERAL_SOURCE remains gated even when METADATA is granted
    for (const literalCall of [
      { method: 'tools/call', params: { name: 'get_artifact', arguments: { artifactId: 'fixture' } } },
      { method: 'tools/call', params: { name: 'read_artifact_section', arguments: {} } },
    ]) {
      const blockedLiteral = await bridge.handle({
        id: 'lit-blocked',
        action: 'mcp_request',
        site: 'deepseek',
        webOrigin: 'https://chat.deepseek.com',
        ...literalCall
      })
      expect(blockedLiteral.error?.code).toBe('CONSENT_REQUIRED')
      expect(blockedLiteral.error?.details?.dataClass).toBe('LITERAL_SOURCE')
    }

    // Grant LITERAL_SOURCE consent for deepseek + proj-1 -> allowed
    await bridge.handle({
      id: 'g-2',
      action: 'set_consent',
      site: 'deepseek',
      projectId: 'proj-1',
      dataClass: 'LITERAL_SOURCE',
      granted: true
    })
    const allowedLiteral = await bridge.handle({
      id: 'lit-ok',
      action: 'mcp_request',
      site: 'deepseek',
      webOrigin: 'https://chat.deepseek.com',
      method: 'tools/call',
      params: { name: 'get_artifact', arguments: { artifactId: 'fixture' } }
    })
    expect(allowedLiteral.ok).toBe(true)

    // Consent isolation by site and projectId
    const qwenBlocked = await bridge.handle({
      id: 'qwen-blocked',
      action: 'mcp_request',
      site: 'qwen',
      webOrigin: 'https://chat.qwen.ai',
      method: 'tools/list'
    })
    expect(qwenBlocked.error?.code).toBe('CONSENT_REQUIRED')

    activeProjectId = 'proj-2'
    const otherProjBlocked = await bridge.handle({
      id: 'p2-blocked',
      action: 'mcp_request',
      site: 'deepseek',
      webOrigin: 'https://chat.deepseek.com',
      method: 'tools/list'
    })
    expect(otherProjBlocked.error?.code).toBe('CONSENT_REQUIRED')
    expect(otherProjBlocked.error?.details?.projectId).toBe('proj-2')

    // Revoking LITERAL_SOURCE blocks read_code immediately while keeping METADATA
    activeProjectId = 'proj-1'
    await bridge.handle({
      id: 'r-1',
      action: 'set_consent',
      site: 'deepseek',
      projectId: 'proj-1',
      dataClass: 'LITERAL_SOURCE',
      granted: false
    })
    const revokedRead = await bridge.handle({
      id: 'lit-revoked',
      action: 'mcp_request',
      site: 'deepseek',
      webOrigin: 'https://chat.deepseek.com',
      method: 'tools/call',
      params: { name: 'get_artifact', arguments: {} }
    })
    expect(revokedRead.error?.code).toBe('CONSENT_REQUIRED')

    const reloadedStore = new ConsentStore(dataDir)
    expect(reloadedStore.hasConsent('deepseek', 'proj-1', 'METADATA')).toBe(true)
    expect(reloadedStore.hasConsent('deepseek', 'proj-1', 'LITERAL_SOURCE')).toBe(false)

    // Global-only consent uses normalized GLOBAL_CONSENT_PROJECT_ID
    activeProjectId = null
    const globalBlocked = await bridge.handle({
      id: 'g-blocked',
      action: 'mcp_request',
      site: 'deepseek',
      webOrigin: 'https://chat.deepseek.com',
      method: 'tools/list'
    })
    expect(globalBlocked.error?.details?.projectId).toBe(GLOBAL_CONSENT_PROJECT_ID)
  })

  it('discovers endpoint over LocalChannelHost pipe, propagates SESSION_INVALIDATED, and fails closed when Desktop is unavailable', async () => {
    const profileDir = makeTempDir('web-pipe-profile-')
    const store = new ConsentStore(profileDir)
    store.grantConsent({ site: 'deepseek', projectId: 'proj-A', dataClass: 'METADATA' })

    let endpointState: DesktopSkillsEndpointInfo = {
      status: 'RUNNING',
      mode: 'PROJECT',
      endpoint: 'http://127.0.0.1:41234/mcp',
      projectId: 'proj-A',
      instanceId: 'inst-A',
      bindingId: 'bind-A',
      observedAt: new Date().toISOString()
    }

    const host = new LocalChannelHost(
      [new WebActivationLocalAdapter(async () => endpointState)],
      profileDir
    )
    await host.start()
    cleanups.push(() => host.dispose())

    let nextHttpStatus = 200
    let nextBody: unknown = { jsonrpc: '2.0', id: 1, result: { skills: [] } }
    const seenHeaders: Array<Record<string, string>> = []

    const bridge = new NativeMessagingBridge({
      consentStore: store,
      callerOrigin: VALID_EXT_ORIGIN,
      userDataPath: profileDir,
      mcpTransport: async (_url, headers) => {
        seenHeaders.push(headers)
        return { status: nextHttpStatus, body: nextBody }
      }
    })

    const discovered = await discoverDesktopWebActivationEndpoint(profileDir)
    expect(discovered).toMatchObject({ status: 'RUNNING', projectId: 'proj-A', bindingId: 'bind-A' })

    const okCall = await bridge.handle({
      id: 'ok-1',
      action: 'mcp_request',
      site: 'deepseek',
      webOrigin: 'https://chat.deepseek.com',
      method: 'tools/list',
      expectedProjectId: 'proj-A',
      expectedBindingId: 'bind-A',
      expectedInstanceId: 'inst-A'
    })
    expect(okCall.ok).toBe(true)
    expect(seenHeaders[0]).toMatchObject({
      'x-code-awareness-binding': 'bind-A',
      'x-code-awareness-instance': 'inst-A',
      'x-code-awareness-project': 'proj-A'
    })

    // Project / binding mismatch rejects immediately with SESSION_INVALIDATED
    endpointState = { ...endpointState, projectId: 'proj-B', bindingId: 'bind-B' }
    const staleRes = await bridge.handle({
      id: 'stale-1',
      action: 'mcp_request',
      site: 'deepseek',
      webOrigin: 'https://chat.deepseek.com',
      method: 'tools/list',
      expectedProjectId: 'proj-A',
      expectedBindingId: 'bind-A'
    })
    expect(staleRes.error?.code).toBe('SESSION_INVALIDATED')
    expect(seenHeaders).toHaveLength(1)

    // HTTP 409 / -32001 from MCP server maps to SESSION_INVALIDATED
    store.grantConsent({ site: 'deepseek', projectId: 'proj-B', dataClass: 'METADATA' })
    nextHttpStatus = 409
    nextBody = { jsonrpc: '2.0', id: 2, error: { code: -32001, message: 'MCP_SESSION_INVALIDATED' } }
    const conflictRes = await bridge.handle({
      id: 'conflict-1',
      action: 'mcp_request',
      site: 'deepseek',
      webOrigin: 'https://chat.deepseek.com',
      method: 'tools/list',
      expectedProjectId: 'proj-B',
      expectedBindingId: 'bind-B'
    })
    expect(conflictRes.error?.code).toBe('SESSION_INVALIDATED')

    // Stopping Desktop host causes fail-closed APP_UNAVAILABLE
    host.dispose()
    const statusUnavailable = await bridge.handle({ id: 'st-down', action: 'get_status', site: 'deepseek' })
    expect(statusUnavailable.ok).toBe(true)
    expect(statusUnavailable.result).toMatchObject({ available: false, errorCode: 'APP_UNAVAILABLE' })

    const blockedUnavailable = await bridge.handle({
      id: 'mcp-down',
      action: 'mcp_request',
      site: 'deepseek',
      webOrigin: 'https://chat.deepseek.com',
      method: 'tools/list'
    })
    expect(blockedUnavailable.error?.code).toBe('APP_UNAVAILABLE')
  })

  it('installs and uninstalls Windows Native Messaging host manifest/registry idempotently and rejects worktree paths', () => {
    const baseDir = makeTempDir('native-install-')
    const stableHostScript = join(baseDir, 'native-host.cjs')
    writeFileSync(stableHostScript, '// host', 'utf8')
    const installDir = join(baseDir, 'install-target')
    const worktreeDir = join(baseDir, 'worktrees', 'bad-install')

    expect(() =>
      installNativeMessagingHost({
        extensionIds: ['abcdefghijklmnopabcdefghijklmnop'],
        hostScriptPath: stableHostScript,
        installDir: worktreeDir
      })
    ).toThrow(/WORKTREE_DESTINATION_UNSUPPORTED/)

    const worktreeScript = join(baseDir, 'worktree', 'native-host.cjs')
    expect(() =>
      installNativeMessagingHost({
        extensionIds: ['abcdefghijklmnopabcdefghijklmnop'],
        hostScriptPath: worktreeScript,
        installDir
      })
    ).toThrow(/WORKTREE_HOST_SCRIPT_UNSUPPORTED/)

    const registryOps: Array<{ op: 'add' | 'delete'; key: string; value?: string }> = []
    const fakeRegistry: NativeHostRegistryRunner = {
      addDefaultStringValue(keyPath, value) {
        registryOps.push({ op: 'add', key: keyPath, value })
      },
      deleteKey(keyPath) {
        registryOps.push({ op: 'delete', key: keyPath })
      }
    }

    const firstInstall = installNativeMessagingHost({
      extensionIds: ['ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP', `chrome-extension://abcdefghijklmnopabcdefghijklmnop/`],
      hostScriptPath: stableHostScript,
      installDir,
      runtimeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      userDataPath: 'C:\\Users\\test\\AppData\\Roaming\\code-awareness',
      browsers: ['chrome', 'edge'],
      registry: fakeRegistry
    })
    // Re-running is idempotent
    const secondInstall = installNativeMessagingHost({
      extensionIds: ['abcdefghijklmnopabcdefghijklmnop'],
      hostScriptPath: stableHostScript,
      installDir,
      runtimeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      userDataPath: 'C:\\Users\\test\\AppData\\Roaming\\code-awareness',
      browsers: ['chrome', 'edge'],
      registry: fakeRegistry
    })

    expect(firstInstall.manifestPath).toBe(secondInstall.manifestPath)
    expect(existsSync(firstInstall.manifestPath)).toBe(true)
    expect(existsSync(firstInstall.launcherPath)).toBe(true)

    const manifest = JSON.parse(readFileSync(firstInstall.manifestPath, 'utf8'))
    expect(manifest).toEqual({
      name: WEB_NATIVE_HOST_NAME,
      description: 'Code Awareness Local Web Activation Native Messaging Bridge',
      path: firstInstall.launcherPath,
      type: 'stdio',
      allowed_origins: [VALID_EXT_ORIGIN]
    })

    const launcher = readFileSync(firstInstall.launcherPath, 'utf8')
    expect(launcher).toContain('CODE_AWARENESS_USER_DATA=C:\\Users\\test\\AppData\\Roaming\\code-awareness')
    expect(launcher).toContain(stableHostScript)

    expect(registryOps).toContainEqual({
      op: 'add',
      key: getBrowserNativeMessagingRegistryKey('chrome'),
      value: firstInstall.manifestPath
    })
    expect(registryOps).toContainEqual({
      op: 'add',
      key: getBrowserNativeMessagingRegistryKey('edge'),
      value: firstInstall.manifestPath
    })

    uninstallNativeMessagingHost({ installDir, browsers: ['chrome', 'edge'], registry: fakeRegistry })
    expect(existsSync(firstInstall.manifestPath)).toBe(false)
    expect(existsSync(firstInstall.launcherPath)).toBe(false)
    expect(registryOps).toContainEqual({
      op: 'delete',
      key: getBrowserNativeMessagingRegistryKey('chrome')
    })
  })

  it('reuses chrome.runtime.connectNative Port with id multiplexing, idle TTL, fail-closed disconnect, and safe reconnect', async () => {
    vi.useFakeTimers()
    cleanups.push(() => {
      vi.useRealTimers()
    })

    interface MockPortHarness {
      port: ChromeNativePortLike
      posted: Array<Record<string, unknown>>
      disconnected: boolean
      emitMessage: (msg: unknown) => void
      triggerDisconnect: (errorMessage?: string) => void
    }

    const ports: MockPortHarness[] = []
    let runtimeErrorMessage: string | undefined

    const chromeMock: ChromeApi = {
      runtime: {
        get lastError() {
          return runtimeErrorMessage ? { message: runtimeErrorMessage } : undefined
        },
        connectNative(application) {
          expect(application).toBe(WEB_NATIVE_HOST_NAME)
          const messageListeners = new Set<(msg: unknown) => void>()
          const disconnectListeners = new Set<() => void>()
          const harness: MockPortHarness = {
            posted: [],
            disconnected: false,
            port: {
              name: application,
              postMessage(msg) {
                harness.posted.push(msg as Record<string, unknown>)
              },
              disconnect() {
                harness.disconnected = true
              },
              onMessage: {
                addListener(cb) {
                  messageListeners.add(cb)
                },
                removeListener(cb) {
                  messageListeners.delete(cb)
                }
              },
              onDisconnect: {
                addListener(cb) {
                  disconnectListeners.add(cb)
                },
                removeListener(cb) {
                  disconnectListeners.delete(cb)
                }
              }
            },
            emitMessage(msg) {
              for (const cb of messageListeners) cb(msg)
            },
            triggerDisconnect(errorMessage) {
              harness.disconnected = true
              runtimeErrorMessage = errorMessage
              for (const cb of disconnectListeners) cb()
              runtimeErrorMessage = undefined
            }
          }
          ports.push(harness)
          return harness.port
        }
      }
    }

    const sender = createChromeNativePortSender(chromeMock, { idleTtlMs: 250, requestTimeoutMs: 5_000 })

    // Concurrent requests share 1 port and resolve out of order by id
    const req1 = sender({ id: 'req-1', action: 'ping' })
    const req2 = sender({ id: 'req-2', action: 'get_status' })
    expect(ports).toHaveLength(1)
    expect(sender.getPortStats()).toEqual({ connectCount: 1, activePort: true, pendingCount: 2 })
    expect(ports[0].posted.map((p) => p.id)).toEqual(['req-1', 'req-2'])

    ports[0].emitMessage({ id: 'req-2', ok: true, result: { second: true } })
    // Even after advancing past idleTtlMs, req-1 is still pending so Port stays open
    await vi.advanceTimersByTimeAsync(400)
    expect(ports[0].disconnected).toBe(false)
    expect(sender.getPortStats()).toEqual({ connectCount: 1, activePort: true, pendingCount: 1 })

    ports[0].emitMessage({ id: 'req-1', ok: true, result: { first: true } })
    expect(await req2).toEqual({ id: 'req-2', ok: true, result: { second: true } })
    expect(await req1).toEqual({ id: 'req-1', ok: true, result: { first: true } })

    // Idle timeout closes Port once pendingCount === 0
    await vi.advanceTimersByTimeAsync(260)
    expect(ports[0].disconnected).toBe(true)
    expect(sender.getPortStats()).toEqual({ connectCount: 1, activePort: false, pendingCount: 0 })

    // Subsequent call opens a new Port cleanly; abrupt disconnect fails in-flight request without retrying
    const req3 = sender({ id: 'req-3', action: 'mcp_request' })
    expect(ports).toHaveLength(2)
    expect(ports[1].posted).toHaveLength(1)
    ports[1].triggerDisconnect('Host crashed mid-flight')

    const failed3 = (await req3) as { ok: boolean; error?: { code: string; message: string } }
    expect(failed3.ok).toBe(false)
    expect(failed3.error?.code).toBe('APP_UNAVAILABLE')
    expect(failed3.error?.message).toContain('Host crashed mid-flight')
    expect(ports[1].posted).toHaveLength(1) // no silent auto-retry
    expect(sender.getPortStats()).toEqual({ connectCount: 2, activePort: false, pendingCount: 0 })

    // Next call after disconnect reconnects safely on a fresh Port
    const req4 = sender({ id: 'req-4', action: 'ping' })
    expect(ports).toHaveLength(3)
    ports[2].emitMessage({ id: 'req-4', ok: true, result: { reconnected: true } })
    expect(await req4).toEqual({ id: 'req-4', ok: true, result: { reconnected: true } })
    sender.closePort('test-cleanup')
  })

  it('classifies pipe, HTTP abort, Port, one-shot, and runtime-message timeouts as TIMEOUT, validates JSON-RPC correlation, and unblocks serial stdio', async () => {
    // 1. Pipe timeout -> TIMEOUT (phase: desktop_discovery), distinct from APP_UNAVAILABLE
    const pipeDir = makeTempDir('ca-pipe-timeout-')
    mkdirWait: {
      const { mkdirSync } = await import('node:fs')
      mkdirSync(join(pipeDir, 'local-agent-channel'), { recursive: true })
      break mkdirWait
    }
    const silentSockets = new Set<import('node:net').Socket>()
    const silentSocketServer = createNetServer((conn) => {
      silentSockets.add(conn)
      conn.once('close', () => silentSockets.delete(conn))
    })
    const pipePath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\ca-silent-${Date.now()}-${Math.random().toString(16).slice(2)}`
        : join(pipeDir, 'silent.sock')
    await new Promise<void>((resolve) => silentSocketServer.listen(pipePath, resolve))
    writeFileSync(
      join(pipeDir, 'local-agent-channel', 'endpoint.json'),
      JSON.stringify({ protocol: 'code-awareness-local/v1', token: 'tok', endpoint: pipePath }),
      'utf8'
    )
    const pipeLookup = await discoverDesktopWebActivationEndpointDetailed(pipeDir, 80)
    for (const conn of silentSockets) conn.destroy()
    await new Promise<void>((resolve) => silentSocketServer.close(() => resolve()))
    expect(pipeLookup.ok).toBe(false)
    if (!pipeLookup.ok) {
      expect(pipeLookup.code).toBe('TIMEOUT')
      expect(pipeLookup.details?.phase).toBe('desktop_discovery')
    }

    // 2. Real hung HTTP server aborted by NativeMessagingBridge unblocks subsequent serial stdio message
    let hangFirst = true
    const stalledHttp = createHttpServer((_req, res) => {
      if (hangFirst) {
        hangFirst = false
        return // Hang first request until client AbortController aborts
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { ok: true } }))
    })
    await new Promise<void>((resolve) => stalledHttp.listen(0, '127.0.0.1', resolve))
    const httpPort = (stalledHttp.address() as { port: number }).port

    const bridgeDir = makeTempDir('ca-http-abort-')
    const consentStore = new ConsentStore(bridgeDir)
    consentStore.grantConsent({ site: 'deepseek', projectId: 'proj-t', dataClass: 'METADATA' })

    const bridge = new NativeMessagingBridge({
      consentStore,
      callerOrigin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/',
      mcpTimeoutMs: 100,
      resolveDesktopEndpointDetailed: async () => ({
        ok: true,
        info: {
          status: 'RUNNING',
          mode: 'PROJECT',
          projectId: 'proj-t',
          instanceId: 'inst-t',
          bindingId: 'bind-t',
          endpoint: `http://127.0.0.1:${httpPort}/mcp`,
          observedAt: new Date().toISOString()
        }
      })
    })

    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const decoder = new NativeMessageFrameDecoder()
    const outMessages: Array<Record<string, unknown>> = []
    stdout.on('data', (chunk: Buffer) => {
      for (const msg of decoder.push(chunk)) {
        outMessages.push(msg as Record<string, unknown>)
      }
    })
    const loopDone = runNativeStdioLoop(stdin, stdout, (msg) => bridge.handle(msg))

    stdin.write(
      encodeNativeMessage({
        id: 'serial-1',
        action: 'mcp_request',
        site: 'deepseek',
        webOrigin: 'https://chat.deepseek.com',
        method: 'tools/list',
        expectedProjectId: 'proj-t',
        expectedBindingId: 'bind-t',
        expectedInstanceId: 'inst-t'
      })
    )
    stdin.write(
      encodeNativeMessage({
        id: 'serial-2',
        action: 'mcp_request',
        site: 'deepseek',
        webOrigin: 'https://chat.deepseek.com',
        method: 'tools/list',
        expectedProjectId: 'proj-t',
        expectedBindingId: 'bind-t',
        expectedInstanceId: 'inst-t'
      })
    )

    await vi.waitFor(() => expect(outMessages.length).toBe(2), { timeout: 3000 })
    stdin.end()
    await loopDone
    stalledHttp.closeAllConnections?.()
    await new Promise<void>((resolve) => stalledHttp.close(() => resolve()))

    expect(outMessages[0]).toMatchObject({
      id: 'serial-1',
      ok: false,
      error: {
        code: 'TIMEOUT',
        details: { phase: 'mcp_http', executionStateUnknown: true }
      }
    })
    expect(outMessages[1]).toMatchObject({ id: 'serial-2', ok: true })

    // 3. JSON-RPC correlation id mismatch and missing result/error rejected explicitly
    const mismatchBridge = new NativeMessagingBridge({
      consentStore,
      callerOrigin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/',
      resolveDesktopEndpointDetailed: async () => ({
        ok: true,
        info: {
          status: 'RUNNING',
          mode: 'PROJECT',
          projectId: 'proj-t',
          endpoint: 'http://127.0.0.1:1/mcp',
          observedAt: new Date().toISOString()
        }
      }),
      mcpTransport: async () => ({ status: 200, body: { jsonrpc: '2.0', id: 999, result: {} } })
    })
    const mismatchRes = await mismatchBridge.handle({
      id: 'm-1',
      action: 'mcp_request',
      site: 'deepseek',
      webOrigin: 'https://chat.deepseek.com',
      method: 'tools/list'
    })
    expect(mismatchRes.ok).toBe(false)
    expect(mismatchRes.error?.code).toBe('INVALID_MCP_RESPONSE')

    // 4. Fake timers on Port sender, one-shot fallback, and runtime-message transport
    vi.useFakeTimers()
    let messageListeners: Array<(msg: unknown) => void> = []
    const portMock: ChromeNativePortLike = {
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: (l) => messageListeners.push(l), removeListener: vi.fn() },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() }
    }
    const portSender = createChromeNativePortSender(
      { runtime: { connectNative: () => portMock } },
      { requestTimeoutMs: 20_000, idleTtlMs: 30_000 }
    )
    const pendingPortCall = portSender({ id: 'p-timeout', action: 'mcp_request' })
    // Unrelated ID & malformed payload must NOT hijack pendingPortCall
    for (const l of messageListeners) {
      l({ id: 'wrong-id', ok: true })
      l(null)
    }
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await pendingPortCall).toMatchObject({
      id: 'p-timeout',
      ok: false,
      error: { code: 'TIMEOUT', details: { phase: 'native_port', timeoutMs: 20_000, executionStateUnknown: true } }
    })
    // Late response after timeout is ignored safely
    const pFollowup = portSender({ id: 'p-ok', action: 'ping' })
    for (const l of messageListeners) {
      l({ id: 'p-timeout', ok: true, result: { late: true } })
      l({ id: 'p-ok', ok: true, result: { ok: true } })
    }
    expect(await pFollowup).toEqual({ id: 'p-ok', ok: true, result: { ok: true } })

    // Fallback one-shot timeout + ignore late callback
    let capturedOneShotCb: ((r: unknown) => void) | undefined
    const oneShotSender = createChromeNativePortSender(
      {
        runtime: {
          sendNativeMessage: (_app, _msg, cb) => {
            capturedOneShotCb = cb
          }
        }
      },
      { requestTimeoutMs: 5_000 }
    )
    const pOneShot = oneShotSender({ id: 'os-1', action: 'ping' })
    await vi.advanceTimersByTimeAsync(5_000)
    ;(capturedOneShotCb as ((r: unknown) => void) | undefined)?.({ id: 'os-1', ok: true, result: { late: true } })
    expect(await pOneShot).toMatchObject({
      id: 'os-1',
      ok: false,
      error: { code: 'TIMEOUT', details: { phase: 'native_port', timeoutMs: 5_000 } }
    })

    // Content runtime-message transport 25s timeout + consents forwarding
    let capturedRuntimeCb: ((r: unknown) => void) | undefined
    const rtTransport = createRuntimeMessageTransport(
      {
        runtime: {
          sendMessage: (_payload, cb) => {
            capturedRuntimeCb = cb
          }
        }
      },
      'deepseek',
      'https://chat.deepseek.com',
      { timeoutMs: 25_000 }
    )
    const pRt = rtTransport.mcpRequest({
      method: 'tools/call',
      expectedProjectId: null,
      expectedBindingId: null,
      expectedInstanceId: null
    })
    await vi.advanceTimersByTimeAsync(25_000)
    ;(capturedRuntimeCb as ((r: unknown) => void) | undefined)?.({ ok: true, result: { late: true } })
    expect(await pRt).toMatchObject({
      ok: false,
      error: { code: 'TIMEOUT', details: { phase: 'runtime_message', timeoutMs: 25_000 } }
    })

    const rtWithConsents = createRuntimeMessageTransport(
      {
        runtime: {
          sendMessage: (_payload, cb) => {
            cb?.({
              ok: true,
              result: {
                available: true,
                mode: 'PROJECT',
                projectId: 'p1',
                consents: { metadata: true, literalSource: false }
              }
            })
          }
        }
      },
      'deepseek',
      'https://chat.deepseek.com'
    )
    expect(await rtWithConsents.getStatus()).toMatchObject({
      available: true,
      consents: { metadata: true, literalSource: false }
    })
    vi.useRealTimers()
  })
})
