import { describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { QwenWebAdapter } from './qwen-adapter'
import { ContentSessionController } from '../content-script'
import { ACTIVATION_CONTRACT_PROTOCOL } from '../../shared/web-activation/activation-contract'
import type { WebActivationTransport } from '../../shared/web-activation/activation-session'

describe('QwenWebAdapter & ContentSessionController', () => {
  it('detects Qwen chat readiness, ignores incomplete/quoted turns, and executes emulated ActivationSession replies', async () => {
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <main id="chat-root">
          <div class="qwen-chat-message" data-message-id="q1" data-role="user">Hello Qwen</div>
          <footer>
            <textarea id="chat-input" placeholder="Ask Qwen anything"></textarea>
            <button data-testid="send-button" aria-label="Send" disabled>Send</button>
          </footer>
        </main>
      </body></html>`,
      { url: 'https://chat.qwen.ai/c/session-1' }
    )

    const adapter = new QwenWebAdapter()
    const doc = dom.window.document
    const textarea = doc.querySelector('#chat-input') as HTMLTextAreaElement
    const sendBtn = doc.querySelector('[data-testid="send-button"]') as HTMLButtonElement
    textarea.addEventListener('input', () => {
      sendBtn.disabled = textarea.value.trim().length === 0
    })

    const sentMessages: string[] = []
    sendBtn.addEventListener('click', () => {
      sentMessages.push(textarea.value)
      textarea.value = ''
      sendBtn.disabled = true
    })

    expect(adapter.matchesLocation(dom.window.location.href)).toBe(true)
    expect(adapter.matchesLocation('https://chat.deepseek.com/c/1')).toBe(false)
    expect(adapter.isAuthenticatedChatReady(doc)).toBe(true)

    const transport: WebActivationTransport = {
      getStatus: vi.fn(async () => ({
        available: true,
        mode: 'PROJECT' as const,
        projectId: 'proj-q',
        instanceId: 'inst-1',
        bindingId: 'bind-1'
      })),
      mcpRequest: vi.fn(async ({ method, params }) => {
        if (method === 'skills/list') {
          return {
            ok: true,
            mcp: { result: { skills: [{ uri: 'skill://global/s1/sec/SKILL.md', name: 'sec', description: 'Security audit' }] } }
          }
        }
        if (method === 'tools/list') {
          return { ok: true, mcp: { result: { tools: [{ name: 'discover_repository' }] } } }
        }
        if (method === 'tools/call') {
          return {
            ok: true,
            mcp: { result: { tool: params?.name, directories: [{ relativePath: '.', children: ['src'] }] } }
          }
        }
        return { ok: true, mcp: { result: {} } }
      })
    }

    const controller = new ContentSessionController(adapter, doc, transport, true)
    expect(doc.querySelector('#code-awareness-activation-pill')?.getAttribute('data-ca-state')).toBe('INACTIVE')

    const act = await controller.activate(true)
    expect(act.ok).toBe(true)
    expect(act.state).toBe('READY')
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0]).toContain(ACTIVATION_CONTRACT_PROTOCOL)
    expect(doc.querySelector('#code-awareness-activation-pill')?.getAttribute('data-ca-state')).toBe('READY')

    // Simulated streaming assistant response must not trigger call yet
    const main = doc.querySelector('#chat-root')!
    const assistantDiv = doc.createElement('div')
    assistantDiv.className = 'qwen-chat-message'
    assistantDiv.setAttribute('data-message-id', 'q2')
    assistantDiv.setAttribute('data-role', 'assistant')
    assistantDiv.setAttribute('data-streaming', 'true')
    assistantDiv.innerHTML = `<div class="qwen-markdown"><pre><code class="language-code-awareness-call">{"protocol":"${ACTIVATION_CONTRACT_PROTOCOL}","requestId":"qw-1","method":"tools/call","params":{"name":"discover_repository","arguments":{}}}</code></pre></div>`
    main.appendChild(assistantDiv)

    await controller.handleDomMutation()
    expect(sentMessages).toHaveLength(1)

    // Complete assistant turn executes and injects code-awareness-result into composer
    assistantDiv.removeAttribute('data-streaming')
    await controller.handleDomMutation()
    expect(sentMessages).toHaveLength(2)
    expect(sentMessages[1]).toContain('```code-awareness-result')
    expect(sentMessages[1]).toContain('"requestId":"qw-1"')
    expect(sentMessages[1]).toContain('"server":"code-awareness-desktop"')
    expect(sentMessages[1]).toContain('"ok":true')

    // Revocation updates UI pill immediately
    controller.revoke()
    expect(doc.querySelector('#code-awareness-activation-pill')?.getAttribute('data-ca-state')).toBe('REVOKED')
    controller.dispose()
  })

  it('matches live chat.qwen.ai localized DOM classes (message-input-textarea and send-button aria-label Enviar)', async () => {
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <div class="message-input-container">
          <div class="message-input-container-area">
            <textarea class="message-input-textarea message-input-textarea-separation" placeholder="Perguntar ao Qwen" rows="1"></textarea>
          </div>
          <div class="message-input-right-button-send">
            <div class="chat-prompt-send-button">
              <button class="send-button" aria-label="Enviar" disabled>Enviar</button>
            </div>
          </div>
        </div>
      </body></html>`,
      { url: 'https://chat.qwen.ai/' }
    )
    const adapter = new QwenWebAdapter()
    const doc = dom.window.document
    const textarea = doc.querySelector('textarea.message-input-textarea') as HTMLTextAreaElement
    const sendBtn = doc.querySelector('button.send-button') as HTMLButtonElement
    textarea.addEventListener('input', () => {
      sendBtn.disabled = textarea.value.trim().length === 0
    })
    let clicked = 0
    sendBtn.addEventListener('click', () => { clicked += 1 })

    expect(adapter.isAuthenticatedChatReady(doc)).toBe(true)
    const sent = await adapter.sendMessage(doc, 'test')
    expect(sent).toEqual({ ok: true, status: 'DISPATCHED' })
    expect(clicked).toBe(1)
  })

  it('detects live chat.qwen.ai button.stop-button (aria-label Pare) while generating and button.chat-prompt-send-button when ready', async () => {
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <div class="chat-messages-container">
          <div class="qwen-chat-message qwen-chat-message-user">Hi</div>
          <div class="qwen-chat-message qwen-chat-message-assistant"><div class="qwen-markdown qwen-markdown-loose">Streaming...</div></div>
        </div>
        <textarea class="message-input-textarea" placeholder="Perguntar ao Qwen"></textarea>
        <div class="chat-prompt-send-button">
          <button class="stop-button" aria-label="Pare"></button>
        </div>
      </body></html>`,
      { url: 'https://chat.qwen.ai/c/session-live' }
    )
    const adapter = new QwenWebAdapter()
    const doc = dom.window.document

    expect(adapter.isAuthenticatedChatReady(doc)).toBe(true)
    expect(adapter.isGenerating(doc)).toBe(true)
    expect((await adapter.sendMessage(doc, 'wait')).reason).toBe('STREAMING_IN_PROGRESS')

    const turnsStreaming = adapter.readTurns(doc)
    expect(turnsStreaming.map((t) => t.role)).toEqual(['user', 'assistant'])
    expect(turnsStreaming[1].isComplete).toBe(false)

    doc.querySelector('button.stop-button')!.outerHTML = '<button class="chat-prompt-send-button" aria-label="Enviar" disabled></button>'
    expect(adapter.isGenerating(doc)).toBe(false)

    const textarea = doc.querySelector('textarea.message-input-textarea') as HTMLTextAreaElement
    const sendBtn = doc.querySelector('button.chat-prompt-send-button') as HTMLButtonElement
    textarea.addEventListener('input', () => {
      sendBtn.disabled = textarea.value.trim().length === 0
    })
    let clicked = 0
    sendBtn.addEventListener('click', () => { clicked += 1 })

    expect(await adapter.sendMessage(doc, 'ready')).toEqual({ ok: true, status: 'DISPATCHED' })
    expect(clicked).toBe(1)
  })
})
