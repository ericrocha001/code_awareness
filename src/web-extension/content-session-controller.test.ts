import { createHash } from 'node:crypto'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACTIVATION_CONTRACT_PROTOCOL } from '../shared/web-activation/activation-contract'
import type { WebActivationTransport } from '../shared/web-activation/activation-session'
import { DeepSeekWebAdapter } from './adapters/deepseek-adapter'
import { ContentSessionController } from './content-script'

function sha256(text: string): { digest: string; size: number } {
  const buf = Buffer.from(text, 'utf8')
  return {
    digest: `sha256:${createHash('sha256').update(buf).digest('hex')}`,
    size: buf.byteLength
  }
}

interface SentResultEnvelope {
  protocol: string
  requestId: string
  server: string
  ok: boolean
  result?: Record<string, unknown>
  error?: { code: string; message: string }
}

function parseSentResultEnvelope(raw: string): SentResultEnvelope {
  const lines = raw.split('\n')
  return JSON.parse(lines[1] ?? '{}') as SentResultEnvelope
}

function buildCallHtml(opts: {
  requestId: string
  method: string
  params: Record<string, unknown>
  prefixHtml?: string
  suffixHtml?: string
  reasoningText?: string
  quoted?: boolean
}): string {
  const callJson = JSON.stringify({
    protocol: ACTIVATION_CONTRACT_PROTOCOL,
    requestId: opts.requestId,
    method: opts.method,
    params: opts.params
  })
  const block = `<pre><code class="language-code-awareness-call">${callJson}</code></pre>`
  const callSegment = opts.quoted ? `<blockquote>${block}</blockquote>` : block
  const reasoningSegment = opts.reasoningText
    ? `<div class="ds-think-content" data-thinking="true">${opts.reasoningText}</div>`
    : ''
  return `${reasoningSegment}<div class="ds-markdown">${opts.prefixHtml ?? ''}${callSegment}${opts.suffixHtml ?? ''}</div>`
}

