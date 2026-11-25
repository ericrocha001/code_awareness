export interface ChromeMessageSender {
  id?: string
  frameId?: number
  documentId?: string
  url?: string
  origin?: string
  tab?: { id?: number; url?: string }
}

export interface ChromeNativePortLike {
  readonly name?: string
  postMessage(message: unknown): void
  disconnect(): void
  onMessage: {
    addListener(listener: (message: unknown) => void): void
    removeListener?(listener: (message: unknown) => void): void
  }
  onDisconnect: {
    addListener(listener: () => void): void
    removeListener?(listener: () => void): void
  }
}

export type ChromeMessageListener = (
  message: unknown,
  sender: ChromeMessageSender,
  sendResponse: (response?: unknown) => void
) => boolean | void

export interface ChromeRuntimeApi {
  readonly id?: string
  readonly lastError?: { message?: string }
  getURL?(path: string): string
  getContexts?(filter: {
    contextTypes: ['POPUP']
    documentIds?: string[]
    documentUrls: string[]
  }): Promise<Array<{ contextType: string; documentId?: string; documentUrl?: string; frameId: number; tabId: number }>>
  getManifest?: () => { version?: string; [key: string]: unknown }
  reload?: () => void
  connectNative?(application: string): ChromeNativePortLike
  sendNativeMessage?(
    application: string,
    message: unknown,
    callback: (response: unknown) => void
  ): void
  sendMessage?(message: unknown, callback?: (response: unknown) => void): void
  onInstalled?: {
    addListener(listener: (details: { reason?: string; previousVersion?: string }) => void): void
  }
  onStartup?: {
    addListener(listener: () => void): void
  }
  onMessage?: {
    addListener(listener: ChromeMessageListener): void
    removeListener?(listener: ChromeMessageListener): void
  }
}

export interface ChromeTabInfo {
  id?: number
  url?: string
  title?: string
}

export interface ChromeTabsQueryInfo {
  active?: boolean
  currentWindow?: boolean
  url?: string | string[]
}

export interface ChromeTabsApi {
  query(
    queryInfo: ChromeTabsQueryInfo,
    callback: (tabs: ChromeTabInfo[]) => void
  ): void
  sendMessage(tabId: number, message: unknown, callback?: (response: unknown) => void): void
  sendMessage(tabId: number, message: unknown, options: { documentId: string }, callback: (response: unknown) => void): void
}

export interface ChromeStorageArea {
  get(keys: string | string[] | null, callback: (items: Record<string, unknown>) => void): void
  set(items: Record<string, unknown>, callback?: () => void): void
  remove?(keys: string | string[], callback?: () => void): void
}

export interface ChromeAlarmInfo {
  name: string
  scheduledTime?: number
  periodInMinutes?: number
}

export interface ChromeAlarmsApi {
  create(name: string, alarmInfo: { delayInMinutes?: number; periodInMinutes?: number }): void
  clear(name: string, callback?: (wasCleared: boolean) => void): void
  get?(name: string, callback: (alarm?: ChromeAlarmInfo) => void): void
  onAlarm: {
    addListener(listener: (alarm: ChromeAlarmInfo) => void): void
  }
}

export interface ChromeManagementExtensionInfo {
  id: string
  installType?: string
  version?: string
  enabled?: boolean
}

export interface ChromeManagementApi {
  getSelf(callback?: (info: ChromeManagementExtensionInfo) => void): Promise<ChromeManagementExtensionInfo> | void
}

export interface ChromeScriptingApi {
  executeScript(injection: {
    target: { tabId: number; allFrames?: boolean }
    files?: string[]
  }): Promise<Array<{ frameId?: number; result?: unknown }>>
}

export type ChromeStorageChangeListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void

export interface ChromeApi {
  runtime?: ChromeRuntimeApi
  tabs?: ChromeTabsApi
  storage?: {
    local?: ChromeStorageArea
    onChanged?: {
      addListener(listener: ChromeStorageChangeListener): void
      removeListener(listener: ChromeStorageChangeListener): void
    }
  }
  alarms?: ChromeAlarmsApi
  management?: ChromeManagementApi
  scripting?: ChromeScriptingApi
}

export function getChromeApi(): ChromeApi | undefined {
  return (globalThis as unknown as { chrome?: ChromeApi }).chrome
}
