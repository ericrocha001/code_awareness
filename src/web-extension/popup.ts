import { defaultPosition, detectChatSite, positionKey, positions, readPosition } from './floating-bar'
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

export async function initPopup(): Promise<void> {
  const doc = (globalThis as unknown as { document?: Document }).document
  const chromeApi = getChromeApi()
  if (!doc || !chromeApi?.tabs) return

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
  const floatingBarSite = detectChatSite(activeTab?.url)
  const storage = chromeApi.storage?.local
  const globalPosition = doc.querySelector<HTMLSelectElement>('#floating-bar-global')
  const sitePosition = doc.querySelector<HTMLSelectElement>('#floating-bar-site')
  if (storage && globalPosition && sitePosition) {
    const labels = ['Top left', 'Top right', 'Bottom left', 'Bottom right']
    const options = () => positions.map((position, index) => new Option(labels[index], position))
    globalPosition.replaceChildren(...options())
    globalPosition.addEventListener('change', () => storage.set({ [positionKey()]: globalPosition.value }))
    storage.get(positionKey(), (items) => {
      globalPosition.value = readPosition(items[positionKey()]) ?? defaultPosition
    })
    if (floatingBarSite) {
      const key = positionKey(floatingBarSite)
      doc.getElementById('floating-bar-site-label')!.textContent = activeTab?.url
        ? new URL(activeTab.url).hostname
        : floatingBarSite
      doc.getElementById('floating-bar-site-row')!.hidden = false
      sitePosition.replaceChildren(new Option('Use global position', ''), ...options())
      storage.get(key, (items) => { sitePosition.value = readPosition(items[key]) ?? '' })
      sitePosition.addEventListener('change', () => storage.set({ [key]: sitePosition.value || null }))
    }
  }
  const tabId = activeTab?.id
  const detected = detectSiteFromUrl(activeTab?.url)

  let currentProjectId: string | null = null

  async function refresh(): Promise<void> {
    errorBox.textContent = ''
    siteLabel.textContent = detected ? detected.site : 'Unsupported tab'

    const statusRes = await sendRuntime<{ ok: boolean; result?: StatusResult; error?: { message?: string } }>({
      type: 'GET_STATUS',
      ...(detected ? { site: detected.site, webOrigin: detected.origin } : {})
    })

    if (!statusRes.ok || !statusRes.result?.available) {
      desktopBadge.textContent = 'Offline'
      desktopBadge.className = 'badge warn'
      scopeLabel.textContent = 'Unavailable'
      errorBox.textContent = statusRes.error?.message ?? 'Open Code Awareness Desktop to connect.'
      metaToggle.disabled = true
      literalToggle.disabled = true
      btnActivate.disabled = true
      btnNewChat.disabled = true
      btnRevoke.disabled = true
      return
    }

    const info = statusRes.result
    currentProjectId = info.projectId ?? null
    desktopBadge.textContent = 'Connected'
    desktopBadge.className = 'badge ok'
    scopeLabel.textContent = info.mode === 'PROJECT' && info.projectId ? `PROJECT (${info.projectId})` : 'GLOBAL_ONLY'

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
      stateBadge.textContent = tabState?.state ?? 'INACTIVE'
      btnActivate.disabled = false
      btnNewChat.disabled = false
      btnRevoke.disabled = false
      if (tabState?.lastDiagnostic) {
        const d = tabState.lastDiagnostic
        const phase = d.phase ? `[${d.phase}] ` : ''
        const req = d.requestId ? ` (${d.requestId})` : ''
        const actionHint =
          d.code === 'SESSION_INVALIDATED' || d.code === 'SESSION_REVOKED'
            ? ' Re-activate when ready.'
            : d.code === 'DELIVERY_UNKNOWN' || d.code === 'DELIVERY_RECOVERY_EXPIRED'
              ? ' Verify the chat conversation before continuing.'
              : ''
        errorBox.textContent = `${phase}${d.code ?? 'DIAGNOSTIC'}${req}: ${d.message ?? tabState.lastError ?? ''}${actionHint}`
      } else if (tabState?.lastError) {
        errorBox.textContent = tabState.lastError
      } else if (tabState?.lastDelivery && !tabState.lastDelivery.reason && tabState.lastDelivery.status === 'AWAITING_DELIVERY_ACK') {
        errorBox.textContent = 'Awaiting chat delivery confirmation...'
      }
    } else {
      stateBadge.textContent = 'INACTIVE'
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
      errorBox.textContent = res.error.message
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

  await refresh()
}

if (typeof (globalThis as { document?: unknown }).document !== 'undefined') {
  void initPopup()
}
