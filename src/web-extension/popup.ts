import { isPopupPickerRequest } from '../shared/web-activation/context-picker-contract'
import { labelFor, localize, messages as pt, platformNames } from './locale'
import { positionKey, positions, resolveBarPreferences, visibilityKey } from './floating-bar-preferences'
import { contextPickerSites, type ContextPickerSite } from '../shared/web-activation/context-picker-sites'
import { getChromeApi } from './chrome-api'

interface StatusResult {
  available?: boolean
  mode?: 'PROJECT' | 'GLOBAL_ONLY'
  projectId?: string | null
  consentProjectKey?: string
  consents?: {
    metadata: boolean
    literalSource: boolean
  }
}

function detectSiteFromUrl(urlValue: string | undefined): { site: 'deepseek' | 'qwen'; origin: string } | null {
  if (!urlValue) return null
  try {
    const parsed = new URL(urlValue)
    const origin = parsed.origin.toLowerCase()
    if (origin === 'https://chat.deepseek.com') return { site: 'deepseek', origin }
    if (origin === 'https://chat.qwen.ai') return { site: 'qwen', origin }
  } catch {
    // Ignore non-URL tabs
  }
  return null
}

function sendRuntime<T>(msg: Record<string, unknown>): Promise<T> {
  const chromeApi = getChromeApi()
  return new Promise((resolve) => {
    if (!chromeApi?.runtime?.sendMessage) {
      resolve({ ok: false, error: { message: 'chrome.runtime unavailable' } } as T)
      return
    }
    chromeApi.runtime.sendMessage(msg, (res) => {
      resolve((res ?? { ok: false }) as T)
    })
  })
}

function sendTab<T>(tabId: number, msg: Record<string, unknown>): Promise<T | null> {
  const chromeApi = getChromeApi()
  return new Promise((resolve) => {
    if (!chromeApi?.tabs?.sendMessage) {
      resolve(null)
      return
    }
    chromeApi.tabs.sendMessage(tabId, msg, (res) => {
      if (chromeApi.runtime?.lastError) {
        resolve(null)
        return
      }
      resolve((res as T) ?? null)
    })
  })
}

function mountPickerView(doc: Document): void {
  const win = doc.defaultView
  const settings = doc.getElementById('settings-view')
  const picker = doc.getElementById('picker-view')
  const open = doc.getElementById('open-picker')
  const back = doc.getElementById('back-to-settings')
  if (!win || !settings || !picker || !open || !back) return
  let frame: HTMLIFrameElement | undefined
  const origin = win.location.origin
  const close = () => {
    frame?.remove()
    frame = undefined
    picker.hidden = true
    settings.hidden = false
    doc.body.classList.remove('picker-open')
    open.focus()
  }
  const receive = (event: MessageEvent) => {
    const current = frame
    if (!current || event.source !== current.contentWindow || event.origin !== origin) return
    if (event.data?.type === 'PICKER_PANEL_HELLO') {
      current.contentWindow?.postMessage({ type: 'PICKER_POPUP_READY' }, origin)
    } else if (event.data?.type === 'PICKER_PANEL_CLOSE') {
      close()
    } else if (event.data?.type === 'PICKER_POPUP_REQUEST' && Number.isSafeInteger(event.data.id) &&
      isPopupPickerRequest(event.data.request)) {
      const { id, request } = event.data
      void sendRuntime<unknown>({ type: 'PICKER_POPUP_REQUEST', request }).then(response => {
        if (frame === current) current.contentWindow?.postMessage({ type: 'PICKER_POPUP_RESPONSE', id, response }, origin)
      })
    }
  }
  open.addEventListener('click', () => {
    if (frame) return
    frame = doc.createElement('iframe')
    frame.title = pt.picker
    frame.src = 'context-picker.html'
    settings.hidden = true
    picker.hidden = false
    doc.body.classList.add('picker-open')
    picker.append(frame)
  })
  back.addEventListener('click', close)
  win.addEventListener('message', receive)
}

