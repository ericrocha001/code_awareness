import { contextPickerSite, supportsDraftInsertion } from '../shared/web-activation/context-picker-sites'
import type { DraftOutcome, PickerAttachment, PickerFile, PickerRequest } from '../shared/web-activation/context-picker-contract'
import type { ChromeMessageSender } from './chrome-api'

export type PickerMessage =
  | { type: 'PICKER_BIND'; challenge: string }
  | { type: 'PICKER_CLOSE'; challenge: string }
  | { type: 'PICKER_REQUEST'; challenge: string; request: PickerRequest }

function rejected(code: string) {
  return { ok: false, error: { code, message: code } }
}

interface PanelBinding {
  href: string
  challenge: string
  expiresAt: number
  documentId?: string
  topDocumentId?: string
  draftAttempts: Set<string>
  attachmentAttempts: Set<string>
}

export class PickerRouter {
  private readonly bindings = new Map<number, PanelBinding>()

  constructor(
    private readonly runtimeId: string | undefined,
    private readonly nativeRequest: (origin: string, request: PickerRequest) => Promise<unknown>,
    private readonly insertText?: (tab: number, doc: string, href: string, challenge: string, markdown: string) => Promise<unknown>,
    private readonly attachFiles?: (tab: number, doc: string, href: string, challenge: string, files: PickerFile[]) => Promise<unknown>
  ) {}

  async handle(message: PickerMessage, sender: ChromeMessageSender): Promise<unknown> {
    const tabId = sender.tab?.id
    const href = sender.tab?.url
    const site = contextPickerSite(href)
    if (tabId === undefined || !href || !site ||
      !this.runtimeId || sender.id !== this.runtimeId ||
      typeof message.challenge !== 'string' || !/^[a-f0-9-]{36}$/.test(message.challenge)) {
      return rejected('PICKER_SENDER_NOT_AUTHORIZED')
    }

    const top = sender.frameId === 0 && sender.url === href
    if (message.type === 'PICKER_BIND') {
      if (!top) return rejected('PICKER_SENDER_NOT_AUTHORIZED')
      for (const [id, binding] of this.bindings) {
        if (Date.now() >= binding.expiresAt) this.bindings.delete(id)
      }
      this.bindings.set(tabId, {
        href, challenge: message.challenge, expiresAt: Date.now() + 600_000,
        topDocumentId: sender.documentId, draftAttempts: new Set(), attachmentAttempts: new Set()
      })
      return { ok: true }
    }

    const binding = this.bindings.get(tabId)
    if (!binding || binding.href !== href || binding.challenge !== message.challenge ||
      Date.now() >= binding.expiresAt) return rejected('PICKER_SESSION_EXPIRED')
    if (message.type === 'PICKER_CLOSE') {
      if (!top) return rejected('PICKER_SENDER_NOT_AUTHORIZED')
      this.bindings.delete(tabId)
      return { ok: true }
    }
    const panel = `chrome-extension://${this.runtimeId}/context-picker.html`
    if (message.type !== 'PICKER_REQUEST' || !sender.frameId || !sender.documentId ||
      sender.url !== panel || sender.origin !== `chrome-extension://${this.runtimeId}` ||
      (binding.documentId && binding.documentId !== sender.documentId) ||
      !message.request || !['catalog', 'preview', 'copy', 'download', 'attach', 'text', 'tag-membership', 'tag-assign', 'tag-create'].includes(message.request.action)) {
      return rejected('PICKER_SENDER_NOT_AUTHORIZED')
    }

    binding.documentId = sender.documentId
    const request = message.request
    const origin = new URL(href).origin
    if (request.action === 'attach') {
      if (site !== 'chatgpt' || !this.attachFiles || !binding.topDocumentId) return rejected('PICKER_ATTACH_UNAVAILABLE')
      if (!Array.isArray(request.selected) || !request.selected.length || request.selected.length > 100) return rejected('INVALID_SELECTION')
      const keys = request.selected.map(item => JSON.stringify([item.artifactId, item.expectedRevision]))
      if (keys.some(key => binding.attachmentAttempts.has(key))) return rejected('PICKER_ATTACH_ALREADY_ATTEMPTED')
      keys.forEach(key => binding.attachmentAttempts.add(key))
      const release = () => keys.forEach(key => binding.attachmentAttempts.delete(key))
      let materialized
      try {
        materialized = await this.nativeRequest(origin, request) as { ok?: boolean; result?: { files?: PickerFile[] } }
      } catch {
        release()
        return rejected('APP_UNAVAILABLE')
      }
      if (this.bindings.get(tabId) !== binding || Date.now() >= binding.expiresAt) return rejected('PICKER_SESSION_EXPIRED')
      const files = materialized.result?.files
      if (!materialized.ok || !files?.length) {
        release()
        return materialized.ok ? rejected('PICKER_ATTACH_UNAVAILABLE') : materialized
      }
      const response = await this.attachFiles(tabId, binding.topDocumentId, href, binding.challenge, files)
        .catch(() => undefined) as PickerAttachment | undefined
      if (response?.outcome === 'unavailable') release()
      else if (files.length === keys.length) {
        files.forEach((file, index) => {
          if (response?.failed?.includes(file.name) && !response.confirmed.includes(file.name)) {
            binding.attachmentAttempts.delete(keys[index])
          }
        })
      }
      return { ok: true, result: response ?? { outcome: 'uncertain', confirmed: [], pending: files.map(file => file.name) } }
    }

    if (request.action === 'text') {
      if (!supportsDraftInsertion(site) || !this.insertText || !binding.topDocumentId) {
        return rejected('PICKER_INSERT_UNAVAILABLE')
      }
      if (!Array.isArray(request.selected) || request.selected.length > 100) {
        return rejected('INVALID_SELECTION')
      }
      const selection = JSON.stringify(request.selected)
      if (binding.draftAttempts.has(selection)) return rejected('PICKER_INSERT_ALREADY_ATTEMPTED')
      binding.draftAttempts.add(selection)
      const response = await this.nativeRequest(origin, request) as {
        ok?: boolean; result?: { markdown?: string }
      }
      if (this.bindings.get(tabId) !== binding) return rejected('PICKER_SESSION_EXPIRED')
      if (!response.ok || typeof response.result?.markdown !== 'string') {
        binding.draftAttempts.delete(selection)
        return response.ok ? rejected('PICKER_INSERT_UNAVAILABLE') : response
      }
      const delivered = await this.insertText(tabId, binding.topDocumentId, href, binding.challenge, response.result.markdown)
        .catch(() => undefined) as DraftOutcome | undefined
      if (delivered?.outcome === 'unavailable') binding.draftAttempts.delete(selection)
      return { ok: true, result: delivered ?? { outcome: 'uncertain', reason: 'Check the draft before trying again.' } }
    }

    const response = await this.nativeRequest(origin, request)
    if (this.bindings.get(tabId) !== binding) return rejected('PICKER_SESSION_EXPIRED')
    return response
  }
}
