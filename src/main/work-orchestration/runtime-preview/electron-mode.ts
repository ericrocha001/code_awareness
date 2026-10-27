import { BrowserWindow, ipcMain, type App } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, realpathSync, watch } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { validatePreviewContext } from './context-bootstrap'
import type { PreviewContextManifest } from './context-contract'

export const isRuntimePreview = () => ['PREVIEW_SESSION_ID', 'PREVIEW_SESSION_CONFIG', 'PREVIEW_SESSION_DIRECTORY'].some(key => process.env[key] !== undefined)
let context: PreviewContextManifest | undefined
let boundContext: { mode: 'PREVIEW'; repositoryId: string; worktreeId: string; generation: string; profileRevision: number; activeCheckout: string; identity: 'IDENTITY_BOUND'; data: PreviewContextManifest['data'] } | undefined
let saveEvidence: (() => void) | undefined
export const previewBootstrapContext = () => context ? structuredClone(context) : undefined
export function previewStartsHidden() {
  if (!isRuntimePreview()) return false
  return JSON.parse(readFileSync(process.env.PREVIEW_SESSION_CONFIG!, 'utf8')).prepareHidden === true
}
export function bindPreviewContext(repositoryId: string, checkout: string) {
  if (!context || repositoryId !== context.selection.repositoryId || realpathSync(checkout).toLowerCase() !== context.worktree.toLowerCase()) throw new Error('PREVIEW_CONTEXT_BINDING_MISMATCH')
  boundContext = { mode: 'PREVIEW', repositoryId, worktreeId: context.selection.worktreeId, generation: context.selection.generation,
    profileRevision: context.profileRevision, activeCheckout: context.worktree, identity: 'IDENTITY_BOUND', data: context.data }
  saveEvidence?.()
}
type Build = { component: string; artifactDigest: string; sources: Record<string, string> }
declare global { var __RUNTIME_PREVIEW_BUILDS__: Build[] | undefined }
export async function initializeElectronPreview(app: App) {
  const file = process.env.PREVIEW_SESSION_CONFIG
  if (!file) throw new Error('PREVIEW_CONFIGURATION_REQUIRED')
  const config = JSON.parse(readFileSync(file, 'utf8'))
  const directory = realpathSync(process.env.PREVIEW_SESSION_DIRECTORY!), worktree = realpathSync(process.cwd())
  if (config.sessionId !== process.env.PREVIEW_SESSION_ID || config.kind !== 'ELECTRON' || config.directory !== directory || config.worktree.toLowerCase() !== worktree.toLowerCase()) throw new Error('PREVIEW_CONFIGURATION_INVALID')
  for (const resource of ['appData', 'userData', 'sessionData', 'home', 'temp']) {
    const target = resolve(directory, resource), scope = relative(directory, target)
    if (!scope || scope.startsWith('..') || isAbsolute(scope)) throw new Error('PREVIEW_RESOURCE_INVALID')
    mkdirSync(target, { recursive: true })
    app.setPath(resource as 'appData' | 'userData' | 'sessionData' | 'home' | 'temp', target)
  }
  app.setName('code-awareness-preview-' + config.sessionId)
  mkdirSync(join(directory, 'cache'), { recursive: true })
  app.commandLine.appendSwitch('disk-cache-dir', join(directory, 'cache'))
  app.enableSandbox()
  const resourcesIsolated = ['appData', 'userData', 'sessionData', 'home', 'temp'].every(resource => {
    const scope = relative(directory, realpathSync(app.getPath(resource as 'appData' | 'userData' | 'sessionData' | 'home' | 'temp')))
    return !!scope && !scope.startsWith('..') && !isAbsolute(scope)
  })
  if (!resourcesIsolated) throw new Error('PREVIEW_RESOURCE_ESCAPED')
  context = await validatePreviewContext(config.context, { sessionId: config.sessionId, profile: config.profile, approvedProfile: config.approvedProfile, directory, worktree })
  let preload: Build[] = [], rendererPid: number | null = null, rendererFailure: string | null = null, sandboxObserved: boolean | null = null
  const rendererModules = new Map<string, { path: string; sourceDigest: string; transformDigest: string }>()
  let createdNs: string | null = null, loadedNs: string | null = null, presentedNs: string | null = null
  let quiescent = false, controlId = '', showNs: string | null = null, functionalNs: string | null = null, focusedNs: string | null = null
  let controlBusy = false
  const save = () => {
    const visible = app.isReady() && BrowserWindow.getAllWindows().some(window => window.isVisible() && window.webContents.getOSProcessId() === rendererPid && !window.webContents.isLoadingMainFrame())
    if (visible && rendererModules.size && sandboxObserved && !rendererFailure) presentedNs ??= process.hrtime.bigint().toString()
    writeFileSync(join(directory, 'electron-evidence.json'), JSON.stringify({ sessionId: config.sessionId, pid: process.pid,
      runtime: process.versions.electron, abi: process.versions.modules, builds: [...(globalThis.__RUNTIME_PREVIEW_BUILDS__ ?? []), ...preload],
      rendererPid, rendererFailure, sandboxObserved, rendererModules: [...rendererModules.values()], resourcesIsolated, channelDisabled: true, protocolDisabled: true,
      window: { visible, rendererInitialized: rendererModules.size > 0, createdNs, loadedNs, presentedNs,
        hiddenReady: !!boundContext && !!rendererModules.size && !!sandboxObserved && !rendererFailure && !!loadedNs,
        quiescent, focused: app.isReady() && BrowserWindow.getAllWindows().some(window => window.isFocused()), controlId, showNs, functionalNs, focusedNs },
      ...(boundContext ? { context: boundContext } : {}),
      processes: app.isReady() ? app.getAppMetrics().map(p => ({ pid: p.pid, type: p.type })) : []
    }))
  }
  saveEvidence = save
  ipcMain.on('runtime-preview:activity-confirmed', (event, value) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || event.senderFrame !== event.sender.mainFrame || value?.controlId !== controlId || typeof value.quiescent !== 'boolean') return
    quiescent = value.quiescent
    if (!quiescent && window.isVisible() && window.isFocused() && value.functional === true && boundContext && rendererModules.size && !rendererFailure) {
      functionalNs = process.hrtime.bigint().toString(); focusedNs = functionalNs
    }
    save()
  })
  const activity = (window: BrowserWindow, quiet: boolean) => window.webContents.send('runtime-preview:activity', { quiescent: quiet, controlId })
  const controlWatcher = watch(directory, { persistent: false }, (_event, name) => {
    if (String(name) !== 'preview-control.json' || controlBusy) return
    try {
      const file = join(directory, 'preview-control.json'), raw = readFileSync(file)
      if (raw.length > 1024) return
      const request = JSON.parse(raw.toString())
      if (request.sessionId !== config.sessionId || request.token !== config.token || !/^[a-f0-9-]{36}$/.test(request.controlId) || request.controlId === controlId || !['SHOW', 'QUIESCE'].includes(request.action)) return
      const window = BrowserWindow.getAllWindows().find(value => value.webContents.getOSProcessId() === rendererPid)
      if (!window || !boundContext || !rendererModules.size || rendererFailure) return
      controlBusy = true; controlId = request.controlId; functionalNs = null; focusedNs = null
      if (request.action === 'SHOW') { showNs = process.hrtime.bigint().toString(); window.show(); window.focus(); activity(window, false) }
      else { window.hide(); activity(window, true) }
      save()
    } catch { }
    finally { controlBusy = false }
  })
  app.once('will-quit', () => controlWatcher.close())
  ipcMain.on('runtime-preview:preload-initialized', (event, payload: { builds: unknown; sandboxed: unknown; contextIsolated: unknown }) => {
    const builds = payload?.builds
    if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame || !Array.isArray(builds) || builds.length > 8) return
    if (!builds.every(b => b.component === 'ELECTRON_PRELOAD' && /^[a-f0-9]{64}$/.test(b.artifactDigest) && b.sources && Object.keys(b.sources).length <= 12)) return
    preload = builds; sandboxObserved = payload.sandboxed === true && payload.contextIsolated === true; rendererFailure = null; rendererModules.clear(); save()
  })
  ipcMain.on('runtime-preview:renderer-initialized', (event, report: { path: string; sourceDigest: string; transformDigest: string }) => {
    if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame || !report || typeof report.path !== 'string') return
    const file = join(directory, 'renderer-transforms.json')
    try {
      const transforms = JSON.parse(readFileSync(file, 'utf8')) as Array<{ path: string; sourceDigest: string; transformDigest: string }>
      if (transforms.length > 12 || !transforms.some(t => t.path === report.path && t.sourceDigest === report.sourceDigest && t.transformDigest === report.transformDigest)) return
      rendererModules.set(report.path, report); rendererPid = event.sender.getOSProcessId(); if (config.prepareHidden && !controlId && !quiescent) activity(BrowserWindow.fromWebContents(event.sender)!, true); save(); setImmediate(save)
    } catch { }
  })
  app.on('browser-window-created', (_event, window) => {
    createdNs ??= process.hrtime.bigint().toString()
    window.on('show', save)
    window.webContents.on('did-stop-loading', save)
    window.webContents.on('did-finish-load', () => { loadedNs ??= process.hrtime.bigint().toString(); rendererPid = window.webContents.getOSProcessId(); if (config.prepareHidden) activity(window, true); save() })
    window.webContents.on('render-process-gone', (_event, details) => { rendererFailure = details.reason; rendererPid = null; rendererModules.clear(); save() })
    window.webContents.on('preload-error', () => { preload = []; rendererFailure = 'PRELOAD_FAILURE'; save() })
  })
  void app.whenReady().then(save)
}

export function failPreviewBootstrap(app: App, error: unknown): never {
  const code = error instanceof Error && /^PREVIEW_[A-Z_]{1,120}$/.test(error.message) ? error.message : 'PREVIEW_BOOTSTRAP_FAILED'
  try {
    const file = process.env.PREVIEW_SESSION_CONFIG, directory = realpathSync(process.env.PREVIEW_SESSION_DIRECTORY!)
    const config = JSON.parse(readFileSync(file!, 'utf8'))
    if (realpathSync(config.directory) === directory && config.sessionId === process.env.PREVIEW_SESSION_ID && resolve(file!) === join(directory, 'configuration.json')) {
      writeFileSync(join(directory, 'bootstrap-failure.json'), JSON.stringify({ sessionId: config.sessionId, code }), { flag: 'wx', mode: 0o600 })
    }
  } catch { }
  console.error(code)
  app.exit(1)
  process.exit(1)
}
