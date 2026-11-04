import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { CodexArchiveBridge } from '../session-context/codex-archive-bridge'
import { candidateView, discoverCodexArchive, verifyCodexCandidate, type CodexCandidate, type CodexDiscovery } from '../session-context/codex-discovery'

export function registerCodexArchiveHandlers(getBridge: () => CodexArchiveBridge | undefined, getWindow: () => BrowserWindow | null, trustedUrl: string, discover = discoverCodexArchive): void {
  const selections = new WeakMap<CodexArchiveBridge, { discovery: CodexDiscovery; selected?: CodexCandidate; manual?: boolean }>()
  const operations = new WeakMap<CodexArchiveBridge, object>()
  const begin = (bridge: CodexArchiveBridge) => { const operation = {}; operations.set(bridge, operation); return operation }
  const bind = (name: string, callback: (window: BrowserWindow, bridge: CodexArchiveBridge | undefined, selection?: string) => unknown, acceptsSelection = false) => {
    ipcMain.handle('codex-archive:' + name, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const window = getWindow(), url = event.senderFrame?.url
      if ((acceptsSelection ? args.length !== 1 || typeof args[0] !== 'string' || !/^[a-f0-9]{64}$/.test(args[0]) : args.length !== 0) || !window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || !url || new URL(url).href.split('#')[0] !== new URL(trustedUrl).href.split('#')[0]) throw new Error('UNAUTHORIZED')
      return callback(window, getBridge(), args[0] as string | undefined)
    })
  }
  const current = (window: BrowserWindow, bridge: CodexArchiveBridge) => {
    if (bridge !== getBridge() || window !== getWindow() || window.isDestroyed()) throw new Error('PROJECT_CONTEXT_CHANGED')
  }
  const snapshot = (bridge: CodexArchiveBridge) => {
    const selection = selections.get(bridge)
    return { ...bridge.inspect(), ...(selection ? { discovery: { ...selection.discovery.view, selectedId: selection.selected?.id } } : {}) }
  }
  const canceled = (bridge: CodexArchiveBridge) => {
    const result = snapshot(bridge)
    return { ...result, ...(result.discovery ? { discovery: { ...result.discovery, reason: 'CANCELED' } } : {}) }
  }
  bind('inspect', async (window, bridge) => {
    if (!bridge) return { state: 'NOT_CONFIGURED' }
    if (['READY', 'CONNECTING'].includes(bridge.inspect().state) && selections.has(bridge)) return snapshot(bridge)
    const operation = begin(bridge)
    const discovery = await discover(); current(window, bridge)
    if (operations.get(bridge) !== operation) return snapshot(bridge)
    selections.set(bridge, { discovery, selected: discovery.view.state === 'ONE_VERIFIED_CANDIDATE' ? discovery.candidates[0] : undefined })
    return snapshot(bridge)
  })
  bind('select', (window, bridge, id) => {
    if (!bridge) throw new Error('UNAUTHORIZED')
    if (['READY', 'CONNECTING'].includes(bridge.inspect().state)) throw new Error('UNAUTHORIZED')
    current(window, bridge)
    const selection = selections.get(bridge), selected = selection?.discovery.candidates.find(candidate => candidate.id === id)
    if (!selection || !selected) throw new Error('UNAUTHORIZED')
    begin(bridge)
    selection.selected = selected
    return snapshot(bridge)
  }, true)
  bind('disable', (_window, bridge) => {
    if (!bridge) return { state: 'NOT_CONFIGURED' }
    begin(bridge)
    bridge.disable(); return snapshot(bridge)
  })
  bind('enable', async (window, bridge) => {
    if (!bridge) return { state: 'NOT_CONFIGURED' }
    const selection = selections.get(bridge), selected = selection?.selected
    if (!selection || !selected) return snapshot(bridge)
    const operation = begin(bridge)
    try {
      const verified = await verifyCodexCandidate(selected.profile)
      current(window, bridge)
      if (verified.pin !== selected.pin) throw new Error('CANDIDATE_CHANGED')
      if (!selection.manual) {
        const latest = await discover(); current(window, bridge)
        if (latest.candidates.map(item => item.id).sort().join() !== selection.discovery.candidates.map(item => item.id).sort().join()) throw new Error('CANDIDATE_CHANGED')
      }
      if (operations.get(bridge) !== operation) return snapshot(bridge)
      if (selections.get(bridge) !== selection || selection.selected !== selected) throw new Error('CANDIDATE_CHANGED')
      await bridge.enable(selected.profile, selected.pin)
    } catch {
      current(window, bridge)
      if (operations.get(bridge) !== operation) return snapshot(bridge)
      selections.delete(bridge); bridge.disable('EXECUTABLE_UNAVAILABLE')
      return { ...bridge.inspect(), discovery: { state: 'INVALID', reason: 'CANDIDATE_CHANGED', candidates: [] } }
    }
    return snapshot(bridge)
  })
  bind('choose-advanced', async (window, bridge) => {
    if (!bridge) return { state: 'NOT_CONFIGURED' }
    if (['READY', 'CONNECTING'].includes(bridge.inspect().state)) throw new Error('UNAUTHORIZED')
    const operation = begin(bridge)
    const executable = await dialog.showOpenDialog(window, { title: 'Selecione o executável Codex', properties: ['openFile'], filters: [{ name: 'Codex', extensions: ['exe'] }] })
    current(window, bridge)
    if (operations.get(bridge) !== operation) return snapshot(bridge)
    if (executable.canceled || executable.filePaths.length !== 1) return canceled(bridge)
    const profile = await dialog.showOpenDialog(window, { title: 'Selecione o perfil Codex', properties: ['openDirectory'] })
    current(window, bridge)
    if (operations.get(bridge) !== operation) return snapshot(bridge)
    if (profile.canceled || profile.filePaths.length !== 1) return canceled(bridge)
    try {
      const selected = await verifyCodexCandidate({ executable: executable.filePaths[0], directory: profile.filePaths[0] }); current(window, bridge)
      if (operations.get(bridge) !== operation) return snapshot(bridge)
      selections.set(bridge, { manual: true, selected, discovery: { view: { state: 'ONE_VERIFIED_CANDIDATE', candidates: [candidateView(selected)] }, candidates: [selected] } })
      return snapshot(bridge)
    } catch {
      current(window, bridge)
      selections.delete(bridge)
      return { ...bridge.inspect(), discovery: { state: 'INVALID', reason: 'UNSAFE_CANDIDATE', candidates: [] } }
    }
  })
}
