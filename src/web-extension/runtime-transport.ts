import type { ActivationClock, WebActivationTransport } from '../shared/web-activation/activation-session'
import type { ChromeApi } from './chrome-api'

export const DEFAULT_RUNTIME_MESSAGE_TIMEOUT_MS = 25_000

export function createRuntimeMessageTransport(
  chromeApi: ChromeApi,
  site: 'deepseek' | 'qwen',
  webOrigin: string,
  options: { timeoutMs?: number; clock?: ActivationClock } = {}
): WebActivationTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUNTIME_MESSAGE_TIMEOUT_MS
  const clock: ActivationClock = options.clock ?? {
    setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
    clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>)
  }

  const sendRuntimeMessage = <T>(payload: Record<string, unknown>): Promise<T> =>
    new Promise((resolve) => {
      if (!chromeApi.runtime?.sendMessage) {
        resolve({
          ok: false,
          error: {
            code: 'APP_UNAVAILABLE',
            message: 'chrome.runtime.sendMessage unavailable',
            details: { phase: 'runtime_message' }
          }
        } as T)
        return
      }
      let settled = false
      const timer = clock.setTimeout(() => {
        if (settled) return
        settled = true
        resolve({
          ok: false,
          error: {
            code: 'TIMEOUT',
            message: `Extension runtime bridge timed out after ${timeoutMs}ms`,
            details: { phase: 'runtime_message', timeoutMs, executionStateUnknown: true }
          }
        } as T)
      }, timeoutMs)

      try {
        chromeApi.runtime.sendMessage(payload, (response) => {
          if (settled) return
          settled = true
          clock.clearTimeout(timer)
          if (chromeApi.runtime?.lastError) {
            resolve({
              ok: false,
              error: {
                code: 'APP_UNAVAILABLE',
                message: chromeApi.runtime.lastError.message ?? 'Extension background disconnected',
                details: { phase: 'runtime_message', executionStateUnknown: true }
              }
            } as T)
            return
          }
          resolve(
            (response ?? {
              ok: false,
              error: {
                code: 'APP_UNAVAILABLE',
                message: 'Empty bridge response',
                details: { phase: 'runtime_message' }
              }
            }) as T
          )
        })
      } catch (err) {
        if (!settled) {
          settled = true
          clock.clearTimeout(timer)
          resolve({
            ok: false,
            error: {
              code: 'APP_UNAVAILABLE',
              message: err instanceof Error ? err.message : 'chrome.runtime.sendMessage failed',
              details: { phase: 'runtime_message' }
            }
          } as T)
        }
      }
    })

  return {
    async getStatus() {
      const res = await sendRuntimeMessage<{
        ok?: boolean
        result?: {
          available?: boolean
          mode?: 'PROJECT' | 'GLOBAL_ONLY'
          projectId?: string | null
          instanceId?: string | null
          bindingId?: string | null
          catalogRevision?: string | null
          consents?: { metadata: boolean; literalSource: boolean }
          errorCode?: string
        }
        error?: { code?: string }
      }>({ type: 'GET_STATUS', site, webOrigin })

      if (!res?.ok || !res.result?.available) {
        return {
          available: false,
          errorCode: res?.error?.code ?? res?.result?.errorCode ?? 'APP_UNAVAILABLE'
        }
      }

      return {
        available: true,
        mode: res.result.mode ?? (res.result.projectId ? 'PROJECT' : 'GLOBAL_ONLY'),
        projectId: res.result.projectId ?? null,
        instanceId: res.result.instanceId ?? null,
        bindingId: res.result.bindingId ?? null,
        ...(res.result.catalogRevision ? { catalogRevision: res.result.catalogRevision } : {}),
        ...(res.result.consents ? { consents: res.result.consents } : {})
      }
    },

    async mcpRequest(input) {
      const res = await sendRuntimeMessage<{
        ok?: boolean
        result?: {
          mcp?: { id?: string | number | null; result?: unknown; error?: { code?: number; message?: string } }
        }
        error?: { code: string; message: string; details?: Record<string, unknown> }
      }>({
        type: 'MCP_REQUEST',
        site,
        webOrigin,
        method: input.method,
        params: input.params ?? {},
        expectedProjectId: input.expectedProjectId,
        expectedBindingId: input.expectedBindingId,
        expectedInstanceId: input.expectedInstanceId
      })

      if (!res?.ok) {
        return {
          ok: false,
          error: res?.error ?? { code: 'APP_UNAVAILABLE', message: 'MCP request failed' }
        }
      }

      return {
        ok: true,
        mcp: res.result?.mcp
      }
    }
  }
}