function mountBarSettings(doc: Document, storage: NonNullable<ReturnType<typeof getChromeApi>>['storage']): void {
  const master = doc.querySelector<HTMLInputElement>('#floating-bar-visible')
  const globalPosition = doc.querySelector<HTMLSelectElement>('#floating-bar-global')
  const rows = doc.getElementById('floating-bar-sites')
  const suspended = doc.getElementById('floating-bar-suspended')
  if (!storage?.local || !master || !globalPosition || !rows || !suspended) return
  const local = storage.local
  const labels = [pt.topLeft, pt.topRight, pt.bottomLeft, pt.bottomRight]
  const options = () => positions.map((position, index) => new Option(labels[index], position))
  globalPosition.replaceChildren(...options())
  const sites = Object.keys(contextPickerSites) as ContextPickerSite[]
  const controls = sites.map(site => {
    const row = doc.createElement('fieldset')
    const name = doc.createElement('legend')
    name.textContent = platformNames[site]
    const show = doc.createElement('input')
    show.type = 'checkbox'
    const position = doc.createElement('select')
    const showLabel = doc.createElement('label')
    const positionLabel = doc.createElement('label')
    showLabel.className = positionLabel.className = 'row'
    show.setAttribute('aria-label', pt.floatingBarVisible + " · " + platformNames[site])
    position.setAttribute('aria-label', pt.barPosition + " · " + platformNames[site])
    showLabel.append(pt.floatingBarVisible, show)
    positionLabel.append(pt.barPosition, position)
    position.replaceChildren(new Option(pt.inherit, ''), ...options())
    row.append(name, showLabel, positionLabel)
    rows.append(row)
    show.addEventListener('change', () => local.set({ [visibilityKey(site)]: show.checked }))
    position.addEventListener('change', () => local.set({ [positionKey(site)]: position.value || null }))
    return { site, show, position }
  })
  const keys = [visibilityKey(), positionKey(), ...sites.flatMap(site => [visibilityKey(site), positionKey(site)])]
  let generation = 0
  const refresh = () => {
    const version = ++generation
    local.get(keys, items => {
      if (version !== generation) return
      const defaults = resolveBarPreferences(items)
      master.checked = defaults.masterVisible
      master.disabled = false
      globalPosition.value = defaults.position
      suspended.hidden = defaults.masterVisible
      for (const { site, show, position } of controls) {
        const preferences = resolveBarPreferences(items, site)
        show.checked = preferences.siteVisible
        position.value = preferences.override ?? ''
        position.options[0].text = `${pt.inherit} · ${labels[positions.indexOf(preferences.defaultLocation)]}`
      }
    })
  }
  master.addEventListener('change', () => local.set({ [visibilityKey()]: master.checked }, refresh))
  globalPosition.addEventListener('change', () => local.set({ [positionKey()]: globalPosition.value }, refresh))
  storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && keys.some(key => key in changes)) refresh()
  })
  refresh()
}

