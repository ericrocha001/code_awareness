import { ipcMain } from 'electron'
import { exportQuickContextBundle } from '../continuum/bundle-export'
import type { ContinuumBundleQuick } from '../../shared/types/continuum-bundle-types'
import { ContextBundle } from '../continuum/context-bundle'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'

export function registerContinuumBundleHandlers(session: RepositoryContinuumSession): void {
  const busy = new Set<number>()

  ipcMain.handle('continuum:quick-bundle', async (event, request: ContinuumBundleQuick) => {
    if (!request || typeof request !== 'object' || !['copy', 'markdown', 'zip'].includes(request.intent)) {
      throw new Error('INVALID_BUNDLE_EXPORT')
    }
    const hasSlug = typeof (request as any).slug === 'string' && (request as any).slug.length > 0
    const hasSelected = Array.isArray((request as any).selected) && (request as any).selected.length > 0
    if ((hasSlug && hasSelected) || (!hasSlug && !hasSelected)) {
      throw new Error('INVALID_BUNDLE_REQUEST: especifique slug ou selected, mutuamente exclusivos')
    }
    if (typeof request.repositoryId !== 'string' || session.getActiveSession()?.repositoryId !== request.repositoryId) {
      throw new Error('REPOSITORY_UNAVAILABLE')
    }
    const service = session.getActiveService()
    if (!service) throw new Error('REPOSITORY_UNAVAILABLE')
    if (busy.has(event.sender.id)) throw new Error('BUNDLE_BUSY')
    busy.add(event.sender.id)
    try {
      const bundle = ContextBundle.prepare(
        service,
        hasSlug
          ? { repositoryId: request.repositoryId, slug: (request as any).slug }
          : { repositoryId: request.repositoryId, source: { kind: 'selection', selected: (request as any).selected } }
      )
      if (session.getActiveService() !== service) throw new Error('REPOSITORY_CONTEXT_CHANGED')
      const assertContext = () => {
        if (session.getActiveSession()?.repositoryId !== request.repositoryId || session.getActiveService() !== service || event.sender.isDestroyed()) {
          throw new Error('REPOSITORY_CONTEXT_CHANGED')
        }
        bundle.assertFresh()
      }
      const result = await exportQuickContextBundle(bundle, request.intent, assertContext)
      const { markdownBytes, tokenCount, tokenizerEncoding, hasVisuals, members, slug } = bundle.preview
      return {
        ...result,
        repositoryId: request.repositoryId,
        slug,
        count: members.length,
        markdownBytes,
        tokenCount,
        tokenizerEncoding,
        hasVisuals
      }
    } finally {
      busy.delete(event.sender.id)
    }
  })
}
