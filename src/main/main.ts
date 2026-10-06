/*
-T ---
*/

import { app, BrowserWindow, Menu, nativeTheme, shell, safeStorage } from 'electron'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { registerFileHandlers } from './ipc/file-handler'
import { registerSettingsHandlers } from './ipc/settings-handler'
import { registerGitHandlers } from './ipc/git-handler'
import { registerCheckpointHandlers } from './ipc/checkpoint-handler'
import { registerRestoreHandlers } from './ipc/restore-handler'
import { registerWorkspaceHandlers } from './ipc/workspace-handler'
import { registerTagHandlers } from './ipc/tag-handler'
import { registerDatabaseHandlers } from './ipc/database-handler'
import { registerCampaignHandlers } from './ipc/campaign-handler'
import { registerDevToolsHandlers } from './ipc/devtools-handler'
import { registerDeepLinkHandlers } from './ipc/deeplink-handler'
import { registerDashHandlers } from './ipc/dash-handler'
import { setPendingDeepLink, emitDeepLinkToRenderer } from './core/deeplink-manager'
import { DevToolsManager } from './core/devtools-manager'
import { settingsService } from './core/settings-service'
import { WorkspaceService } from './core/workspace-service'
import { sanitizeEnvironment } from './utils/env-sanitizer'
import { WatcherService } from './core/watcher-service'
import { getCodeMapService, closeCodeMapService, type CodeMapService } from './core/code-map-service'
import { CompressionService } from './core/compression-service'
import type { ContentIdentityPort } from './core/content-identity-port'
import { registerCodeMapHandlers } from './ipc/code-map-handler'
import { BetterSqlite3DatabaseAdapter } from './core/better-sqlite3-database-adapter'
import { CheckpointService } from './core/checkpoint-service'
import { CampaignService } from './core/campaign-service'
import { RestoreService } from './core/restore-service'
import { GitService } from './core/git-service'
import { CodeSourceService } from './core/code-source-service'
import { DashService } from './core/dash/dash-service'
import { DashFileResolver } from './core/dash/dash-file-resolver'
import { SourceContextProvider } from './core/dash/providers/source-context-provider'
import { CompressionContextProvider } from './core/dash/providers/compression-context-provider'
import { IgnorePolicy } from './core/ignore-policy'
import { OneClickXmlService } from './core/one-click-xml-service'
import { RepomixAdapter } from './core/repomix-adapter'
import { CodeAwarenessIgnoreService } from './core/code-awareness-ignore-service'
import { ContextEngine } from './core/context/context-engine'
import { DashDiscoveryService } from './core/dash/dash-discovery-service'
import { ActiveProjectService } from './core/active-project-service'
import { bindProjectNavigation } from './core/context/project-context-navigation'
import { registerActiveProjectHandlers } from './ipc/active-project-handler'
import { McpLifecycle } from './mcp/mcp-lifecycle'
import { registerApplicationShutdown } from './application-shutdown'
import { ConnectionLifecycle } from './mcp/connection/connection-lifecycle'
import { NgrokTransport } from './mcp/connection/ngrok-transport'
import { RelayTransport } from './mcp/connection/relay-transport'
import { resolveRelayEndpoint } from './mcp/connection/relay-endpoint'
import { SelectedTransport } from './mcp/connection/selected-transport'
import { RemoteAccessService } from './mcp/connection/remote-access-service'
import { InstallationIdentityService } from './installation/installation-identity-service'
import { desktopProfilePaths } from './desktop-profile'
import { registerConnectionHandlers } from './ipc/connection-handler'
import { ChatGptIntegrationProjection } from './integrations/chatgpt-integration-projection'
import { isInstallationConfigured } from './integrations/installation-configured'
import { registerChatGptIntegrationHandlers } from './ipc/chatgpt-integration-handler'
import { CodeScopeHealthMonitor } from './mcp/code-scope-health'
import { SystemHealthCore } from './system-health/system-health-core'
import { RuntimeIdentityProvider } from './runtime-identity/runtime-identity-provider'
import { registerSystemHealthHandlers } from './ipc/system-health-handler'
import { ValidationLedger } from './validation-ledger/validation-ledger'
import { RepositoryContinuumSession } from './continuum/project-continuum-session'
import { CodeMapSyncMonitor, CodeMapSyncDrilldownProvider } from './system-health/codemap-sync-monitor'
import { CodeMapLifecycleMonitor } from './system-health/codemap-lifecycle-monitor'
import { codeScopeExecutionDrilldownProvider } from './system-health/codescope-execution-drilldown'
import { ValidationExecution } from './validation-execution/validation-execution'
import { DiagnosticSourceAccess } from './diagnostic-source-access/diagnostic-source-access'
import { EnvironmentRestartSupervisorClient, RuntimeRestartController } from './runtime-restart/runtime-restart-controller'
import { AcademyService } from './academy/academy-service'
import { registerAcademyHandlers } from './ipc/academy-handler'
import { RepositoryCatalogStore } from './repository-catalog/repository-catalog-store'
import { RepositoryCatalogService } from './repository-catalog/repository-catalog-service'
import { RepositoryRuntimeService } from './repository-catalog/repository-runtime-service'
import { GitHubCredentialStore } from './github/github-credential-store'
import { GitHubAuthService } from './github/github-auth-service'
import { GitHubApiClient } from './github/github-api-client'
import { GitHubIntegrationService } from './github/github-integration-service'
import { loadGitHubProductConfig } from './github/github-config'
import { registerGitHubHandlers } from './ipc/github-handler'
import { AcademyGitMaterializer } from './academy/git/academy-git-materializer'
import { AcademyGitSyncService } from './academy/git/academy-git-sync-service'
import { AcademyPluginRepositoryProjection } from './academy/git/academy-plugin-repository-projection'
import { GitHubGitTransport } from './github/github-git-transport'
import { GitOperationsService } from './git-operations/git-operations-service'
import { GitService } from './core/git-service'





