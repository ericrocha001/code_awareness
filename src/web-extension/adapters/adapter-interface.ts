export type WebAdapterSite = 'deepseek' | 'qwen'

export type ChatTurnIdentitySource = 'dom-attribute' | 'dom-id' | 'fallback-position' | 'ambiguous'

export interface ChatDomTurn {
  messageId: string
  role: 'assistant' | 'user' | 'system'
  text: string
  isComplete: boolean
  identitySource?: ChatTurnIdentitySource
  element?: Element
}

export interface SendMessageResult {
  ok: boolean
  status?: 'DISPATCHED' | 'PRE_DISPATCH_BLOCKED' | 'DISPATCH_ABORTED'
  reason?: string
}

export interface WebChatAdapter {
  readonly site: WebAdapterSite
  readonly allowedOrigin: string
  matchesLocation(locationHref: string): boolean
  isAuthenticatedChatReady(root: ParentNode): boolean
  isGenerating(root: ParentNode): boolean
  canDispatchNow?(root: ParentNode): boolean
  readTurns(root: ParentNode): ChatDomTurn[]
  sendMessage(root: ParentNode, text: string, shouldContinue?: () => boolean): Promise<SendMessageResult>
  observeConversation(root: ParentNode, onChange: () => void): () => void
}

const CODE_LANG_CLASS_RE = /\blanguage-([a-z0-9_+-]+)\b/i

function isElementNode(node: Node): node is Element {
  return node.nodeType === 1
}

function getCodeBlockLanguage(preEl: Element): string {
  const codeEl = preEl.querySelector('code')
  const className = `${codeEl?.className ?? ''} ${preEl.className ?? ''}`
  const classMatch = CODE_LANG_CLASS_RE.exec(className)
  if (classMatch) return classMatch[1].toLowerCase()

  const dataLang =
    codeEl?.getAttribute('data-language') ??
    preEl.getAttribute('data-language') ??
    preEl.getAttribute('data-lang')
  if (dataLang?.trim()) return dataLang.trim().toLowerCase()

  // DeepSeek / Qwen code block wrappers often put the language label in a sibling header/banner above <pre>
  const wrapper = preEl.closest('.md-code-block, [class*="code-block" i], [class*="codeBlock" i]')
  if (wrapper) {
    const headerLang = wrapper.querySelector(
      '[class*="banner" i] span, [class*="header" i] span, [data-testid*="code-lang" i], .code-block-header > span'
    )
    const label = headerLang?.textContent?.trim().toLowerCase()
    if (label && /^[a-z0-9_+-]{1,40}$/.test(label)) {
      return label
    }
  }

  return ''
}

function isCodeWrapperChromeElement(el: Element): boolean {
  const cls = typeof el.className === 'string' ? el.className : ''
  return (
    /banner|toolbar|copy|action-bar|code-header/i.test(cls) ||
    el.tagName === 'BUTTON'
  )
}

const REASONING_CLASS_RE =
  /\b(?:ds-think|ds-thinking|ds-thought|think-content|thinking-content|thought-content|reasoning-content|thinking-block|reasoning-block|chain-of-thought)\b/i
const REASONING_TESTID_RE = /think|thought|reason/i
const STRONG_IDENTITY_ATTRS = ['data-message-id', 'data-msg-id', 'data-turn-id'] as const
const STREAMING_ATTR_SELECTOR =
  '[data-streaming="true"], [aria-busy="true"], [data-complete="false"], [data-state="streaming"], [data-status="streaming"]'

function isReasoningElement(el: Element): boolean {
  if (el.getAttribute('data-reasoning') === 'true' || el.getAttribute('data-thinking') === 'true') {
    return true
  }
  const roleAttr = (el.getAttribute('data-role') ?? '').trim().toLowerCase()
  if (roleAttr === 'reasoning' || roleAttr === 'thinking' || roleAttr === 'thought') {
    return true
  }
  const testId = el.getAttribute('data-testid') ?? ''
  if (testId && REASONING_TESTID_RE.test(testId)) {
    return true
  }
  const cls = typeof el.className === 'string' ? el.className : ''
  return Boolean(cls && REASONING_CLASS_RE.test(cls))
}

function isInsideReasoning(el: Element, boundary: Element): boolean {
  let current: Element | null = el
  while (current) {
    if (isReasoningElement(current)) return true
    if (current === boundary) break
    current = current.parentElement
  }
  return false
}

function compareDomDocumentOrder(a: Element, b: Element): number {
  if (a === b) return 0
  if (typeof a.compareDocumentPosition !== 'function') return 0
  const pos = a.compareDocumentPosition(b)
  if (pos & 4) return -1
  if (pos & 2) return 1
  return 0
}

