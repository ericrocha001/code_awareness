import { getChromeApi, type ChromeApi, type ChromeMessageSender, type ChromeNativePortLike } from './chrome-api'
import {
  ExtensionMaintenanceCoordinator,
  registerGlobalMaintenanceDebugHandle
} from './extension-maintenance'
import { getConfiguredNativeHostApplication } from './runtime-config'

export const NATIVE_HOST_APPLICATION = getConfiguredNativeHostApplication()

function maybeUnrefTimer(timer: unknown): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    const candidate = (timer as { unref?: unknown }).unref
    if (typeof candidate === 'function') {
      candidate.call(timer)
    }
  }
}

const ALLOWED_PAGE_ORIGINS: Readonly<Record<string, 'deepseek' | 'qwen'>> = {
  'https://chat.deepseek.com': 'deepseek',
  'https://chat.qwen.ai': 'qwen'
}

export type ExtensionBackgroundMessage =
  | { type: 'PING_BRIDGE' }
  | { type: 'GET_STATUS'; site?: string; webOrigin?: string }
  | { type: 'GET_CONSENT'; site: string; projectId?: string | null; webOrigin?: string }
  | {
      type: 'SET_CONSENT'
      site: string
      projectId?: string | null
      dataClass: 'METADATA' | 'LITERAL_SOURCE'
      granted: boolean
      webOrigin?: string
    }
  | {
      type: 'MCP_REQUEST'
      site: string
      webOrigin: string
      method: string
      params?: Record<string, unknown>
      expectedProjectId?: string | null
      expectedBindingId?: string | null
      expectedInstanceId?: string | null
    }

export type NativeMessageSender = (payload: Record<string, unknown>) => Promise<unknown>

export interface NativePortSenderOptions {
  idleTtlMs?: number
  requestTimeoutMs?: number
  clock?: {
    setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout>
    clearTimeout(timer: ReturnType<typeof setTimeout>): void
  }
}

export interface NativePortSenderStats {
  connectCount: number
  activePort: boolean
  pendingCount: number
}

export interface ReusableNativePortSender extends NativeMessageSender {
  closePort: (reason?: string) => void
  getPortStats: () => NativePortSenderStats
}

export const DEFAULT_PORT_IDLE_TTL_MS = 30_000
export const DEFAULT_PORT_REQUEST_TIMEOUT_MS = 20_000

function parseOrigin(urlValue: string | undefined): string | null {
  if (!urlValue) return null
  try {
    return new URL(urlValue).origin.toLowerCase()
  } catch {
    return null
  }
}

function isTrustedExtensionUiSender(sender: ChromeMessageSender, runtimeId: string | undefined): boolean {
  if (sender.tab) return false
  if (runtimeId && sender.id && sender.id !== runtimeId) return false
  const senderUrl = sender.url ?? ''
  if (runtimeId && senderUrl.startsWith(`chrome-extension://${runtimeId}/`)) {
    return true
  }
  // When sender.url is omitted by mock/popup runtime, verify id matches extension id and there is no tab
  return Boolean(runtimeId && sender.id === runtimeId && !sender.tab)
}

function resolveSenderWebSite(sender: ChromeMessageSender): { origin: string; site: 'deepseek' | 'qwen' } | null {
  const origin = parseOrigin(sender.url ?? sender.tab?.url ?? sender.origin)
  if (!origin) return null
  const site = ALLOWED_PAGE_ORIGINS[origin]
  if (!site) return null
  return { origin, site }
}

