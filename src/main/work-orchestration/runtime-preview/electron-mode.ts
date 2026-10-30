import { pathToFileURL } from 'node:url'
import { BrowserWindow, ipcMain, type App } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { validatePreviewContext } from './context-bootstrap'
import type { PreviewContextManifest } from './context-contract'
import { startPreviewChannel } from './channel-server'
import { hash, verify } from '../preview-build/files'

export const isRuntimePreview = () => ['PREVIEW_SESSION_ID', 'PREVIEW_SESSION_CONFIG', 'PREVIEW_SESSION_DIRECTORY'].some(key => process.env[key] !== undefined)
let context: PreviewContextManifest | undefined
let boundContext: { mode: 'PREVIEW'; repositoryId: string; worktreeId: string; generation: string; profileRevision: number; activeCheckout: string; identity: 'IDENTITY_BOUND'; data: PreviewContextManifest['data'] } | undefined
let saveEvidence: (() => void) | undefined
let channelConfiguration: { token: string; directory: string } | undefined
let revokeChannel: (() => Promise<void>) | undefined
export const previewBootstrapContext = () => context ? structuredClone(context) : undefined
export async function bindPreviewContext(repositoryId: string, checkout: string, readiness: () => Record<string, { state: string; reasonCode?: string }> | undefined) {
  if (!context || repositoryId !== context.selection.repositoryId || realpathSync(checkout).toLowerCase() !== context.worktree.toLowerCase()) throw new Error('PREVIEW_CONTEXT_BINDING_MISMATCH')
  boundContext = { mode: 'PREVIEW', repositoryId, worktreeId: context.selection.worktreeId, generation: context.selection.generation,
    profileRevision: context.profileRevision, activeCheckout: context.worktree, identity: 'IDENTITY_BOUND', data: context.data }
  saveEvidence?.()
  if (context.data.policy === 'ARTIFACT_FIRST') {
    if (!channelConfiguration || revokeChannel) throw Error('PREVIEW_CHANNEL_CONFIGURATION_INVALID')
    revokeChannel = await startPreviewChannel(context, channelConfiguration.token, channelConfiguration.directory, readiness)
  }
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
  context = await validatePreviewContext(config.context, { sessionId: config.sessionId, profile: config.profile, approvedProfile: config.approvedProfile, directory, worktree, snapshot: config.mode === 'SNAPSHOT' ? config.snapshot : undefined })
  if (context.data.policy === 'ARTIFACT_FIRST') channelConfiguration = { token: config.channelToken, directory }
  app.on('before-quit', () => { void revokeChannel?.() })
  if (config.mode === 'SNAPSHOT') {
    const snapshot = config.snapshot
    if (!context.snapshot || snapshot.buildId !== context.snapshot.buildId || snapshot.captureId !== context.snapshot.captureId || snapshot.runtimeId !== context.snapshot.runtimeId || resolve(app.getAppPath()) !== resolve(snapshot.bundle, 'app')) throw Error('PREVIEW_BUILD_IDENTITY_MISMATCH')
    await verify(snapshot.bundle, snapshot.manifest.files)
    const file = join(directory, 'snapshot-evidence.json')
    const evidence = { sessionId: config.sessionId, pid: process.pid, runtime: process.versions.electron, abi: process.versions.modules,
      buildId: snapshot.buildId, captureId: snapshot.captureId, runtimeId: snapshot.runtimeId,
      mainDigest: hash(readFileSync(join(app.getAppPath(), 'out/main/main.js'))),
      preloadDigest: hash(readFileSync(join(app.getAppPath(), 'out/preload/preload.js'))),
      rendererDigest: hash(readFileSync(join(app.getAppPath(), 'out/renderer/index.html'))),
      rendererPid: null as number | null, sandboxObserved: null as boolean | null, functionalAt: null as string | null, rendererFailure: null as string | null, contextBound: false }
    saveEvidence = () => { evidence.contextBound = !!boundContext; writeFileSync(file, JSON.stringify(evidence)) }
    saveEvidence()
    ipcMain.on('runtime-preview:preload-initialized', (event, payload) => {
      if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) return
      evidence.sandboxObserved = payload?.sandboxed === true && payload?.contextIsolated === true
      evidence.functionalAt = null; saveEvidence?.()
    })
    ipcMain.on('runtime-preview:functional', event => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window || event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== pathToFileURL(join(app.getAppPath(), 'out/renderer/index.html')).href || !boundContext) return
      evidence.rendererPid = event.sender.getOSProcessId(); evidence.functionalAt = new Date().toISOString(); evidence.rendererFailure = null; saveEvidence?.()
    })
    app.on('browser-window-created', (_event, window) => {
      window.webContents.on('render-process-gone', (_event, details) => { evidence.rendererFailure = details.reason; evidence.functionalAt = null; saveEvidence?.() })
      window.webContents.on('preload-error', () => { evidence.rendererFailure = 'PRELOAD_FAILURE'; evidence.functionalAt = null; saveEvidence?.() })
    })
    return
  }
  let preload: Build[] = [], rendererPid: number | null = null, rendererFailure: string | null = null, sandboxObserved: boolean | null = null
  const rendererModules = new Map<string, { path: string; sourceDigest: string; transformDigest: string }>()
  const save = () => {
    writeFileSync(join(directory, 'electron-evidence.json'), JSON.stringify({ sessionId: config.sessionId, pid: process.pid,
      runtime: process.versions.electron, abi: process.versions.modules, builds: [...(globalThis.__RUNTIME_PREVIEW_BUILDS__ ?? []), ...preload],
      rendererPid, rendererFailure, sandboxObserved, rendererModules: [...rendererModules.values()], resourcesIsolated, channelDisabled: true, protocolDisabled: true,
      ...(boundContext ? { context: boundContext } : {}),
      processes: app.isReady() ? app.getAppMetrics().map(p => ({ pid: p.pid, type: p.type })) : []
    }))
  }
  saveEvidence = save
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
      rendererModules.set(report.path, report); rendererPid = event.sender.getOSProcessId(); save()
    } catch { }
  })
  app.on('browser-window-created', (_event, window) => {
    window.webContents.on('did-finish-load', () => { rendererPid = window.webContents.getOSProcessId(); save() })
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
