import { labelFor, localize, messages as pt, number, pickerError, selectedCount, tokens } from './locale'
import type {
  DraftOutcome, PickerAttachment, PickerDownload, PickerArtifact, PickerCatalog, PickerFilters, PickerPreview, PickerRequest, PickerResponse
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
const selectionPanel = document.querySelector<HTMLElement>('#selection')!
const selectionToggle = document.querySelector<HTMLButtonElement>('#selection-toggle')!
const count = document.querySelector<HTMLElement>('#count')!
const preview = document.querySelector<HTMLSpanElement>('#preview')!
const more = document.querySelector<HTMLButtonElement>('#more')!
const close = document.querySelector<HTMLButtonElement>('#close')!
const copy = document.querySelector<HTMLButtonElement>('#copy')!
const attach = document.querySelector<HTMLButtonElement>('#attach')!
const insert = document.querySelector<HTMLButtonElement>('#insert')!
const retry = document.querySelector<HTMLButtonElement>('#retry')!
const actionStatus = document.querySelector<HTMLParagraphElement>('#action-status')!
const destination = document.querySelector<HTMLParagraphElement>('#destination')!
const site = contextPickerSite(location.ancestorOrigins?.[0])
localize(document)
insert.hidden = !(site && supportsDraftInsertion(site))
destination.textContent = site ? `${pt.destination} · ${new URL(location.ancestorOrigins[0]).hostname}` : ''

const selected = new Map<string, PickerArtifact>()
const visible = new Map<string, PickerArtifact>()
let catalog: PickerCatalog | undefined
let ready = false
let actionPending = false
let textAttempted = false
let attachmentFallback = false
let searchGeneration = 0
let estimateGeneration = 0
let searchTimer: ReturnType<typeof setTimeout> | undefined
let estimateTimer: ReturnType<typeof setTimeout> | undefined
let estimate: PickerPreview | undefined
let estimateFailed = false

const selection = () => Array.from(selected.values(), ({ artifactId, revision }) => ({
  artifactId, expectedRevision: revision
}))

const shouldDownload = () => site !== 'chatgpt' || attachmentFallback || [...selected.values()].some(item => item.kind === 'VISUAL_REFERENCE')

function renderActions() {
  const disabled = actionPending || !catalog || selected.size === 0
  copy.disabled = disabled
  attach.disabled = disabled
  attach.querySelector('span')!.textContent = shouldDownload() ? pt.download : pt.attach
  insert.disabled = disabled || textAttempted
}

function renderSelection() {
  count.textContent = selectedCount(selected.size)
  const amounts = new Map(estimate?.artifactTokens.map(item => [item.artifactId, item.rawMarkdownTokenCount]))
  if (estimate || selected.size === 0) {
    const total = document.createElement('span')
    total.className = 'token-total'
    total.textContent = estimate ? `≈ ${tokens(estimate.tokenCount)}` : tokens(0)
    preview.replaceChildren(total, estimate?.hasVisuals ? ' · ' + pt.media : '')
  } else {
    preview.textContent = estimateFailed ? pt.estimateUnavailable : pt.estimating
  }
  const focused = document.activeElement instanceof HTMLButtonElement
    ? document.activeElement.dataset.remove : undefined
  const scrollTop = selectedList.scrollTop
  selectedList.replaceChildren(...Array.from(selected.values(), item => {
    const li = document.createElement('li')
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.dataset.remove = item.artifactId
    remove.textContent = pt.remove
    remove.setAttribute('aria-label', `${pt.remove} ${item.name}`)
    remove.addEventListener('click', () => {
      selected.delete(item.artifactId)
      for (const checkbox of results.querySelectorAll('input')) {
        if (checkbox.value === item.artifactId) checkbox.checked = false
      }
      selectionChanged()
    })
    const amount = amounts.get(item.artifactId)
    const line = document.createElement('div')
    line.className = 'selection-line'
    const title = document.createElement('span')
    title.textContent = item.name
    if (amount !== undefined) {
      const detail = document.createElement('small')
      detail.textContent = ` · ≈ ${tokens(amount)}`
      title.append(detail)
    }
    line.append(title, remove)
    li.append(line)
    return li
  }))
  if (focused) {
    const target = [...selectedList.querySelectorAll('button')].find(button => button.dataset.remove === focused)
    const nextFocus = target ?? selectedList.querySelector('button') ?? selectionToggle
    nextFocus.focus({ preventScroll: true })
  }
  selectedList.scrollTop = scrollTop
  renderActions()
}

function selectionChanged() {
  clearTimeout(estimateTimer)
  const generation = ++estimateGeneration
  estimate = undefined
  estimateFailed = false
  textAttempted = false
  attachmentFallback = false
  renderSelection()
  const scope = catalog?.scope
  if (!scope || !selected.size) return
  const requested = selection()
  estimateTimer = setTimeout(async () => {
    try {
      const value = await request<PickerPreview>({ action: 'preview', scope, selected: requested })
      if (generation !== estimateGeneration) return
      estimate = value
    } catch (error) {
      if (generation !== estimateGeneration) return
      if (invalidate(codeOf(error))) return
      estimateFailed = true
    }
    renderSelection()
  }, 100)
}

function closePanel() {
  window.parent.postMessage({ type: 'PICKER_PANEL_CLOSE' }, '*')
}

function request<T>(payload: PickerRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!runtime?.sendMessage) {
      reject(new Error('APP_UNAVAILABLE'))
      return
    }
    runtime.sendMessage({ type: 'PICKER_REQUEST', challenge, request: payload }, raw => {
      const response = raw as PickerResponse | undefined
      if (response?.ok) resolve(response.result as T)
      else reject(new Error(response?.error.message?.split(':')[0] ?? 'APP_UNAVAILABLE'))
    })
  })
}