export function createChromeNativePortSender(
  chromeApi: ChromeApi,
  options: NativePortSenderOptions = {}
): ReusableNativePortSender {
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_PORT_IDLE_TTL_MS
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_PORT_REQUEST_TIMEOUT_MS
  const timerApi = options.clock ?? {
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)
  }

  let activePort: ChromeNativePortLike | null = null
  let connectCount = 0
  let fallbackSeq = 0
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const pending = new Map<
    string,
    {
      resolve: (response: unknown) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  const clearIdleTimer = (): void => {
    if (idleTimer !== null) {
      timerApi.clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  const detachAndClearPort = (port: ChromeNativePortLike | null): void => {
    if (!port) return
    try {
      port.onMessage.removeListener?.(handlePortMessage)
      port.onDisconnect.removeListener?.(handlePortDisconnect)
    } catch {
      // Ignore listener removal errors during disconnect
    }
    if (activePort === port) {
      activePort = null
    }
  }

  const rejectPending = (code: string, message: string): void => {
    const entries = Array.from(pending.entries())
    pending.clear()
    for (const [id, entry] of entries) {
      timerApi.clearTimeout(entry.timer)
      entry.resolve({
        id,
        ok: false,
        error: {
          code,
          message,
          details: { phase: 'native_port', executionStateUnknown: true }
        }
      })
    }
  }

  const scheduleIdleClose = (): void => {
    clearIdleTimer()
    if (!activePort || pending.size > 0 || idleTtlMs <= 0) return
    idleTimer = timerApi.setTimeout(() => {
      idleTimer = null
      if (pending.size === 0 && activePort) {
        closePort('IDLE_TIMEOUT')
      }
    }, idleTtlMs)
    maybeUnrefTimer(idleTimer)
  }

  const handlePortMessage = (response: unknown): void => {
    if (!response || typeof response !== 'object') return
    const respId = typeof (response as { id?: unknown }).id === 'string' ? (response as { id: string }).id : ''
    if (!respId) return
    const entry = pending.get(respId)
    if (!entry) return
    pending.delete(respId)
    timerApi.clearTimeout(entry.timer)
    entry.resolve(response)
    if (pending.size === 0) {
      scheduleIdleClose()
    }
  }

  const handlePortDisconnect = (): void => {
    clearIdleTimer()
    const disconnectedPort = activePort
    detachAndClearPort(disconnectedPort)
    const reason = chromeApi.runtime?.lastError?.message ?? 'Native messaging port disconnected'
    rejectPending('APP_UNAVAILABLE', reason)
  }

  const ensurePort = (): ChromeNativePortLike | null => {
    if (activePort) return activePort
    const connectNative = chromeApi.runtime?.connectNative
    if (!connectNative) return null
    const port = connectNative.call(chromeApi.runtime, NATIVE_HOST_APPLICATION)
    connectCount += 1
    activePort = port
    port.onMessage.addListener(handlePortMessage)
    port.onDisconnect.addListener(handlePortDisconnect)
    return port
  }

  const closePort = (reason = 'Native messaging port closed'): void => {
    clearIdleTimer()
    const port = activePort
    detachAndClearPort(port)
    rejectPending('APP_UNAVAILABLE', reason)
    if (port) {
      try {
        port.disconnect()
      } catch {
        // Ignore disconnect errors if already closed
      }
    }
  }

  const sendFallbackOneShot = (payload: Record<string, unknown>, id: string): Promise<unknown> =>
    new Promise((resolve) => {
      const runtime = chromeApi.runtime
      if (!runtime?.sendNativeMessage) {
        resolve({
          id,
          ok: false,
          error: {
            code: 'APP_UNAVAILABLE',
            message: 'chrome.runtime.sendNativeMessage is unavailable',
            details: { phase: 'native_port' }
          }
        })
        return
      }
      let settled = false
      const timer = timerApi.setTimeout(() => {
        if (settled) return
        settled = true
        resolve({
          id,
          ok: false,
          error: {
            code: 'TIMEOUT',
            message: `One-shot native messaging request "${id}" timed out after ${requestTimeoutMs}ms`,
            details: { phase: 'native_port', timeoutMs: requestTimeoutMs, executionStateUnknown: true }
          }
        })
      }, requestTimeoutMs)
      maybeUnrefTimer(timer)

      try {
        runtime.sendNativeMessage(NATIVE_HOST_APPLICATION, { ...payload, id }, (response) => {
          if (settled) return
          settled = true
          timerApi.clearTimeout(timer)
          if (runtime.lastError) {
            resolve({
              id,
              ok: false,
              error: {
                code: 'APP_UNAVAILABLE',
                message: runtime.lastError.message ?? 'Native messaging host disconnected',
                details: { phase: 'native_port', executionStateUnknown: true }
              }
            })
            return
          }
          if (!response || typeof response !== 'object') {
            resolve({
              id,
              ok: false,
              error: {
                code: 'INVALID_MCP_RESPONSE',
                message: 'Native messaging host returned non-object response',
                details: { phase: 'native_port' }
              }
            })
            return
          }
          const respId = (response as { id?: unknown }).id
          if (respId !== undefined && respId !== id) {
            resolve({
              id,
              ok: false,
              error: {
                code: 'INVALID_MCP_RESPONSE',
                message: 'One-shot native messaging response correlation id mismatch',
                details: { phase: 'native_port' }
              }
            })
            return
          }
          resolve(response)
        })
      } catch (err) {
        if (!settled) {
          settled = true
          timerApi.clearTimeout(timer)
          resolve({
            id,
            ok: false,
            error: {
              code: 'APP_UNAVAILABLE',
              message: err instanceof Error ? err.message : 'sendNativeMessage failed',
              details: { phase: 'native_port' }
            }
          })
        }
      }
    })

  const sender = ((payload: Record<string, unknown>): Promise<unknown> => {
    const id =
      typeof payload.id === 'string' && payload.id.trim().length > 0
        ? payload.id
        : `port-${Date.now().toString(36)}-${++fallbackSeq}`

    if (!chromeApi.runtime?.connectNative) {
      return sendFallbackOneShot(payload, id)
    }

    clearIdleTimer()
    let port: ChromeNativePortLike | null = null
    try {
      port = ensurePort()
    } catch (err) {
      return Promise.resolve({
        id,
        ok: false,
        error: {
          code: 'APP_UNAVAILABLE',
          message: err instanceof Error ? err.message : 'Failed to connect Native Messaging port'
        }
      })
    }

    if (!port) {
      return Promise.resolve({
        id,
        ok: false,
        error: { code: 'APP_UNAVAILABLE', message: 'chrome.runtime.connectNative returned no port' }
      })
    }

    return new Promise((resolve) => {
      const timer = timerApi.setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        resolve({
          id,
          ok: false,
          error: {
            code: 'TIMEOUT',
            message: `Native messaging request "${id}" timed out after ${requestTimeoutMs}ms`,
            details: { phase: 'native_port', timeoutMs: requestTimeoutMs, executionStateUnknown: true }
          }
        })
        if (pending.size === 0) {
          scheduleIdleClose()
        }
      }, requestTimeoutMs)
      maybeUnrefTimer(timer)

      pending.set(id, { resolve, timer })
      try {
        port!.postMessage({ ...payload, id })
      } catch (err) {
        if (pending.has(id)) {
          pending.delete(id)
          timerApi.clearTimeout(timer)
        }
        detachAndClearPort(port)
        resolve({
          id,
          ok: false,
          error: {
            code: 'APP_UNAVAILABLE',
            message: err instanceof Error ? err.message : 'Native messaging port postMessage failed',
            details: { phase: 'native_port' }
          }
        })
      }
    })
  }) as ReusableNativePortSender

  sender.closePort = closePort
  sender.getPortStats = (): NativePortSenderStats => ({
    connectCount,
    activePort: activePort !== null,
    pendingCount: pending.size
  })

  return sender
}