export async function initPopup(): Promise<void> {
  const doc = (globalThis as unknown as { document?: Document }).document
  const chromeApi = getChromeApi()
  if (!doc) return
  localize(doc)
  mountPickerView(doc)
  mountBarSettings(doc, chromeApi?.storage)
  if (!chromeApi?.tabs) return

  const desktopBadge = doc.getElementById('desktop-status')!
  const scopeLabel = doc.getElementById('scope-label')!
  const siteLabel = doc.getElementById('site-label')!
  const stateBadge = doc.getElementById('session-state')!
  const metaToggle = doc.getElementById('consent-metadata') as HTMLInputElement
  const literalToggle = doc.getElementById('consent-literal') as HTMLInputElement
  const btnActivate = doc.getElementById('btn-activate') as HTMLButtonElement
  const btnNewChat = doc.getElementById('btn-new-chat') as HTMLButtonElement
  const btnRevoke = doc.getElementById('btn-revoke') as HTMLButtonElement
  const errorBox = doc.getElementById('status-message')!

  const tabs = await new Promise<Array<{ id?: number; url?: string }>>((resolve) => {
    chromeApi.tabs!.query({ active: true, currentWindow: true }, resolve)
  })
  const activeTab = tabs[0]
  const tabId = activeTab?.id
  const detected = detectSiteFromUrl(activeTab?.url)
  const activationSettings = doc.getElementById('activation-settings')
  if (activationSettings && !detected) activationSettings.hidden = true

  let currentProjectId: string | null = null

  async function refresh(): Promise<void> {
    errorBox.textContent = ''
    errorBox.title = ''
    siteLabel.textContent = detected ? detected.site : pt.unsupportedTab

    const statusRes = await sendRuntime<{ ok: boolean; result?: StatusResult; error?: { message?: string } }>({
      type: 'GET_STATUS',
      ...(detected ? { site: detected.site, webOrigin: detected.origin } : {})
    })

    if (!statusRes.ok || !statusRes.result?.available) {
      desktopBadge.textContent = pt.offline
      desktopBadge.className = 'badge warn'
      scopeLabel.textContent = pt.unavailable
      errorBox.textContent = pt.openDesktop
      errorBox.title = statusRes.error?.message ?? ''
      metaToggle.disabled = true
      literalToggle.disabled = true
      btnActivate.disabled = true
      btnNewChat.disabled = true
      btnRevoke.disabled = true
      return
    }

    const info = statusRes.result
    currentProjectId = info.projectId ?? null
    desktopBadge.textContent = pt.online
    desktopBadge.className = 'badge ok'
    scopeLabel.textContent = info.mode === 'PROJECT' && info.projectId ? `${pt.project} (${info.projectId})` : pt.global

    if (detected && info.consents) {
      metaToggle.checked = info.consents.metadata
      literalToggle.checked = info.consents.literalSource
      metaToggle.disabled = false
      literalToggle.disabled = false
    } else {
      metaToggle.disabled = true
      literalToggle.disabled = true
    }

    if (tabId && detected) {
      const tabState = await sendTab<{
        state?: string
        lastError?: string | null
        lastDelivery?: { status?: string; reason?: string; requestIds?: string[] } | null
        lastDiagnostic?: { code?: string; phase?: string; requestId?: string; message?: string; recoverable?: boolean } | null
      }>(tabId, {
        type: 'CONTENT_GET_STATE'
      })
      stateBadge.textContent = labelFor(tabState?.state ?? 'INACTIVE')
      btnActivate.disabled = false
      btnNewChat.disabled = false
      btnRevoke.disabled = false
      if (tabState?.lastDiagnostic) {
        const d = tabState.lastDiagnostic
        const phase = d.phase ? `[${d.phase}] ` : ''
        const req = d.requestId ? ` (${d.requestId})` : ''
        const actionHint =
          d.code === 'SESSION_INVALIDATED' || d.code === 'SESSION_REVOKED'
            ? pt.reactivate
            : d.code === 'DELIVERY_UNKNOWN' || d.code === 'DELIVERY_RECOVERY_EXPIRED'
              ? pt.verifyDraft
              : ''
        errorBox.textContent = actionHint || pt.sessionProblem
        errorBox.title = `${phase}${d.code ?? 'DIAGNOSTIC'}${req}: ${d.message ?? tabState.lastError ?? ''}${actionHint}`
      } else if (tabState?.lastError) {
        errorBox.textContent = pt.sessionProblem
        errorBox.title = tabState.lastError
      } else if (tabState?.lastDelivery && !tabState.lastDelivery.reason && tabState.lastDelivery.status === 'AWAITING_DELIVERY_ACK') {
        errorBox.textContent = pt.awaitDelivery
      }
    } else {
      stateBadge.textContent = labelFor('INACTIVE')
      btnActivate.disabled = true
      btnNewChat.disabled = true
      btnRevoke.disabled = true
    }
  }

  metaToggle.addEventListener('change', async () => {
    if (!detected) return
    await sendRuntime({
      type: 'SET_CONSENT',
      site: detected.site,
      projectId: currentProjectId,
      dataClass: 'METADATA',
      granted: metaToggle.checked,
      webOrigin: detected.origin
    })
    await refresh()
  })

  literalToggle.addEventListener('change', async () => {
    if (!detected) return
    await sendRuntime({
      type: 'SET_CONSENT',
      site: detected.site,
      projectId: currentProjectId,
      dataClass: 'LITERAL_SOURCE',
      granted: literalToggle.checked,
      webOrigin: detected.origin
    })
    await refresh()
  })

  btnActivate.addEventListener('click', async () => {
    if (!tabId) return
    const res = await sendTab<{ ok?: boolean; error?: { message?: string } }>(tabId, {
      type: 'CONTENT_ACTIVATE',
      sendBootstrap: true
    })
    if (res && !res.ok && res.error?.message) {
      errorBox.textContent = pt.sessionProblem
      errorBox.title = res.error.message
    }
    await refresh()
  })

  btnNewChat.addEventListener('click', async () => {
    if (!tabId) return
    await sendTab(tabId, { type: 'CONTENT_NEW_CHAT' })
    await refresh()
  })

  btnRevoke.addEventListener('click', async () => {
    if (detected) {
      await sendRuntime({
        type: 'SET_CONSENT',
        site: detected.site,
        projectId: currentProjectId,
        dataClass: 'METADATA',
        granted: false,
        webOrigin: detected.origin
      })
      await sendRuntime({
        type: 'SET_CONSENT',
        site: detected.site,
        projectId: currentProjectId,
        dataClass: 'LITERAL_SOURCE',
        granted: false,
        webOrigin: detected.origin
      })
    }
    if (tabId) {
      await sendTab(tabId, { type: 'CONTENT_REVOKE' })
    }
    await refresh()
  })

  if (detected || !activationSettings) await refresh()
}

if (typeof (globalThis as { document?: unknown }).document !== 'undefined') {
  void initPopup()
}
