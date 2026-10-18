import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { LocalMcpClientService } from '../local-mcp-clients/local-mcp-client-service'
import type { LocalMcpAction, LocalMcpClientId } from '../../shared/types/local-mcp-client-types'

export function registerLocalMcpClientHandlers(service: LocalMcpClientService, trustedUrl: string): void {
  const bind = (name: string, count: number, callback: (owner: number, ...args: unknown[]) => unknown) => {
    ipcMain.handle(`local-mcp:${name}`, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const url = event.senderFrame?.url
      if (args.length !== count || event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed() || !url || new URL(url).href.split('#')[0] !== new URL(trustedUrl).href.split('#')[0]) throw new Error('INVALID_LOCAL_SETUP_REQUEST')
      return callback(event.sender.id, ...args)
    })
  }
  const client = (value: unknown): LocalMcpClientId => {
    if (!['codex', 'antigravity', 'antigravity-settings', 'cline', 'cline-settings', 'cline-vscode'].includes(String(value))) throw new Error('UNKNOWN_CLIENT')
    return value as LocalMcpClientId
  }
  bind('detect', 0, () => service.detect())
  bind('verify', 1, (_owner, id) => service.verify(client(id)))
  bind('preview', 2, (owner, id, action) => {
    if (!['connect', 'repair', 'disconnect'].includes(String(action))) throw new Error('INVALID_ACTION')
    return service.preview(client(id), action as LocalMcpAction, owner)
  })
  bind('apply', 3, (owner, token, confirmed, replaceConflict) => {
    if (typeof token !== 'string' || typeof confirmed !== 'boolean' || typeof replaceConflict !== 'boolean') throw new Error('INVALID_LOCAL_SETUP_REQUEST')
    return service.apply(token, confirmed, replaceConflict, owner)
  })
}
