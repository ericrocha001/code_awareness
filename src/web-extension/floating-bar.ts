import { attachChatGptFiles } from './chatgpt-attachments'
import type { PickerFile } from '../shared/web-activation/context-picker-contract'
import { messages as pt } from './locale'
import type { ChromeApi, ChromeMessageListener, ChromeRuntimeApi, ChromeStorageChangeListener } from './chrome-api'
import { insertDraftText } from './chat-context-adapter'

import type { ContextPickerSite as ChatSite } from '../shared/web-activation/context-picker-sites'
export { contextPickerSite as detectChatSite } from '../shared/web-activation/context-picker-sites'

export const positions = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const
type Position = typeof positions[number]
export const defaultPosition: Position = 'bottom-right'

export function positionKey(site?: ChatSite): string {
  return site ? `floatingBarPosition.${site}` : 'floatingBarPosition'
}

export function readPosition(value: unknown): Position | undefined {
  return positions.find((position) => position === value)
}

export class FloatingBar {
  private readonly host: HTMLElement
  private readonly controls: HTMLElement
  private readonly onStorageChanged: ChromeStorageChangeListener
  private disposed = false
  private readonly activation: HTMLElement
  private panel?: HTMLIFrameElement
  private challenge?: string
  private pickerCleanup?: () => void
  private position = defaultPosition

