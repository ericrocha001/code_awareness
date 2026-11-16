import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcademyService } from '../main/academy/academy-service'
import { LocalChannelHost } from '../main/local-agent-channel/local-channel-host'
import { ChannelMcpAdapter } from '../main/mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../main/mcp/mcp-http-server'
import { ConsentStore } from '../main/web-activation/consent-store'
import { encodeNativeMessage, NativeMessageFrameDecoder } from '../main/web-activation/native-messaging-protocol'
import { WebActivationLocalAdapter } from '../main/web-activation/web-activation-local-adapter'
import type { DesktopSkillsEndpointInfo } from '../main/web-activation/web-activation-types'
import type { ProjectContextNavigation } from '../main/core/context/project-context-navigation'
import { DeepSeekWebAdapter } from './adapters/deepseek-adapter'
import { QwenWebAdapter } from './adapters/qwen-adapter'
import { ExtensionBackgroundRouter, type NativeMessageSender } from './background'
import { ContentSessionController } from './content-script'
import { ACTIVATION_CONTRACT_PROTOCOL } from '../shared/web-activation/activation-contract'
import type { WebActivationTransport } from '../shared/web-activation/activation-session'

const tempDirs: string[] = []
const services: AcademyService[] = []
const cleanups: Array<() => void | Promise<void>> = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function stubNavigation(): ProjectContextNavigation {
  return {
    discoverRepository: vi.fn(async () => ({ directories: [{ relativePath: '.', children: ['src'] }] })),
    getRelationships: vi.fn(async () => ({ files: [] })),
    inspectFiles: vi.fn(async () => ({ files: [] })),
    getReferences: vi.fn(async () => ({ targets: [] })),
    getSymbolDependencies: vi.fn(async () => ({ sources: [] })),
    getSymbolHierarchy: vi.fn(async () => ({ targets: [] })),
    readCode: vi.fn(async () => [])
  }
}