function resolveElementStrongIdentity(
  el: Element
): { messageId: string; identitySource: 'dom-attribute' | 'dom-id' } | null {
  for (const attr of STRONG_IDENTITY_ATTRS) {
    const val = el.getAttribute(attr)?.trim()
    if (val) return { messageId: val, identitySource: 'dom-attribute' }
  }
  const domId = el.getAttribute('id')?.trim()
  if (domId) {
    return { messageId: domId, identitySource: 'dom-id' }
  }
  const descendantIds = new Set<string>()
  for (const desc of Array.from(el.querySelectorAll('[data-message-id], [data-msg-id], [data-turn-id]'))) {
    if (isInsideReasoning(desc, el)) continue
    for (const attr of STRONG_IDENTITY_ATTRS) {
      const val = desc.getAttribute(attr)?.trim()
      if (val) {
        descendantIds.add(val)
        break
      }
    }
  }
  if (descendantIds.size === 1) {
    return { messageId: Array.from(descendantIds)[0], identitySource: 'dom-attribute' }
  }
  return null
}

function serializeDomNodeToMarkdown(node: Node, insideBlockquote = false): string {
  if (node.nodeType === 3) {
    const text = node.textContent ?? ''
    if (!insideBlockquote) return text
    return text.replace(/(^|\n)/g, '$1> ')
  }
  if (!isElementNode(node)) return ''

  const tag = node.tagName.toUpperCase()
  if (tag === 'STYLE' || tag === 'SCRIPT' || isCodeWrapperChromeElement(node) || isReasoningElement(node)) {
    return ''
  }

  if (tag === 'PRE') {
    const codeEl = node.querySelector('code')
    const rawCode = (codeEl ?? node).textContent ?? ''
    const trimmedCode = rawCode.replace(/^\n+|\n+$/g, '')
    const lang = getCodeBlockLanguage(node)
    const maxRun = Math.max(2, ...Array.from(trimmedCode.matchAll(/`+/g), (m: RegExpMatchArray) => m[0].length))
    const fence = '`'.repeat(maxRun + 1)
    const block = `\n${fence}${lang}\n${trimmedCode}\n${fence}\n`
    if (!insideBlockquote) return block
    return block
      .split('\n')
      .map((line) => (line.length > 0 ? `> ${line}` : '>'))
      .join('\n')
  }

  if (tag === 'BLOCKQUOTE') {
    let inner = ''
    for (const child of Array.from(node.childNodes)) {
      inner += serializeDomNodeToMarkdown(child, true)
    }
    return `\n${inner}\n`
  }

  if (tag === 'BR') {
    return insideBlockquote ? '\n> ' : '\n'
  }

  let content = ''
  for (const child of Array.from(node.childNodes)) {
    content += serializeDomNodeToMarkdown(child, insideBlockquote)
  }

  if (/^(P|DIV|LI|TR|H[1-6]|SECTION|ARTICLE)$/.test(tag) && content && !content.endsWith('\n')) {
    return `${content}\n`
  }
  return content
}

export function extractTurnMarkdownText(container: Element): string {
  return serializeDomNodeToMarkdown(container, false).replace(/\n{3,}/g, '\n\n').trim()
}

function collectTopLevelMatchedElements(
  root: ParentNode,
  selectors: readonly string[],
  predicate?: (el: Element) => boolean
): Element[] {
  const matchedSet = new Set<Element>()
  for (const selector of selectors) {
    let nodes: NodeListOf<Element>
    try {
      nodes = root.querySelectorAll(selector)
    } catch {
      continue
    }
    for (const el of Array.from(nodes)) {
      if (predicate && !predicate(el)) continue
      matchedSet.add(el)
    }
  }
  const topLevel: Element[] = []
  for (const el of matchedSet) {
    let parent = el.parentElement
    let hasMatchedAncestor = false
    while (parent) {
      if (matchedSet.has(parent)) {
        hasMatchedAncestor = true
        break
      }
      if (parent === (root as unknown as Element)) break
      parent = parent.parentElement
    }
    if (!hasMatchedAncestor) {
      topLevel.push(el)
    }
  }
  topLevel.sort(compareDomDocumentOrder)
  return topLevel
}

export function collectTopLevelMessageElements(root: ParentNode, selectors: readonly string[]): Element[] {
  return collectTopLevelMatchedElements(root, selectors)
}

export function isVisibleElement(el: Element | null): el is HTMLElement {
  if (!el) return false
  if (el.hasAttribute('hidden')) return false
  if (el.getAttribute('aria-hidden') === 'true') return false
  const styleAttr = el.getAttribute('style') ?? ''
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(styleAttr)) return false
  return true
}

export function readComposerText(composer: HTMLElement): string {
  if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
    return (composer as HTMLTextAreaElement | HTMLInputElement).value ?? ''
  }
  return composer.textContent ?? ''
}

export function setInputOrEditableText(
  composer: HTMLElement,
  text: string
): void {
  const win = composer.ownerDocument.defaultView
  if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
    const proto =
      composer.tagName === 'TEXTAREA'
        ? win?.HTMLTextAreaElement?.prototype
        : win?.HTMLInputElement?.prototype
    const valueSetter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : undefined
    if (valueSetter) {
      valueSetter.call(composer, text)
    } else {
      ;(composer as HTMLTextAreaElement).value = text
    }
  } else {
    composer.focus?.()
    composer.textContent = text
  }

  const InputEventCtor = win?.InputEvent ?? win?.Event
  if (InputEventCtor) {
    composer.dispatchEvent(new InputEventCtor('input', { bubbles: true, cancelable: true }))
  }
  if (win?.Event) {
    composer.dispatchEvent(new win.Event('change', { bubbles: true }))
  }
}