const codeOf = (error: unknown) => error instanceof Error ? error.message : ''

function invalidate(code: string): boolean {
  const scopeLost = ['PROJECT_CONTEXT_CHANGED', 'NO_ACTIVE_PROJECT', 'PICKER_SESSION_EXPIRED', 'PICKER_SENDER_NOT_AUTHORIZED'].includes(code)
  const stale = code === 'REVISION_CONFLICT' || code === 'BUNDLE_SNAPSHOT_STALE'
  if (!scopeLost && !stale) return false
  if (scopeLost) {
    catalog = undefined
    projectName.textContent = ''
  }
  searchGeneration++
  clearTimeout(searchTimer)
  selected.clear()
  visible.clear()
  results.replaceChildren()
  more.hidden = true
  retry.hidden = code === 'PICKER_SESSION_EXPIRED'
  status.textContent = pickerError(code)
  selectionChanged()
  return true
}

function setupFilters(page: PickerCatalog) {
  const configure = (name: string, values: [string, string][]) => {
    const field = form.elements.namedItem(name) as HTMLSelectElement
    const previous = field.value
    field.replaceChildren(new Option(pt.any, ''), ...values.map(([value, label]) => new Option(label, value)))
    if ([...field.options].some(option => option.value === previous)) field.value = previous
  }
  configure('tag', (page.tags ?? []).map(({ slug, name }) => [slug, name]))
  for (const name of ['kind', 'status']) {
    const values = page.facets?.find(({ key }) => key === name)?.values ?? []
    configure(name, values.map(({ value, count }) => [String(value), `${labelFor(String(value))} (${number.format(count)})`]))
  }
}

function row(item: PickerArtifact) {
  const li = document.createElement('li')
  const label = document.createElement('label')
  const checkbox = document.createElement('input')
  const name = document.createElement('span')
  name.className = 'result-name'
  const badge = document.createElement('span')
  badge.className = 'icon-box'
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('icon')
  svg.setAttribute('aria-hidden', 'true')
  const glyph = document.createElementNS(svg.namespaceURI, 'use')
  glyph.setAttribute('href', item.kind === 'VISUAL_REFERENCE' ? '#icon-globe' : '#icon-file')
  svg.append(glyph)
  badge.append(svg)
  checkbox.type = 'checkbox'
  checkbox.value = item.artifactId
  checkbox.checked = selected.has(item.artifactId)
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) selected.set(item.artifactId, item)
    else selected.delete(item.artifactId)
    selectionChanged()
  })
  const kind = document.createElement('small')
  kind.textContent = item.kind === 'VISUAL_REFERENCE' ? ' · WebP' : ` · ${labelFor(item.kind)}`
  name.append(item.name, kind)
  label.append(checkbox, badge, name)
  li.append(label)
  return li
}

function currentFilters(): PickerFilters {
  const fields = new FormData(form)
  const filters: PickerFilters = {}
  for (const key of ['query', 'kind', 'status', 'tag'] as const) {
    const value = fields.get(key)?.toString().trim()
    if (value) filters[key] = value
  }
  return filters
}

async function load(generation: number, filters: PickerFilters, cursor?: string) {
  const loading = setTimeout(() => {
    if (generation === searchGeneration) status.textContent = pt.loading
  }, 160)
  more.disabled = true
  retry.hidden = true
  try {
    const opening = !catalog
    const page = await request<PickerCatalog>({
      action: 'catalog', scope: catalog?.scope, filters: { ...filters, ...(cursor && { cursor }) }
    })
    if (generation !== searchGeneration) return
    catalog = page
    if (opening) setupFilters(page)
    projectName.textContent = page.projectName
    if (!cursor) {
      visible.clear()
      results.replaceChildren()
    }
    let revisionChanged = false
    for (const item of page.artifacts) {
      if (selected.has(item.artifactId) && selected.get(item.artifactId)?.revision !== item.revision) {
        selected.delete(item.artifactId)
        revisionChanged = true
      }
      if (!visible.has(item.artifactId)) results.append(row(item))
      visible.set(item.artifactId, item)
    }
    status.textContent = revisionChanged ? pt.REVISION_CONFLICT : visible.size ? '' : pt.noResults
    if (revisionChanged) selectionChanged()
    more.hidden = !page.nextCursor
    renderActions()
  } catch (error) {
    if (generation !== searchGeneration) return
    if (!invalidate(codeOf(error))) {
      status.textContent = pickerError(codeOf(error))
      retry.hidden = false
    }
  } finally {
    clearTimeout(loading)
    if (generation === searchGeneration) more.disabled = false
  }
}

