import { getChromeApi, type ChromeAlarmInfo, type ChromeApi } from './chrome-api'
import { getBuiltWebExtensionBuildId, getConfiguredNativeHostApplication } from './runtime-config'

export const MAINTENANCE_ALARM_NAME = 'code_awareness.extension_maintenance'
export const MAINTENANCE_ALARM_PERIOD_MINUTES = 1
const MAX_BACKOFF_MINUTES = 15
const AUTHORIZED_TAB_URL_PATTERNS = ['https://chat.deepseek.com/*', 'https://chat.qwen.ai/*']

const STORAGE_KEYS = {
  installationId: 'ca.webActivation.installationId',
  profileId: 'ca.webActivation.profileId',
  pendingReload: 'ca.webActivation.pendingReload'
} as const

export interface PendingReloadRecord {
  operationId: string
  installationId: string
  targetBuildId: string
  previousBootId: string
  previousBuildId: string
  epoch: number
  nonce: string
  expiresAt: string
  startedAt: string
}

export interface MaintenanceIdentitySnapshot {
  installationId: string
  profileId: string
  extensionId: string
  bootId: string
  buildId: string
  manifestVersion: string
  installType: string
  nativeHostApplication: string
}

export interface ExtensionMaintenanceDeps {
  chromeApi: ChromeApi
  sendNative: (payload: Record<string, unknown>) => Promise<unknown>
  closeNativePort?: (reason?: string) => void
  getActiveRequestCount?: () => number
  now?: () => number
  generateUuid?: () => string
}

