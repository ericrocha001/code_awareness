import { BrowserWindow, ipcMain, type App } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'

export const isRuntimePreview = () => Boolean(process.env.PREVIEW_SESSION_ID)
type Build = { component: string; artifactDigest: string; sources: Record<string, string> }
declare global { var __RUNTIME_PREVIEW_BUILDS__: Build[] | undefined }
export function initializeElectronPreview(app: App) {
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
  let preload: Build[] = [], rendererPid: number | null = null, rendererFailure: string | null = null, sandboxObserved: boolean | null = null
  const rendererModules = new Map<string, { path: string; sourceDigest: string; transformDigest: string }>()
  const save = () => {
    writeFileSync(join(directory, 'electron-evidence.json'), JSON.stringify({ sessionId: config.sessionId, pid: process.pid,
      runtime: process.versions.electron, abi: process.versions.modules, builds: [...(globalThis.__RUNTIME_PREVIEW_BUILDS__ ?? []), ...preload],
      rendererPid, rendererFailure, sandboxObserved, rendererModules: [...rendererModules.values()], resourcesIsolated, channelDisabled: true, protocolDisabled: true,
      processes: app.isReady() ? app.getAppMetrics().map(p => ({ pid: p.pid, type: p.type })) : []
    }))
  }
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