export function createChromeNativeSender(chromeApi: ChromeApi): NativeMessageSender {
  return createChromeNativePortSender(chromeApi)
}

export class ExtensionBackgroundRouter {
  private seq = 0

  constructor(
    private readonly sendNative: NativeMessageSender,
    private readonly runtimeId?: string
  ) {}

  private nextId(): string {
    this.seq += 1
    return `ext-${Date.now().toString(36)}-${this.seq}`
  }

  async handleMessage(rawMessage: unknown, sender: ChromeMessageSender): Promise<unknown> {
    if (!rawMessage || typeof rawMessage !== 'object' || typeof (rawMessage as { type?: unknown }).type !== 'string') {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Missing message type' } }
    }

    const msg = rawMessage as ExtensionBackgroundMessage
    if ((msg as { type: string }).type.startsWith('MAINTENANCE_')) {
      return {
        ok: false,
        error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Maintenance actions cannot be triggered via runtime messages' }
      }
    }
    const isPopup = isTrustedExtensionUiSender(sender, this.runtimeId)
    const webSender = resolveSenderWebSite(sender)

    if (!isPopup && !webSender) {
      return {
        ok: false,
        error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Sender origin is not authorized' }
      }
    }

    const id = this.nextId()

    switch (msg.type) {
      case 'PING_BRIDGE':
        return await this.sendNative({ id, action: 'ping' })

      case 'GET_STATUS': {
        const site = isPopup ? msg.site : webSender?.site
        const webOrigin = isPopup ? msg.webOrigin : webSender?.origin
        return await this.sendNative({
          id,
          action: 'get_status',
          ...(site ? { site } : {}),
          ...(webOrigin ? { webOrigin } : {})
        })
      }

      case 'GET_CONSENT': {
        const site = isPopup ? msg.site : webSender!.site
        const webOrigin = isPopup ? msg.webOrigin : webSender!.origin
        return await this.sendNative({
          id,
          action: 'get_consent',
          site,
          projectId: msg.projectId ?? null,
          ...(webOrigin ? { webOrigin } : {})
        })
      }

      case 'SET_CONSENT': {
        // Web page tabs / content scripts MUST NOT be able to self-grant or revoke consent
        if (!isPopup) {
          return {
            ok: false,
            error: {
              code: 'ORIGIN_NOT_ALLOWED',
              message: 'Consent changes may only originate from trusted extension UI'
            }
          }
        }
        const consentResult = await this.sendNative({
          id,
          action: 'set_consent',
          site: msg.site,
          projectId: msg.projectId ?? null,
          dataClass: msg.dataClass,
          granted: msg.granted,
          ...(msg.webOrigin ? { webOrigin: msg.webOrigin } : {})
        })
        if (!msg.granted) {
          this.closeIdlePort('CONSENT_REVOKED')
        }
        return consentResult
      }

      case 'MCP_REQUEST': {
        if (!webSender) {
          return {
            ok: false,
            error: { code: 'ORIGIN_NOT_ALLOWED', message: 'mcp_request requires an authorized chat page sender' }
          }
        }
        const mcpResult = await this.sendNative({
          id,
          action: 'mcp_request',
          site: webSender.site,
          webOrigin: webSender.origin,
          method: msg.method,
          params: msg.params ?? {},
          ...(msg.expectedProjectId !== undefined ? { expectedProjectId: msg.expectedProjectId } : {}),
          ...(msg.expectedBindingId !== undefined ? { expectedBindingId: msg.expectedBindingId } : {}),
          ...(msg.expectedInstanceId !== undefined ? { expectedInstanceId: msg.expectedInstanceId } : {})
        })
        if (
          mcpResult &&
          typeof mcpResult === 'object' &&
          (mcpResult as { error?: { code?: unknown } }).error?.code === 'SESSION_INVALIDATED'
        ) {
          this.closeIdlePort('SESSION_INVALIDATED')
        }
        return mcpResult
      }

      default:
        return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Unsupported message type' } }
    }
  }