function createStdioNativeClient(
  hostScript: string,
  callerOrigin: string,
  userDataPath: string
): { send: NativeMessageSender; close: () => Promise<void> } {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [hostScript, callerOrigin], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CODE_AWARENESS_USER_DATA: userDataPath
    }
  })

  const decoder = new NativeMessageFrameDecoder()
  const pending = new Map<string, (response: unknown) => void>()

  child.stdout.on('data', (chunk: Buffer) => {
    for (const msg of decoder.push(chunk)) {
      const id = msg && typeof msg === 'object' && typeof (msg as { id?: unknown }).id === 'string'
        ? (msg as { id: string }).id
        : ''
      const resolvePending = pending.get(id)
      if (resolvePending) {
        pending.delete(id)
        resolvePending(msg)
      }
    }
  })

  const send: NativeMessageSender = (payload) =>
    new Promise((resolve, reject) => {
      const id = String(payload.id ?? '')
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Native stdio timeout waiting for ${id}`))
      }, 5000)
      pending.set(id, (resp) => {
        clearTimeout(timer)
        resolve(resp)
      })
      child.stdin.write(encodeNativeMessage(payload))
    })

  const close = () =>
    new Promise<void>((res) => {
      if (child.killed || child.exitCode !== null) {
        res()
        return
      }
      child.once('exit', () => res())
      child.stdin.end()
      setTimeout(() => child.kill(), 1500)
    })

  return { send, close }
}

function createRouterBackedTransport(
  router: ExtensionBackgroundRouter,
  site: 'deepseek' | 'qwen',
  webOrigin: string
): WebActivationTransport {
  const webSender = { url: `${webOrigin}/c/live`, tab: { id: 1, url: `${webOrigin}/c/live` } }
  return {
    async getStatus() {
      const res = (await router.handleMessage({ type: 'GET_STATUS', site, webOrigin }, webSender)) as {
        ok?: boolean
        result?: {
          available?: boolean
          mode?: 'PROJECT' | 'GLOBAL_ONLY'
          projectId?: string | null
          instanceId?: string | null
          bindingId?: string | null
          errorCode?: string
        }
        error?: { code?: string }
      }
      if (!res?.ok || !res.result?.available) {
        return { available: false, errorCode: res?.error?.code ?? res?.result?.errorCode ?? 'APP_UNAVAILABLE' }
      }
      return {
        available: true,
        mode: res.result.mode ?? 'GLOBAL_ONLY',
        projectId: res.result.projectId ?? null,
        instanceId: res.result.instanceId ?? null,
        bindingId: res.result.bindingId ?? null
      }
    },
    async mcpRequest(input) {
      const res = (await router.handleMessage(
        {
          type: 'MCP_REQUEST',
          site,
          webOrigin,
          method: input.method,
          params: input.params ?? {},
          expectedProjectId: input.expectedProjectId,
          expectedBindingId: input.expectedBindingId,
          expectedInstanceId: input.expectedInstanceId
        },
        webSender
      )) as {
        ok?: boolean
        result?: { mcp?: { result?: unknown; error?: { code?: number; message?: string } } }
        error?: { code: string; message: string; details?: Record<string, unknown> }
      }
      if (!res?.ok) {
        return { ok: false, error: res?.error ?? { code: 'APP_UNAVAILABLE', message: 'Failed' } }
      }
      return { ok: true, mcp: res.result?.mcp }
    }
  }
}

function createSiteDom(url: string) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <main id="chat">
        <footer>
          <textarea id="chat-input" placeholder="Message"></textarea>
          <button data-testid="send-button" aria-label="Send" disabled>Send</button>
        </footer>
      </main>
    </body></html>`,
    { url }
  )
  const doc = dom.window.document
  const textarea = doc.querySelector('#chat-input') as HTMLTextAreaElement
  const sendBtn = doc.querySelector('[data-testid="send-button"]') as HTMLButtonElement
  const sent: string[] = []
  textarea.addEventListener('input', () => {
    sendBtn.disabled = textarea.value.trim().length === 0
  })
  sendBtn.addEventListener('click', () => {
    sent.push(textarea.value)
    textarea.value = ''
    sendBtn.disabled = true
  })
  return { dom, doc, sent }
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).reverse().map((fn) => fn()))
  await Promise.all(services.splice(0).map((svc) => svc.close().catch(() => {})))
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('End-to-End Web Activation Pipeline (MCP Server + Pipe + Native Stdio Host + Session + DeepSeek/Qwen Adapters)', () => {
  it('completes real DeepSeek and Qwen activation, skill verification, consent revocation, and project-change invalidation over real spawned stdio host', async () => {
    const profileDir = makeTempDir('e2e-profile-')
    const repoDir = makeTempDir('e2e-repo-')
    const academy = new AcademyService(join(profileDir, 'academy.db'))
    services.push(academy)

    const dest = academy.store.upsertDestination(repoDir, 'e2e-repo')
    const skillMd = '---\nname: clean-boundaries\ndescription: Verify clean boundaries\n---\n\n# Rule\nIsolate pure domain modules.\n'
    await academy.saveNewSkill({
      package: { skillMd },
      scope: 'PROJECT',
      projectIds: [dest.id],
      origin: 'UI'
    })

    const mcpAdapter = new ChannelMcpAdapter(
      { projectId: dest.id, repoRoot: repoDir, navigation: stubNavigation() },
      undefined,
      undefined,
      undefined,
      academy
    )
    const server = createMcpHttpServer(mcpAdapter, () => {})
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
    cleanups.push(() => new Promise<void>((res) => server.close(() => res())))
    const port = (server.address() as { port: number }).port

    let currentProjectId: string | null = dest.id
    let currentBindingId = 'bind-e2e-1'
    const endpointProvider = async (): Promise<DesktopSkillsEndpointInfo> => ({
      status: 'RUNNING',
      mode: currentProjectId ? 'PROJECT' : 'GLOBAL_ONLY',
      endpoint: `http://127.0.0.1:${port}/mcp`,
      projectId: currentProjectId,
      instanceId: 'inst-e2e-1',
      bindingId: currentBindingId,
      observedAt: new Date().toISOString()
    })

    const pipeHost = new LocalChannelHost(
      [new WebActivationLocalAdapter(endpointProvider)],
      profileDir
    )
    await pipeHost.start()
    cleanups.push(() => pipeHost.dispose())

    const extId = 'abcdefghijklmnopabcdefghijklmnop'
    const extOrigin = `chrome-extension://${extId}/`
    const hostScript = resolve(process.cwd(), 'scripts', 'web-activation', 'native-host.cjs')
    const stdioClient = createStdioNativeClient(hostScript, extOrigin, profileDir)
    cleanups.push(() => stdioClient.close())

    const router = new ExtensionBackgroundRouter(stdioClient.send, extId)
    const popupSender = { id: extId, url: `chrome-extension://${extId}/popup.html` }

    for (const [site, webOrigin] of [
      ['deepseek', 'https://chat.deepseek.com'],
      ['qwen', 'https://chat.qwen.ai']
    ] as const) {
      await router.handleMessage(
        { type: 'SET_CONSENT', site, projectId: dest.id, dataClass: 'METADATA', granted: true, webOrigin },
        popupSender
      )
      await router.handleMessage(
        { type: 'SET_CONSENT', site, projectId: dest.id, dataClass: 'LITERAL_SOURCE', granted: true, webOrigin },
        popupSender
      )
    }

    const dsDom = createSiteDom('https://chat.deepseek.com/c/demo')
    const dsController = new ContentSessionController(
      new DeepSeekWebAdapter(),
      dsDom.doc,
      createRouterBackedTransport(router, 'deepseek', 'https://chat.deepseek.com'),
      true
    )
    cleanups.push(() => dsController.dispose())

    const dsAct = await dsController.activate(true)
    expect(dsAct.ok).toBe(true)
    expect(dsAct.bootstrapPrompt).toContain('clean-boundaries')
    expect(dsAct.bootstrapPrompt).toContain('skills.load')
    expect(dsAct.bootstrapPrompt).not.toContain('Isolate pure domain modules.')
    expect(dsAct.bootstrapPrompt).not.toContain('discover_repository')
    // Ensures write/admin Academy tools are filtered out from bootstrap catalog
    expect(dsAct.bootstrapPrompt).not.toContain('delete_academy_global_skill')
    expect(dsDom.sent).toHaveLength(1)

    // Progressive flow: skills.load delivers verified SKILL.md + compact availableTools (without digests or inputSchema), then tools.schema + tools.call
    const dsChat = dsDom.doc.querySelector('#chat')!
    const uriMatch = /(skill:\/\/project\/[^\s)]+\/clean-boundaries\/SKILL\.md)/.exec(dsAct.bootstrapPrompt ?? '')
    const listedUri = uriMatch?.[1] ?? ''
    expect(listedUri).toMatch(/^skill:\/\/project\/.+\/clean-boundaries\/SKILL\.md$/)

    const dsLoadTurn = dsDom.doc.createElement('div')
    dsLoadTurn.className = 'ds-message'
    dsLoadTurn.setAttribute('data-message-id', 'ds-msg-load')
    dsLoadTurn.setAttribute('data-role', 'assistant')
    dsLoadTurn.innerHTML = `<div class="ds-markdown"><pre><code class="language-code-awareness-call">${JSON.stringify({
      protocol: ACTIVATION_CONTRACT_PROTOCOL,
      requestId: 'e2e-ds-load',
      method: 'skills.load',
      params: { uri: listedUri }
    })}</code></pre></div>`
    dsChat.appendChild(dsLoadTurn)
    await dsController.handleDomMutation()
    expect(dsDom.sent).toHaveLength(2)
    expect(dsDom.sent[1]).toContain('Isolate pure domain modules.')
    expect(dsDom.sent[1]).toContain('discover_repository')
    expect(dsDom.sent[1]).not.toContain('sha256:')
    expect(dsDom.sent[1]).not.toContain('delete_academy_global_skill')
    expect(dsController.session.isPresentInActiveChat(listedUri)).toBe(true)

    const dsTurn1 = dsDom.doc.createElement('div')
    dsTurn1.className = 'ds-message'
    dsTurn1.setAttribute('data-message-id', 'ds-msg-1')
    dsTurn1.setAttribute('data-role', 'assistant')
    dsTurn1.innerHTML = `<div class="ds-markdown"><pre><code class="language-code-awareness-call">${JSON.stringify({
      protocol: ACTIVATION_CONTRACT_PROTOCOL,
      requestId: 'e2e-ds-schema',
      method: 'tools.schema',
      params: { names: ['discover_repository'] }
    })}</code></pre></div>`
    dsChat.appendChild(dsTurn1)
    await dsController.handleDomMutation()
    expect(dsDom.sent).toHaveLength(3)
    const schemaEnvelope = JSON.parse(dsDom.sent[2].split('\n')[1])
    expect(schemaEnvelope.ok).toBe(true)
    expect(schemaEnvelope.result.tools[0].name).toBe('discover_repository')

    const dsTurn2 = dsDom.doc.createElement('div')
    dsTurn2.className = 'ds-message'
    dsTurn2.setAttribute('data-message-id', 'ds-msg-2')
    dsTurn2.setAttribute('data-role', 'assistant')
    dsTurn2.innerHTML = `<div class="ds-markdown"><pre><code class="language-code-awareness-call">${JSON.stringify({
      protocol: ACTIVATION_CONTRACT_PROTOCOL,
      requestId: 'e2e-ds-2',
      method: 'tools.call',
      params: { name: 'discover_repository', arguments: {} }
    })}</code></pre></div>`
    dsChat.appendChild(dsTurn2)
    await dsController.handleDomMutation()
    expect(dsDom.sent).toHaveLength(4)
    expect(dsDom.sent[3]).toContain('"ok":true')
    expect(dsController.session.isPresentInActiveChat(listedUri)).toBe(true)
    const skillUri = listedUri

    const qwDom = createSiteDom('https://chat.qwen.ai/c/demo')
    const qwController = new ContentSessionController(
      new QwenWebAdapter(),
      qwDom.doc,
      createRouterBackedTransport(router, 'qwen', 'https://chat.qwen.ai'),
      true
    )
    cleanups.push(() => qwController.dispose())
    const qwAct = await qwController.activate(true)
    expect(qwAct.ok).toBe(true)
    expect(qwController.session.isPresentInActiveChat(skillUri)).toBe(false)

    currentProjectId = 'proj-other'
    currentBindingId = 'bind-e2e-2'
    const qwTurn = qwDom.doc.createElement('div')
    qwTurn.className = 'qwen-chat-message'
    qwTurn.setAttribute('data-message-id', 'qw-msg-1')
    qwTurn.setAttribute('data-role', 'assistant')
    qwTurn.innerHTML = `<div class="qwen-markdown"><pre><code class="language-code-awareness-call">${JSON.stringify({
      protocol: ACTIVATION_CONTRACT_PROTOCOL,
      requestId: 'e2e-qw-stale',
      method: 'skills/list',
      params: {}
    })}</code></pre></div>`
    qwDom.doc.querySelector('#chat')!.appendChild(qwTurn)
    await qwController.handleDomMutation()
    expect(qwController.session.getState()).toBe('INACTIVE')
    expect(qwDom.sent[1]).toContain('SESSION_INVALIDATED')

    const store = new ConsentStore(join(profileDir, 'web-activation'))
    store.revokeConsent({ site: 'deepseek', projectId: dest.id, dataClass: 'METADATA' })
    currentProjectId = dest.id
    currentBindingId = 'bind-e2e-1'
    const dsTurn3 = dsDom.doc.createElement('div')
    dsTurn3.className = 'ds-message'
    dsTurn3.setAttribute('data-message-id', 'ds-msg-3')
    dsTurn3.setAttribute('data-role', 'assistant')
    dsTurn3.innerHTML = `<div class="ds-markdown"><pre><code class="language-code-awareness-call">${JSON.stringify({
      protocol: ACTIVATION_CONTRACT_PROTOCOL,
      requestId: 'e2e-ds-revoked',
      method: 'skills/list',
      params: {}
    })}</code></pre></div>`
    dsChat.appendChild(dsTurn3)
    await dsController.handleDomMutation()
    expect(dsController.session.getState()).toBe('REVOKED')
  }, 15000)
})
