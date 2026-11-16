export interface ChromeMessageSender {
  id?: string
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

export interface ChromeRuntimeApi {
  readonly id?: string
  readonly lastError?: { message?: string }
  connectNative?(application: string): ChromeNativePortLike
  sendNativeMessage?(
    application: string,
    message: unknown,
    callback: (response: unknown) => void
  ): void
  sendMessage?(message: unknown, callback?: (response: unknown) => void): void
  onMessage?: {
    addListener(
      listener: (
        message: unknown,
        sender: ChromeMessageSender,
        sendResponse: (response?: unknown) => void
      ) => boolean | void
    ): void
  }
}

export interface ChromeTabsApi {
  query(
    queryInfo: { active?: boolean; currentWindow?: boolean },
    callback: (tabs: Array<{ id?: number; url?: string; title?: string }>) => void
  ): void
  sendMessage(tabId: number, message: unknown, callback?: (response: unknown) => void): void
}

export interface ChromeStorageArea {
  get(keys: string | string[] | null, callback: (items: Record<string, unknown>) => void): void
  set(items: Record<string, unknown>, callback?: () => void): void
}

export interface ChromeApi {
  runtime?: ChromeRuntimeApi
  tabs?: ChromeTabsApi
  storage?: {
    local?: ChromeStorageArea
  }
}

export function getChromeApi(): ChromeApi | undefined {
  return (globalThis as unknown as { chrome?: ChromeApi }).chrome
}