  private closeIdlePort(reason: string): void {
    const portControl = this.sendNative as Partial<ReusableNativePortSender>
    if (typeof portControl.closePort !== 'function') return
    const stats = typeof portControl.getPortStats === 'function' ? portControl.getPortStats() : null
    if (!stats || stats.pendingCount === 0) {
      portControl.closePort(reason)
    }
  }
}

export function registerBackgroundServiceWorker(
  chromeApi: ChromeApi | undefined = getChromeApi()
): ExtensionMaintenanceCoordinator | null {
  if (!chromeApi?.runtime?.onMessage) return null
  const nativeSender = createChromeNativePortSender(chromeApi)
  const router = new ExtensionBackgroundRouter(nativeSender, chromeApi.runtime.id)
  const maintenance = new ExtensionMaintenanceCoordinator({
    chromeApi,
    sendNative: nativeSender,
    closeNativePort: (reason) => nativeSender.closePort(reason),
    getActiveRequestCount: () => nativeSender.getPortStats().pendingCount
  })
  maintenance.registerAlarmAndLifecycleListeners()
  registerGlobalMaintenanceDebugHandle(maintenance)

  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void router.handleMessage(message, sender).catch(() => ({
      ok: false,
      error: {
        code: 'BACKGROUND_REQUEST_FAILED',
        message: 'Extension background could not complete the request',
        details: { executionStateUnknown: true }
      }
    })).then((res) => {
      if (res && typeof res === 'object' && (res as { ok?: unknown }).ok === true) {
        maintenance.resetBackoff()
      }
      sendResponse(res)
    })
    return true
  })

  void maintenance.runTick('boot')
  return maintenance
}

registerBackgroundServiceWorker()
