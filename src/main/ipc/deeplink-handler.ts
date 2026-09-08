/*
-T ---
*/

import { ipcMain } from 'electron'
import { getPendingDeepLink, clearPendingDeepLink } from '../core/deeplink-manager'

export function registerDeepLinkHandlers(): void {
  ipcMain.handle('deeplink:get-pending', () => {
    const url = getPendingDeepLink()
    console.log('[DL][hdl-get]', JSON.stringify(url))
    clearPendingDeepLink()
    return url
  })
}