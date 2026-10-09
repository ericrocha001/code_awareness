import { BrowserWindow, ipcMain } from 'electron'
import { posix, win32 } from 'node:path'
import { dump } from 'js-yaml'
import type { ContinuumListRequest, ContinuumPublishRequest, ContinuumPublishReceipt, ContinuumVisualPublishRequest } from '../../shared/types/continuum-ui-types'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'
import { parseArtifactMarkdown, validateMarkdown, visualMarkdown } from '../continuum/artifact-metadata'
import { VISUAL_MAX_BYTES } from '../continuum/visual-media'

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

export function registerContinuumHandlers(session: RepositoryContinuumSession): () => void {
  const active = (repositoryId: unknown) => {
    if (typeof repositoryId !== 'string' || !repositoryId) throw new Error('INVALID_ARGUMENT: repositoryId required')
    return session.getActiveSession()?.repositoryId === repositoryId ? session.getActiveService() : null
  }
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
    return service.publish(publicationMarkdown(request.fileName, request.rawMarkdown))
  })
  ipcMain.handle('continuum:list', (_event, request: ContinuumListRequest) => {
    if (!request || typeof request !== 'object') throw new Error('INVALID_ARGUMENT: list request required')
    const service = active(request.repositoryId)
    if (!service) return { repositoryId: null, artifacts: [] }
    if (request.query !== undefined && typeof request.query !== 'string') throw new Error('INVALID_ARGUMENT: query must be text')
    if (request.cursor !== undefined && typeof request.cursor !== 'string') throw new Error('INVALID_ARGUMENT: cursor must be text')
    if (request.metadata !== undefined && (!request.metadata || typeof request.metadata !== 'object' || Array.isArray(request.metadata) ||
      Object.values(request.metadata).some(value => !['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))))) throw new Error('INVALID_ARGUMENT: scalar metadata required')
    return { repositoryId: request.repositoryId, ...service.list({ ...(request.query !== undefined ? { query: request.query } : {}), ...(request.metadata !== undefined ? { metadata: request.metadata } : {}), ...(request.cursor !== undefined ? { cursor: request.cursor } : {}), limit: 30 }) }
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
