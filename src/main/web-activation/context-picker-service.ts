import { randomUUID } from 'node:crypto'
import { contextPickerSite } from '../../shared/web-activation/context-picker-sites'
import type {
  PickerCatalog, PickerFilters, PickerPreview, PickerRequest, PickerResult, PickerScope
} from '../../shared/web-activation/context-picker-contract'
import type { ContinuumService } from '../continuum/continuum-service'
import { ContextBundle, SELECTION_MAX_ARTIFACTS } from '../continuum/context-bundle'
import { downloadPickerFiles, nativePickerFiles, pickerOriginals } from './context-picker-files'
import { object, text } from '../local-agent-channel/request-validation'

interface PickerProject {
  repositoryId: string
  revision: number
  name: string
  service: ContinuumService
}

export class ContextPickerService {
  private binding?: { project: PickerProject; scope: PickerScope }

  constructor(private readonly activeProject: () => PickerProject | null) {}

  private current() {
    const project = this.activeProject()
    if (!project) {
      this.binding = undefined
      throw new Error('NO_ACTIVE_PROJECT')
    }
    project.service.assertRepository(project.repositoryId)
    if (
      this.binding?.project.service !== project.service ||
      this.binding.project.revision !== project.revision
    ) {
      this.binding = { project, scope: { repositoryId: project.repositoryId, binding: randomUUID() } }
    }
    return this.binding
  }

  async execute(input: unknown, connected: () => boolean): Promise<PickerResult> {
    const args = object(input, ['webOrigin', 'request'])
    const webOrigin = text(args.webOrigin)
    if (!contextPickerSite(webOrigin) || new URL(webOrigin).origin !== webOrigin) {
      throw new Error('ORIGIN_NOT_ALLOWED')
    }
    const request = parseRequest(args.request)
    const { project, scope } = this.current()
    const assertCurrent = () => {
      if (!connected()) throw new Error('PICKER_SESSION_EXPIRED')
      if (this.current().scope !== scope) throw new Error('PROJECT_CONTEXT_CHANGED')
    }
    if (request.scope && (
      request.scope.repositoryId !== scope.repositoryId || request.scope.binding !== scope.binding
    )) throw new Error('PROJECT_CONTEXT_CHANGED')

    if (request.action === 'catalog') {
      const page = project.service.list({ ...request.filters, limit: 20 })
      const artifactProjection = page.artifacts.flatMap(({ artifactId, name, kind, revision }) =>
        revision === undefined ? [] : [{ artifactId, name, kind, revision }]
      )
      const result: PickerCatalog = {
        scope,
        projectName: project.name,
        artifacts: artifactProjection,
        nextCursor: page.nextCursor,
        ...(!request.scope && {
          tags: project.service.tags().map(({ slug, name }) => ({ slug, name })),
          facets: project.service.facets().filter(({ key }) => key === 'kind' || key === 'status')
        })
      }
      assertCurrent()
      return result
    }

    if (request.action === 'attach' || request.action === 'download') {
      const bundle = ContextBundle.prepare(project.service, {
        repositoryId: scope.repositoryId, source: { kind: 'selection', selected: request.selected }
      })
      const assertSelection = () => {
        assertCurrent()
        bundle.assertFresh()
      }
      if (request.action === 'attach' && bundle.preview.hasVisuals) throw new Error('PICKER_MEDIA_DOWNLOAD_REQUIRED')
      const files = pickerOriginals(project.service, bundle)
      assertSelection()
      return request.action === 'attach' ? { files: nativePickerFiles(files) } : downloadPickerFiles(files, assertSelection)
    }

    const bundle = ContextBundle.prepareBuilder(
      project.service,
      scope.repositoryId,
      request.selected,
      request.selected.map(({ artifactId }) => artifactId)
    )
    const assertSelection = () => {
      assertCurrent()
      bundle.assertFresh()
    }
    const markdown = request.selected.length === 1
      ? project.service.get(request.selected[0].artifactId)?.rawMarkdown
      : bundle.preview.markdown
    if (markdown === undefined) throw new Error('BUNDLE_SNAPSHOT_STALE')
    assertSelection()

    if (request.action === 'preview') {
      const artifactTokens = await project.service.selectionTokens(request.selected, true)
      assertSelection()
      const result: PickerPreview = {
        tokenCount: request.selected.length === 1
          ? artifactTokens[0].rawMarkdownTokenCount
          : bundle.preview.tokenCount,
        artifactTokens,
        markdownBytes: Buffer.byteLength(markdown),
        hasVisuals: bundle.preview.hasVisuals,
        members: bundle.preview.members
      }
      return result
    }
    if (request.action === 'copy') {
      const { clipboard } = await import('electron')
      if (!clipboard?.writeText) throw new Error('INTERACTIVE_SESSION_REQUIRED')
      assertSelection()
      clipboard.writeText(markdown)
      return { outcome: 'copied' }
    }
    if (Buffer.byteLength(JSON.stringify(markdown)) > 900_000) throw new Error('PICKER_TEXT_TOO_LARGE')
    return { markdown }
  }
}

function parseScope(input: unknown): PickerScope {
  const scope = object(input, ['repositoryId', 'binding'])
  return { repositoryId: text(scope.repositoryId), binding: text(scope.binding) }
}

function parseRequest(input: unknown): PickerRequest {
  const action = object(input).action
  if (action === 'catalog') {
    const req = object(input, ['action', 'scope', 'filters'])
    const raw = object(req.filters, ['query', 'tag', 'kind', 'status', 'cursor'])
    const filters: PickerFilters = {}
    for (const key of ['query', 'tag', 'kind', 'status', 'cursor'] as const) {
      if (raw[key] !== undefined) {
        const value = text(raw[key])
        if (value.length > 2048) throw new Error('INVALID_ARGUMENT')
        filters[key] = value
      }
    }
    if (filters.cursor && !req.scope) throw new Error('PROJECT_CONTEXT_CHANGED')
    return { action, scope: req.scope === undefined ? undefined : parseScope(req.scope), filters }
  }

  if (action !== 'preview' && action !== 'copy' && action !== 'download' && action !== 'attach' && action !== 'text') {
    throw new Error('INVALID_ARGUMENT')
  }
  const req = object(input, ['action', 'scope', 'selected'])
  if (!Array.isArray(req.selected) || req.selected.length < 1 || req.selected.length > SELECTION_MAX_ARTIFACTS) {
    throw new Error('INVALID_SELECTION')
  }
  return {
    action,
    scope: parseScope(req.scope),
    selected: req.selected.map(value => {
      const item = object(value, ['artifactId', 'expectedRevision'])
      const artifactId = text(item.artifactId)
      const expectedRevision = item.expectedRevision
      if (artifactId.length > 200 || typeof expectedRevision !== 'number' ||
        !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('INVALID_SELECTION')
      return { artifactId, expectedRevision }
    })
  }
}
