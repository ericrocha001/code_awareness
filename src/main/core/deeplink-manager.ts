/*
-T ---
*/

import { BrowserWindow } from 'electron'

let pendingDeepLink: string | null = null

export function setPendingDeepLink(url: string): void {
  console.log('[DL][mgr-set]', JSON.stringify(url))
  pendingDeepLink = url
}

export function getPendingDeepLink(): string | null {
  return pendingDeepLink
}

export function clearPendingDeepLink(): void {
  pendingDeepLink = null
}

export function emitDeepLinkToRenderer(mainWindow: BrowserWindow, url: string): void {
  console.log('[DL][mgr-emit]', JSON.stringify(url), 'windowAlive=', !!(mainWindow && !mainWindow.isDestroyed()))
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('deeplink:received', url)
  }
}