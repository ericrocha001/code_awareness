import type {
  DraftOutcome, PickerArtifact, PickerCatalog, PickerFilters, PickerPreview, PickerRequest, PickerResponse
} from '../shared/web-activation/context-picker-contract'
import { getChromeApi } from './chrome-api'
import { contextPickerSite, supportsDraftInsertion } from '../shared/web-activation/context-picker-sites'

const runtime = getChromeApi()?.runtime
const challenge = crypto.randomUUID()
const status = document.querySelector<HTMLParagraphElement>('#status')!
const projectName = document.querySelector<HTMLParagraphElement>('#project')!
const form = document.querySelector<HTMLFormElement>('#search')!
const results = document.querySelector<HTMLUListElement>('#results')!
const selectedList = document.querySelector<HTMLOListElement>('#selected')!
const count = document.querySelector<HTMLElement>('#count')!
const preview = document.querySelector<HTMLParagraphElement>('#preview')!
const more = document.querySelector<HTMLButtonElement>('#more')!
const close = document.querySelector<HTMLButtonElement>('#close')!
const previewButton = document.querySelector<HTMLButtonElement>('#preview-button')!
const copy = document.querySelector<HTMLButtonElement>('#copy')!
const exportButton = document.querySelector<HTMLButtonElement>('#export')!
const insert = document.querySelector<HTMLButtonElement>('#insert')!
const destination = document.querySelector<HTMLParagraphElement>('#destination')!
const destinationOrigin = location.ancestorOrigins[0]
const site = contextPickerSite(destinationOrigin)
const supportsInsert = site ? supportsDraftInsertion(site) : false
insert.hidden = !supportsInsert
destination.textContent = supportsInsert
  ? `Draft on ${new URL(destinationOrigin).hostname}. Files are available as ZIP.`
  : 'Copy text or export files to add them manually.'

const selected = new Map<string, PickerArtifact>()
let catalog: PickerCatalog | undefined
let filters: PickerFilters = {}
let busy = false
let ready = false
let reviewed = false
let textAttempted = false

function renderActions() {
  const hasSelection = Boolean(catalog && selected.size)
  previewButton.disabled = busy || !hasSelection
  copy.disabled = busy || !reviewed
  exportButton.disabled = busy || !reviewed
  insert.disabled = busy || !reviewed || textAttempted
  more.disabled = busy
  for (const element of Array.from(form.elements)) {
    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement ||
      element instanceof HTMLButtonElement) element.disabled = busy || !ready
  }
  for (const checkbox of results.querySelectorAll('input')) checkbox.disabled = busy
  for (const button of selectedList.querySelectorAll('button')) button.disabled = busy
}

function showSelection() {
  reviewed = false
  textAttempted = false
  preview.hidden = true
  count.textContent = `${selected.size} selected`
  selectedList.replaceChildren(...Array.from(selected.values(), item => {
    const li = document.createElement('li')
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = 'Remove'
    remove.setAttribute('aria-label', `Remove ${item.name}`)
    remove.addEventListener('click', () => {
      selected.delete(item.artifactId)
      for (const checkbox of results.querySelectorAll('input')) {
        if (checkbox.value === item.artifactId) checkbox.checked = false
      }
      showSelection()
    })
    li.append(item.name, remove)
    return li
  }))
  renderActions()
}

function closePanel() {
  window.parent.postMessage({ type: 'PICKER_PANEL_CLOSE' }, '*')
}

async function request<T>(payload: PickerRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!runtime?.sendMessage) {
      reject(new Error('Extension connection unavailable'))
      return
    }
    runtime.sendMessage({ type: 'PICKER_REQUEST', challenge, request: payload }, raw => {
      const response = raw as PickerResponse | undefined
      if (response?.ok) resolve(response.result as T)
      else reject(new Error(response?.error.message ?? 'Desktop connection unavailable'))
    })
  })
}

async function run(action: () => Promise<void>) {
  if (!ready || busy) return
  busy = true
  status.textContent = 'Working…'
  renderActions()
  try {
    await action()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Continuum request failed'
    if (message !== 'PICKER_TEXT_TOO_LARGE') {
      results.replaceChildren()
      more.hidden = true
      projectName.textContent = ''
      catalog = undefined
      selected.clear()
      showSelection()
    }
    status.textContent = ({
      PROJECT_CONTEXT_CHANGED: 'The active project changed. Search again to reload.',
      NO_ACTIVE_PROJECT: 'Select a project in Code Awareness and search again.',
      BUNDLE_SNAPSHOT_STALE: 'An artifact changed. Search again to select the latest revision.',
      REVISION_CONFLICT: 'An artifact changed. Search again to select the latest revision.',
      PICKER_TEXT_TOO_LARGE: 'This selection is too large to insert. Copy the text or export the originals.',
      PICKER_INSERT_ALREADY_ATTEMPTED: 'This selection was already attempted. Check the draft before using the fallback.',
      PICKER_SESSION_EXPIRED: 'Close and reopen Context to reconnect.'
    } as Record<string, string>)[message] ?? message
  } finally {
    busy = false
    renderActions()
  }
}

