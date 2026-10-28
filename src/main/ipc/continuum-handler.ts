import { registerContinuumBundleHandlers } from './continuum-bundle-handler'
import { registerContinuumBuilderHandlers } from './continuum-builder-handler'
import type { ContinuumTagMutation } from '../../shared/types/continuum-tag-types'
import { validatePeriods } from '../continuum/temporal-metadata'
import type { ContinuumGraphRequest } from '../../shared/types/continuum-graph-types'
import type { ContinuumSuggestionRequest } from '../../shared/types/continuum-suggestion-types'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage } from 'electron'
import { dirname, extname, join, posix, win32 } from 'node:path'
import { randomUUID } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'
import { dump } from 'js-yaml'
import type { ContinuumListRequest, ContinuumPublishRequest, ContinuumPublishReceipt, ContinuumVisualPublishRequest } from '../../shared/types/continuum-ui-types'
import type { ContinuumExportRequest, ContinuumExportReceipt } from '../../shared/types/continuum-ui-types'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'
import { parseArtifactMarkdown, validateMarkdown, visualMarkdown } from '../continuum/artifact-metadata'
import { VISUAL_MAX_BYTES, VISUAL_MAX_PIXELS } from '../continuum/visual-media'

function exportName(name: unknown, extension: string): string {
  let stem = String(name ?? 'Artifact').replace(/[<>:"/\\|?*\x00-\x1F\x7F]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 100).trim()
  if (!stem) stem = 'Artifact'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`
  return `${stem}${extension}`
}

function publicationMarkdown(fileName: unknown, rawMarkdown: string): string {
  if (typeof fileName !== 'string' || !/\.md$/i.test(fileName) ||
    posix.basename(fileName) !== fileName || win32.basename(fileName) !== fileName ||
    /[\x00-\x1F\x7F]/.test(fileName) || !fileName.slice(0, -3).trim()) {
    throw new Error('INVALID_ARGUMENT: nome simples de arquivo .md obrigatório, sem diretórios')
  }
  validateMarkdown(rawMarkdown)
  if (/^(?:\uFEFF)?---(?:\r?\n|$)/.test(rawMarkdown)) return rawMarkdown
  const bom = rawMarkdown.startsWith('\uFEFF') ? '\uFEFF' : ''
  const body = rawMarkdown.slice(bom.length)
  const yaml = dump({
    name: fileName.slice(0, -3),
    description: 'Documento Markdown publicado manualmente pela interface do Continuum. Abra para consultar seu conteúdo.',
    kind: 'DOCUMENT',
    date: new Date().toISOString()
  }, { lineWidth: -1, quotingType: '"', forceQuotes: true })
  return `${bom}---\n${yaml}---\n${body}`
}

function validateListRequest(request: ContinuumListRequest) {
  if (request.sortBy !== undefined && request.sortBy !== 'createdAt' && request.sortBy !== 'updatedAt') throw new Error('INVALID_ARGUMENT: invalid sortBy')
  if (request.includeTags !== undefined && typeof request.includeTags !== 'boolean') throw new Error('INVALID_ARGUMENT: includeTags must be boolean')
  if (request.query !== undefined && typeof request.query !== 'string') throw new Error('INVALID_ARGUMENT: query must be text')
  if (request.cursor !== undefined && typeof request.cursor !== 'string') throw new Error('INVALID_ARGUMENT: cursor must be text')
  if (request.metadata !== undefined && (!request.metadata || typeof request.metadata !== 'object' || Array.isArray(request.metadata) ||
    Object.values(request.metadata).some(value => !['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))))) throw new Error('INVALID_ARGUMENT: scalar metadata required')
  validatePeriods(request.periods, request.metadata)
}

export function registerContinuumHandlers(session: RepositoryContinuumSession): () => void {
  registerContinuumBundleHandlers(session)
  registerContinuumBuilderHandlers(session)
  const active = (repositoryId: unknown) => {
    if (typeof repositoryId !== 'string' || !repositoryId) throw new Error('INVALID_ARGUMENT: repositoryId required')
    return session.getActiveSession()?.repositoryId === repositoryId ? session.getActiveService() : null
  }
  ipcMain.handle('continuum:tags', (_event, repositoryId: string) => {
    const service = active(repositoryId)
    if (!service) throw new Error('REPOSITORY_UNAVAILABLE')
    const tags = service.tags()
    if (active(repositoryId) !== service) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    return { repositoryId, tags }
  })
  ipcMain.handle('continuum:mutate-tags', (_event, request: ContinuumTagMutation) => {
    if (!request || typeof request !== 'object') throw new Error('INVALID_ARGUMENT')
    const service = active(request.repositoryId)
    if (!service) throw new Error('REPOSITORY_UNAVAILABLE')
    return { repositoryId: request.repositoryId, tags: service.mutateTags(request) }
  })
  const exporting = new Set<number>()
  ipcMain.handle('continuum:resolve-selection', (_event, request: ContinuumListRequest) => {
    if (!request || typeof request !== 'object' || request.cursor !== undefined) throw new Error('INVALID_SELECTION_REQUEST')
    validateListRequest(request)
    const service = active(request.repositoryId)
    if (!service) throw new Error('REPOSITORY_UNAVAILABLE')
    const { repositoryId, ...filter } = request
    const artifacts = service.resolveSelection(filter)
    if (active(repositoryId) !== service) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    return { repositoryId, artifacts }
  })
  ipcMain.handle('continuum:selection-tokens', async (_event, repositoryId: string, selected: import('../../shared/types/continuum-ui-types').ContinuumSelectedArtifact[]) => {
    const service = active(repositoryId)
    if (!service) throw new Error('REPOSITORY_UNAVAILABLE')
    const artifacts = await service.selectionTokens(selected)
    if (active(repositoryId) !== service) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    return { repositoryId, artifacts }
  })
  ipcMain.handle('continuum:tag-tokens', async (_event, repositoryId: string, slugs: string[]) => {
    const service = active(repositoryId)
    if (!service) throw new Error('REPOSITORY_UNAVAILABLE')
    const totals = await service.tagTokenTotals(slugs)
    if (active(repositoryId) !== service) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    return { repositoryId, totals }
  })
  ipcMain.handle('continuum:export', async (event, request: ContinuumExportRequest): Promise<ContinuumExportReceipt> => {
    if (!request || typeof request !== 'object' || typeof request.artifactId !== 'string' || !request.artifactId.trim() || !['copy', 'save'].includes(request.intent)) throw new Error('INVALID_ARGUMENT')
    const service = active(request.repositoryId)
    if (!service) throw new Error('REPOSITORY_UNAVAILABLE')
    if (exporting.has(event.sender.id)) throw new Error('EXPORT_BUSY')
    exporting.add(event.sender.id)
    try {
      const artifact = service.get(request.artifactId)
      if (!artifact) throw new Error('ARTIFACT_NOT_FOUND')
      const assertContext = () => {
        if (active(request.repositoryId) !== service || event.sender.isDestroyed()) throw new Error('REPOSITORY_CONTEXT_CHANGED')
        const current = service.get(request.artifactId)
        if (!current || current.revision !== artifact.revision || current.rawMarkdown !== artifact.rawMarkdown) throw new Error('ARTIFACT_CONTEXT_CHANGED')
        if (active(request.repositoryId) !== service) throw new Error('REPOSITORY_CONTEXT_CHANGED')
      }
      const visual = artifact.metadata.kind === 'VISUAL_REFERENCE'
      const data = visual ? service.getVisual(request.artifactId).data : Buffer.from(artifact.rawMarkdown, 'utf8')
      const receipt = (outcome: ContinuumExportReceipt['outcome']): ContinuumExportReceipt => ({ repositoryId: request.repositoryId, artifactId: request.artifactId, outcome })
      if (request.intent === 'copy') {
        if (visual) {
          const png = await sharp(data, { failOn: 'warning', limitInputPixels: VISUAL_MAX_PIXELS }).timeout({ seconds: 5 }).png().toBuffer()
          const image = nativeImage.createFromBuffer(png)
          if (image.isEmpty()) throw new Error('INVALID_VISUAL_MEDIA')
          assertContext()
          clipboard.writeImage(image)
        } else {
          assertContext()
          clipboard.writeText(artifact.rawMarkdown)
        }
        return receipt('copied')
      }
      const extension = visual ? '.webp' : '.md'
      assertContext()
      const options: Electron.SaveDialogOptions = {
        title: 'Salvar Artifact como…', defaultPath: join(app.getPath('downloads'), exportName(artifact.metadata.name, extension)),
        filters: [{ name: visual ? 'WebP original' : 'Markdown', extensions: [extension.slice(1)] }],
        properties: ['showOverwriteConfirmation', 'createDirectory', 'dontAddToRecent']
      }
      const parent = BrowserWindow.fromWebContents(event.sender)
      const result = await (parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options))
      if (result.canceled) return receipt('cancelled')
      assertContext()
      if (!result.filePath || extname(result.filePath).toLowerCase() !== extension) throw new Error(`INVALID_EXPORT_EXTENSION: ${extension} obrigatório`)
      const temporary = join(dirname(result.filePath), `.continuum-${randomUUID()}.tmp`)
      try {
        writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 })
        renameSync(temporary, result.filePath)
      } finally { rmSync(temporary, { force: true }) }
      return receipt('saved')
    } finally { exporting.delete(event.sender.id) }
  })
  ipcMain.handle('continuum:publish-visual', async (_event, request: ContinuumVisualPublishRequest) => {
    if (!request || typeof request !== 'object' || !(request.data instanceof Uint8Array) || request.data.byteLength > VISUAL_MAX_BYTES || !(['name', 'description', 'context'] as const).every(key => typeof request[key] === 'string' && request[key].trim())) throw new Error('INVALID_ARGUMENT: referência visual obrigatória')
    const service = active(request.repositoryId)
    if (!service) throw new Error('REPOSITORY_UNAVAILABLE')
    return service.publishVisual(visualMarkdown(request.name, request.description, request.context, request.relations), request.data)
  })
  ipcMain.handle('continuum:get-visual', (_event, repositoryId: string, artifactId: string) => {
    const service = active(repositoryId)
    if (!service) throw new Error('REPOSITORY_UNAVAILABLE')
    if (typeof artifactId !== 'string' || !artifactId.trim()) throw new Error('INVALID_ARGUMENT')
    const visual = service.getVisual(artifactId)
    return { repositoryId, artifactId, mimeType: visual.media.mimeType, data: new Uint8Array(visual.data) }
  })
  ipcMain.handle('continuum:get-visual-thumbnail', async (_event, repositoryId: string, artifactId: string) => {
    const service = active(repositoryId)
    if (!service) throw new Error('REPOSITORY_UNAVAILABLE')
    if (typeof artifactId !== 'string' || !artifactId.trim()) throw new Error('INVALID_ARGUMENT')
    const data = await service.getVisualThumbnail(artifactId)
    if (active(repositoryId) !== service) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    return { repositoryId, artifactId, mimeType: 'image/webp', data: new Uint8Array(data) }
  })
  ipcMain.handle('continuum:publish', (_event, request: ContinuumPublishRequest): ContinuumPublishReceipt => {
    if (!request || typeof request !== 'object' || typeof request.rawMarkdown !== 'string') throw new Error('INVALID_ARGUMENT: conteúdo Markdown obrigatório')
    const service = active(request.repositoryId)
    if (!service) throw new Error('REPOSITORY_UNAVAILABLE: o repositório ativo mudou ou o Continuum está indisponível. Selecione o arquivo novamente.')
    return service.publishHuman(publicationMarkdown(request.fileName, request.rawMarkdown), request.confirmedTags === true)
  })
  ipcMain.handle('continuum:list', (_event, request: ContinuumListRequest) => {
    if (!request || typeof request !== 'object') throw new Error('INVALID_ARGUMENT: list request required')
    const service = active(request.repositoryId)
    if (!service) return { repositoryId: null, artifacts: [] }
    validateListRequest(request)
    const result = service.list({ ...(request.sortBy !== undefined ? { sortBy: request.sortBy } : {}), ...(request.includeTags !== undefined ? { includeTags: request.includeTags } : {}), ...(request.tag !== undefined ? { tag: request.tag } : {}), ...(request.query !== undefined ? { query: request.query } : {}), ...(request.metadata !== undefined ? { metadata: request.metadata } : {}), ...(request.periods !== undefined ? { periods: request.periods } : {}), ...(request.cursor !== undefined ? { cursor: request.cursor } : {}), limit: 30, includeRawMarkdownTokenCount: true })
    if (active(request.repositoryId) !== service) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    return { repositoryId: request.repositoryId, ...result }
  })
  ipcMain.handle('continuum:graph', (_event, request: ContinuumGraphRequest) => {
    if (!request || typeof request !== 'object') throw new Error('INVALID_ARGUMENT: graph request required')
    const service = active(request.repositoryId)
    if (!service) throw new Error('REPOSITORY_UNAVAILABLE')
    const { repositoryId, ...query } = request
    const result = service.graph(query)
    if (active(repositoryId) !== service) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    return result
  })
  ipcMain.handle('continuum:suggestions', (_event, request: ContinuumSuggestionRequest) => {
    if (!request || typeof request !== 'object') throw new Error('INVALID_ARGUMENT: suggestion request required')
    const service = active(request.repositoryId)
    if (!service) throw new Error('REPOSITORY_UNAVAILABLE')
    const { repositoryId, ...query } = request
    const result = service.suggestions(query)
    if (active(repositoryId) !== service) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    return result
  })
  ipcMain.handle('continuum:facets', (_event, repositoryPath: string) => {
    if (typeof repositoryPath !== 'string' || !repositoryPath) throw new Error('INVALID_ARGUMENT: repositoryPath required')
    const current = session.getActiveSession()
    const repositoryId = current?.repositoryPath === repositoryPath ? current.repositoryId : null
    const service = repositoryId ? active(repositoryId) : null
    return { repositoryId: service ? repositoryId : null, facets: service?.facets() ?? [] }
  })
  ipcMain.handle('continuum:get', (_event, repositoryId: string, artifactId: string) => {
    const service = active(repositoryId)
    if (typeof artifactId !== 'string' || !artifactId.trim()) throw new Error('INVALID_ARGUMENT: artifactId required')
    const artifact = service?.get(artifactId)
    if (!artifact) return { repositoryId: service ? repositoryId : null, artifact: null }
    // Legacy imports can be body-only Markdown and lack the modern required description.
    const body = /^(?:\uFEFF)?---\r?\n/.test(artifact.rawMarkdown)
      ? parseArtifactMarkdown(artifact.rawMarkdown, true).body : artifact.rawMarkdown
    return { repositoryId, artifact: { artifactId, revision: artifact.revision, metadata: artifact.metadata,
      body, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt } }
  })
  return session.onChanged(() => {
    const change = { repositoryId: session.getActiveSession()?.repositoryId ?? null }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        try { window.webContents.send('continuum:changed', change) } catch (error) { console.error('[Continuum] Renderer notification failed:', error) }
      }
    }
  })
}