// Handlers globais de crash para evitar quedas silenciosas
process.on('uncaughtException', (error) => {
  console.error('[CrashHandler] uncaughtException:', error.message)
  if (error.stack) console.error('[CrashHandler] Stack:', error.stack)
})

process.on('unhandledRejection', (reason) => {
  console.error('[CrashHandler] unhandledRejection:', reason)
})

let mainWindow: BrowserWindow | null = null
let dbAdapter: BetterSqlite3DatabaseAdapter | null = null
const watcherService = new WatcherService()
const codeScopeHealth = new CodeScopeHealthMonitor()
const runtimeIdentityProvider = new RuntimeIdentityProvider({
  appVersion: app.getVersion(),
  mode: app.isPackaged ? 'production' : 'development'
})
const systemHealth = new SystemHealthCore({ runtimeIdentityProvider })
const codeMapSyncMonitor = new CodeMapSyncMonitor().connect()
const codeMapLifecycleMonitor = new CodeMapLifecycleMonitor().connect()
systemHealth.registerDrilldownProvider(
  new CodeMapSyncDrilldownProvider(codeMapSyncMonitor, codeScopeExecutionDrilldownProvider, codeMapLifecycleMonitor)
)
const validationLedger = new ValidationLedger(
  join(app.getPath('userData'), 'validation-ledger.db'),
  runtimeIdentityProvider
)
const continuumSession = new RepositoryContinuumSession(join(app.getPath('userData'), 'continuum'), {
  findByPath: path => repositoryCatalog?.findByPath(path) ?? null
})
const academyService = new AcademyService(desktopProfilePaths(app.getPath('userData')).academyPath, app.getPath('downloads'))
const runtimeRestart = new RuntimeRestartController(
  runtimeIdentityProvider,
  new EnvironmentRestartSupervisorClient(),
  () => app.quit()
)
let activeValidationExecution: ValidationExecution | null = null
let diagnosticInstallationId: string | null = null
let repositoryCatalog: RepositoryCatalogService | null = null
const traceSink = {
  record(event: import('./mcp/code-scope-health').CodeScopeTraceEvent) {
    if (!event.runtimeInstanceId) {
      event.runtimeInstanceId = runtimeIdentityProvider.getInstanceId()
    }
    if (!event.installationId && diagnosticInstallationId) {
      event.installationId = diagnosticInstallationId
    }
    codeScopeHealth.record(event)
    systemHealth.sink.record(event)
  }
}
const mcpLifecycle = new McpLifecycle({
  trace: traceSink,
  systemHealth,
  runtimeIdentity: runtimeIdentityProvider,
  validationLedger,
  academy: academyService
})
const selectedTransport = new SelectedTransport(
  () => settingsService.loadSettings().transportKind === 'relay' ? 'relay' : 'ngrok',
  (kind) => {
    if (kind === 'ngrok') return new NgrokTransport()
    const installPath = desktopProfilePaths(app.getPath('userData')).installationPath
    return new RelayTransport(
      resolveRelayEndpoint(),
      new InstallationIdentityService(installPath, safeStorage),
      30_000,
      25_000,
      traceSink
    )
  }
)
const connectionLifecycle = new ConnectionLifecycle(mcpLifecycle, selectedTransport, () => ({
  publicDomain: settingsService.loadSettings().ngrokDomain
}))
const remoteAccess = new RemoteAccessService(settingsService, connectionLifecycle)
let activeProjects: ActiveProjectService | null = null
let chatGptIntegration: ChatGptIntegrationProjection | null = null