export function isElementDisabled(el: Element | null): boolean {
  if (!el) return true
  if ((el as HTMLButtonElement).disabled === true) return true
  const ariaDisabled = el.getAttribute('aria-disabled')
  if (ariaDisabled === 'true') return true
  const cls = typeof el.className === 'string' ? el.className : ''
  if (/\bdisabled\b/i.test(cls)) return true
  return false
}

export function createDebouncedMutationObserver(
  target: Node,
  onChange: () => void,
  debounceMs = 150
): () => void {
  const doc = target.ownerDocument ?? (target as Document)
  const win = doc.defaultView
  const Observer = win?.MutationObserver ?? globalThis.MutationObserver
  if (!Observer) {
    return () => {}
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = () => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      onChange()
    }, debounceMs)
  }

  const observer = new Observer(schedule)
  observer.observe(target, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      'id',
      'data-message-id',
      'data-msg-id',
      'data-turn-id',
      'data-role',
      'data-streaming',
      'data-complete',
      'data-state',
      'data-status',
      'aria-busy',
      'aria-disabled',
      'disabled',
      'hidden',
      'aria-hidden'
    ]
  })

  return () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    observer.disconnect()
  }
}

export interface SiteAdapterConfig {
  site: WebAdapterSite
  allowedOrigin: string
  composerSelectors: readonly string[]
  sendButtonSelectors: readonly string[]
  stopButtonSelectors: readonly string[]
  messageSelectors: readonly string[]
  contentSelectors: readonly string[]
  resolveRole: (el: Element) => 'assistant' | 'user' | 'system'
}

export class ConfiguredWebChatAdapter implements WebChatAdapter {
  readonly site: WebAdapterSite
  readonly allowedOrigin: string

  constructor(private readonly config: SiteAdapterConfig) {
    this.site = config.site
    this.allowedOrigin = config.allowedOrigin
  }

  matchesLocation(locationHref: string): boolean {
    try {
      return new URL(locationHref).origin.toLowerCase() === this.allowedOrigin
    } catch {
      return false
    }
  }

  private findComposer(root: ParentNode): HTMLElement | null {
    for (const selector of this.config.composerSelectors) {
      for (const node of Array.from(root.querySelectorAll(selector))) {
        if (isVisibleElement(node)) return node
      }
    }
    return null
  }

  private findStopButton(root: ParentNode): HTMLElement | null {
    for (const selector of this.config.stopButtonSelectors) {
      const node = root.querySelector(selector)
      if (isVisibleElement(node) && !isElementDisabled(node)) return node
    }
    return null
  }

  isAuthenticatedChatReady(root: ParentNode): boolean {
    if (!this.findComposer(root)) return false
    const passwordInput = root.querySelector('input[type="password"]')
    return !isVisibleElement(passwordInput)
  }

  private findSendButton(root: ParentNode): HTMLElement | null {
    for (const selector of this.config.sendButtonSelectors) {
      for (const el of Array.from(root.querySelectorAll(selector))) {
        if (!isVisibleElement(el) || isElementDisabled(el)) continue
        const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').toLowerCase()
        if (label.includes('stop') || label.includes('interromper')) continue
        return el
      }
    }
    return null
  }

  canDispatchNow(root: ParentNode): boolean {
    if (this.isGenerating(root)) return false
    const composer = this.findComposer(root)
    if (!composer || readComposerText(composer).trim().length > 0) return false
    return true
  }

  isGenerating(root: ParentNode): boolean {
    if (this.findStopButton(root)) return true
    return Boolean(root.querySelector('[data-streaming="true"], [aria-busy="true"]'))
  }

  readTurns(root: ParentNode): ChatDomTurn[] {
    const topLevel = collectTopLevelMessageElements(root, this.config.messageSelectors)
    const pageGenerating = this.isGenerating(root)
    const extractedIds = topLevel.map((el) => resolveElementStrongIdentity(el))
    const identityCounts = new Map<string, number>()
    for (const item of extractedIds) {
      if (!item) continue
      const key = `${item.identitySource}:${item.messageId}`
      identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1)
    }