function createDeepSeekDom(url = 'https://chat.deepseek.com/a/chat/s/conv-1') {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <main id="chat">
        <div id="messages"></div>
        <footer>
          <textarea id="chat-input" placeholder="Message DeepSeek"></textarea>
          <button data-testid="send-button" aria-label="Send" disabled>Send</button>
        </footer>
      </main>
    </body></html>`,
    { url }
  )
  const doc = dom.window.document
  const messagesEl = doc.querySelector('#messages') as HTMLElement
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

  const createAssistantElement = (opts: {
    messageId?: string | null
    domId?: string
    className?: string
    testId?: string
    requestId: string
    method: string
    params: Record<string, unknown>
    streaming?: boolean
    dataComplete?: string
    reasoningText?: string
    quoted?: boolean
    prefixHtml?: string
    suffixHtml?: string
  }) => {
    const turnEl = doc.createElement('div')
    turnEl.className = opts.className ?? 'ds-message'
    if (opts.messageId) {
      turnEl.setAttribute('data-message-id', opts.messageId)
    }
    if (opts.domId) {
      turnEl.setAttribute('id', opts.domId)
    }
    if (opts.testId) {
      turnEl.setAttribute('data-testid', opts.testId)
    }
    turnEl.setAttribute('data-role', 'assistant')
    if (opts.streaming) {
      turnEl.setAttribute('data-streaming', 'true')
    }
    if (opts.dataComplete !== undefined) {
      turnEl.setAttribute('data-complete', opts.dataComplete)
    }
    turnEl.innerHTML = buildCallHtml(opts)
    return turnEl
  }

  const appendAssistantTurn = (
    opts: Parameters<typeof createAssistantElement>[0]
  ): HTMLElement => {
    const turnEl = createAssistantElement(opts)
    messagesEl.appendChild(turnEl)
    return turnEl
  }

  const appendUserTurn = (text: string, messageId?: string | null): HTMLElement => {
    const turnEl = doc.createElement('div')
    turnEl.className = 'ds-message'
    if (messageId) turnEl.setAttribute('data-message-id', messageId)
    turnEl.setAttribute('data-role', 'user')
    turnEl.textContent = text
    messagesEl.appendChild(turnEl)
    return turnEl
  }

  return {
    dom,
    doc,
    messagesEl,
    textarea,
    sendBtn,
    sent,
    createAssistantElement,
    appendAssistantTurn,
    appendUserTurn
  }
}

function createContinuumFixtureTransport(opts?: {
  onToolCall?: (toolName: string, params: Record<string, unknown>) => Promise<unknown> | unknown
}) {
  const skillUri = 'skill://global/s-cont/continuum/SKILL.md'
  const skillMd = '---\nname: continuum\ndescription: Recover durable project artifacts\n---\n\n# Continuum\nUse list_artifacts and get_artifact.\n'
  const skillMeta = sha256(skillMd)

  const artifactFixture = {
    artifactId: 'artifact-f24c4c39',
    revision: 1,
    metadata: {
      name: 'Architecture Decisions',
      kind: 'ARCHITECTURAL_DECISION'
    },
    rawMarkdown: '# Architecture Decisions\nPreserve strict isolation between renderer and main.'
  }

  const callCounts = {
    skillsList: 0,
    skillsGet: 0,
    resourcesRead: 0,
    toolsList: 0,
    listArtifacts: 0,
    getArtifact: 0,
    otherToolCalls: [] as string[]
  }

  const transport: WebActivationTransport = {
    getStatus: vi.fn(async () => ({
      available: true,
      mode: 'PROJECT' as const,
      projectId: 'proj-cont-1',
      instanceId: 'inst-cont-1',
      bindingId: 'bind-cont-1'
    })),
    mcpRequest: vi.fn(async ({ method, params }) => {
      if (method === 'skills/list') {
        callCounts.skillsList += 1
        return {
          ok: true,
          mcp: {
            result: {
              skills: [
                {
                  uri: skillUri,
                  frontmatter: { name: 'continuum', description: 'Recover durable project artifacts' },
                  resources: [{ uri: skillUri, ...skillMeta, mimeType: 'text/markdown' }]
                }
              ],
              catalogRevision: 'sha256:rev-cont-1'
            }
          }
        }
      }
      if (method === 'skills/get') {
        callCounts.skillsGet += 1
        return {
          ok: true,
          mcp: {
            result: {
              skill: {
                uri: skillUri,
                frontmatter: { name: 'continuum', description: 'Recover durable project artifacts' },
                resources: [{ uri: skillUri, ...skillMeta, mimeType: 'text/markdown' }]
              },
              catalogRevision: 'sha256:rev-cont-1'
            }
          }
        }
      }
      if (method === 'resources/read') {
        callCounts.resourcesRead += 1
        return {
          ok: true,
          mcp: {
            result: {
              contents: [{ uri: skillUri, mimeType: 'text/markdown', text: skillMd }]
            }
          }
        }
      }
      if (method === 'tools/list') {
        callCounts.toolsList += 1
        return {
          ok: true,
          mcp: {
            result: {
              tools: [
                {
                  name: 'list_artifacts',
                  description: 'List Continuum artifacts',
                  inputSchema: { type: 'object', properties: { kind: { type: 'string' } } }
                },
                {
                  name: 'get_artifact',
                  description: 'Get Continuum artifact',
                  inputSchema: { type: 'object', properties: { artifactId: { type: 'string' } }, required: ['artifactId'] }
                }
              ]
            }
          }
        }
      }
      if (method === 'tools/call') {
        const toolName = String(params?.name ?? '')
        if (opts?.onToolCall) {
          const customResult = await opts.onToolCall(toolName, params ?? {})
          if (customResult !== undefined) {
            if (toolName === 'list_artifacts') callCounts.listArtifacts += 1
            else if (toolName === 'get_artifact') callCounts.getArtifact += 1
            else callCounts.otherToolCalls.push(toolName)
            return { ok: true, mcp: { result: customResult } }
          }
        }
        if (toolName === 'list_artifacts') {
          callCounts.listArtifacts += 1
          return {
            ok: true,
            mcp: {
              result: {
                artifacts: [{ artifactId: artifactFixture.artifactId, name: artifactFixture.metadata.name }]
              }
            }
          }
        }
        if (toolName === 'get_artifact') {
          callCounts.getArtifact += 1
          return {
            ok: true,
            mcp: {
              result: artifactFixture
            }
          }
        }
        callCounts.otherToolCalls.push(toolName)
        return { ok: true, mcp: { result: { ok: true } } }
      }
      return { ok: true, mcp: { result: {} } }
    })
  }

  return { transport, skillUri, artifactFixture, callCounts }
}

describe('ContentSessionController turn identity, consumption, and requestId correlation', () => {
  const disposables: ContentSessionController[] = []

  afterEach(() => {
    for (const c of disposables.splice(0)) {
      c.dispose()
    }
  })

  it('advances from skills.load and list_artifacts (req-1) to get_artifact (get-artifact-f24c4c39-v2) after old message mutation and remount without DUPLICATE_REQUEST_ID', async () => {
    const ds = createDeepSeekDom('https://chat.deepseek.com/a/chat/s/conv-1')
    const fixture = createContinuumFixtureTransport()
    const controller = new ContentSessionController(new DeepSeekWebAdapter(), ds.doc, fixture.transport, true)
    disposables.push(controller)

    const activated = await controller.activate(true)
    expect(activated.ok).toBe(true)
    expect(ds.sent).toHaveLength(1)

    ds.appendAssistantTurn({
      messageId: 'ds-load',
      requestId: 'req-load-1',
      method: 'skills.load',
      params: { uri: fixture.skillUri }
    })
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(2)

    const listTurn = ds.appendAssistantTurn({
      messageId: 'ds-list',
      requestId: 'req-1',
      method: 'tools.call',
      params: { name: 'list_artifacts', arguments: { limit: 5 } }
    })
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(3)

    // Mutate old assistant turn in-place AND remount a brand new Element keeping logical data-message-id="ds-list"
    const extraParagraph = ds.doc.createElement('p')
    extraParagraph.textContent = 'Extra rendered note'
    listTurn.querySelector('.ds-markdown')!.appendChild(extraParagraph)
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(3)

    const remountedListTurn = ds.createAssistantElement({
      messageId: 'ds-list',
      requestId: 'req-1',
      method: 'tools.call',
      params: { name: 'list_artifacts', arguments: { limit: 5 } },
      suffixHtml: '<p>Recreated wrapper text</p>'
    })
    listTurn.replaceWith(remountedListTurn)

    ds.appendAssistantTurn({
      messageId: 'ds-get',
      requestId: 'get-artifact-f24c4c39-v2',
      method: 'tools.call',
      params: { name: 'get_artifact', arguments: { artifactId: fixture.artifactFixture.artifactId } }
    })
    await controller.handleDomMutation()

    expect(fixture.callCounts.skillsGet).toBe(1)
    expect(fixture.callCounts.resourcesRead).toBe(1)
    expect(fixture.callCounts.toolsList).toBe(1)
    expect(fixture.callCounts.listArtifacts).toBe(1)
    expect(fixture.callCounts.getArtifact).toBe(1)
    expect(ds.sent).toHaveLength(4)

    const envelopes = ds.sent.slice(1).map(parseSentResultEnvelope)
    expect(envelopes.map((e) => e.requestId)).toEqual(['req-load-1', 'req-1', 'get-artifact-f24c4c39-v2'])
    expect(envelopes.every((e) => e.ok)).toBe(true)
    expect(envelopes.some((e) => e.error?.code === 'DUPLICATE_REQUEST_ID')).toBe(false)
    expect(ds.sent[3]).toContain(fixture.artifactFixture.metadata.name)
    expect(ds.sent[3]).toContain('Preserve strict isolation between renderer and main.')
  })

  it('ignores repeated re-renders, unanchored slot remounts, prepended history shifts, historical edits, and preserves true DOM selector order', async () => {
    const ds = createDeepSeekDom('https://chat.deepseek.com/a/chat/s/conv-reorder')
    const fixture = createContinuumFixtureTransport()
    const controller = new ContentSessionController(new DeepSeekWebAdapter(), ds.doc, fixture.transport, true)
    disposables.push(controller)

    await controller.activate(false)

    // 1. Weakly identified assistant turn (no data-message-id) executes once, then undergoes repeated re-renders and in-place slot remount
    const weakTurn = ds.appendAssistantTurn({
      messageId: null,
      requestId: 'req-weak-1',
      method: 'skills.load',
      params: { uri: fixture.skillUri }
    })
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(1)
    expect(controller.session.getTurnCycleCount()).toBe(1)

    weakTurn.querySelector('.ds-markdown')!.appendChild(ds.doc.createElement('span')).textContent = 'rerender-1'
    await controller.handleDomMutation()
    const weakRemount = ds.createAssistantElement({
      messageId: null,
      requestId: 'req-weak-1',
      method: 'skills.load',
      params: { uri: fixture.skillUri },
      suffixHtml: '<p>remounted-same-slot</p>'
    })
    weakTurn.replaceWith(weakRemount)
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(1)
    expect(controller.session.getTurnCycleCount()).toBe(1)
    expect(controller.getStatusSnapshot().lastDiagnostic).toBeNull()

    // 2. Strongly identified turns matched by heterogeneous selectors in mixed priority order vs DOM order
    // Selector priority is [data-message-id] -> [data-testid="chat-message"] -> .ds-message
    // Put .ds-message (no data-message-id) BEFORE [data-testid="chat-message"] BEFORE [data-message-id]
    const firstDomTurn = ds.appendAssistantTurn({
      messageId: 'm-strong-1',
      requestId: 'req-order-1',
      method: 'tools.call',
      params: { name: 'list_artifacts', arguments: {} }
    })
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(2)

    // Prepend historical message using .ds-message (lower selector priority than [data-message-id])
    const prependedHist = ds.createAssistantElement({
      messageId: null,
      className: 'ds-message',
      requestId: 'req-hist-prepended',
      method: 'tools.call',
      params: { name: 'list_artifacts', arguments: {} }
    })
    ds.messagesEl.insertBefore(prependedHist, ds.messagesEl.firstChild)
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(2)
    expect(fixture.callCounts.listArtifacts).toBe(1)

    // Append new valid turn matched via [data-testid="chat-message"] (different selector than .ds-message)
    ds.appendAssistantTurn({
      messageId: null,
      domId: 'dom-id-2',
      className: 'custom-turn',
      testId: 'chat-message',
      requestId: 'req-order-2',
      method: 'tools.call',
      params: { name: 'get_artifact', arguments: { artifactId: fixture.artifactFixture.artifactId } }
    })
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(3)
    expect(parseSentResultEnvelope(ds.sent[2]).requestId).toBe('req-order-2')

    // Edit/regenerate an earlier historical message in the middle even with a brand new data-message-id -> ignored
    firstDomTurn.setAttribute('data-message-id', 'm-strong-1-regenerated')
    firstDomTurn.innerHTML = buildCallHtml({
      requestId: 'req-regen-hist',
      method: 'tools.call',
      params: { name: 'list_artifacts', arguments: {} }
    })
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(3)
    expect(fixture.callCounts.listArtifacts).toBe(1)
    expect(fixture.callCounts.getArtifact).toBe(1)
  })

  it('ignores historical turns on activation and conversation switches, while supporting ephemeral landing-page URL promotion', async () => {
    // Part A: Activation baseline + SPA switch to populated conversation + empty-then-hydrated switch + startNewChat
    const ds = createDeepSeekDom('https://chat.deepseek.com/a/chat/s/conv-a')
    ds.appendUserTurn('Old question', 'u-old')
    const initialHist = ds.appendAssistantTurn({
      messageId: 'a-old',
      requestId: 'req-old-activate',
      method: 'tools.call',
      params: { name: 'list_artifacts', arguments: {} }
    })

    const fixture = createContinuumFixtureTransport()
    const controller = new ContentSessionController(new DeepSeekWebAdapter(), ds.doc, fixture.transport, true)
    disposables.push(controller)

    await controller.activate(false)
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(0)

    // Mutating pre-activation historical message does not replay it
    initialHist.querySelector('.ds-markdown')!.appendChild(ds.doc.createElement('p')).textContent = 'late-render'
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(0)

    // New turn after activation runs normally
    ds.appendUserTurn('New question', 'u-new')
    ds.appendAssistantTurn({
      messageId: 'a-new-1',
      requestId: 'req-after-act',
      method: 'skills.load',
      params: { uri: fixture.skillUri }
    })
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(1)
    expect(parseSentResultEnvelope(ds.sent[0]).requestId).toBe('req-after-act')

    // SPA switch to conv-b already populated with historical envelopes -> never executed
    ds.dom.reconfigure({ url: 'https://chat.deepseek.com/a/chat/s/conv-b' })
    ds.messagesEl.innerHTML = ''
    ds.appendUserTurn('Conv B question', 'b-u1')
    ds.appendAssistantTurn({
      messageId: 'b-a1',
      requestId: 'req-conv-b-old',
      method: 'tools.call',
      params: { name: 'list_artifacts', arguments: {} }
    })
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(1)
    expect(controller.getStatusSnapshot().lastDiagnostic?.code).toBe('CONVERSATION_SWITCHED')

    // New turn in conv-b executes cleanly
    ds.appendUserTurn('Conv B follow-up', 'b-u2')
    ds.appendAssistantTurn({
      messageId: 'b-a2',
      requestId: 'req-conv-b-new',
      method: 'skills.load',
      params: { uri: fixture.skillUri }
    })
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(2)
    expect(parseSentResultEnvelope(ds.sent[1]).requestId).toBe('req-conv-b-new')

    // Switch to conv-c initially empty, then multi-turn history hydrates asynchronously -> still ignored!
    ds.dom.reconfigure({ url: 'https://chat.deepseek.com/a/chat/s/conv-c' })
    ds.messagesEl.innerHTML = ''
    await controller.handleDomMutation()
    ds.appendUserTurn('Conv C old u1', 'c-u1')
    ds.appendAssistantTurn({
      messageId: 'c-a1',
      requestId: 'req-conv-c-old1',
      method: 'tools.call',
      params: { name: 'list_artifacts', arguments: {} }
    })
    ds.appendUserTurn('Conv C old u2', 'c-u2')
    ds.appendAssistantTurn({
      messageId: 'c-a2',
      requestId: 'req-conv-c-old2',
      method: 'tools.call',
      params: { name: 'list_artifacts', arguments: {} }
    })
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(2)
    expect(fixture.callCounts.listArtifacts).toBe(0)

    // startNewChat resets baseline cleanly and processes a brand-new single exchange
    ds.messagesEl.innerHTML = ''
    controller.startNewChat()
    ds.appendUserTurn('Fresh question', 'fresh-u1')
    ds.appendAssistantTurn({
      messageId: 'fresh-a1',
      requestId: 'req-fresh-1',
      method: 'skills.load',
      params: { uri: fixture.skillUri }
    })
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(3)
    expect(parseSentResultEnvelope(ds.sent[2]).requestId).toBe('req-fresh-1')

    // Part B: Ephemeral landing-page URL promotion (/ -> /a/chat/s/promoted-1) keeps first assistant turn eligible
    const landingDom = createDeepSeekDom('https://chat.deepseek.com/')
    const landingFixture = createContinuumFixtureTransport()
    const landingCtrl = new ContentSessionController(new DeepSeekWebAdapter(), landingDom.doc, landingFixture.transport, true)
    disposables.push(landingCtrl)

    await landingCtrl.activate(true)
    expect(landingDom.sent).toHaveLength(1)
    landingDom.dom.reconfigure({ url: 'https://chat.deepseek.com/a/chat/s/promoted-1' })
    landingDom.appendUserTurn(landingDom.sent[0]!)
    landingDom.appendAssistantTurn({
      messageId: 'land-a1',
      requestId: 'req-land-1',
      method: 'skills.load',
      params: { uri: landingFixture.skillUri }
    })
    await landingCtrl.handleDomMutation()
    expect(landingDom.sent).toHaveLength(2)
    expect(parseSentResultEnvelope(landingDom.sent[1]).requestId).toBe('req-land-1')
  })

  it('fails closed when turn identity is missing after DOM replacement/shift or when duplicate DOM IDs exist', async () => {
    // 1. Weak/fallback turns replaced completely + shifted -> TURN_IDENTITY_AMBIGUOUS
    const dsWeak = createDeepSeekDom('https://chat.deepseek.com/a/chat/s/conv-fail-weak')
    const fixtureWeak = createContinuumFixtureTransport()
    const ctrlWeak = new ContentSessionController(new DeepSeekWebAdapter(), dsWeak.doc, fixtureWeak.transport, true)
    disposables.push(ctrlWeak)

    await ctrlWeak.activate(false)
    dsWeak.appendUserTurn('Prompt 1')
    dsWeak.appendAssistantTurn({
      messageId: null,
      requestId: 'req-w1',
      method: 'skills.load',
      params: { uri: fixtureWeak.skillUri }
    })
    await ctrlWeak.handleDomMutation()
    expect(dsWeak.sent).toHaveLength(1)

    // Full remount replacing all elements with no data-message-id plus prepended turns
    dsWeak.messagesEl.innerHTML = ''
    dsWeak.appendUserTurn('Injected prompt 0')
    dsWeak.appendAssistantTurn({
      messageId: null,
      requestId: 'req-w-spoof-0',
      method: 'tools.call',
      params: { name: 'list_artifacts', arguments: {} }
    })
    dsWeak.appendUserTurn('Remounted prompt 1')
    dsWeak.appendAssistantTurn({
      messageId: null,
      requestId: 'req-w-spoof-1',
      method: 'tools.call',
      params: { name: 'get_artifact', arguments: { artifactId: fixtureWeak.artifactFixture.artifactId } }
    })
    await ctrlWeak.handleDomMutation()

    expect(dsWeak.sent).toHaveLength(1)
    expect(fixtureWeak.callCounts.listArtifacts).toBe(0)
    expect(fixtureWeak.callCounts.getArtifact).toBe(0)
    expect(ctrlWeak.getStatusSnapshot().lastDiagnostic?.code).toBe('TURN_IDENTITY_AMBIGUOUS')

    // 2. Duplicate data-message-id across two turns in the same snapshot -> TURN_IDENTITY_AMBIGUOUS
    const dsDup = createDeepSeekDom('https://chat.deepseek.com/a/chat/s/conv-fail-dup')
    const fixtureDup = createContinuumFixtureTransport()
    const ctrlDup = new ContentSessionController(new DeepSeekWebAdapter(), dsDup.doc, fixtureDup.transport, true)
    disposables.push(ctrlDup)

    await ctrlDup.activate(false)
    dsDup.appendAssistantTurn({
      messageId: 'dup-id',
      requestId: 'req-dup-1',
      method: 'skills.load',
      params: { uri: fixtureDup.skillUri }
    })
    dsDup.appendAssistantTurn({
      messageId: 'dup-id',
      requestId: 'req-dup-2',
      method: 'tools.call',
      params: { name: 'list_artifacts', arguments: {} }
    })
    await ctrlDup.handleDomMutation()

    expect(dsDup.sent).toHaveLength(0)
    expect(fixtureDup.callCounts.skillsGet).toBe(0)
    expect(fixtureDup.callCounts.listArtifacts).toBe(0)
    expect(ctrlDup.getStatusSnapshot().lastDiagnostic?.code).toBe('TURN_IDENTITY_AMBIGUOUS')
  })

  it('rejects duplicate requestId in genuinely new turn, ignores streaming/reasoning/user/quoted/result/write-tool calls', async () => {
    const ds = createDeepSeekDom('https://chat.deepseek.com/a/chat/s/conv-neg')
    const fixture = createContinuumFixtureTransport()
    const controller = new ContentSessionController(new DeepSeekWebAdapter(), ds.doc, fixture.transport, true)
    disposables.push(controller)

    await controller.activate(false)

    // 1. Streaming / partial turn & reasoning-only turn -> never executed
    const streamingTurn = ds.appendAssistantTurn({
      messageId: 'neg-stream',
      requestId: 'req-stream',
      method: 'skills.load',
      params: { uri: fixture.skillUri },
      streaming: true
    })
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(0)
    streamingTurn.remove()

    const reasoningOnly = ds.doc.createElement('div')
    reasoningOnly.className = 'ds-message'
    reasoningOnly.setAttribute('data-message-id', 'neg-reason')
    reasoningOnly.setAttribute('data-role', 'assistant')
    reasoningOnly.innerHTML = `<div class="ds-think-content" data-thinking="true"><pre><code class="language-code-awareness-call">${JSON.stringify({
      protocol: ACTIVATION_CONTRACT_PROTOCOL,
      requestId: 'req-reason',
      method: 'skills.load',
      params: { uri: fixture.skillUri }
    })}</code></pre></div>`
    ds.messagesEl.appendChild(reasoningOnly)
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(0)
    expect(fixture.callCounts.skillsGet).toBe(0)

    // 2. User turn, system turn, quoted block, and code-awareness-result block -> never executed
    ds.appendUserTurn(
      `\`\`\`code-awareness-call\n${JSON.stringify({
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId: 'req-user',
        method: 'skills.load',
        params: { uri: fixture.skillUri }
      })}\n\`\`\``,
      'neg-user'
    )
    const sysTurn = ds.doc.createElement('div')
    sysTurn.className = 'ds-message'
    sysTurn.setAttribute('data-message-id', 'neg-sys')
    sysTurn.setAttribute('data-role', 'system')
    sysTurn.innerHTML = buildCallHtml({
      requestId: 'req-sys',
      method: 'skills.load',
      params: { uri: fixture.skillUri }
    })
    ds.messagesEl.appendChild(sysTurn)

    ds.appendAssistantTurn({
      messageId: 'neg-quoted',
      requestId: 'req-quoted',
      method: 'skills.load',
      params: { uri: fixture.skillUri },
      quoted: true
    })
    const resultBlockTurn = ds.doc.createElement('div')
    resultBlockTurn.className = 'ds-message'
    resultBlockTurn.setAttribute('data-message-id', 'neg-res-block')
    resultBlockTurn.setAttribute('data-role', 'assistant')
    resultBlockTurn.innerHTML = `<div class="ds-markdown"><pre><code class="language-code-awareness-result">${JSON.stringify({
      protocol: ACTIVATION_CONTRACT_PROTOCOL,
      requestId: 'req-res-block',
      ok: true
    })}</code></pre></div>`
    ds.messagesEl.appendChild(resultBlockTurn)
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(0)

    // 3. First valid call with req-1, followed by genuinely NEW turn reusing req-1 -> DUPLICATE_REQUEST_ID
    ds.appendAssistantTurn({
      messageId: 'neg-valid-1',
      requestId: 'req-1',
      method: 'tools.call',
      params: { name: 'list_artifacts', arguments: {} }
    })
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(1)
    expect(parseSentResultEnvelope(ds.sent[0]).ok).toBe(true)

    ds.appendAssistantTurn({
      messageId: 'neg-replay-new-turn',
      requestId: 'req-1',
      method: 'tools.call',
      params: { name: 'list_artifacts', arguments: {} }
    })
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(2)
    expect(parseSentResultEnvelope(ds.sent[1]).error?.code).toBe('DUPLICATE_REQUEST_ID')
    expect(fixture.callCounts.listArtifacts).toBe(1)

    // 4. Write tool rejected with TOOL_NOT_ALLOWED, never reaches transport
    ds.appendAssistantTurn({
      messageId: 'neg-write',
      requestId: 'req-write-1',
      method: 'tools.call',
      params: { name: 'publish_artifact', arguments: { file: 'x.md' } }
    })
    await controller.handleDomMutation()
    expect(ds.sent).toHaveLength(3)
    expect(parseSentResultEnvelope(ds.sent[2]).error?.code).toBe('TOOL_NOT_ALLOWED')
    expect(fixture.callCounts.otherToolCalls).toEqual([])
  })

  it('drains concurrent mutations during async processing without losing turns and handles send failures without overwriting user drafts or retrying blindly', async () => {
    // Part A: Async mutation during deferred mcpRequest drains cleanly
    let releaseListCall!: () => void
    const listGate = new Promise<void>((resolve) => {
      releaseListCall = resolve
    })
    const dsAsync = createDeepSeekDom('https://chat.deepseek.com/a/chat/s/conv-async')
    const fixtureAsync = createContinuumFixtureTransport({
      onToolCall: async (toolName) => {
        if (toolName === 'list_artifacts') {
          await listGate
          return { artifacts: [{ artifactId: 'artifact-f24c4c39' }] }
        }
        return undefined
      }
    })
    const ctrlAsync = new ContentSessionController(new DeepSeekWebAdapter(), dsAsync.doc, fixtureAsync.transport, true)
    disposables.push(ctrlAsync)

    await ctrlAsync.activate(false)
    const t1 = dsAsync.appendAssistantTurn({
      messageId: 'async-1',
      requestId: 'req-async-1',
      method: 'tools.call',
      params: { name: 'list_artifacts', arguments: {} }
    })
    const firstPassPromise = ctrlAsync.handleDomMutation()
    await Promise.resolve()

    // While req-async-1 is in-flight, mutate t1 AND append t2, then fire handleDomMutation()
    t1.querySelector('.ds-markdown')!.appendChild(dsAsync.doc.createElement('p')).textContent = 'in-flight-update'
    dsAsync.appendAssistantTurn({
      messageId: 'async-2',
      requestId: 'req-async-2',
      method: 'tools.call',
      params: { name: 'get_artifact', arguments: { artifactId: fixtureAsync.artifactFixture.artifactId } }
    })
    await ctrlAsync.handleDomMutation()
    releaseListCall()
    await firstPassPromise

    expect(fixtureAsync.callCounts.listArtifacts).toBe(1)
    expect(fixtureAsync.callCounts.getArtifact).toBe(1)
    expect(dsAsync.sent).toHaveLength(2)
    expect(dsAsync.sent.map((raw) => parseSentResultEnvelope(raw).requestId)).toEqual(['req-async-1', 'req-async-2'])

    // Part B: Send failure with user draft present preserves draft and does not blind-retry
    const dsFail = createDeepSeekDom('https://chat.deepseek.com/a/chat/s/conv-send-fail')
    const fixtureFail = createContinuumFixtureTransport()
    const ctrlFail = new ContentSessionController(new DeepSeekWebAdapter(), dsFail.doc, fixtureFail.transport, true)
    disposables.push(ctrlFail)

    await ctrlFail.activate(false)
    dsFail.textarea.value = 'My unsent user draft'
    dsFail.appendAssistantTurn({
      messageId: 'fail-draft-1',
      requestId: 'req-fail-draft',
      method: 'tools.call',
      params: { name: 'list_artifacts', arguments: {} }
    })
    await ctrlFail.handleDomMutation()

    expect(dsFail.textarea.value).toBe('My unsent user draft')
    expect(dsFail.sent).toHaveLength(0)
    expect(ctrlFail.getStatusSnapshot().lastDelivery).toMatchObject({
      ok: false,
      reason: 'USER_DRAFT_PRESENT',
      requestIds: ['req-fail-draft']
    })
    expect(ctrlFail.getStatusSnapshot().lastError).toBe('USER_DRAFT_PRESENT')

    // Clearing the draft and mutating DOM later must NOT blindly retry or re-execute the already-consumed turn
    dsFail.textarea.value = ''
    await ctrlFail.handleDomMutation()
    expect(dsFail.sent).toHaveLength(0)
    expect(fixtureFail.callCounts.listArtifacts).toBe(1)

    // Disabled send button also fails cleanly without leaving reply text behind or blind-retrying
    const sendBtnDisabledFail = dsFail.doc.querySelector('[data-testid="send-button"]') as HTMLButtonElement
    // Prevent input listener from re-enabling button for this turn
    const replacementBtn = sendBtnDisabledFail.cloneNode(true) as HTMLButtonElement
    replacementBtn.disabled = true
    sendBtnDisabledFail.replaceWith(replacementBtn)

    dsFail.appendAssistantTurn({
      messageId: 'fail-btn-2',
      requestId: 'req-fail-btn',
      method: 'tools.call',
      params: { name: 'get_artifact', arguments: { artifactId: fixtureFail.artifactFixture.artifactId } }
    })
    await ctrlFail.handleDomMutation()

    expect(dsFail.sent).toHaveLength(0)
    expect(dsFail.textarea.value).toBe('')
    expect(ctrlFail.getStatusSnapshot().lastDelivery).toMatchObject({
      ok: false,
      reason: 'SEND_BUTTON_UNAVAILABLE',
      requestIds: ['req-fail-btn']
    })
    expect(ctrlFail.getStatusSnapshot().lastError).toBe('SEND_BUTTON_UNAVAILABLE')

    replacementBtn.disabled = false
    await ctrlFail.handleDomMutation()
    expect(dsFail.sent).toHaveLength(0)
    expect(fixtureFail.callCounts.getArtifact).toBe(1)
  })
})
