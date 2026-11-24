import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionBackgroundRouter } from './background'
import type { ChromeApi } from './chrome-api'
import { bootstrapContentScript } from './content-script'
import {
  ExtensionMaintenanceCoordinator,
  MAINTENANCE_ALARM_NAME,
  MAINTENANCE_ALARM_PERIOD_MINUTES
} from './extension-maintenance'

function createMockChromeApi(options: {
  extensionId?: string
  installType?: string
  manifestVersion?: string
  initialStorage?: Record<string, unknown>
  tabs?: Array<{ id: number; url: string }>
  tabHandlers?: Record<number, (msg: unknown) => unknown>
  executeScriptSpy?: (injection: { target: { tabId: number }; files?: string[] }) => void
} = {}) {
  const storageData: Record<string, unknown> = { ...(options.initialStorage ?? {}) }
  const createdAlarms = new Map<string, { delayInMinutes?: number; periodInMinutes?: number }>()
  const clearedAlarms: string[] = []
  const alarmListeners: Array<(alarm: { name: string }) => void> = []
  const reload = vi.fn()
  const closePort = vi.fn()

  const chromeApi: ChromeApi = {
    runtime: {
      id: options.extensionId ?? 'a'.repeat(32),
      getManifest: () => ({ version: options.manifestVersion ?? '1.0.0' }),
      reload,
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() }
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const out: Record<string, unknown> = {}
          const keyList = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(storageData)
          for (const key of keyList) {
            if (key in storageData) out[key] = storageData[key]
          }
          cb(out)
        },
        set: (items, cb) => {
          Object.assign(storageData, items)
          cb?.()
        },
        remove: (keys, cb) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete storageData[key]
          }
          cb?.()
        }
      }
    },
    alarms: {
      create: (name, info) => {
        createdAlarms.set(name, info)
      },
      clear: (name, cb) => {
        createdAlarms.delete(name)
        clearedAlarms.push(name)
        cb?.(true)
      },
      get: (name, cb) => {
        const found = createdAlarms.get(name)
        cb(found ? { name, ...found } : undefined)
      },
      onAlarm: {
        addListener: (listener) => {
          alarmListeners.push(listener)
        }
      }
    },
    management: {
      getSelf: (cb) => {
        const info = {
          id: options.extensionId ?? 'a'.repeat(32),
          installType: options.installType ?? 'development',
          version: options.manifestVersion ?? '1.0.0',
          enabled: true
        }
        cb?.(info)
        return Promise.resolve(info)
      }
    },
    tabs: {
      query: (_queryInfo, cb) => {
        cb(options.tabs ?? [])
      },
      sendMessage: (tabId, message, cb) => {
        const handler = options.tabHandlers?.[tabId]
        cb?.(handler ? handler(message) : null)
      }
    },
    scripting: {
      executeScript: async (injection) => {
        options.executeScriptSpy?.(injection)
        return [{ frameId: 0, result: null }]
      }
    }
  }

  return {
    chromeApi,
    storageData,
    createdAlarms,
    clearedAlarms,
    alarmListeners,
    reload,
    closePort
  }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__codeAwarenessContentController__
})

