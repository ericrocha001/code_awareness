export type WebAdapterSite = 'deepseek' | 'qwen'

export interface ChatDomTurn {
  messageId: string
  role: 'assistant' | 'user' | 'system'
  text: string
  isComplete: boolean
}

export interface SendMessageResult {
  ok: boolean
  reason?: string
}

export interface WebChatAdapter {
  readonly site: WebAdapterSite
  readonly allowedOrigin: string
  matchesLocation(locationHref: string): boolean
  isAuthenticatedChatReady(root: ParentNode): boolean
  isGenerating(root: ParentNode): boolean
  readTurns(root: ParentNode): ChatDomTurn[]
  sendMessage(root: ParentNode, text: string): Promise<SendMessageResult>
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

function serializeDomNodeToMarkdown(node: Node, insideBlockquote = false): string {
  if (node.nodeType === 3) {
    const text = node.textContent ?? ''
    if (!insideBlockquote) return text
    return text.replace(/(^|\n)/g, '$1> ')
  }
  if (!isElementNode(node)) return ''

  const tag = node.tagName.toUpperCase()
  if (tag === 'STYLE' || tag === 'SCRIPT' || isCodeWrapperChromeElement(node)) {
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

export function collectTopLevelMessageElements(root: ParentNode, selectors: readonly string[]): Element[] {
  const matched: Element[] = []
  const matchedSet = new Set<Element>()
  for (const selector of selectors) {
    for (const el of Array.from(root.querySelectorAll(selector))) {
      if (!matchedSet.has(el)) {
        matchedSet.add(el)
        matched.push(el)
      }
    }
  }
  return matched.filter((el) => {
    let parent = el.parentElement
    while (parent) {
      if (matchedSet.has(parent)) return false
      parent = parent.parentElement
    }
    return true
  })
}

export function isVisibleElement(el: Element | null): el is HTMLElement {
  if (!el) return false
  if (el.hasAttribute('hidden')) return false
  if (el.getAttribute('aria-hidden') === 'true') return false
  const styleAttr = el.getAttribute('style') ?? ''
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(styleAttr)) return false
  return true
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
    attributeFilter: ['data-message-id', 'data-role', 'data-streaming', 'aria-busy', 'aria-disabled', 'disabled']
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

  isGenerating(root: ParentNode): boolean {
    if (this.findStopButton(root)) return true
    return Boolean(root.querySelector('[data-streaming="true"], [aria-busy="true"]'))
  }

  readTurns(root: ParentNode): ChatDomTurn[] {
    const topLevel = collectTopLevelMessageElements(root, this.config.messageSelectors)
    const pageGenerating = this.isGenerating(root)
    const contentSelector = this.config.contentSelectors.join(', ')
    const turns: ChatDomTurn[] = []

    topLevel.forEach((el, index) => {
      const role = this.config.resolveRole(el)
      const contentEl = (contentSelector ? el.querySelector(contentSelector) : null) ?? el
      const text = extractTurnMarkdownText(contentEl)
      const messageId =
        el.getAttribute('data-message-id') ??
        el.getAttribute('id') ??
        `${this.site}-turn-${index}`
      const nodeStreaming =
        el.getAttribute('data-streaming') === 'true' ||
        el.getAttribute('aria-busy') === 'true' ||
        Boolean(el.querySelector('[data-streaming="true"], [aria-busy="true"]'))
      const isLast = index === topLevel.length - 1
      const isComplete = !nodeStreaming && (!isLast || !pageGenerating)

      if (text || role === 'assistant') {
        turns.push({ messageId, role, text, isComplete })
      }
    })

    return turns
  }

  async sendMessage(root: ParentNode, text: string): Promise<SendMessageResult> {
    if (this.isGenerating(root)) {
      return { ok: false, reason: 'STREAMING_IN_PROGRESS' }
    }
    const composer = this.findComposer(root)
    if (!composer) {
      return { ok: false, reason: 'COMPOSER_NOT_FOUND' }
    }

    setInputOrEditableText(composer, text)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    let sendBtn: HTMLElement | null = null
    for (const selector of this.config.sendButtonSelectors) {
      for (const el of Array.from(root.querySelectorAll(selector))) {
        if (!isVisibleElement(el) || isElementDisabled(el)) continue
        const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').toLowerCase()
        if (label.includes('stop') || label.includes('interromper')) continue
        sendBtn = el
        break
      }
      if (sendBtn) break
    }

    if (!sendBtn) {
      return { ok: false, reason: 'SEND_BUTTON_UNAVAILABLE' }
    }

    sendBtn.click()
    return { ok: true }
  }

  observeConversation(root: ParentNode, onChange: () => void): () => void {
    return createDebouncedMutationObserver(root, onChange)
  }
}
