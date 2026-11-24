import { isPickerTagMutation, isPopupPickerRequest } from '../../shared/web-activation/context-picker-contract'
import { randomUUID } from 'node:crypto'
import { contextPickerSite } from '../../shared/web-activation/context-picker-sites'
import type {
  PickerCatalog, PickerFilters, PickerPreview, PickerRequest, PickerResult, PickerScope, PickerTagMutation, PickerTagView
} from '../../shared/web-activation/context-picker-contract'
import { artifactTags, quickTag, tagDescription, validateTagSlug } from '../../shared/types/continuum-tag-types'
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

  constructor(
    private readonly activeProject: () => PickerProject | null,
    private readonly isEnrolledExtension: (origin: string) => boolean = () => false,
    private readonly confirmWebTag: (name: string, project: string, request: PickerTagMutation) => Promise<boolean> = async () => false
  ) {}

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
    const surface = object(input).surface
    const args = surface === 'extension-ui'
      ? object(input, ['surface', 'extensionOrigin', 'request'])
      : object(input, ['webOrigin', 'extensionOrigin', 'request'])
    if (surface === 'extension-ui') {
      if (!isPopupPickerRequest(args.request) || !this.isEnrolledExtension(text(args.extensionOrigin))) {
        throw new Error('ORIGIN_NOT_ALLOWED')
      }
    } else {
      const webOrigin = text(args.webOrigin)
      if (!contextPickerSite(webOrigin) || new URL(webOrigin).origin !== webOrigin) {
        throw new Error('ORIGIN_NOT_ALLOWED')
      }
    }
    const request = parseRequest(args.request)
    const mutation = isPickerTagMutation(request)
    const { project, scope } = this.current()
    const assertCurrent = () => {
      if (!connected()) throw new Error('PICKER_SESSION_EXPIRED')
      if ((surface === 'extension-ui' || mutation) && !this.isEnrolledExtension(text(args.extensionOrigin))) {
        throw new Error('ORIGIN_NOT_ALLOWED')
      }
      if (this.current().scope !== scope) throw new Error('PROJECT_CONTEXT_CHANGED')
    }
    if (request.scope && (
      request.scope.repositoryId !== scope.repositoryId || request.scope.binding !== scope.binding
    )) throw new Error('PROJECT_CONTEXT_CHANGED')

    if (request.action === 'tag-membership' || isPickerTagMutation(request)) {
      const artifactId = request.action === 'tag-membership' ? request.artifactId : request.target.artifactId
      const read = (): PickerTagView => {
        const tags = project.service.tags().map(({ slug, name }) => ({ slug, name }))
        const item = project.service.get(artifactId)
        if (!item) throw new Error('ARTIFACT_NOT_FOUND')
        assertCurrent()
        return {
          artifact: { artifactId, revision: item.revision, name: item.metadata.name, kind: item.metadata.kind },
          assigned: artifactTags(item.metadata.tags),
          tags
        }
      }
      assertCurrent()
      if (request.action === 'tag-membership') return read()
      const target = [request.target]
      project.service.assertSelection(target)
      if (surface !== 'extension-ui') {
        const item = read()
        if (!await this.confirmWebTag(item.artifact.name, project.name, request)) throw new Error('PICKER_TAG_CANCELLED')
        assertCurrent()
        project.service.assertSelection(target)
      }
      const result = request.action === 'tag-create'
        ? project.service.createTag({ name: request.name, description: request.description, selected: target })
        : project.service.assignTag({ slug: request.slug, operation: request.operation, selected: target })
      const receipt = result.artifacts[0]
      if (result.state !== 'PERSISTED' || !receipt?.success) throw new Error('PICKER_TAG_UNCONFIRMED')
      return { ...read(), receipt: { state: result.state, artifactId: receipt.artifactId, revision: receipt.revision } }
    }

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

  if (action === 'tag-membership') {
    const req = object(input, ['action', 'scope', 'artifactId'])
    return { action, scope: parseScope(req.scope), artifactId: text(req.artifactId) }
  }
  if (action === 'tag-assign' || action === 'tag-create') {
    const req = object(input, action === 'tag-assign'
      ? ['action', 'scope', 'target', 'slug', 'operation']
      : ['action', 'scope', 'target', 'name', 'description'])
    const target = parseTarget(req.target)
    const scope = parseScope(req.scope)
    if (action === 'tag-assign') {
      const slug = text(req.slug)
      validateTagSlug(slug)
      if (req.operation !== 'add' && req.operation !== 'remove') throw new Error('INVALID_TAG_OPERATION')
      return { action, scope, target, slug, operation: req.operation }
    }
    const name = quickTag(text(req.name)).name
    const description = tagDescription(req.description)
    return { action, scope, target, name, description }
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
    selected: req.selected.map(parseTarget)
  }
}

function parseTarget(value: unknown) {
  const item = object(value, ['artifactId', 'expectedRevision'])
  const artifactId = text(item.artifactId)
  const expectedRevision = item.expectedRevision
  if (artifactId.length > 200 || typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('INVALID_SELECTION')
  return { artifactId, expectedRevision }
}