describe('MV3 ExtensionMaintenanceCoordinator & Manifest Permissions', () => {
  it('enforces minimal MV3 manifest permissions without management, tabs, or <all_urls>', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src', 'web-extension', 'manifest.json'), 'utf8')
    ) as { permissions: string[]; host_permissions: string[] }

    expect(manifest.permissions).toContain('nativeMessaging')
    expect(manifest.permissions).toContain('storage')
    expect(manifest.permissions).toContain('alarms')
    expect(manifest.permissions).toContain('scripting')
    expect(manifest.permissions).not.toContain('management')
    expect(manifest.permissions).not.toContain('tabs')
    expect(manifest.host_permissions).toEqual([
      'https://chatgpt.com/*', 'https://claude.ai/*', 'https://gemini.google.com/*',
      'https://chat.deepseek.com/*', 'https://chat.qwen.ai/*'
    ])
  })

  it('schedules 1-minute alarm only for managed development installs, backs off on APP_UNAVAILABLE, and clears on revoke', async () => {
    let nowMs = 1_700_000_000_000
    const mockNonDev = createMockChromeApi({ installType: 'normal' })
    const sendNonDev = vi.fn(async () => ({ ok: true }))
    const coordNonDev = new ExtensionMaintenanceCoordinator({
      chromeApi: mockNonDev.chromeApi,
      sendNative: sendNonDev,
      now: () => nowMs
    })
    await coordNonDev.runTick('boot')
    expect(sendNonDev).not.toHaveBeenCalled()
    expect(mockNonDev.clearedAlarms).toContain(MAINTENANCE_ALARM_NAME)

    const mock = createMockChromeApi({ installType: 'development' })
    let responseQueue: Array<unknown> = [
      { ok: true, result: { managed: true, pendingOperation: null } },
      { ok: false, error: { code: 'APP_UNAVAILABLE' } },
      { ok: true, result: { managed: true, pendingOperation: null } },
      { ok: true, result: { managed: false, revoked: true, pendingOperation: null } }
    ]
    const sendNative = vi.fn(async () => responseQueue.shift() ?? { ok: true, result: { managed: true } })
    const coord = new ExtensionMaintenanceCoordinator({
      chromeApi: mock.chromeApi,
      sendNative,
      now: () => nowMs
    })
    coord.registerAlarmAndLifecycleListeners()

    // 1. Managed check -> creates 1-min alarm
    await coord.runTick('boot')
    expect(mock.createdAlarms.get(MAINTENANCE_ALARM_NAME)?.periodInMinutes).toBe(MAINTENANCE_ALARM_PERIOD_MINUTES)
    expect(sendNative).toHaveBeenCalledTimes(1)

    // 2. APP_UNAVAILABLE -> 1m backoff
    nowMs += 60_000
    await coord.runTick('alarm')
    expect(sendNative).toHaveBeenCalledTimes(2)

    // 30s later (< 1m backoff) -> skipped without waking Desktop
    nowMs += 30_000
    await coord.runTick('alarm')
    expect(sendNative).toHaveBeenCalledTimes(2)

    // After backoff expires -> check succeeds and resets backoff
    nowMs += 30_000
    await coord.runTick('alarm')
    expect(sendNative).toHaveBeenCalledTimes(3)

    // Revoked response -> clears alarm immediately
    nowMs += 60_000
    await coord.runTick('alarm')
    expect(sendNative).toHaveBeenCalledTimes(4)
    expect(mock.createdAlarms.has(MAINTENANCE_ALARM_NAME)).toBe(false)
    expect(mock.clearedAlarms).toContain(MAINTENANCE_ALARM_NAME)
  })

  it('defers reload on quiescence busy, persists reload marker when idle, attests and re-injects tabs post-reload', async () => {
    const nowMs = 1_700_000_000_000
    let tabReady = false
    const tabMessages: Array<{ tabId: number; msg: unknown }> = []
    const injectedTabs: number[] = []
    const extId = 'd'.repeat(32)

    const mock = createMockChromeApi({
      extensionId: extId,
      installType: 'development',
      initialStorage: {
        'ca.webActivation.installationId': 'inst-e2e',
        'ca.webActivation.profileId': 'prof-e2e'
      },
      tabs: [{ id: 101, url: 'https://chat.deepseek.com/a/chat' }],
      tabHandlers: {
        101: (msg) => {
          tabMessages.push({ tabId: 101, msg })
          const type = (msg as { type?: string }).type
          if (type === 'CONTENT_PREPARE_MAINTENANCE') {
            return tabReady ? { ok: true, ready: true } : { ok: true, ready: false, reason: 'ASSISTANT_STREAMING' }
          }
          if (type === 'CONTENT_GET_STATE') {
            return { ok: true, buildId: 'dev-unbuilt' }
          }
          return { ok: true }
        }
      },
      executeScriptSpy: (inj) => injectedTabs.push(inj.target.tabId)
    })

    const sentNativePayloads: Array<Record<string, unknown>> = []
    const sendNative = vi.fn(async (payload: Record<string, unknown>) => {
      sentNativePayloads.push(payload)
      if (payload.action === 'maintenance_check') {
        return {
          ok: true,
          result: {
            managed: true,
            pendingOperation: {
              operationId: 'op-reload-1',
              installationId: 'inst-e2e',
              targetBuildId: 'dev-unbuilt',
              epoch: 1,
              nonce: 'nonce-1',
              expiresAt: new Date(nowMs + 60_000).toISOString()
            }
          }
        }
      }
      if (payload.action === 'maintenance_claim') {
        return {
          ok: true,
          result: payload.readyToReload
            ? {
                decision: 'RELOAD_NOW',
                authorization: {
                  operationId: 'op-reload-1',
                  installationId: 'inst-e2e',
                  targetBuildId: 'dev-unbuilt',
                  epoch: 1,
                  nonce: 'nonce-1',
                  expiresAt: new Date(nowMs + 60_000).toISOString()
                }
              }
            : { decision: 'DEFER', retryAfterMs: 1000 }
        }
      }
      return { ok: true, result: { accepted: true, verified: true } }
    })

    const coordA = new ExtensionMaintenanceCoordinator({
      chromeApi: mock.chromeApi,
      sendNative,
      closeNativePort: mock.closePort,
      now: () => nowMs,
      generateUuid: () => 'boot-generation-A'
    })

    // Busy tab -> claim sends readyToReload: false, does NOT call reload()
    await coordA.runTick('manual')
    expect(mock.reload).not.toHaveBeenCalled()
    expect(sentNativePayloads.some((p) => p.action === 'maintenance_claim' && p.readyToReload === false)).toBe(true)

    // Idle tab -> claim sends readyToReload: true, stores pendingReload, closes port, calls runtime.reload()
    tabReady = true
    await coordA.runTick('manual')
    expect(mock.closePort).toHaveBeenCalledWith('EXTENSION_RELOAD')
    expect(mock.reload).toHaveBeenCalledTimes(1)
    expect(mock.storageData['ca.webActivation.pendingReload']).toBeTruthy()

    // Simulated new SW boot after runtime.reload() with brand new bootId
    sentNativePayloads.length = 0
    const sendNativeAfterBoot = vi.fn(async (payload: Record<string, unknown>) => {
      sentNativePayloads.push(payload)
      if (payload.action === 'maintenance_check') {
        return { ok: true, result: { managed: true, pendingOperation: null } }
      }
      return { ok: true, result: { accepted: true, verified: true } }
    })

    const coordB = new ExtensionMaintenanceCoordinator({
      chromeApi: mock.chromeApi,
      sendNative: sendNativeAfterBoot,
      closeNativePort: mock.closePort,
      now: () => nowMs + 2000,
      generateUuid: () => 'boot-generation-B'
    })

    await coordB.runTick('boot')

    const bootAttest = sentNativePayloads.find(
      (p) => p.action === 'maintenance_report' && p.phase === 'BOOT_ATTESTATION'
    )
    expect(bootAttest).toBeTruthy()
    expect((bootAttest!.report as { bootId: string }).bootId).toBe('boot-generation-B')
    expect(injectedTabs).toEqual([101])

    const reinjectReport = sentNativePayloads.find(
      (p) => p.action === 'maintenance_report' && p.phase === 'REINJECT_RESULT'
    )
    expect(reinjectReport).toBeTruthy()
    expect((reinjectReport!.report as { tabStates: Array<{ status: string }> }).tabStates).toEqual([
      expect.objectContaining({ tabId: 101, status: 'REINJECTED' })
    ])
    expect(mock.storageData['ca.webActivation.pendingReload']).toBeUndefined()
  })

  it('re-injects content-script idempotently without duplicate UI or losing composer draft text', () => {
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <textarea id="chat-input" placeholder="Message DeepSeek">Unsent user draft text</textarea>
        <button data-testid="send-button">Send</button>
      </body></html>`,
      { url: 'https://chat.deepseek.com/a/chat/s/test-conv' }
    )
    const { chromeApi } = createMockChromeApi()
    const ctrl1 = bootstrapContentScript(chromeApi, dom.window.document, dom.window.location.href)
    expect(ctrl1).not.toBeNull()
    expect(dom.window.document.querySelectorAll('#code-awareness-activation-pill').length).toBe(1)

    const textarea = dom.window.document.getElementById('chat-input') as HTMLTextAreaElement
    textarea.value = 'User kept typing carefully'

    // Simulate idempotent re-injection into the same page
    const ctrl2 = bootstrapContentScript(chromeApi, dom.window.document, dom.window.location.href)
    expect(ctrl2).not.toBeNull()
    expect(dom.window.document.querySelectorAll('#code-awareness-activation-pill').length).toBe(1)
    expect((dom.window.document.getElementById('chat-input') as HTMLTextAreaElement).value).toBe(
      'User kept typing carefully'
    )
    ctrl2!.dispose()
  })

  it('blocks MAINTENANCE_* commands sent via runtime.onMessage', async () => {
    const router = new ExtensionBackgroundRouter(vi.fn(async () => ({ ok: true })), 'a'.repeat(32))
    const blocked = await router.handleMessage(
      { type: 'MAINTENANCE_CLAIM' },
      { url: 'https://chat.deepseek.com/a/chat' }
    )
    expect(blocked).toEqual({
      ok: false,
      error: {
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'Maintenance actions cannot be triggered via runtime messages'
      }
    })
  })
})
