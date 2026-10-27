import { BrowserWindow, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { BuilderRequest } from '../../shared/types/continuum-builder-types'
import { consolidateBundle } from '../../shared/types/continuum-builder-types'
import { ContextBundle } from '../continuum/context-bundle'
import { exportContextBundle, exportHistoricalBundle } from '../continuum/bundle-export'
import { BundleResultHistory } from '../continuum/bundle-result-history'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'

export function registerContinuumBuilderHandlers(session: RepositoryContinuumSession) {
  const jobs = new Map<number, object>()
  const previews = new Map<number, { fingerprint: string; bundle: ContextBundle }>()
  const senders = new Set<number>()
  session.onChanged(() => { previews.clear() })
  ipcMain.handle('continuum:builder', async (event, request: BuilderRequest) => {
    const sender = event.sender.id
    if (!senders.has(sender)) {
      senders.add(sender)
      event.sender.once('destroyed', () => { senders.delete(sender); jobs.delete(sender); previews.delete(sender) })
    }
    const service = session.getActiveService()
    if (!request || !service || session.getActiveSession()?.repositoryId !== request.repositoryId) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    if (request.action === 'cancel') { jobs.delete(sender); previews.delete(sender); return { repositoryId: request.repositoryId, outcome: 'cancelled' } }
    if (jobs.has(sender)) throw new Error('BUNDLE_BUSY')
    const job = {}
    jobs.set(sender, job)
    const assertContext = () => {
      if (jobs.get(sender) !== job || event.sender.isDestroyed() || session.getActiveService() !== service) throw new Error('BUNDLE_CANCELLED_OR_CONTEXT_CHANGED')
      service.assertRepository(request.repositoryId)
    }
    try {
      assertContext()
      const history = <T>(operation: (store: BundleResultHistory) => T): T => {
        const store = new BundleResultHistory(join(session.getStorageBaseDir(), 'context-bundle-results'))
        try { return operation(store) } finally { store.close() }
      }
      if (request.action === 'recent') return history(store => store.list(request.repositoryId))
      if (request.action === 'reuse' || request.action === 'restore') {
        const { result, data } = history(store => store.get(request.repositoryId, request.id))
        assertContext()
        if (request.action === 'reuse') {
          const exported = await exportHistoricalBundle(result, data, assertContext, BrowserWindow.fromWebContents(event.sender))
          return { ...exported, repositoryId: request.repositoryId, historicalAt: result.generatedAt, retentionMessage: 'Resultado histórico reutilizado sem recomposição nem verificação de vigência.' }
        }
        if (!['members', 'recipe'].includes(request.mode)) throw new Error('INVALID_RESTORE_MODE')
        const composition = structuredClone(result.composition)
        if (request.mode === 'members') {
          const members = consolidateBundle(composition)
          const component = await service.resolveBuilderComponent(request.repositoryId, { kind: 'artifact', selected: members.map(member => ({ artifactId: member.artifactId, expectedRevision: member.revision! })) }, true)
          assertContext()
          return { repositoryId: request.repositoryId, components: [component], excluded: [], order: members.map(member => member.artifactId) }
        }
        const components = []
        for (const component of composition.components) {
          components.push(await service.resolveBuilderComponent(request.repositoryId, component.source, true))
          assertContext()
        }
        return { ...composition, components }
      }
      if (request.action === 'resolve') {
        const component = await service.resolveBuilderComponent(request.repositoryId, request.source, request.refresh === true)
        assertContext(); return component
      }
      if (request.action !== 'preview' && request.action !== 'export') throw new Error('INVALID_BUNDLE_ACTION')
      const composition = request.composition
      if (!composition || composition.repositoryId !== request.repositoryId || !Array.isArray(composition.components) || !Array.isArray(composition.excluded) || !Array.isArray(composition.order) || Buffer.byteLength(JSON.stringify(composition)) > 4 * 1024 * 1024) throw new Error('INVALID_BUNDLE_COMPOSITION')
      const members = consolidateBundle(composition)
      const profile = request.profile ?? 'off'
      if (!['off', 'light', 'balanced', 'strong'].includes(profile)) throw new Error('INVALID_COMPRESSION_PROFILE')
      const fingerprint = createHash('sha256').update(JSON.stringify([composition, profile, request.intent ?? 'copy'])).digest('hex')
      const cached = previews.get(sender)
      const bundle = cached?.fingerprint === fingerprint ? cached.bundle : ContextBundle.prepareBuilder(service, request.repositoryId, members.map(item => ({ artifactId: item.artifactId, expectedRevision: item.revision! })), composition.order.filter(id => members.some(member => member.artifactId === id)))
      bundle.composition = structuredClone(composition)
      await new Promise<void>(resolve => setImmediate(resolve)); assertContext()
      if (!bundle.compression) bundle.compressOutput(profile)
      await new Promise<void>(resolve => setImmediate(resolve)); assertContext()
      bundle.assertFresh(); assertContext()
      previews.set(sender, { fingerprint, bundle })
      if (request.action === 'preview') {
        const counts = await service.selectionTokens(members.map(item => ({ artifactId: item.artifactId, expectedRevision: item.revision! })), true)
        assertContext(); bundle.assertFresh()
        return { repositoryId: request.repositoryId, fingerprint, count: members.length, documentTokens: counts.reduce((sum, item) => sum + item.rawMarkdownTokenCount, 0), tokenCount: bundle.preview.tokenCount, tokenizerEncoding: bundle.preview.tokenizerEncoding, markdownBytes: bundle.preview.markdownBytes, hasVisuals: bundle.preview.hasVisuals, markdown: bundle.preview.markdown, compression: bundle.compression }
      }
      if (!['copy', 'markdown', 'zip'].includes(request.intent)) throw new Error('INVALID_BUNDLE_EXPORT')
      if (request.name !== undefined && (typeof request.name !== 'string' || request.name.length > 120)) throw new Error('INVALID_BUNDLE_NAME')
      let output: Buffer | undefined
      const result = await exportContextBundle(bundle, request.intent, () => { assertContext(); bundle.assertFresh() }, BrowserWindow.fromWebContents(event.sender), data => { output = data })
      if (!output || result.outcome === 'cancelled') return { repositoryId: request.repositoryId, outcome: result.outcome }
      let retention: { retained: boolean; retentionMessage: string }
      try {
        retention = history(store => store.retain({ repositoryId: request.repositoryId, generatedAt: bundle.preview.generatedAt, name: request.name?.trim() || undefined, format: request.intent, count: members.length, tokenCount: bundle.preview.tokenCount, tokenizerEncoding: bundle.preview.tokenizerEncoding, hasVisuals: bundle.preview.hasVisuals, composition: structuredClone(composition), compression: bundle.compression }, output!))
      } catch (error) { retention = { retained: false, retentionMessage: `Exportação concluída; histórico não retido: ${String(error)}` } }
      return { repositoryId: request.repositoryId, outcome: result.outcome, compression: bundle.compression, ...retention }
    } finally { if (jobs.get(sender) === job) jobs.delete(sender) }
  })
}