function setupFilters(page: PickerCatalog) {
  const configure = (name: string, values: [string, string][]) => {
    const field = form.elements.namedItem(name) as HTMLSelectElement
    field.replaceChildren(new Option('Any', ''), ...values.map(([value, label]) => new Option(label, value)))
  }
  configure('tag', (page.tags ?? []).map(({ slug, name }) => [slug, name]))
  for (const name of ['kind', 'status']) {
    const values = page.facets?.find(({ key }) => key === name)?.values ?? []
    configure(name, values.map(({ value, count }) => [String(value), `${value} (${count})`]))
  }
}

function row(item: PickerArtifact) {
  const li = document.createElement('li')
  const label = document.createElement('label')
  const checkbox = document.createElement('input')
  const name = document.createElement('span')
  checkbox.type = 'checkbox'
  checkbox.value = item.artifactId
  checkbox.checked = selected.has(item.artifactId)
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) selected.set(item.artifactId, item)
    else selected.delete(item.artifactId)
    showSelection()
  })
  const kind = document.createElement('small')
  kind.textContent = item.kind === 'VISUAL_REFERENCE' ? ' · WebP' : ` · ${item.kind}`
  name.append(item.name, kind)
  label.append(checkbox, name)
  li.append(label)
  return li
}

async function load(cursor?: string) {
  const opening = !catalog
  const page = await request<PickerCatalog>({
    action: 'catalog',
    scope: catalog?.scope,
    filters: { ...filters, ...(cursor && { cursor }) }
  })
  catalog = page
  if (opening) setupFilters(page)
  projectName.textContent = page.projectName
  if (!cursor) results.replaceChildren()
  results.append(...page.artifacts.map(row))
  status.textContent = results.children.length ? '' : 'No matching artifacts.'
  more.hidden = !page.nextCursor
}

function doSelection(action: 'preview' | 'copy' | 'export' | 'text') {
  return run(async () => {
    if (!catalog) return
    const requested = Array.from(selected.values(), ({ artifactId, revision }) => ({
      artifactId, expectedRevision: revision
    }))
    const response = await request<PickerPreview | DraftOutcome | { outcome: 'copied' | 'saved' }>({
      action, scope: catalog.scope, selected: requested
    })
    if ('tokenCount' in response) {
      preview.textContent = `Estimated ${response.tokenCount.toLocaleString()} tokens · ${requested.length === 1 ? 'Original Markdown' : 'Context Bundle Markdown'}${response.hasVisuals ? ' · WebP originals in ZIP' : ''}`
      preview.hidden = false
      reviewed = true
      status.textContent = ''
    } else if (response.outcome === 'inserted') {
      textAttempted = true
      status.textContent = 'Markdown inserted in the draft. Use Export originals for WebP files.'
    } else if (response.outcome === 'uncertain' || response.outcome === 'unavailable') {
      textAttempted = response.outcome === 'uncertain'
      status.textContent = response.outcome === 'unavailable'
        ? `${response.reason} Copy the text to paste it manually.`
        : response.reason
    } else {
      status.textContent = response.outcome === 'copied'
        ? 'Markdown copied. Paste it into the chat draft.'
        : 'Original files exported as ZIP.'
    }
  })
}

form.addEventListener('submit', event => {
  event.preventDefault()
  if (!event.isTrusted) return
  const fields = new FormData(form)
  filters = {}
  for (const key of ['query', 'kind', 'status', 'tag'] as const) {
    const value = fields.get(key)?.toString().trim()
    if (value) filters[key] = value
  }
  void run(() => load())
})
more.addEventListener('click', event => {
  if (event.isTrusted && catalog?.nextCursor) void run(() => load(catalog?.nextCursor))
})
previewButton.addEventListener('click', event => { if (event.isTrusted) void doSelection('preview') })
copy.addEventListener('click', event => { if (event.isTrusted && reviewed) void doSelection('copy') })
exportButton.addEventListener('click', event => { if (event.isTrusted && reviewed) void doSelection('export') })
insert.addEventListener('click', event => { if (event.isTrusted && reviewed && !textAttempted) void doSelection('text') })
close.addEventListener('click', closePanel)
document.addEventListener('keydown', event => { if (event.key === 'Escape') closePanel() })

renderActions()
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.type !== 'PICKER_PANEL_READY' || ready) return
  ready = true
  void run(() => load()).then(() => form.querySelector('input')?.focus({ preventScroll: true }))
})
if (window.parent !== window) window.parent.postMessage({ type: 'PICKER_PANEL_HELLO', challenge }, '*')
