import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import { dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import type { ContinuumBundlePrepare, ContinuumBundleExport } from '../../shared/types/continuum-bundle-types'
import { ContextBundle } from '../continuum/context-bundle'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'

export function registerContinuumBundleHandlers(session: RepositoryContinuumSession): void {
  const snapshots = new Map<number, { service: NonNullable<ReturnType<RepositoryContinuumSession['getActiveService']>>; bundle: ContextBundle }>()
  const busy = new Set<number>()
  const observed = new WeakSet<object>()
  ipcMain.handle('continuum:prepare-bundle', (event, request: ContinuumBundlePrepare) => {
    if (!request || typeof request !== 'object' || typeof request.repositoryId !== 'string' || session.getActiveSession()?.repositoryId !== request.repositoryId) throw new Error('REPOSITORY_UNAVAILABLE')
    if (busy.has(event.sender.id)) throw new Error('BUNDLE_BUSY')
    const service = session.getActiveService()
    if (!service) throw new Error('REPOSITORY_UNAVAILABLE')
    snapshots.delete(event.sender.id)
    const bundle = ContextBundle.prepare(service, request)
    if (session.getActiveService() !== service) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    if (!observed.has(event.sender)) { observed.add(event.sender); event.sender.once('destroyed', () => snapshots.delete(event.sender.id)) }
    snapshots.set(event.sender.id, { service, bundle })
    return bundle.preview
  })
  ipcMain.handle('continuum:export-bundle', async (event, request: ContinuumBundleExport) => {
    if (!request || typeof request !== 'object' || !['copy', 'markdown', 'zip'].includes(request.intent)) throw new Error('INVALID_BUNDLE_EXPORT')
    if (busy.has(event.sender.id)) throw new Error('BUNDLE_BUSY')
    const snapshot = snapshots.get(event.sender.id)
    if (!snapshot || snapshot.bundle.preview.snapshotId !== request.snapshotId || snapshot.bundle.preview.repositoryId !== request.repositoryId) throw new Error('BUNDLE_SNAPSHOT_UNAVAILABLE: regenere o pacote')
    const { bundle, service } = snapshot
    const assertContext = () => {
      if (session.getActiveSession()?.repositoryId !== request.repositoryId || session.getActiveService() !== service || event.sender.isDestroyed()) throw new Error('REPOSITORY_CONTEXT_CHANGED')
      bundle.assertFresh()
    }
    busy.add(event.sender.id)
    try {
      assertContext()
      if (!bundle.preview.members.length) throw new Error('BUNDLE_EMPTY')
      if (request.intent === 'copy') {
        clipboard.writeText(bundle.preview.markdown)
        return { outcome: 'copied' as const, snapshotId: request.snapshotId }
      }
      const extension = request.intent === 'zip' ? 'zip' : 'md'
      const options: Electron.SaveDialogOptions = { title: 'Salvar Context Bundle', defaultPath: join(app.getPath('downloads'), `${bundle.preview.slug}-context.${extension}`), filters: [{ name: extension === 'zip' ? 'Pacote completo ZIP' : 'Markdown', extensions: [extension] }], properties: ['showOverwriteConfirmation', 'createDirectory', 'dontAddToRecent'] }
      const parent = BrowserWindow.fromWebContents(event.sender)
      const result = await (parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options))
      if (result.canceled) return { outcome: 'cancelled' as const, snapshotId: request.snapshotId }
      assertContext()
      if (!result.filePath || extname(result.filePath).toLowerCase() !== '.' + extension) throw new Error(`INVALID_EXPORT_EXTENSION: .${extension} obrigatório`)
      const data = request.intent === 'zip' ? await bundle.zip() : Buffer.from(bundle.preview.markdown, 'utf8')
      assertContext()
      const temporary = join(dirname(result.filePath), `.continuum-bundle-${randomUUID()}.tmp`)
      try {
        writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 })
        renameSync(temporary, result.filePath)
      } finally { rmSync(temporary, { force: true }) }
      return { outcome: 'saved' as const, snapshotId: request.snapshotId }
    } finally { busy.delete(event.sender.id) }
  })
}