function defaultUuid(): string {
  const cryptoObj = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID()
  }
  return `ca-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function storageGet(chromeApi: ChromeApi, keys: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const local = chromeApi.storage?.local
    if (!local) {
      resolve({})
      return
    }
    local.get(keys, (items) => {
      resolve(items ?? {})
    })
  })
}

function storageSet(chromeApi: ChromeApi, items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    const local = chromeApi.storage?.local
    if (!local) {
      resolve()
      return
    }
    local.set(items, () => resolve())
  })
}

function storageRemove(chromeApi: ChromeApi, keys: string | string[]): Promise<void> {
  return new Promise((resolve) => {
    const local = chromeApi.storage?.local
    if (!local) {
      resolve()
      return
    }
    if (typeof local.remove === 'function') {
      local.remove(keys, () => resolve())
      return
    }
    const entries: Record<string, unknown> = {}
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      entries[k] = null
    }
    local.set(entries, () => resolve())
  })
}

function queryAuthorizedTabs(chromeApi: ChromeApi): Promise<Array<{ id?: number; url?: string }>> {
  return new Promise((resolve) => {
    const tabs = chromeApi.tabs
    if (!tabs) {
      resolve([])
      return
    }
    try {
      tabs.query({ url: AUTHORIZED_TAB_URL_PATTERNS }, (found) => {
        if (chromeApi.runtime?.lastError) {
          resolve([])
          return
        }
        resolve(Array.isArray(found) ? found : [])
      })
    } catch {
      resolve([])
    }
  })
}

function sendTabMessageSafe<T>(
  chromeApi: ChromeApi,
  tabId: number,
  message: unknown
): Promise<T | null> {
  return new Promise((resolve) => {
    const tabs = chromeApi.tabs
    if (!tabs) {
      resolve(null)
      return
    }
    try {
      tabs.sendMessage(tabId, message, (res) => {
        if (chromeApi.runtime?.lastError) {
          resolve(null)
          return
        }
        resolve((res as T) ?? null)
      })
    } catch {
      resolve(null)
    }
  })
}

async function getSelfInstallType(chromeApi: ChromeApi): Promise<string> {
  const mgmt = chromeApi.management
  if (!mgmt || typeof mgmt.getSelf !== 'function') {
    return 'unknown'
  }
  return await new Promise<string>((resolve) => {
    let settled = false
    const finish = (info?: { installType?: string }) => {
      if (settled) return
      settled = true
      resolve(typeof info?.installType === 'string' ? info.installType : 'unknown')
    }
    try {
      const maybePromise = mgmt.getSelf((info) => finish(info))
      if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
        void (maybePromise as Promise<{ installType?: string }>).then(finish, () => finish())
      }
    } catch {
      finish()
    }
  })
}

function urlPrefixForTab(urlValue: string | undefined): string {
  if (!urlValue) return 'unknown'
  try {
    return new URL(urlValue).origin.toLowerCase()
  } catch {
    return 'unknown'
  }
}

/**
 * Coordinates low-cost MV3 maintenance polling, quiescence verification, reload execution,
 * post-reload runtime attestation, and idempotent content-script re-injection.
 */
export class ExtensionMaintenanceCoordinator {
  readonly bootId: string
  readonly buildId: string
  readonly nativeHostApplication: string
  private readonly now: () => number
  private readonly generateUuid: () => string
  private seq = 0
  private consecutiveUnavailable = 0
  private nextAllowedCheckAt = 0
  private tickInFlight: Promise<void> | null = null
  private cachedIdentity: MaintenanceIdentitySnapshot | null = null

  constructor(private readonly deps: ExtensionMaintenanceDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.generateUuid = deps.generateUuid ?? defaultUuid
    this.bootId = this.generateUuid()
    this.buildId = getBuiltWebExtensionBuildId()
    this.nativeHostApplication = getConfiguredNativeHostApplication()
  }

  private nextId(): string {
    this.seq += 1
    return `maint-${this.bootId.slice(0, 8)}-${this.seq}`
  }

  async ensureIdentity(): Promise<MaintenanceIdentitySnapshot> {
    if (this.cachedIdentity) {
      return this.cachedIdentity
    }
    const items = await storageGet(this.deps.chromeApi, [STORAGE_KEYS.installationId, STORAGE_KEYS.profileId])
    let installationId =
      typeof items[STORAGE_KEYS.installationId] === 'string' && items[STORAGE_KEYS.installationId]
        ? String(items[STORAGE_KEYS.installationId])
        : ''
    let profileId =
      typeof items[STORAGE_KEYS.profileId] === 'string' && items[STORAGE_KEYS.profileId]
        ? String(items[STORAGE_KEYS.profileId])
        : ''

    const updates: Record<string, unknown> = {}
    if (!installationId) {
      installationId = this.generateUuid()
      updates[STORAGE_KEYS.installationId] = installationId
    }
    if (!profileId) {
      profileId = this.generateUuid()
      updates[STORAGE_KEYS.profileId] = profileId
    }
    if (Object.keys(updates).length > 0) {
      await storageSet(this.deps.chromeApi, updates)
    }

    const installType = await getSelfInstallType(this.deps.chromeApi)
    const manifestVersion = this.deps.chromeApi.runtime?.getManifest?.()?.version ?? '0.0.0'
    const extensionId = this.deps.chromeApi.runtime?.id ?? ''

    this.cachedIdentity = {
      installationId,
      profileId,
      extensionId,
      bootId: this.bootId,
      buildId: this.buildId,
      manifestVersion: String(manifestVersion),
      installType,
      nativeHostApplication: this.nativeHostApplication
    }
    return this.cachedIdentity
  }

  private ensureAlarm(): Promise<void> {
    const alarms = this.deps.chromeApi.alarms
    if (!alarms) return Promise.resolve()
    return new Promise((resolve) => {
      if (typeof alarms.get === 'function') {
        alarms.get(MAINTENANCE_ALARM_NAME, (existing) => {
          if (!existing) {
            alarms.create(MAINTENANCE_ALARM_NAME, {
              delayInMinutes: MAINTENANCE_ALARM_PERIOD_MINUTES,
              periodInMinutes: MAINTENANCE_ALARM_PERIOD_MINUTES
            })
          }
          resolve()
        })
        return
      }
      alarms.create(MAINTENANCE_ALARM_NAME, {
        delayInMinutes: MAINTENANCE_ALARM_PERIOD_MINUTES,
        periodInMinutes: MAINTENANCE_ALARM_PERIOD_MINUTES
      })
      resolve()
    })
  }

  private clearAlarm(): void {
    const alarms = this.deps.chromeApi.alarms
    if (!alarms) return
    alarms.clear(MAINTENANCE_ALARM_NAME)
  }

  resetBackoff(): void {
    this.consecutiveUnavailable = 0
    this.nextAllowedCheckAt = 0
  }

  async runTick(trigger: 'boot' | 'alarm' | 'manual' = 'alarm'): Promise<void> {
    if (this.tickInFlight) {
      if (trigger !== 'manual') {
        return this.tickInFlight
      }
      await this.tickInFlight.catch(() => undefined)
    }
    const run = this.executeTick(trigger).finally(() => {
      if (this.tickInFlight === run) {
        this.tickInFlight = null
      }
    })
    this.tickInFlight = run
    return run
  }

  private async executeTick(trigger: 'boot' | 'alarm' | 'manual'): Promise<void> {
    const identity = await this.ensureIdentity()
    if (identity.installType !== 'development' || !identity.extensionId) {
      this.clearAlarm()
      return
    }

    await this.processPendingReloadOnBoot(identity)

    if (trigger === 'alarm' && this.now() < this.nextAllowedCheckAt) {
      return
    }

    const response = (await this.deps.sendNative({
      id: this.nextId(),
      action: 'maintenance_check',
      installationId: identity.installationId,
      extensionId: identity.extensionId,
      profileId: identity.profileId,
      bootId: identity.bootId,
      buildId: identity.buildId,
      manifestVersion: identity.manifestVersion,
      installType: identity.installType
    })) as {
      ok?: boolean
      error?: { code?: string }
      result?: {
        managed?: boolean
        revoked?: boolean
        pendingOperation?: {
          operationId: string
          installationId: string
          targetBuildId: string
          epoch: number
          nonce: string
          expiresAt: string
        } | null
      }
    } | null

    if (!response?.ok) {
      if (response?.error?.code === 'APP_UNAVAILABLE') {
        this.consecutiveUnavailable += 1
        const delayMinutes = Math.min(MAX_BACKOFF_MINUTES, 2 ** Math.max(0, this.consecutiveUnavailable - 1))
        this.nextAllowedCheckAt = this.now() + delayMinutes * 60_000
      }
      return
    }

    this.resetBackoff()
    const result = response.result
    if (!result?.managed || result.revoked) {
      this.clearAlarm()
      return
    }

    await this.ensureAlarm()

    const pendingOp = result.pendingOperation
    if (!pendingOp) {
      return
    }

    await this.attemptClaimAndReload(identity, pendingOp)
  }

  private async processPendingReloadOnBoot(identity: MaintenanceIdentitySnapshot): Promise<void> {
    const stored = await storageGet(this.deps.chromeApi, [STORAGE_KEYS.pendingReload])
    const pending = stored[STORAGE_KEYS.pendingReload] as PendingReloadRecord | null | undefined
    if (!pending || typeof pending !== 'object' || typeof pending.operationId !== 'string') {
      return
    }

    const expMs = Date.parse(pending.expiresAt)
    if (!Number.isNaN(expMs) && this.now() > expMs) {
      await storageRemove(this.deps.chromeApi, STORAGE_KEYS.pendingReload)
      return
    }

    const baseReport = {
      installationId: identity.installationId,
      extensionId: identity.extensionId,
      profileId: identity.profileId,
      bootId: identity.bootId,
      buildId: identity.buildId,
      manifestVersion: identity.manifestVersion,
      installType: identity.installType,
      reloadedOperationId: pending.operationId,
      reloadedNonce: pending.nonce,
      reloadedEpoch: pending.epoch,
      reportedAt: new Date(this.now()).toISOString()
    }

    let bootAck: { ok?: boolean; error?: { code?: string } } | null = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      bootAck = (await this.deps.sendNative({
        id: this.nextId(),
        action: 'maintenance_report',
        phase: 'BOOT_ATTESTATION',
        report: baseReport
      })) as { ok?: boolean; error?: { code?: string } } | null
      if (bootAck?.ok || bootAck?.error?.code !== 'APP_UNAVAILABLE') {
        break
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
      }
    }

    if (!bootAck?.ok) {
      return
    }

    const tabStates = await this.reinjectAuthorizedTabs(identity.buildId)

    await this.deps.sendNative({
      id: this.nextId(),
      action: 'maintenance_report',
      phase: 'REINJECT_RESULT',
      report: {
        ...baseReport,
        tabStates,
        reportedAt: new Date(this.now()).toISOString()
      }
    })

    await storageRemove(this.deps.chromeApi, STORAGE_KEYS.pendingReload)
  }

  private async reinjectAuthorizedTabs(expectedBuildId: string): Promise<
    Array<{
      tabId?: number
      urlPrefix: string
      status: 'REINJECTED' | 'FAILED' | 'UNAVAILABLE'
      buildId?: string
      reason?: string
    }>
  > {
    const tabs = await queryAuthorizedTabs(this.deps.chromeApi)
    const scripting = this.deps.chromeApi.scripting
    const results: Array<{
      tabId?: number
      urlPrefix: string
      status: 'REINJECTED' | 'FAILED' | 'UNAVAILABLE'
      buildId?: string
      reason?: string
    }> = []

    for (const tab of tabs) {
      const urlPrefix = urlPrefixForTab(tab.url)
      if (typeof tab.id !== 'number') {
        results.push({ urlPrefix, status: 'UNAVAILABLE', reason: 'MISSING_TAB_ID' })
        continue
      }
      if (!scripting || typeof scripting.executeScript !== 'function') {
        results.push({ tabId: tab.id, urlPrefix, status: 'FAILED', reason: 'SCRIPTING_API_UNAVAILABLE' })
        continue
      }
      try {
        await scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content-script.js']
        })
        const status = await sendTabMessageSafe<{ ok?: boolean; buildId?: string }>(
          this.deps.chromeApi,
          tab.id,
          { type: 'CONTENT_GET_STATE' }
        )
        if (status?.ok && status.buildId === expectedBuildId) {
          results.push({
            tabId: tab.id,
            urlPrefix,
            status: 'REINJECTED',
            buildId: status.buildId
          })
        } else {
          results.push({
            tabId: tab.id,
            urlPrefix,
            status: 'FAILED',
            ...(status?.buildId ? { buildId: status.buildId } : {}),
            reason: status?.ok ? 'CONTENT_BUILD_MISMATCH' : 'CONTENT_STATUS_UNAVAILABLE'
          })
        }
      } catch (err) {
        results.push({
          tabId: tab.id,
          urlPrefix,
          status: 'FAILED',
          reason: err instanceof Error ? err.message : 'EXECUTE_SCRIPT_FAILED'
        })
      }
    }

    return results
  }

  private async attemptClaimAndReload(
    identity: MaintenanceIdentitySnapshot,
    pendingOp: {
      operationId: string
      installationId: string
      targetBuildId: string
      epoch: number
      nonce: string
      expiresAt: string
    }
  ): Promise<void> {
    if (pendingOp.installationId !== identity.installationId) {
      return
    }
    const expMs = Date.parse(pendingOp.expiresAt)
    if (!Number.isNaN(expMs) && this.now() > expMs) {
      return
    }

    const quiescence = await this.verifyQuiescenceAndDrain()
    const claim = (await this.deps.sendNative({
      id: this.nextId(),
      action: 'maintenance_claim',
      operationId: pendingOp.operationId,
      installationId: identity.installationId,
      extensionId: identity.extensionId,
      profileId: identity.profileId,
      bootId: identity.bootId,
      buildId: identity.buildId,
      targetBuildId: pendingOp.targetBuildId,
      nonce: pendingOp.nonce,
      epoch: pendingOp.epoch,
      readyToReload: quiescence.ready,
      ...(quiescence.reason ? { activeBusyReason: quiescence.reason } : {})
    })) as {
      ok?: boolean
      result?: {
        decision?: 'RELOAD_NOW' | 'DEFER' | 'REJECT'
        authorization?: {
          operationId: string
          installationId: string
          targetBuildId: string
          epoch: number
          nonce: string
          expiresAt: string
        }
      }
    } | null

    const decision = claim?.ok ? claim.result?.decision : 'REJECT'
    const auth = claim?.result?.authorization
    if (
      decision !== 'RELOAD_NOW' ||
      !auth ||
      auth.operationId !== pendingOp.operationId ||
      auth.installationId !== identity.installationId ||
      auth.targetBuildId !== pendingOp.targetBuildId ||
      auth.nonce !== pendingOp.nonce ||
      auth.epoch !== pendingOp.epoch
    ) {
      await this.abortTabsMaintenanceDrain(quiescence.preparedTabIds)
      return
    }

    const pendingReload: PendingReloadRecord = {
      operationId: auth.operationId,
      installationId: auth.installationId,
      targetBuildId: auth.targetBuildId,
      previousBootId: identity.bootId,
      previousBuildId: identity.buildId,
      epoch: auth.epoch,
      nonce: auth.nonce,
      expiresAt: auth.expiresAt,
      startedAt: new Date(this.now()).toISOString()
    }
    await storageSet(this.deps.chromeApi, { [STORAGE_KEYS.pendingReload]: pendingReload })

    this.deps.closeNativePort?.('EXTENSION_RELOAD')
    this.deps.chromeApi.runtime?.reload?.()
  }

  private async verifyQuiescenceAndDrain(): Promise<{
    ready: boolean
    reason?: string
    preparedTabIds: number[]
  }> {
    if ((this.deps.getActiveRequestCount?.() ?? 0) > 0) {
      return { ready: false, reason: 'ACTIVE_NATIVE_REQUEST', preparedTabIds: [] }
    }

    const tabs = await queryAuthorizedTabs(this.deps.chromeApi)
    const preparedTabIds: number[] = []

    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue
      const res = await sendTabMessageSafe<{ ok?: boolean; ready?: boolean; reason?: string }>(
        this.deps.chromeApi,
        tab.id,
        { type: 'CONTENT_PREPARE_MAINTENANCE' }
      )
      if (!res) continue
      if (res.ready === false) {
        await this.abortTabsMaintenanceDrain(preparedTabIds)
        return {
          ready: false,
          reason: res.reason ?? 'TAB_BUSY',
          preparedTabIds: []
        }
      }
      preparedTabIds.push(tab.id)
    }

    return { ready: true, preparedTabIds }
  }

  private async abortTabsMaintenanceDrain(tabIds: readonly number[]): Promise<void> {
    for (const tabId of tabIds) {
      await sendTabMessageSafe(this.deps.chromeApi, tabId, { type: 'CONTENT_ABORT_MAINTENANCE' })
    }
  }

  registerAlarmAndLifecycleListeners(): void {
    const { chromeApi } = this.deps
    chromeApi.alarms?.onAlarm.addListener((alarm: ChromeAlarmInfo) => {
      if (alarm?.name === MAINTENANCE_ALARM_NAME) {
        void this.runTick('alarm')
      }
    })
    chromeApi.runtime?.onInstalled?.addListener(() => {
      void this.runTick('boot')
    })
    chromeApi.runtime?.onStartup?.addListener(() => {
      void this.runTick('boot')
    })
  }
}

export function registerGlobalMaintenanceDebugHandle(coordinator: ExtensionMaintenanceCoordinator): void {
  ;(globalThis as unknown as Record<string, unknown>).__codeAwarenessMaintenance = {
    getIdentity: () => coordinator.ensureIdentity(),
    runTick: (trigger: 'boot' | 'alarm' | 'manual' = 'manual') => coordinator.runTick(trigger),
    getBootId: () => coordinator.bootId,
    getBuildId: () => coordinator.buildId
  }
}

export { getChromeApi }
