import { BrowserWindow, ipcMain } from 'electron'
import { exportContextBundle } from '../continuum/bundle-export'
import type { ContinuumBundleQuick, ContinuumBundlePrepare, ContinuumBundleExport } from '../../shared/types/continuum-bundle-types'
import { ContextBundle } from '../continuum/context-bundle'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'

export function registerContinuumBundleHandlers(session: RepositoryContinuumSession): void {
  const snapshots = new Map<number, { service: NonNullable<ReturnType<RepositoryContinuumSession['getActiveService']>>; bundle: ContextBundle }>()
  const busy = new Set<number>(), observed = new WeakSet<object>()
  const prepare = (request: ContinuumBundlePrepare) => {
    if (!request || typeof request !== 'object' || typeof request.repositoryId !== 'string' || session.getActiveSession()?.repositoryId !== request.repositoryId) throw new Error('REPOSITORY_UNAVAILABLE')
    const service = session.getActiveService()
    if (!service) throw new Error('REPOSITORY_UNAVAILABLE')
    const bundle = ContextBundle.prepare(service, request)
    if (session.getActiveService() !== service) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    return { service, bundle }
  }
  const exporter = async (sender: Electron.WebContents, request: ContinuumBundleExport, snapshot: ReturnType<typeof prepare>) => {
    const { service, bundle } = snapshot
    const assertContext = () => {
      if (session.getActiveSession()?.repositoryId !== request.repositoryId || session.getActiveService() !== service || sender.isDestroyed()) throw new Error('REPOSITORY_CONTEXT_CHANGED')
      bundle.assertFresh()
    }
    return exportContextBundle(bundle, request.intent, assertContext, BrowserWindow.fromWebContents(sender))
  }
  ipcMain.handle('continuum:prepare-bundle', (event, request: ContinuumBundlePrepare) => {
    if (busy.has(event.sender.id)) throw new Error('BUNDLE_BUSY')
    snapshots.delete(event.sender.id)
    const snapshot = prepare(request)
    if (!observed.has(event.sender)) { observed.add(event.sender); event.sender.once('destroyed', () => snapshots.delete(event.sender.id)) }
    snapshots.set(event.sender.id, snapshot)
    return snapshot.bundle.preview
  })
  ipcMain.handle('continuum:export-bundle', async (event, request: ContinuumBundleExport) => {
    if (!request || typeof request !== 'object' || !['copy', 'markdown', 'zip'].includes(request.intent)) throw new Error('INVALID_BUNDLE_EXPORT')
    if (busy.has(event.sender.id)) throw new Error('BUNDLE_BUSY')
    const snapshot = snapshots.get(event.sender.id)
    if (!snapshot || snapshot.bundle.preview.snapshotId !== request.snapshotId || snapshot.bundle.preview.repositoryId !== request.repositoryId) throw new Error('BUNDLE_SNAPSHOT_UNAVAILABLE: regenere o pacote')
    busy.add(event.sender.id)
    try { return await exporter(event.sender, request, snapshot) } finally { busy.delete(event.sender.id) }
  })
  ipcMain.handle('continuum:quick-bundle', async (event, request: ContinuumBundleQuick) => {
    if (!request || !['copy', 'markdown', 'zip'].includes(request.intent)) throw new Error('INVALID_BUNDLE_EXPORT')
    if (busy.has(event.sender.id)) throw new Error('BUNDLE_BUSY')
    busy.add(event.sender.id)
    try {
      const snapshot = prepare(request)
      const result = await exporter(event.sender, { ...request, snapshotId: snapshot.bundle.preview.snapshotId }, snapshot)
      const { markdownBytes, tokenCount, tokenizerEncoding, hasVisuals, members, slug } = snapshot.bundle.preview
      return { ...result, repositoryId: request.repositoryId, slug, count: members.length, markdownBytes, tokenCount, tokenizerEncoding, hasVisuals }
    } finally { busy.delete(event.sender.id) }
  })
}