// Single instance lock ANTES de app.whenReady() — evita race condition de duas janelas.
// Se outra instância já está rodando, esta encerra imediatamente.
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  // Warm start (Windows/Linux): a URL chega nos argv da segunda instância
  app.on('second-instance', (_event, commandLine) => {
    console.log('[DL][main-warm-cmdline]', JSON.stringify(commandLine))
    const url = commandLine.find(arg => arg.startsWith('codeawareness://'))
    console.log('[DL][main-warm-url]', JSON.stringify(url))
    if (url && mainWindow) {
      setPendingDeepLink(url)
      emitDeepLinkToRenderer(mainWindow, url)
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// Resolve caminho de assets de forma robusta: dev usa a pasta assets da raiz
// do projeto (em dev __dirname e out/main, entao dois niveis acima e a raiz),
// producao usa resourcesPath (build empacotado) com fallback para app.getAppPath()
const getAssetPath = (filename: string): string => {
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  if (isDev) {
    return join(__dirname, '../../assets', filename)
  }
  // BUGFIX: No build de producao, __dirname resolve para dentro do asar.
  // Usar process.resourcesPath ou app.getAppPath() garante resolucao correta.
  const basePath = process.resourcesPath ?? app.getAppPath()
  return join(basePath, 'assets', filename)
}

// Retorna o caminho do icone unico e colorido da janela.
// Nao ha mais variante por tema — usa-se sempre o icone colorido.
const getWindowIconPath = (): string => {
  return getAssetPath('app-icon-1024x1024.png')
}

function createWindow(): void {
  // BUGFIX: Verifica se o icone existe antes de passa-lo ao BrowserWindow.
  // Se estiver ausente, omite a opcao icon para evitar falha na criacao da janela.
  const iconPath = getWindowIconPath()
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1200,
    height: 800,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18181B' : '#F9FAFB',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  }

  if (existsSync(iconPath)) {
    windowOptions.icon = iconPath
  } else {
    console.warn('[Main] Icone nao encontrado em:', iconPath, '— usando icone padrao do Electron')
  }

  mainWindow = new BrowserWindow(windowOptions)

  Menu.setApplicationMenu(null)

  // Redirecionar links externos para o navegador padrão
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[Renderer] [${level}] ${message} (${sourceId}:${line})`)
  })
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Main] Janela do aplicativo carregada e visivel.')
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// Normalizar ambiente PATH antes de qualquer operação
sanitizeEnvironment()

app.whenReady().then(async () => {
  // Força o Electron a seguir o tema do sistema operacional antes de criar a janela
  nativeTheme.themeSource = 'system'

  // Registra o protocolo codeawareness:// no SO — deve ser chamado no whenReady.
  // No Windows em modo dev, o executável é o Electron e o app é o argv[1];
  // sem esses argumentos extras o protocolo seria registrado com o caminho errado.
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('codeawareness', process.execPath, [resolve(process.argv[1])])
    }
  } else {
    app.setAsDefaultProtocolClient('codeawareness')
  }

  const gitService = new GitService()
  const githubConfig = loadGitHubProductConfig()
  const githubCredentials = new GitHubCredentialStore(desktopProfilePaths(app.getPath('userData')).githubPath, safeStorage)
  const githubAuth = githubConfig ? new GitHubAuthService(githubConfig, githubCredentials) : null
  const githubApi = githubAuth ? new GitHubApiClient(() => githubAuth.getValidAccessToken()) : null
  const gitTransport = new GitHubGitTransport(githubAuth, gitService)
  const academyGitMaterializer = new AcademyGitMaterializer()
  const academyPluginProjection = new AcademyPluginRepositoryProjection()

  const workspaceService = new WorkspaceService()
  const repositoryCatalogStore = new RepositoryCatalogStore(desktopProfilePaths(app.getPath('userData')).repositoryCatalogPath)
  repositoryCatalog = new RepositoryCatalogService(repositoryCatalogStore, workspaceService, academyService)
  await repositoryCatalog.initialize(settingsService.loadSettings())

  const academyGitRepositoryPort = {
    resolveRepository: (id: string) => {
      try { return repositoryCatalog!.store.get(id) } catch { return null }
    },
    findByGitHubId: (ghId: string) => repositoryCatalog!.findByGitHubRepositoryId(ghId),
    listEligibleRepositories: () => repositoryCatalog!.list().filter((r) =>
      Boolean(r.github && r.github.accessState === 'AVAILABLE' && r.localCheckout?.availability === 'AVAILABLE' && r.localCheckout.gitState === 'GIT')
    )
  }
  const academyGitSyncService = new AcademyGitSyncService(
    academyService.store,
    academyGitMaterializer,
    gitService,
    gitTransport,
    academyGitRepositoryPort,
    academyService,
    academyPluginProjection,
    { packageRevisions: academyService.packageRevisions }
  )
  academyService.initializeGitSync(academyGitSyncService)
  registerAcademyHandlers(academyService)

  void (async () => {
    if (academyService.store.list().length === 0) {
      for (const destination of academyService.store.listDestinations()) {
        const skillsRoot = join(destination.path, '.skills')
        if (existsSync(skillsRoot)) await academyService.importer.import(skillsRoot, 'GLOBAL', [destination.id])
      }
    }
    if (!academyService.store.getOpenAiPluginProfile() || !academyService.listOpenAiReleases().some((release) => release.baseline)) {
      try { await academyService.bootstrapOpenAiPlugin() }
      catch (error: any) { console.warn('[Academy] OpenAI plugin profile bootstrap pending:', error?.code ?? error?.message) }
    }
    if (academyService.store.getOpenAiPluginProfile()) {
      academyService.initializePluginPackage()
      academyService.recordMarketplaceProbeUnsupported()
    }
    const gitProfile = academyService.store.getGitProfile()
    if (!gitProfile) {
      const eligible = academyGitRepositoryPort.listEligibleRepositories()
      const matches = eligible.filter((r) => r.name.toLowerCase() === 'academy')
      if (matches.length === 1) {
        try {
          console.log('[Academy] Auto-bootstrapping Academy Git repository:', matches[0].name)
          await academyGitSyncService.bindRepository(matches[0].id)
        } catch (error: any) {
          console.warn('[Academy] Auto-bootstrap pending:', error?.message)
        }
      }
    } else {
      await academyGitSyncService.recoverOnStartup()
    }
    await academyService.reconcileAll()
    academyService.start()
  })().catch((error) => console.error('[Academy] Initialization failed:', error))

  // Composição de dependências (bootstrap): o CodeMapService depende apenas das portas
  // CompressionPort/ContentIdentityPort. A implementação concreta do ContentIdentityPort
  // consulta o CodeMapService para reusar hashes SHA-256 do RepositoryModel sem I/O
  // redundante, e um único CompressionService concreto é injetado tanto no CodeMapService
  // (via porta) quanto repassado ao git-handler.
  let codeMapService: CodeMapService | null = null
  const contentIdentityProvider: ContentIdentityPort = {
    getContentHash: (repoPath, relativePath) => {
      // Guarda defensiva: protege contra chamadas ao getContentHash antes do
      // codeMapService ser atribuído (ex.: compressão disparada prematuramente).
      if (!codeMapService) {
        if (process.env.NODE_ENV === 'development') {
          console.warn('[main] getContentHash chamado antes da inicialização do codeMapService')
        }
        return Promise.resolve(null)
      }
      const contentHash = codeMapService.getFileContentHash(repoPath, relativePath)
      return Promise.resolve(contentHash)
    }
  }
  const compressionService = new CompressionService(undefined, contentIdentityProvider)
  codeMapService = getCodeMapService(watcherService, compressionService)

  // Composição de persistência e serviços de domínio
  dbAdapter = new BetterSqlite3DatabaseAdapter()
  const checkpointService = new CheckpointService(dbAdapter)
  const campaignService = new CampaignService(dbAdapter)
  const restoreService = new RestoreService(checkpointService, dbAdapter)

  // Composição do Code Dash com injeção de dependências reais
  const codeSourceService = new CodeSourceService()
  const sourceContextProvider = new SourceContextProvider(codeSourceService)
  const compressionContextProvider = new CompressionContextProvider(compressionService)
  const dashService = new DashService(
    (repoPath: string) => new DashFileResolver(repoPath),
    sourceContextProvider,
    compressionContextProvider
  )
  const contextNavigation = new ContextEngine(codeMapService)
  const dashDiscoveryService = new DashDiscoveryService(contextNavigation)
  activeProjects = new ActiveProjectService(codeMapService)
  const repositoryRuntime = new RepositoryRuntimeService(repositoryCatalog, codeMapService, activeProjects)
  activeProjects.onBeforeChange(async () => {
    await mcpLifecycle.quiesce()
    await activeValidationExecution?.shutdown()
    activeValidationExecution = null
    continuumSession.deactivate()
  })
  activeProjects.onChanged(({ project }) => {
    if (!project) {
      void mcpLifecycle.deactivate()
      continuumSession.deactivate()
      return
    }

    let continuum = undefined
    try {
      const report = continuumSession.activate(project.path)
      if (report && report.discovered > 0) {
        console.log(`[Continuum] Ingestion: discovered=${report.discovered} ingested=${report.ingested} rejected=${report.rejected} retryable=${report.retryableFailures}`)
      }
      continuum = continuumSession.getActiveService() ?? undefined
    } catch (error: any) {
      // Continuum is auxiliary context — never block project opening on its failure.
      console.error('[Continuum] Session activation failed, continuing without Continuum:', error?.message)
    }

    const navigation = bindProjectNavigation(contextNavigation, project.path)
    activeValidationExecution = new ValidationExecution(project.path, validationLedger, runtimeIdentityProvider)
    void mcpLifecycle.activateContext({
      projectId: project.id,
      repoRoot: project.path,
      navigation,
      continuum,
      validationExecution: activeValidationExecution,
      diagnosticSourceAccess: new DiagnosticSourceAccess(project.path),
      gitOperations: new GitOperationsService(project.path, gitService, gitTransport),
      runtimeRestart
    })
  })
  registerActiveProjectHandlers(activeProjects)
  registerConnectionHandlers(remoteAccess)
  chatGptIntegration = new ChatGptIntegrationProjection(remoteAccess, activeProjects, mcpLifecycle,
    () => isInstallationConfigured(desktopProfilePaths(app.getPath('userData')).installationPath, safeStorage), settingsService, codeScopeHealth)
  registerChatGptIntegrationHandlers(chatGptIntegration)
  registerSystemHealthHandlers(systemHealth)
  try {
    const installPath = desktopProfilePaths(app.getPath('userData')).installationPath
    diagnosticInstallationId = new InstallationIdentityService(installPath, safeStorage).getId()
  } catch { diagnosticInstallationId = null }
  try {
    const trace = traceSink as import('./mcp/code-scope-health').CodeScopeTraceSink
    const catalogProbe = (mcpLifecycle as unknown as { getCatalogProbe?: () => { getToolCatalogHash: () => string } }).getCatalogProbe?.()
    console.log('[Spike] runtime-boot', JSON.stringify({ instanceId: runtimeIdentityProvider.getInstanceId(), installationId: diagnosticInstallationId, startedAt: runtimeIdentityProvider.getStartedAt(), toolCatalogHash: catalogProbe?.getToolCatalogHash() ?? null, timestamp: new Date().toISOString() }))
  } catch {}
  remoteAccess.onChanged((state) => {
    if (state.status === 'CONNECTED') {
      systemHealth.invalidate()
      try {
        const trace = traceSink as import('./mcp/code-scope-health').CodeScopeTraceSink
        const catalogProbe = (mcpLifecycle as unknown as { getCatalogProbe?: () => { getToolCatalogHash: () => string } }).getCatalogProbe?.()
        trace.record({ timestamp: new Date().toISOString(), requestId: 'none', sessionId: state.localEndpoint ?? 'local', method: 'unknown', tool: 'unknown', stage: 'desktop-connection-established', durationMs: 0, status: 'started', runtimeInstanceId: runtimeIdentityProvider.getInstanceId(), installationId: diagnosticInstallationId ?? undefined })
        console.log('[Spike] runtime-boot', JSON.stringify({ instanceId: runtimeIdentityProvider.getInstanceId(), installationId: diagnosticInstallationId, toolCatalogHash: catalogProbe?.getToolCatalogHash() ?? null, timestamp: new Date().toISOString() }))
      } catch {}
    }
  })
  remoteAccess.start()

  // Composição do One-Click XML com política de escopo e adapter de Direct Output
  const repomixAdapterForOneClick = new RepomixAdapter()
  const githubIntegration = new GitHubIntegrationService(
    githubConfig, githubCredentials, githubAuth, githubApi, repositoryCatalog, gitService, shell
  )
  const codeAwarenessIgnoreService = new CodeAwarenessIgnoreService(settingsService)
  const ignorePolicy = new IgnorePolicy(gitService, settingsService, codeAwarenessIgnoreService)
  const oneClickXmlService = new OneClickXmlService(ignorePolicy, repomixAdapterForOneClick)

  // Registrar todos os handlers IPC dinâmicos e estáticos de forma única no ciclo de vida
  registerFileHandlers()
  registerSettingsHandlers(settingsService)
  registerGitHandlers(watcherService, settingsService, compressionService, codeAwarenessIgnoreService)
  registerWorkspaceHandlers(settingsService, repositoryCatalog, repositoryRuntime)
  registerGitHubHandlers(githubIntegration)
  registerCheckpointHandlers(checkpointService, dbAdapter)
  registerRestoreHandlers(restoreService)
  registerTagHandlers()
  registerDatabaseHandlers(dbAdapter)
  registerCampaignHandlers(campaignService)
  registerCodeMapHandlers(codeMapService, activeProjects)
  registerDashHandlers(dashService, oneClickXmlService, dashDiscoveryService)


  createWindow()

  // Registra handler IPC e atalhos F12 / Ctrl+Shift+I para DevTools
  registerDevToolsHandlers(mainWindow!)
  DevToolsManager.registerShortcuts(mainWindow!)

  // Warm start (Mac): a URL chega via evento open-url
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (mainWindow) {
      setPendingDeepLink(url)
      emitDeepLinkToRenderer(mainWindow, url)
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  // Cold start (Windows/Linux): a URL pode estar nos argv do processo.
  // Não emite imediatamente — espera o renderer montar e pedir via getPendingDeepLink.
  console.log('[DL][main-cold-argv]', JSON.stringify(process.argv))
  const url = process.argv.find(arg => arg.startsWith('codeawareness://'))
  console.log('[DL][main-cold-url]', JSON.stringify(url))
  if (url && mainWindow) {
    setPendingDeepLink(url)
  }

  // Expõe a URL pendente ao renderer via IPC deeplink:get-pending
  registerDeepLinkHandlers()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

registerApplicationShutdown(app, async () => {
  chatGptIntegration?.dispose()
  codeMapSyncMonitor.dispose()
  codeMapLifecycleMonitor.dispose()
  await remoteAccess.dispose()
  await activeValidationExecution?.shutdown()
  activeValidationExecution = null
  await activeProjects?.dispose()
  await mcpLifecycle.dispose()
  DevToolsManager.unregisterShortcuts()
  watcherService.stop()
  // Fecha o Code Map Service (fecha conexões de banco e watchers do Repository Model)
  try {
    closeCodeMapService()
  } catch (error: any) {
    console.error('[Main] Erro ao fechar Code Map Service:', error)
  }
  // Fecha conexões de banco de dados ao encerrar o app
  try {
    if (dbAdapter) {
      dbAdapter.closeAll()
    }
  } catch (error: any) {
    console.error('[Main] Erro ao fechar conexões de banco:', error)
  }
  try {
    validationLedger.close()
  } catch (error: any) {
    console.error('[Main] Erro ao fechar Validation Ledger:', error)
  }
  try {
    continuumSession.dispose()
  } catch (error: any) {
    console.error('[Main] Erro ao fechar Continuum Session:', error)
  }
  try {
    academyService.close()
  } catch (error: any) {
    console.error('[Main] Erro ao fechar Academy:', error)
  }
  try {
    repositoryCatalog?.store.close()
  } catch (error: any) {
    console.error('[Main] Erro ao fechar Repository Catalog:', error)
  }
})

// Notifica o renderer quando o tema do SO muda.
// O ícone da janela não é mais trocado por tema — usa-se sempre o ícone colorido.
nativeTheme.on('updated', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
