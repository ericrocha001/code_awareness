import { BrowserWindow, ipcMain } from 'electron'
import type { ConnectionLifecycle } from '../mcp/connection/connection-lifecycle'
import type { ConnectionResult } from '../../shared/types/connection-types'

export function registerConnectionHandlers(connection: Pick<ConnectionLifecycle, 'connect' | 'disconnect' | 'getState' | 'onChanged'>): void {
  for (const [channel, operation] of [
    ['connection:connect', () => connection.connect()],
    ['connection:disconnect', () => connection.disconnect()],
    ['connection:get-state', (): ConnectionResult => ({ success: true, state: connection.getState() })]
  ] as const) {
    ipcMain.handle(channel, (_event, ...args: unknown[]): ConnectionResult | Promise<ConnectionResult> => {
      if (args.length) return { success: false, error: 'INVALID_ARGUMENTS', state: connection.getState() }
      return operation()
    })
  }
  connection.onChanged((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      try { window.webContents.send('connection:changed', state) } catch {}
    }
  })
}
