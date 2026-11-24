import { expect, it, vi } from 'vitest'
import { ExtensionBackgroundRouter } from './background'
import type { ChromeMessageSender } from './chrome-api'

const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const origin = `chrome-extension://${id}`
const url = `${origin}/popup.html`
const documentId = 'popup-document'

it('allows only the genuine popup context to invoke manual Picker operations', async () => {
  const runtime = {
    getContexts: vi.fn(async () => [{ contextType: 'POPUP', documentId, documentUrl: url }])
  }
  const sendNative = vi.fn(async () => ({ ok: true }))
  const router = new ExtensionBackgroundRouter(sendNative, id, { runtime })
  const sender: ChromeMessageSender = { id, origin, url, documentId }
  const request = { action: 'catalog', filters: {} }
  const message = { type: 'PICKER_POPUP_REQUEST', request }
  await expect(router.handleMessage(message, sender)).resolves.toEqual({ ok: true })
  expect(sendNative).toHaveBeenCalledWith(expect.objectContaining({ action: 'context_picker', surface: 'extension-ui', request }))
  expect(runtime.getContexts).toHaveBeenCalledWith({
    contextTypes: ['POPUP'], documentIds: [documentId], documentUrls: [url]
  })

  for (const invalid of [
    { ...sender, url: origin + '/context-picker.html' },
    { ...sender, url: url + '?popup=1' },
    { ...sender, tab: { id: 8, url: 'https://chatgpt.com/' }, frameId: 1 },
    { ...sender, documentId: 'ordinary-extension-tab' },
    { ...sender, documentId: undefined },
    { ...sender, id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }
  ]) await expect(router.handleMessage(message, invalid)).resolves.toMatchObject({ ok: false })

  for (const action of ['attach', 'text', 'mcp_request', 'publish']) {
    await expect(router.handleMessage({ ...message, request: { action } }, sender)).resolves.toMatchObject({ ok: false })
  }
  expect(sendNative).toHaveBeenCalledTimes(1)
})
