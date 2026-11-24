import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import type { ChromeStorageChangeListener } from './chrome-api'
import { bootstrapContentScript } from './content-script'
import { detectChatSite, FloatingBar, floatingBarVisibleKey, positionKey } from './floating-bar'

it('applies the global position and platform override live, then restores inheritance', () => {
  const doc = new JSDOM().window.document
  const preferences: Record<string, unknown> = {}
  let listener: ChromeStorageChangeListener | undefined
  const bar = new FloatingBar(doc, 'qwen', {
    local: {
      get: (_keys, callback) => callback(preferences),
      set: (items) => Object.assign(preferences, items)
    },
    onChanged: {
      addListener: (callback) => { listener = callback },
      removeListener: () => { listener = undefined }
    }
  })
  const host = doc.querySelector<HTMLElement>('#code-awareness-activation-pill')!
  expect(host.style.bottom).toBe('16px')
  expect(host.style.right).toBe('16px')

  const global = positionKey()
  const override = positionKey('qwen')
  preferences[global] = 'top-left'
  listener?.({ [global]: { newValue: 'top-left' } }, 'local')
  expect(host.style.top).toBe('16px')
  expect(host.style.left).toBe('16px')

  preferences[override] = 'top-right'
  listener?.({ [override]: { newValue: 'top-right' } }, 'local')
  expect(host.style.right).toBe('16px')
  delete preferences[override]
  listener?.({ [override]: {} }, 'local')
  expect(host.style.left).toBe('16px')

  bar.dispose()
  expect(listener).toBeUndefined()
  expect(host.isConnected).toBe(false)
})

it('reinjects a single dormant shell on a picker-only site without mounting activation', () => {
  const { window } = new JSDOM('<textarea></textarea>', { url: 'https://chatgpt.com/' })
  const { document: doc } = window
  const draft = doc.querySelector('textarea')!
  draft.focus()
  expect(bootstrapContentScript({}, doc, window.location.href)).toBeNull()
  window.history.pushState(null, '', '/c/another')
  expect(bootstrapContentScript({}, doc, window.location.href)).toBeNull()
  const shells = doc.querySelectorAll<HTMLElement>('#code-awareness-activation-pill')
  expect(shells).toHaveLength(1)
  expect(shells[0].hidden).toBe(true)
  expect(shells[0].shadowRoot?.querySelector('.context-trigger')).toBeNull()
  expect(doc.activeElement).toBe(draft)
  expect(detectChatSite('https://chatgpt.com.example.com/')).toBeUndefined()
  expect(detectChatSite('http://chatgpt.com/')).toBeUndefined()
})

it('keeps activation state and position while the bar preference hides and remounts only its UI', () => {
  const doc = new JSDOM().window.document
  const preferences: Record<string, unknown> = { [floatingBarVisibleKey]: false, [positionKey()]: 'top-left' }
  let listener: ChromeStorageChangeListener | undefined
  const storage = {
    local: {
      get: (_keys: unknown, callback: (items: Record<string, unknown>) => void) => callback(preferences),
      set: (items: Record<string, unknown>) => Object.assign(preferences, items)
    },
    onChanged: {
      addListener: (callback: ChromeStorageChangeListener) => { listener = callback },
      removeListener: () => { listener = undefined }
    }
  }
  const runtime = {
    getURL: (path: string) => `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${path}`,
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() }
  }
  const sessionAction = vi.fn()
  const bar = new FloatingBar(doc, 'deepseek', storage, runtime)
  bar.renderActivation({ state: 'READY', label: 'Pronta', title: '', revoke: true, action: sessionAction })
  const host = doc.querySelector<HTMLElement>('#code-awareness-activation-pill')!
  expect(host.hidden).toBe(true)
  expect(runtime.onMessage.addListener).not.toHaveBeenCalled()

  const show = (visible: boolean) => {
    preferences[floatingBarVisibleKey] = visible
    listener?.({ [floatingBarVisibleKey]: { newValue: visible } }, 'local')
  }
  show(true)
  expect(host.hidden).toBe(false)
  expect(host.shadowRoot?.querySelectorAll('.context-trigger')).toHaveLength(1)
  show(false)
  expect(host.hidden).toBe(true)
  expect(host.shadowRoot?.querySelector('.context-trigger')).toBeNull()
  expect(runtime.onMessage.removeListener).toHaveBeenCalledOnce()
  show(true)
  expect(host.shadowRoot?.querySelectorAll('.context-trigger')).toHaveLength(1)
  expect(host.dataset.caState).toBe('READY')
  expect(host.style.left).toBe('16px')
  expect(sessionAction).not.toHaveBeenCalled()
  expect(runtime.sendMessage).not.toHaveBeenCalled()
  bar.dispose()

  preferences[floatingBarVisibleKey] = false
  const reinjected = new FloatingBar(doc, 'deepseek', storage, runtime)
  expect(doc.querySelector<HTMLElement>('#code-awareness-activation-pill')?.hidden).toBe(true)
  reinjected.dispose()
})