function search(delay = 0) {
  clearTimeout(searchTimer)
  const generation = ++searchGeneration
  const filters = currentFilters()
  more.hidden = true
  if (!ready) return
  if (delay) searchTimer = setTimeout(() => void load(generation, filters), delay)
  else void load(generation, filters)
}

async function doSelection(action: 'copy' | 'download' | 'attach' | 'text') {
  if (!catalog || !selected.size || actionPending) return
  const generation = estimateGeneration
  const scope = catalog.scope
  const requested = selection()
  actionPending = true
  actionStatus.textContent = pt.working
  renderActions()
  try {
    const response = await request<DraftOutcome | PickerAttachment | PickerDownload | { outcome: 'copied' }>({ action, scope, selected: requested })
    if (catalog?.scope.binding !== scope.binding) return
    if (action === 'text' && (response.outcome === 'inserted' || response.outcome === 'uncertain')) {
      if (generation === estimateGeneration) textAttempted = true
    }
    if (response.outcome === 'downloaded') {
      actionStatus.textContent = `${pt.downloaded} ${response.directory}. ${pt.manualAttach}`
    } else if ('confirmed' in response) {
      if (generation === estimateGeneration) attachmentFallback = true
      const message = response.outcome === 'attached' ? pt.attached
        : response.outcome === 'partial' ? pt.attachPartial
        : response.outcome === 'uncertain' ? pt.attachUncertain
        : response.outcome === 'failed' ? pt.attachFailed : pt.attachUnavailable
      actionStatus.textContent = [
        message,
        response.confirmed.length ? `${pt.confirmed} · ${response.confirmed.join(', ')}` : '',
        response.failed?.length ? `${pt.rejected} · ${response.failed.join(', ')}` : '',
        response.pending.length ? `${pt.pending} · ${response.pending.join(', ')}` : ''
      ].filter(Boolean).join(' ')
    } else {
      actionStatus.textContent = response.outcome === 'copied' ? pt.copied
        : response.outcome === 'inserted' ? pt.inserted
        : response.outcome === 'uncertain' ? pt.verifyDraft : pt.PICKER_INSERT_UNAVAILABLE
    }
  } catch (error) {
    if (catalog?.scope.binding === scope.binding && generation === estimateGeneration) invalidate(codeOf(error))
    const code = codeOf(error)
    if (action === 'attach' && generation === estimateGeneration &&
      ['PICKER_ATTACH_UNAVAILABLE', 'PICKER_ATTACH_ALREADY_ATTEMPTED', 'PICKER_FILES_TOO_LARGE', 'PICKER_MEDIA_DOWNLOAD_REQUIRED'].includes(code)) {
      attachmentFallback = true
    }
    actionStatus.textContent = code === 'PICKER_ATTACH_UNAVAILABLE' ? pt.attachUnavailable : pickerError(code)
  } finally {
    actionPending = false
    renderActions()
  }
}

form.addEventListener('submit', event => event.preventDefault())
form.querySelector('input')?.addEventListener('input', () => search(250))
for (const field of form.querySelectorAll('select')) field.addEventListener('change', () => search())
more.addEventListener('click', event => {
  if (event.isTrusted && !more.disabled && catalog?.nextCursor) {
    void load(++searchGeneration, currentFilters(), catalog.nextCursor)
  }
})
retry.addEventListener('click', () => search())
copy.addEventListener('click', event => { if (event.isTrusted) void doSelection('copy') })
attach.addEventListener('click', event => { if (event.isTrusted) void doSelection(shouldDownload() ? 'download' : 'attach') })
insert.addEventListener('click', event => { if (event.isTrusted && !textAttempted) void doSelection('text') })
selectionToggle.addEventListener('click', () => {
  const expanded = selectionToggle.getAttribute('aria-expanded') !== 'true'
  selectionToggle.setAttribute('aria-expanded', String(expanded))
  selectionPanel.classList.toggle('is-expanded', expanded)
  selectedList.hidden = !expanded
})
close.addEventListener('click', closePanel)
document.addEventListener('keydown', event => { if (event.key === 'Escape') closePanel() })
renderSelection()
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.type !== 'PICKER_PANEL_READY' || ready) return
  ready = true
  search()
  form.querySelector('input')?.focus({ preventScroll: true })
})
if (window.parent !== window) window.parent.postMessage({ type: 'PICKER_PANEL_HELLO', challenge }, '*')
