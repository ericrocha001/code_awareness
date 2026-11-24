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
      .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px;
        max-width: calc(100vw - 54px); border-radius: 24px; background: #111827; color: #f9fafb;
        border: 1px solid #374151; font: 12px/1.2 system-ui, sans-serif;
        box-shadow: 0 4px 12px #0006; }
      .activation { display: contents; }
      iframe { position: absolute; width: min(340px, calc(100vw - 32px));
        height: min(500px, calc(100vh - 90px)); border: 1px solid #475569;
        border-radius: 12px; box-shadow: 0 8px 24px #0007; background: #111827; }
      button { border: 0; border-radius: 24px; padding: 4px 8px;
        background: #2563eb; color: white; cursor: pointer; font: inherit; }
      button[data-revoke] { background: #b91c1c; }
    `
    this.controls = doc.createElement('div')
    this.controls.className = 'bar'
    this.activation = doc.createElement('div')
    this.activation.className = 'activation'
    this.controls.append(this.activation)
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
    label.textContent = model.label
    label.title = model.title
    const button = this.doc.createElement('button')
    button.type = 'button'
    button.textContent = model.revoke ? 'Revoke' : 'Activate'
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
    trigger.textContent = 'Context'
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
      panel.title = 'Continuum Context Picker'
      this.panel = panel
      this.positionPanel()
      this.host.shadowRoot?.append(panel)
      trigger.setAttribute('aria-expanded', 'true')
    })
    const insert: ChromeMessageListener = (raw, sender, respond) => {
      const message = raw as { type?: string; href?: string; challenge?: string; markdown?: string } | null
      if (message?.type !== 'PICKER_INSERT_TEXT' || sender.id !== runtime.id || sender.tab) return
      const isCurrent = () => Boolean(this.panel && this.challenge && this.challenge === message.challenge &&
        win.location.href === message.href && !this.doc.hidden)
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
