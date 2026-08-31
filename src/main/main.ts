/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Inicializar o ciclo de vida e a janela principal do aplicativo Electron.
2. Registrar todos os manipuladores de IPC (Inter-Process Communication).
3. Normalizar as variáveis de ambiente PATH para compatibilidade com CLI.
4. Registrar o protocolo codeawareness:// no SO e capturar deep links em cold start e warm start, garantindo single instance.
5. Compor a injeção de dependência no bootstrap como único Composition Root: instancia BetterSqlite3DatabaseAdapter, CheckpointService, CampaignService, RestoreService, CompressionService, CodeSourceService e DashService, injetando as dependências prontas nos handlers IPC.
6. Aplicar guarda defensiva com log de warning em desenvolvimento no ContentIdentityProvider, antes de chamadas ao codeMapService não inicializado.
7. Compor e registrar o DashService e seus handlers IPC (registerDashHandlers) com injeção de dependências reais.

Mapa de Relacionamentos do Script

1. ipc/file-handler.ts
   - Tipo: Dependência Direta
   - Relação: Registra manipuladores de arquivos via IPC.
   - Criticidade: Alta

2. ipc/settings-handler.ts
   - Tipo: Dependência Direta
   - Relação: Registra manipuladores de configurações via IPC.
   - Criticidade: Alta

3. ipc/git-handler.ts
   - Tipo: Dependência Direta
   - Relação: Registra manipuladores de operações Git via IPC; recebe a instância do CompressionService por parâmetro.
   - Criticidade: Alta

4. core/workspace-service.ts
   - Tipo: Dependência Direta
   - Relação: Fornece serviço de workspace para manipuladores.
   - Criticidade: Alta

5. core/watcher-service.ts
   - Tipo: Dependência Direta
   - Relação: Monitora mudanças no sistema de arquivos.
   - Criticidade: Alta

6. utils/env-sanitizer.ts
   - Tipo: Dependência Direta
   - Relação: Normaliza variáveis de ambiente PATH.
   - Criticidade: Média

7. assets/app-icon-1024x1024.png
   - Tipo: Relação de UI
   - Relação: Ícone único e colorido da janela principal, resolvido via getWindowIconPath().
   - Criticidade: Baixa

8. core/compression-service.ts
   - Tipo: Dependência Direta
   - Relação: Instancia um único CompressionService, injetado na porta CompressionPort do CodeMapService (com ContentIdentityPort composta) e repassado ao git-handler e DashService.
   - Criticidade: Alta

9. core/content-identity-port.ts
   - Tipo: Contrato / Interface
   - Relação: Implementa a porta delegando ao CodeMapService.getFileContentHash para reuso de hashes SHA-256.
   - Criticidade: Alta

10. core/better-sqlite3-database-adapter.ts
    - Tipo: Dependência Direta
    - Relação: Instancia o adaptador SQLite e injeta como porta de persistência nos serviços e handlers.
    - Criticidade: Alta

11. ipc/dash-handler.ts
    - Tipo: Dependência Direta
    - Relação: Registra manipuladores do Code Dash e One-Click XML via IPC; recebe instâncias de DashService e OneClickXmlService por parâmetro.
    - Criticidade: Alta

12. core/one-click-xml-service.ts
    - Tipo: Dependência Direta
    - Relação: Instancia o serviço OneClickXmlService com IgnorePolicy e RepomixAdapter para geração nativa de XML.
    - Criticidade: Alta


Invariantes do Script

1. A janela principal nunca deve ser instanciada mais de uma vez enquanto estiver ativa.
2. Handlers IPC devem ser registrados antes de criar a janela principal.
3. O serviço de watcher deve ser interrompido antes do encerramento do aplicativo.
4. O app garante single instance via requestSingleInstanceLock e captura a URL de deep link em cold start (argv) e warm start (second-instance/open-url), sem nunca abrir uma segunda janela.
5. main.ts é o único Composition Root do app — instancia adaptadores e serviços e injeta-os nos handlers.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron'
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

// Resolve caminho de assets de forma robusta: dev usa caminho relativo,
// produção usa resourcesPath (build empacotado) com fallback para app.getAppPath()
const getAssetPath = (filename: string): string => {
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  if (isDev) {
    return join(__dirname, '../assets', filename)
  }
  // BUGFIX: No build de produção, __dirname resolve para dentro do asar.
  // Usar process.resourcesPath ou app.getAppPath() garante resolução correta.
  const basePath = process.resourcesPath ?? app.getAppPath()
  return join(basePath, 'assets', filename)
}

// Retorna o caminho do ícone único e colorido da janela.
// Não há mais variante por tema — usa-se sempre o ícone colorido.
const getWindowIconPath = (): string => {
  return getAssetPath('app-icon-1024x1024.png')
}

function createWindow(): void {
  // BUGFIX: Verifica se o ícone existe antes de passá-lo ao BrowserWindow.
  // Se estiver ausente, omite a opção icon para evitar falha na criação da janela.
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
    console.warn('[Main] Ícone não encontrado em:', iconPath, '— usando ícone padrão do Electron')
  }

  mainWindow = new BrowserWindow(windowOptions)

  Menu.setApplicationMenu(null)

  // Redirecionar links externos para o navegador padrão
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
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

app.whenReady().then(() => {
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

  const workspaceService = new WorkspaceService()

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

  // Composição do One-Click XML com política de escopo e adapter de Direct Output
  const repomixAdapterForOneClick = new RepomixAdapter()
  const gitService = new GitService()
  const ignorePolicy = new IgnorePolicy(gitService, settingsService)
  const oneClickXmlService = new OneClickXmlService(ignorePolicy, repomixAdapterForOneClick)

  // Registrar todos os handlers IPC dinâmicos e estáticos de forma única no ciclo de vida
  registerFileHandlers()
  registerSettingsHandlers(settingsService)
  registerGitHandlers(watcherService, settingsService, compressionService)
  registerWorkspaceHandlers(settingsService, workspaceService)
  registerCheckpointHandlers(checkpointService, dbAdapter)
  registerRestoreHandlers(restoreService)
  registerTagHandlers()
  registerDatabaseHandlers(dbAdapter)
  registerCampaignHandlers(campaignService)
  registerCodeMapHandlers(codeMapService)
  registerDashHandlers(dashService, oneClickXmlService)


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

app.on('before-quit', () => {
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