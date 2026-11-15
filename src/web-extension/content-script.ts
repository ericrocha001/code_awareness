import {
  ActivationSession,
  type ActivationSessionState,
  type WebActivationTransport
} from '../shared/web-activation/activation-session'
import { getChromeApi, type ChromeApi } from './chrome-api'
import type { WebChatAdapter } from './adapters/adapter-interface'
import { DeepSeekWebAdapter } from './adapters/deepseek-adapter'
import { QwenWebAdapter } from './adapters/qwen-adapter'

export function selectWebChatAdapter(locationHref: string): WebChatAdapter | null {
  const candidates: WebChatAdapter[] = [new DeepSeekWebAdapter(), new QwenWebAdapter()]
  for (const adapter of candidates) {
    if (adapter.matchesLocation(locationHref)) return adapter
  }
  return null
}

export function createRuntimeMessageTransport(
  chromeApi: ChromeApi,
  site: 'deepseek' | 'qwen',
  webOrigin: string
): WebActivationTransport {
  const sendRuntimeMessage = <T>(payload: Record<string, unknown>): Promise<T> =>
    new Promise((resolve) => {
      if (!chromeApi.runtime?.sendMessage) {
        resolve({
          ok: false,
          error: { code: 'APP_UNAVAILABLE', message: 'chrome.runtime.sendMessage unavailable' }
        } as T)
        return
      }
      chromeApi.runtime.sendMessage(payload, (response) => {
        if (chromeApi.runtime?.lastError) {
          resolve({
            ok: false,
            error: {
              code: 'APP_UNAVAILABLE',
              message: chromeApi.runtime.lastError.message ?? 'Extension background disconnected'
            }
          } as T)
          return
        }
        resolve((response ?? { ok: false, error: { code: 'APP_UNAVAILABLE', message: 'Empty bridge response' } }) as T)
      })
    })

  return {
    async getStatus() {
      const res = await sendRuntimeMessage<{
        ok?: boolean
        result?: {
          available?: boolean
          mode?: 'PROJECT' | 'GLOBAL_ONLY'
          projectId?: string | null
          instanceId?: string | null
          bindingId?: string | null
          catalogRevision?: string | null
          errorCode?: string
        }
        error?: { code?: string }
      }>({ type: 'GET_STATUS', site, webOrigin })

      if (!res?.ok || !res.result?.available) {
        return {
          available: false,
          errorCode: res?.error?.code ?? res?.result?.errorCode ?? 'APP_UNAVAILABLE'
        }
      }

      return {
        available: true,
        mode: res.result.mode ?? (res.result.projectId ? 'PROJECT' : 'GLOBAL_ONLY'),
        projectId: res.result.projectId ?? null,
        instanceId: res.result.instanceId ?? null,
        bindingId: res.result.bindingId ?? null,
        ...(res.result.catalogRevision ? { catalogRevision: res.result.catalogRevision } : {})
      }
    },

    async mcpRequest(input) {
      const res = await sendRuntimeMessage<{
        ok?: boolean
        result?: {
          mcp?: { result?: unknown; error?: { code?: number; message?: string } }
        }
        error?: { code: string; message: string; details?: Record<string, unknown> }
      }>({
        type: 'MCP_REQUEST',
        site,
        webOrigin,
        method: input.method,
        params: input.params ?? {},
        expectedProjectId: input.expectedProjectId,
        expectedBindingId: input.expectedBindingId,
        expectedInstanceId: input.expectedInstanceId
      })

      if (!res?.ok) {
        return {
          ok: false,
          error: res?.error ?? { code: 'APP_UNAVAILABLE', message: 'MCP request failed' }
        }
      }

      return {
        ok: true,
        mcp: res.result?.mcp
      }
    }
  }
}

export class ContentSessionController {
  readonly session: ActivationSession
  private stopObserver: (() => void) | null = null
  private seenAssistantSignatures = new Set<string>()
  private seenUserCount = 0
  private lastErrorMessage: string | null = null
  private processing = false
  private pillEl: HTMLElement | null = null

  constructor(
    readonly adapter: WebChatAdapter,
    readonly rootDocument: Document,
    transport: WebActivationTransport,
    private readonly mountUi = true
  ) {
    this.session = new ActivationSession({
      site: adapter.site,
      transport
    })
    if (this.mountUi) {
      this.renderPill()
    }
  }

