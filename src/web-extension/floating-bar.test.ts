import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'
import type { ChromeStorageChangeListener } from './chrome-api'
import { bootstrapContentScript } from './content-script'
import { detectChatSite, FloatingBar, positionKey } from './floating-bar'

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
  expect(shells[0].shadowRoot?.querySelector('button')).toBeNull()
  expect(doc.activeElement).toBe(draft)
  expect(detectChatSite('https://chatgpt.com.example.com/')).toBeUndefined()
  expect(detectChatSite('http://chatgpt.com/')).toBeUndefined()
})