  constructor(
    private readonly doc: Document,
    private readonly site: ChatSite,
    private readonly storage?: ChromeApi['storage'],
    runtime?: ChromeRuntimeApi
  ) {
    const host = doc.createElement('div')
    host.id = 'code-awareness-activation-pill'
    host.dataset.caSite = site
    host.hidden = true
    this.host = host
    const root = host.attachShadow({ mode: 'open' })
    const style = doc.createElement('style')
    style.textContent = `
      :host { all: initial; position: fixed; z-index: 2147483000; }
      :host([hidden]) { display: none; }
      .bar {
        display: flex; flex-wrap: wrap; align-items: center; gap: 7px; padding: 6px 9px;
        box-sizing: border-box; max-width: calc(100vw - 32px); border-radius: 24px;
        background: radial-gradient(ellipse at 100% 0%, #39377a 0%, transparent 74%),
          linear-gradient(155deg, #19233b, #141b32 75%) padding-box,
          linear-gradient(110deg, #8bb6ee, #8a72ff) border-box;
        color: #f7f8ff; border: 1px solid transparent;
        font: 12px/1.35 system-ui, sans-serif;
        box-shadow: inset 0 1px 3px #b6caff44, 0 7px 18px #25285f70;
      }
      .activation { display: contents; }
      .identity { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 5px; min-width: 0; }
      .product { font-weight: 720; white-space: nowrap; }
      .state { display: inline-flex; align-items: baseline; gap: 5px; color: #b4bde0; overflow-wrap: anywhere; }
      .state::before { content: ''; width: 6px; height: 6px; flex: none; border-radius: 50%; background: #a2abd6; align-self: center; }
      :host([data-ca-state="READY"]) .state::before { background: #8be4be; }
      .brand { display: grid; place-items: center; inline-size: 26px; block-size: 26px;
        flex: none; border-radius: 8px; border: 1px solid #535d9766;
        background: linear-gradient(#2b345b, #20294a); color: #b7a9ff; }
      .brand svg { width: 17px; height: 17px; }
      .bar:has(.identity) .brand { margin-right: 6px; position: relative; }
      .bar:has(.identity) .brand::after { content: ''; position: absolute; left: calc(100% + 6px); top: 3px; bottom: 3px; border-left: 1px solid #59648d88; }
      iframe { position: absolute; width: min(454px, calc(100vw - 32px));
        height: min(570px, calc(100vh - 90px)); border: 1px solid #586b96;
        border-radius: 18px; box-shadow: 0 16px 38px #080b18aa; background: #111827; }
      button {
        flex: none; border: 1px solid #7769dc; border-radius: 20px; padding: 4px 9px;
        color: #f7f8ff; cursor: pointer; font: inherit; font-weight: 650;
        background: linear-gradient(#363c70, #232b51);
      }
      button:hover, button[aria-expanded="true"] { background: #495395; border-color: #afa1ff; }
      button:focus-visible { outline: 2px solid #a5caff; outline-offset: 2px; }
      .activation button { background: linear-gradient(#607bff, #4046eb); border-color: #8498fa;
        box-shadow: inset 0 1px #c3d0ff55; }
      .activation button:hover { background: linear-gradient(#758cff, #5359fa); }
      .activation button[data-revoke] { color: #ffe4e8; background: #442536; border-color: #9b6273; }
      .activation button[data-revoke]:hover { background: #653448; }
    `
    this.controls = doc.createElement('div')
    this.controls.className = 'bar'
    this.activation = doc.createElement('div')
    this.activation.className = 'activation'
    const brand = doc.createElement('span')
    brand.className = 'brand'
    const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('aria-hidden', 'true')
    const layers = doc.createElementNS(icon.namespaceURI, 'path')
    layers.setAttribute('d', 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5')
    layers.setAttribute('fill', 'none')
    layers.setAttribute('stroke', 'currentColor')
    layers.setAttribute('stroke-width', '1.7')
    layers.setAttribute('stroke-linejoin', 'round')
    layers.setAttribute('stroke-linecap', 'round')
    icon.append(layers)
    brand.append(icon)
    this.controls.append(brand, this.activation)
    root.append(style, this.controls)
    if (runtime?.getURL && runtime.sendMessage) this.mountPicker(runtime)
    this.setPosition(defaultPosition)
    this.onStorageChanged = (changes, area) => {
      if (area === 'local' && (positionKey() in changes || positionKey(site) in changes)) {
        this.refreshPosition()
      }
    }
    storage?.onChanged?.addListener(this.onStorageChanged)
    this.refreshPosition()
    doc.body?.append(host)
  }

  private setPosition(position: Position): void {
    this.position = position
    const [vertical, horizontal] = position.split('-')
    this.host.style.inset = 'auto'
    this.host.style.setProperty(vertical, '16px')
    this.host.style.setProperty(horizontal, '16px')
    this.positionPanel()
  }

  private refreshPosition(): void {
    const keys = [positionKey(), positionKey(this.site)]
    this.storage?.local?.get(keys, (items) => {
      if (this.disposed) return
      this.setPosition(readPosition(items[keys[1]]) ?? readPosition(items[keys[0]]) ?? defaultPosition)
    })
  }

  renderActivation(model: {
    state: string
    label: string
    title: string
    revoke: boolean
    action: () => void
  }): void {
    if (!this.host.isConnected) this.doc.body?.append(this.host)
    this.host.hidden = false
    this.host.dataset.caState = model.state
    const label = this.doc.createElement('span')
    label.className = 'identity'
    const product = this.doc.createElement('span')
    product.className = 'product'
    product.textContent = 'Code Awareness'
    const separator = this.doc.createElement('span')
    separator.textContent = '·'
    separator.setAttribute('aria-hidden', 'true')
    const status = this.doc.createElement('span')
    status.className = 'state'
    status.textContent = model.label
    label.append(product, separator, status)
    label.title = model.title
    const button = this.doc.createElement('button')
    button.type = 'button'
    button.textContent = model.revoke ? pt.revoke : pt.activate
    button.toggleAttribute('data-revoke', model.revoke)
    button.addEventListener('click', model.action)
    const restoreFocus = this.host.shadowRoot?.activeElement === this.activation.lastElementChild
    this.activation.replaceChildren(label, button)
    if (restoreFocus) button.focus({ preventScroll: true })
  }

  private positionPanel(): void {
    if (!this.panel) return
    const [vertical, horizontal] = this.position.split('-')
    this.panel.style.inset = 'auto'
    this.panel.style.setProperty(vertical, 'calc(100% + 8px)')
    this.panel.style.setProperty(horizontal, '0')
  }

  private mountPicker(runtime: ChromeRuntimeApi): void {
    const win = this.doc.defaultView
    const panelUrl = runtime.getURL?.('context-picker.html')
    if (!win || !panelUrl) return
    const extensionOrigin = panelUrl.slice(0, panelUrl.lastIndexOf('/'))
    const trigger = this.doc.createElement('button')
    trigger.type = 'button'
    trigger.className = 'context-trigger'
    trigger.textContent = pt.context
    trigger.setAttribute('aria-expanded', 'false')
    trigger.setAttribute('aria-haspopup', 'dialog')
    this.controls.append(trigger)
    this.host.hidden = false

    const close = (restoreFocus = false) => {
      if (!this.panel) return
      this.panel.remove()
      this.panel = undefined
      trigger.setAttribute('aria-expanded', 'false')
      if (this.challenge) runtime.sendMessage?.({ type: 'PICKER_CLOSE', challenge: this.challenge })
      this.challenge = undefined
      if (restoreFocus) trigger.focus({ preventScroll: true })
    }
    const receive = (event: MessageEvent) => {
      const panel = this.panel
      if (!panel || event.origin !== extensionOrigin || event.source !== panel.contentWindow) return
      if (event.data?.type === 'PICKER_PANEL_CLOSE') {
        close(true)
        return
      }
      const challenge = event.data?.challenge
      if (event.data?.type !== 'PICKER_PANEL_HELLO' || typeof challenge !== 'string' ||
        this.challenge || !/^[a-f0-9-]{36}$/.test(challenge)) return
      this.challenge = challenge
      runtime.sendMessage?.({ type: 'PICKER_BIND', challenge }, (result) => {
        if (this.panel === panel && (result as { ok?: boolean } | undefined)?.ok) {
          panel.contentWindow?.postMessage({ type: 'PICKER_PANEL_READY' }, extensionOrigin)
        }
      })
    }
    const outside = (event: PointerEvent) => {
      if (!event.composedPath().includes(this.host)) close()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && this.panel) {
        event.stopPropagation()
        close(true)
      }
    }
    const closeOnNavigation = () => close()
    const visibility = () => { if (this.doc.hidden) close() }
    const navigation = (win as Window & { navigation?: EventTarget }).navigation
    trigger.addEventListener('click', event => {
      if (!event.isTrusted) return
      if (this.panel) {
        close(true)
        return
      }
      const panel = this.doc.createElement('iframe')
      panel.src = panelUrl
      panel.title = pt.picker
      this.panel = panel
      this.positionPanel()
      this.host.shadowRoot?.append(panel)
      trigger.setAttribute('aria-expanded', 'true')
    })
    const insert: ChromeMessageListener = (raw, sender, respond) => {
      const message = raw as { type?: string; href?: string; challenge?: string; markdown?: string; files?: PickerFile[] } | null
      if (!message || sender.id !== runtime.id || sender.tab) return
      const isCurrent = () => Boolean(this.panel && this.challenge && this.challenge === message.challenge &&
        win.location.href === message.href && !this.doc.hidden)
      if (message.type === 'PICKER_ATTACH_FILES') {
        if (this.site !== 'chatgpt' || !Array.isArray(message.files) || !isCurrent()) {
          respond({ outcome: 'unavailable', confirmed: [], pending: [] })
          return
        }
        const files = message.files
        void attachChatGptFiles(this.doc, files, isCurrent).then(respond, () => {
          respond({ outcome: 'uncertain', confirmed: [], pending: files.map(file => file.name) })
        })
        return true
      }
      if (message.type !== 'PICKER_INSERT_TEXT') return
      if (typeof message.markdown !== 'string' || !isCurrent()) {
        respond({ outcome: 'unavailable', reason: 'The original conversation is no longer active.' })
        return
      }
      void insertDraftText(this.site, this.doc, message.markdown, isCurrent).then(respond, () => {
        respond({ outcome: 'uncertain', reason: 'Check the draft before trying again.' })
      })
      return true
    }
    runtime.onMessage?.addListener(insert)
    win.addEventListener('message', receive)
    this.doc.addEventListener('pointerdown', outside, true)
    this.doc.addEventListener('keydown', escape, true)
    this.doc.addEventListener('visibilitychange', visibility)
    navigation?.addEventListener('navigate', closeOnNavigation)
    win.addEventListener('pagehide', closeOnNavigation)
    this.pickerCleanup = () => {
      close()
      runtime.onMessage?.removeListener?.(insert)
      win.removeEventListener('message', receive)
      this.doc.removeEventListener('pointerdown', outside, true)
      this.doc.removeEventListener('keydown', escape, true)
      this.doc.removeEventListener('visibilitychange', visibility)
      navigation?.removeEventListener('navigate', closeOnNavigation)
      win.removeEventListener('pagehide', closeOnNavigation)
    }
  }

  dispose(): void {
    this.disposed = true
    this.pickerCleanup?.()
    this.storage?.onChanged?.removeListener(this.onStorageChanged)
    this.host.remove()
  }
}