  getStatusSnapshot(): {
    site: string
    state: ActivationSessionState
    binding: ReturnType<ActivationSession['getBinding']>
    authenticated: boolean
    lastError: string | null
  } {
    return {
      site: this.adapter.site,
      state: this.session.getState(),
      binding: this.session.getBinding(),
      authenticated: this.adapter.isAuthenticatedChatReady(this.rootDocument),
      lastError: this.lastErrorMessage
    }
  }

  async activate(sendBootstrap = true): Promise<{
    ok: boolean
    state: ActivationSessionState
    bootstrapPrompt?: string
    error?: { code: string; message: string; details?: Record<string, unknown> }
  }> {
    this.lastErrorMessage = null
    if (!this.adapter.isAuthenticatedChatReady(this.rootDocument)) {
      this.renderPill()
      return {
        ok: false,
        state: this.session.getState(),
        error: {
          code: 'CHAT_NOT_READY',
          message: 'Sign in and open an active chat composer before activating Code Awareness'
        }
      }
    }

    const res = await this.session.activate()
    if (res.state !== 'READY' || !res.bootstrapPrompt) {
      this.lastErrorMessage = res.error?.message ?? res.state
      this.renderPill()
      return {
        ok: false,
        state: res.state,
        error: res.error
      }
    }

    this.markCurrentTurnsSeen()
    this.ensureObserving()

    if (sendBootstrap) {
      const sent = await this.adapter.sendMessage(this.rootDocument, res.bootstrapPrompt)
      if (!sent.ok) {
        this.lastErrorMessage = sent.reason ?? 'SEND_FAILED'
        this.renderPill()
        return {
          ok: false,
          state: this.session.getState(),
          bootstrapPrompt: res.bootstrapPrompt,
          error: { code: sent.reason ?? 'SEND_FAILED', message: 'Failed to inject bootstrap prompt' }
        }
      }
    }

    this.renderPill()
    return {
      ok: true,
      state: res.state,
      bootstrapPrompt: res.bootstrapPrompt
    }
  }

  startNewChat(): void {
    this.lastErrorMessage = null
    this.session.startNewChat()
    this.markCurrentTurnsSeen()
    this.renderPill()
  }

  revoke(): void {
    this.lastErrorMessage = 'Consent revoked for this chat session'
    this.session.revoke()
    this.stopObserving()
    this.renderPill()
  }

  dispose(): void {
    this.stopObserving()
    this.pillEl?.remove()
    this.pillEl = null
  }

  private markCurrentTurnsSeen(): void {
    const turns = this.adapter.readTurns(this.rootDocument)
    this.seenAssistantSignatures.clear()
    let userCount = 0
    for (const turn of turns) {
      if (turn.role === 'assistant' && turn.isComplete) {
        this.seenAssistantSignatures.add(`${turn.messageId}::${turn.text}`)
      } else if (turn.role === 'user') {
        userCount += 1
      }
    }
    this.seenUserCount = userCount
  }

  private ensureObserving(): void {
    if (this.stopObserver) return
    this.stopObserver = this.adapter.observeConversation(this.rootDocument, () => {
      void this.handleDomMutation()
    })
  }

  private stopObserving(): void {
    this.stopObserver?.()
    this.stopObserver = null
  }