    const turns: ChatDomTurn[] = []

    topLevel.forEach((el, index) => {
      const role = this.config.resolveRole(el)
      const contentContainers =
        this.config.contentSelectors.length > 0
          ? collectTopLevelMatchedElements(el, this.config.contentSelectors, (match) => !isInsideReasoning(match, el))
          : []
      const text =
        contentContainers.length > 0
          ? contentContainers
              .map((container) => extractTurnMarkdownText(container))
              .filter((part) => part.length > 0)
              .join('\n\n')
          : extractTurnMarkdownText(el)

      const extracted = extractedIds[index]
      let messageId: string
      let identitySource: ChatTurnIdentitySource
      if (extracted) {
        messageId = extracted.messageId
        const count = identityCounts.get(`${extracted.identitySource}:${extracted.messageId}`) ?? 0
        identitySource = count > 1 ? 'ambiguous' : extracted.identitySource
      } else {
        messageId = `${this.site}-turn-${index}`
        identitySource = 'fallback-position'
      }

      const hasStreamingAttr =
        el.getAttribute('data-streaming') === 'true' ||
        el.getAttribute('aria-busy') === 'true' ||
        el.getAttribute('data-complete') === 'false' ||
        el.getAttribute('data-state') === 'streaming' ||
        el.getAttribute('data-status') === 'streaming'
      const nodeStreaming = hasStreamingAttr || Boolean(el.querySelector(STREAMING_ATTR_SELECTOR))
      const hasActiveReasoning =
        el.getAttribute('data-thinking') === 'true' ||
        el.getAttribute('data-reasoning') === 'true' ||
        Boolean(el.querySelector('[data-thinking="true"], [data-reasoning="true"]'))
      const isLast = index === topLevel.length - 1
      const isComplete = !nodeStreaming && (!isLast || !pageGenerating) && !(role === 'assistant' && hasActiveReasoning && !text)

      if (text || role === 'assistant') {
        turns.push({ messageId, role, text, isComplete, identitySource, element: el })
      }
    })

    return turns
  }

  async sendMessage(
    root: ParentNode,
    text: string,
    shouldContinue?: () => boolean
  ): Promise<SendMessageResult> {
    if (this.isGenerating(root)) {
      return { ok: false, status: 'PRE_DISPATCH_BLOCKED', reason: 'STREAMING_IN_PROGRESS' }
    }
    const composer = this.findComposer(root)
    if (!composer) {
      return { ok: false, status: 'PRE_DISPATCH_BLOCKED', reason: 'COMPOSER_NOT_FOUND' }
    }
    if (readComposerText(composer).trim().length > 0) {
      return { ok: false, status: 'PRE_DISPATCH_BLOCKED', reason: 'USER_DRAFT_PRESENT' }
    }

    setInputOrEditableText(composer, text)
    await Promise.resolve()

    if (shouldContinue && !shouldContinue()) {
      if (readComposerText(composer) === text) {
        setInputOrEditableText(composer, '')
      }
      return { ok: false, status: 'DISPATCH_ABORTED', reason: 'CONTEXT_CHANGED_BEFORE_DISPATCH' }
    }

    // Revalidate composer text strictly before clicking; preserve user edits if modified during await
    if (readComposerText(composer) !== text) {
      return { ok: false, status: 'PRE_DISPATCH_BLOCKED', reason: 'COMPOSER_MODIFIED_BY_USER' }
    }

    if (this.isGenerating(root)) {
      if (readComposerText(composer) === text) {
        setInputOrEditableText(composer, '')
      }
      return { ok: false, status: 'PRE_DISPATCH_BLOCKED', reason: 'STREAMING_IN_PROGRESS' }
    }

    const sendBtn = this.findSendButton(root)

    if (!sendBtn) {
      if (readComposerText(composer) === text) {
        setInputOrEditableText(composer, '')
      }
      return { ok: false, status: 'PRE_DISPATCH_BLOCKED', reason: 'SEND_BUTTON_UNAVAILABLE' }
    }

    if (readComposerText(composer) !== text) {
      return { ok: false, status: 'PRE_DISPATCH_BLOCKED', reason: 'COMPOSER_MODIFIED_BY_USER' }
    }

    try {
      sendBtn.click()
      return { ok: true, status: 'DISPATCHED' }
    } catch {
      if (readComposerText(composer) === text) {
        setInputOrEditableText(composer, '')
      }
      return { ok: false, status: 'DISPATCH_ABORTED', reason: 'SEND_CLICK_THREW' }
    }
  }

  observeConversation(root: ParentNode, onChange: () => void): () => void {
    return createDebouncedMutationObserver(root, onChange)
  }
}
