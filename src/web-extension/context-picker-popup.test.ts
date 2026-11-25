import { expect, it, vi } from 'vitest'
import { ExtensionBackgroundRouter } from './background'
import type { ChromeMessageSender } from './chrome-api'

const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const origin = `chrome-extension://${id}`
const url = `${origin}/popup.html`
const documentId = 'popup-document'
const popup = { contextType: 'POPUP', documentId, documentUrl: url, frameId: 0, tabId: -1 }
const sender: ChromeMessageSender = { id, origin, url }
const request = { action: 'catalog', filters: {} }
const message = { type: 'PICKER_POPUP_REQUEST', request }

it('authorizes the native popup catalog even when Chrome omits sender metadata', async () => {
  const child = { ...popup, documentUrl: origin + '/context-picker.html', documentId: 'child', frameId: 5 }
  const runtime = { getContexts: vi.fn(async () => [popup, child]) }
  const sendNative = vi.fn(async () => ({ ok: true }))
  const router = new ExtensionBackgroundRouter(sendNative, id, { runtime })
  await expect(router.handleMessage(message, sender)).resolves.toEqual({ ok: true })
  expect(sendNative).toHaveBeenCalledWith(expect.objectContaining({ action: 'context_picker', surface: 'extension-ui', request }))
  expect(runtime.getContexts).toHaveBeenNthCalledWith(1, { contextTypes: ['POPUP'], documentUrls: [url] })
  await expect(router.handleMessage(message, { ...sender, documentId, frameId: 0 })).resolves.toEqual({ ok: true })
  expect(runtime.getContexts).toHaveBeenNthCalledWith(2, {
    contextTypes: ['POPUP'], documentIds: [documentId], documentUrls: [url]
  })
})

it('rejects invalid sender identities and out-of-scope operations without calling native', async () => {
  const runtime = { getContexts: vi.fn(async () => [popup]) }
  const sendNative = vi.fn()
  const router = new ExtensionBackgroundRouter(sendNative, id, { runtime })
  for (const invalid of [
    { ...sender, url: origin + '/context-picker.html' },
    { ...sender, url: url + '?popup=1' },
    { ...sender, origin: 'https://chatgpt.com' },
    { ...sender, tab: { id: 8 }, frameId: 0 },
    { ...sender, frameId: 5 },
    { ...sender, documentId: 'ordinary-extension-tab' },
    { ...sender, id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }
  ]) await expect(router.handleMessage(message, invalid)).resolves.toMatchObject({ ok: false })

  for (const action of ['attach', 'text', 'mcp_request', 'publish']) {
    await expect(router.handleMessage({ ...message, request: { action } }, sender)).resolves.toMatchObject({ ok: false })
  }
  expect(sendNative).not.toHaveBeenCalled()
})

it('fails closed for missing, ambiguous or inconsistent browser contexts', async () => {
  const runtime = { getContexts: vi.fn(async () => [popup]) }
  const sendNative = vi.fn()
  const router = new ExtensionBackgroundRouter(sendNative, id, { runtime })
  for (const contexts of [
    [],
    [popup, { ...popup, documentId: 'another-popup' }],
    [{ ...popup, contextType: 'TAB' }],
    [{ ...popup, documentUrl: origin + '/context-picker.html' }],
    [{ ...popup, frameId: 5 }],
    [{ ...popup, tabId: 8 }],
    [{ ...popup, documentId: '' }]
  ]) {
    runtime.getContexts.mockResolvedValueOnce(contexts)
    await expect(router.handleMessage(message, sender)).resolves.toMatchObject({ ok: false })
  }
  runtime.getContexts.mockRejectedValueOnce(new Error('API unavailable'))
  await expect(router.handleMessage(message, sender)).resolves.toMatchObject({ ok: false })
  const withoutApi = new ExtensionBackgroundRouter(sendNative, id, { runtime: {} })
  await expect(withoutApi.handleMessage(message, sender)).resolves.toMatchObject({ ok: false })
  expect(sendNative).not.toHaveBeenCalled()
})
