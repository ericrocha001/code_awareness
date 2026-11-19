import { describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { DeepSeekWebAdapter } from './deepseek-adapter'
import { ExtensionBackgroundRouter } from '../background'
import { ACTIVATION_CONTRACT_PROTOCOL, parseActivationCallEnvelopes } from '../../shared/web-activation/activation-contract'

describe('DeepSeekWebAdapter & MV3 Background Router', () => {
  it('detects authenticated ready state, streaming vs complete turns, quoted envelopes, and sends reply via composer', async () => {
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <main>
          <div class="ds-message" data-message-id="m1" data-role="user">Review the architecture</div>
          <div class="ds-message" data-message-id="m2" data-role="assistant" data-streaming="true">
            <div class="ds-markdown">
              <blockquote>
                <pre><code class="language-code-awareness-call">{"protocol":"code-awareness-activation/v1","requestId":"quoted-1","method":"skills/list"}</code></pre>
              </blockquote>
              <div class="md-code-block">
                <div class="md-code-block-banner"><span>code-awareness-call</span><button>Copy</button></div>
                <pre><code>{"protocol":"code-awareness-activation/v1","requestId":"ds-1","method":"skills/get","params":{"name":"arch"}}</code></pre>
              </div>
            </div>
          </div>
          <footer>
            <textarea id="chat-input" placeholder="Message DeepSeek"></textarea>
            <button data-testid="stop-button" aria-label="Stop generating">Stop</button>
            <button data-testid="send-button" aria-label="Send" disabled>Send</button>
          </footer>
        </main>
      </body></html>`,
      { url: 'https://chat.deepseek.com/c/abc123' }
    )

    const adapter = new DeepSeekWebAdapter()
    const doc = dom.window.document

    expect(adapter.matchesLocation(dom.window.location.href)).toBe(true)
    expect(adapter.matchesLocation('https://chat.qwen.ai/c/1')).toBe(false)
    expect(adapter.isAuthenticatedChatReady(doc)).toBe(true)
    expect(adapter.isGenerating(doc)).toBe(true)

    // Streaming turn must NOT trigger envelope parsing
    const streamingTurns = adapter.readTurns(doc)
    expect(streamingTurns).toHaveLength(2)
    expect(streamingTurns[1].isComplete).toBe(false)
    expect(parseActivationCallEnvelopes(streamingTurns[1]).ignoredReason).toBe('INCOMPLETE_TURN')

    // Sending during streaming is rejected
    const blockedSend = await adapter.sendMessage(doc, 'hello')
    expect(blockedSend).toEqual({ ok: false, status: 'PRE_DISPATCH_BLOCKED', reason: 'STREAMING_IN_PROGRESS' })

    // Transition to complete (stop button hidden/removed, streaming flag removed, send button enabled)
    doc.querySelector('[data-testid="stop-button"]')?.remove()
    doc.querySelector('[data-message-id="m2"]')?.removeAttribute('data-streaming')

    expect(adapter.isGenerating(doc)).toBe(false)
    const completeTurns = adapter.readTurns(doc)
    expect(completeTurns[1].isComplete).toBe(true)

    const parsed = parseActivationCallEnvelopes(completeTurns[1])
    expect(parsed.calls).toEqual([
      {
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId: 'ds-1',
        method: 'skills/get',
        params: { name: 'arch' }
      }
    ])

    // Composer updates and clicks send button when enabled
    const textarea = doc.querySelector('#chat-input') as HTMLTextAreaElement
    const sendBtn = doc.querySelector('[data-testid="send-button"]') as HTMLButtonElement
    textarea.addEventListener('input', () => {
      sendBtn.disabled = textarea.value.trim().length === 0
    })
    const clicked = vi.fn()
    sendBtn.addEventListener('click', clicked)

    const sendRes = await adapter.sendMessage(doc, '```code-awareness-result\n{"ok":true}\n```')
    expect(sendRes).toEqual({ ok: true, status: 'DISPATCHED' })
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(textarea.value).toContain('code-awareness-result')
  })

  it('requires login state false when password prompt is visible and rejects unauthorized origins or web-origin consent writes', async () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><form><input type="password" /></form></body></html>`,
      { url: 'https://chat.deepseek.com/sign_in' }
    )
    const adapter = new DeepSeekWebAdapter()
    expect(adapter.isAuthenticatedChatReady(dom.window.document)).toBe(false)

    const sendNative = vi.fn(async (payload) => ({ id: payload.id, ok: true, echoed: payload }))
    const router = new ExtensionBackgroundRouter(sendNative, 'ext-id-123')

    // Unauthorized external site rejected
    const evil = await router.handleMessage(
      { type: 'GET_STATUS' },
      { url: 'https://evil.example.com', tab: { id: 1 } }
    )
    expect(evil).toMatchObject({ ok: false, error: { code: 'ORIGIN_NOT_ALLOWED' } })

    // Content script cannot grant itself consent
    const selfConsent = await router.handleMessage(
      { type: 'SET_CONSENT', site: 'deepseek', dataClass: 'METADATA', granted: true },
      { url: 'https://chat.deepseek.com/c/1', tab: { id: 2, url: 'https://chat.deepseek.com/c/1' } }
    )
    expect(selfConsent).toMatchObject({ ok: false, error: { code: 'ORIGIN_NOT_ALLOWED' } })
    expect(sendNative).not.toHaveBeenCalled()

    // Popup (chrome-extension://<id> without tab) CAN grant consent
    const popupConsent = await router.handleMessage(
      { type: 'SET_CONSENT', site: 'deepseek', projectId: 'p1', dataClass: 'METADATA', granted: true },
      { id: 'ext-id-123', url: 'chrome-extension://ext-id-123/popup.html' }
    )
    expect(popupConsent).toMatchObject({ ok: true })
    expect(sendNative).toHaveBeenCalledTimes(1)
  })

  it('matches live chat.deepseek.com primary role=button send control, .ds-loading streaming indicator, and banner+pre code block', async () => {
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <div class="ds-virtual-list-visible-items">
          <div class="ds-message d29f3d7d _63c77b1">Inspect repo</div>
          <div class="ds-message _63c77b1">
            <div class="ds-markdown ds-assistant-message-main-content">
              <div class="md-code-block md-code-block-dark">
                <div class="md-code-block-banner md-code-block-banner-lite">
                  <span class="d813de27">code-awareness-call</span>
                  <div role="button">Copiar</div>
                </div>
                <pre>{"protocol":"${ACTIVATION_CONTRACT_PROTOCOL}","requestId":"live-ds-1","method":"skills.load","params":{"uri":"skill://global/s1/a/SKILL.md"}}</pre>
              </div>
            </div>
          </div>
        </div>
        <textarea class="_27c9245 ds-scroll-area" placeholder="Mensagem para DeepSeek"></textarea>
        <div role="button" class="ds-button ds-button--primary ds-button--filled ds-button--circle ds-button--m ds-button--icon-relative-m ds-button--disabled _52c986b bd74640a">
          <div class="ds-loading"></div>
        </div>
      </body></html>`,
      { url: 'https://chat.deepseek.com/a/chat/s/live-id' }
    )
    const adapter = new DeepSeekWebAdapter()
    const doc = dom.window.document

    expect(adapter.isAuthenticatedChatReady(doc)).toBe(true)
    expect(adapter.isGenerating(doc)).toBe(true)
    expect((await adapter.sendMessage(doc, 'blocked')).reason).toBe('STREAMING_IN_PROGRESS')

    doc.querySelector('.ds-loading')?.remove()
    expect(adapter.isGenerating(doc)).toBe(false)

    const turns = adapter.readTurns(doc)
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant'])
    expect(turns[1].isComplete).toBe(true)
    expect(parseActivationCallEnvelopes(turns[1]).calls).toEqual([
      {
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId: 'live-ds-1',
        method: 'skills.load',
        params: { uri: 'skill://global/s1/a/SKILL.md' }
      }
    ])

    const textarea = doc.querySelector('textarea') as HTMLTextAreaElement
    const sendBtn = doc.querySelector('div[role="button"].ds-button--primary') as HTMLElement
    textarea.addEventListener('input', () => {
      if (textarea.value.trim().length > 0) {
        sendBtn.classList.remove('ds-button--disabled', 'bd74640a')
      } else {
        sendBtn.classList.add('ds-button--disabled', 'bd74640a')
      }
    })
    let clicked = 0
    sendBtn.addEventListener('click', () => { clicked += 1 })

    const res = await adapter.sendMessage(doc, '```code-awareness-result\n{"ok":true}\n```')
    expect(res).toEqual({ ok: true, status: 'DISPATCHED' })
    expect(clicked).toBe(1)

    // Composer modified by user during await preserves user text and never clicks
    textarea.value = ''
    let clickedGuard = 0
    sendBtn.addEventListener('click', () => { clickedGuard += 1 })
    const pModified = adapter.sendMessage(doc, 'ext-payload')
    textarea.value = 'User edited mid-dispatch'
    const modifiedRes = await pModified
    expect(modifiedRes).toEqual({ ok: false, status: 'PRE_DISPATCH_BLOCKED', reason: 'COMPOSER_MODIFIED_BY_USER' })
    expect(textarea.value).toBe('User edited mid-dispatch')
    expect(clickedGuard).toBe(0)

    // Context change abort during await clears untouched composer text and never clicks
    textarea.value = ''
    const abortedRes = await adapter.sendMessage(doc, 'ext-payload-2', () => false)
    expect(abortedRes).toEqual({ ok: false, status: 'DISPATCH_ABORTED', reason: 'CONTEXT_CHANGED_BEFORE_DISPATCH' })
    expect(textarea.value).toBe('')
    expect(clickedGuard).toBe(0)
  })
})