  async handleDomMutation(): Promise<void> {
    if (this.processing) return
    const state = this.session.getState()
    if (state !== 'READY' && state !== 'RESUMING' && state !== 'LOADING') {
      return
    }

    this.processing = true
    try {
      if (!this.adapter.isAuthenticatedChatReady(this.rootDocument)) {
        return
      }
      const turns = this.adapter.readTurns(this.rootDocument)
      const userTurns = turns.filter((t) => t.role === 'user')
      if (userTurns.length > this.seenUserCount) {
        const newestUserTurn = userTurns[userTurns.length - 1]
        this.seenUserCount = userTurns.length
        if (!/^ {0,3}`{3,}code-awareness-result\b/m.test(newestUserTurn.text)) {
          this.session.beginUserTurn()
        }
      }

      if (this.adapter.isGenerating(this.rootDocument)) {
        return
      }

      for (const turn of turns) {
        if (turn.role !== 'assistant' || !turn.isComplete) continue
        const sig = `${turn.messageId}::${turn.text}`
        if (this.seenAssistantSignatures.has(sig)) continue
        this.seenAssistantSignatures.add(sig)

        const processed = await this.session.processAssistantTurn(turn)
        if (processed.shouldSendReply && processed.emulatedResponses.length > 0) {
          const replyText = processed.emulatedResponses.join('\n\n')
          await this.adapter.sendMessage(this.rootDocument, replyText)
          break
        }
      }
    } finally {
      this.processing = false
      this.renderPill()
    }
  }

  private renderPill(): void {
    if (!this.mountUi) return
    const body = this.rootDocument.body
    if (!body) return

    if (!this.pillEl) {
      const el = this.rootDocument.createElement('div')
      el.id = 'code-awareness-activation-pill'
      el.setAttribute(
        'style',
        [
          'position:fixed',
          'bottom:16px',
          'right:16px',
          'z-index:2147483000',
          'display:flex',
          'align-items:center',
          'gap:8px',
          'padding:6px 10px',
          'border-radius:9999px',
          'background:#111827',
          'color:#f9fafb',
          'border:1px solid #374151',
          'font:12px/1.2 system-ui,-apple-system,sans-serif',
          'box-shadow:0 4px 12px rgba(0,0,0,0.35)'
        ].join(';')
      )
      body.appendChild(el)
      this.pillEl = el
    }

    const state = this.session.getState()
    const binding = this.session.getBinding()
    this.pillEl.setAttribute('data-ca-state', state)
    this.pillEl.setAttribute('data-ca-site', this.adapter.site)

    const scopeTag = binding.mode === 'PROJECT' && binding.projectId ? `Project` : 'Global'
    const label = this.rootDocument.createElement('span')
    label.textContent = `Code Awareness · ${state}${state === 'READY' || state === 'RESUMING' ? ` (${scopeTag})` : ''}`

    const btn = this.rootDocument.createElement('button')
    btn.type = 'button'
    btn.setAttribute(
      'style',
      'border:0;border-radius:9999px;padding:3px 8px;background:#2563eb;color:#fff;cursor:pointer;font-size:11px;'
    )
    if (state === 'INACTIVE' || state === 'REVOKED' || state === 'UNAVAILABLE') {
      btn.textContent = 'Activate'
      btn.addEventListener('click', () => {
        void this.activate(true)
      })
    } else {
      btn.textContent = 'Revoke'
      btn.setAttribute(
        'style',
        'border:0;border-radius:9999px;padding:3px 8px;background:#dc2626;color:#fff;cursor:pointer;font-size:11px;'
      )
      btn.addEventListener('click', () => {
        this.revoke()
      })
    }

    this.pillEl.replaceChildren(label, btn)
  }
}

export function bootstrapContentScript(
  chromeApi: ChromeApi | undefined = getChromeApi(),
  doc: Document | undefined = (globalThis as unknown as { document?: Document }).document,
  href: string | undefined = (globalThis as unknown as { location?: { href?: string } }).location?.href
): ContentSessionController | null {
  if (!chromeApi || !doc || !href) return null
  const adapter = selectWebChatAdapter(href)
  if (!adapter) return null

  const controller = new ContentSessionController(
    adapter,
    doc,
    createRuntimeMessageTransport(chromeApi, adapter.site, adapter.allowedOrigin),
    true
  )

  chromeApi.runtime?.onMessage?.addListener((rawMessage, _sender, sendResponse) => {
    const msg = rawMessage as { type?: string; sendBootstrap?: boolean } | undefined
    if (!msg?.type) return false

    if (msg.type === 'CONTENT_GET_STATE') {
      sendResponse({ ok: true, ...controller.getStatusSnapshot() })
      return false
    }
    if (msg.type === 'CONTENT_ACTIVATE') {
      void controller.activate(msg.sendBootstrap !== false).then(sendResponse)
      return true
    }
    if (msg.type === 'CONTENT_NEW_CHAT') {
      controller.startNewChat()
      sendResponse({ ok: true, ...controller.getStatusSnapshot() })
      return false
    }
    if (msg.type === 'CONTENT_REVOKE') {
      controller.revoke()
      sendResponse({ ok: true, ...controller.getStatusSnapshot() })
      return false
    }
    return false
  })

  return controller
}

bootstrapContentScript()
