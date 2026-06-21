<source_code>
electron.vite.config.ts
```
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: resolve(__dirname, 'src/main/main.ts'),
        formats: ['cjs']
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    build: {
      lib: {
        entry: resolve(__dirname, 'src/main/preload.ts'),
        formats: ['cjs']
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    },
    plugins: [react()]
  }
})
```

package.json
```
{
  "name": "code-awareness",
  "version": "1.0.0",
  "description": "Desktop app to analyze code repos and export to Obsidian via Codefetch",
  "author": "Eric Rocha",
  "homepage": "https://github.com/ericrocha001/code_awareness",
  "main": "./out/main/main.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "typecheck": "tsc --noEmit",
    "dist": "npm run build && electron-builder --win"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "electron": "^33.0.0",
    "electron-builder": "^24.13.3",
    "electron-vite": "^2.3.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0"
  },
  "build": {
    "appId": "com.ericrocha.codeawareness",
    "productName": "Code Awareness",
    "directories": {
      "output": "dist"
    },
    "files": [
      "out/**/*",
      "package.json"
    ],
    "win": {
      "target": "nsis"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "shortcutName": "Code Awareness"
    }
  },
  "dependencies": {
    "markdown-to-jsx": "^9.8.2"
  }
}
```

tsconfig.json
```
{
  "files": [],
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
```

tsconfig.node.json
```
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "skipLibCheck": true,
    "outDir": "out/main",
    "rootDir": "src/main"
  },
  "include": ["src/main/**/*", "src/shared/**/*"]
}
```

tsconfig.web.json
```
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "paths": {
      "@shared/*": ["src/shared/*"]
    }
  },
  "include": ["src/renderer/**/*", "src/shared/**/*"]
}
```

src/main/main.ts
```
// Responsabilidades do Script
//
// 1. Inicializar o ciclo de vida e a janela principal do aplicativo Electron.
// 2. Registrar todos os manipuladores de IPC (Inter-Process Communication).
// 3. Normalizar as variáveis de ambiente PATH para compatibilidade com CLI.

import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'path'
import { registerCodefetchHandlers } from './ipc/codefetch-handler'
import { registerFileHandlers } from './ipc/file-handler'
import { registerSettingsHandlers } from './ipc/settings-handler'
import { registerGitHandlers } from './ipc/git-handler'
import { registerWorkspaceHandlers } from './ipc/workspace-handler'
import { SettingsService } from './core/settings-service'
import { WorkspaceService } from './core/workspace-service'
import { sanitizeEnvironment } from './utils/env-sanitizer'
import { WatcherService } from './core/watcher-service'

// Handlers globais de crash para evitar quedas silenciosas
process.on('uncaughtException', (error) => {
  console.error('[CrashHandler] uncaughtException:', error.message)
  if (error.stack) console.error('[CrashHandler] Stack:', error.stack)
})

process.on('unhandledRejection', (reason) => {
  console.error('[CrashHandler] unhandledRejection:', reason)
})

let mainWindow: BrowserWindow | null = null
const watcherService = new WatcherService()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

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
  const settingsService = new SettingsService()
  const workspaceService = new WorkspaceService()

  // Registrar todos os handlers IPC dinâmicos e estáticos de forma única no ciclo de vida
  registerCodefetchHandlers()
  registerFileHandlers()
  registerSettingsHandlers()
  registerGitHandlers(watcherService)
  registerWorkspaceHandlers(settingsService, workspaceService)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => {
  watcherService.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
```

src/main/preload.ts
```
// Responsabilidades do Script
//
// 1. Expor APIs seguras e limitadas do processo principal para o renderer usando contextBridge.
// 2. Garantir isolamento de contexto impedindo o acesso direto a módulos do Node.js pela interface.
// 3. Mapear os canais IPC do fluxo de monitoramento Git e de arquivos modificados para o renderer.

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { AppSettings, CodefetchResult, DiffFileStatus, ProjectInfo } from '../shared/types'

contextBridge.exposeInMainWorld('codeAwareness', {
  checkCodefetch: (): Promise<boolean> => {
    return ipcRenderer.invoke('check-codefetch')
  },
  runCodefetch: (repoPath: string): Promise<CodefetchResult> => {
    return ipcRenderer.invoke('run-codefetch', repoPath)
  },
  saveMarkdown: (markdown: string, repoName: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('save-markdown', markdown, repoName)
  },
  saveToObsidian: (
    markdown: string,
    repoName: string,
    vaultPath: string
  ): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('save-to-obsidian', markdown, repoName, vaultPath)
  },
  loadSettings: (): Promise<AppSettings> => {
    return ipcRenderer.invoke('load-settings')
  },
  saveSettings: (settings: AppSettings): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('save-settings', settings)
  },
  selectVaultFolder: (): Promise<string | null> => {
    return ipcRenderer.invoke('select-vault-folder')
  },
  selectFolder: (): Promise<{ path: string; name: string } | null> => {
    return ipcRenderer.invoke('select-folder')
  },
  getPathForFile: (file: File): string => {
    return webUtils.getPathForFile(file)
  },
  checkRepository: (dirPath: string): Promise<boolean> => {
    return ipcRenderer.invoke('git:check-repository', dirPath)
  },
  getModifiedFiles: (dirPath: string): Promise<DiffFileStatus[]> => {
    return ipcRenderer.invoke('git:get-modified-files', dirPath)
  },
  startWatcher: (dirPath: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('watcher:start', dirPath)
  },
  stopWatcher: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('watcher:stop')
  },
  onFileChanged: (callback: (filePath: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, filePath: string): void => callback(filePath)
    ipcRenderer.on('watcher:file-changed', handler)
    return () => ipcRenderer.removeListener('watcher:file-changed', handler)
  },
  generateSemanticDiff: (repoPath: string): Promise<string> => {
    return ipcRenderer.invoke('git:generate-semantic-diff', repoPath)
  },
  addRootFolder: (): Promise<ProjectInfo[]> => {
    return ipcRenderer.invoke('workspace:add-root-folder')
  },
  addIndividualProject: (): Promise<ProjectInfo[]> => {
    return ipcRenderer.invoke('workspace:add-individual-project')
  },
  getProjectsList: (): Promise<ProjectInfo[]> => {
    return ipcRenderer.invoke('workspace:get-projects-list')
  },
  hideProject: (projectPath: string): Promise<ProjectInfo[]> => {
    return ipcRenderer.invoke('workspace:hide-project', projectPath)
  }
})
```

src/renderer/index.html
```
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <title>Code Awareness</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!-- Segurança CSP básica recomendada pelo Electron -->
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self';" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

src/shared/types.ts
```
// Responsabilidades do Script
//
// 1. Definir os tipos compartilhados entre o processo principal e o renderer do Electron.
// 2. Declarar as interfaces de domínio do fluxo de monitoramento Git e de arquivos modificados.

export interface AppSettings {
  obsidianVaultPath: string | null
  rootFolders: string[]
  individualProjects: string[]
  hiddenProjects: string[]
}

export interface ProjectInfo {
  path: string
  name: string
  isGit: boolean
}

export interface CodefetchResult {
  success: boolean
  markdown?: string
  error?: string
}

export interface DiffFileStatus {
  relativePath: string
  name: string
  changeType: 'modified' | 'added' | 'deleted'
}

export type WatcherState = 'active' | 'inactive' | 'error'
```

src/main/core/codefetch-adapter.ts
```
// Responsabilidades do Script
//
// 1. Verificar se o Codefetch CLI está instalado no sistema.
// 2. Executar o Codefetch em um repositório, copiar o Markdown gerado para code_awareness/[nome].md e fazer a limpeza da pasta temporária codefetch/.
// 3. Garantir a existência do arquivo .codefetchignore com as exclusões padrão antes de cada execução do Codefetch.

import { spawn } from 'child_process'
import { join, basename } from 'path'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { CodefetchResult } from '../../shared/types'

const TIMEOUT_MS = 120_000

export class CodefetchAdapter {
  private getCommand(): string {
    return process.platform === 'win32' ? 'codefetch.cmd' : 'codefetch'
  }

  async checkInstallation(): Promise<boolean> {
    console.log(`[CodefetchAdapter] Verificando instalação na plataforma: ${process.platform}`)
    const cmd = this.getCommand()
    console.log(`[CodefetchAdapter] Comando a ser executado: ${cmd}`)
    console.log(`[CodefetchAdapter] PATH env: ${process.env.PATH}`)

    return new Promise((resolve) => {
      const proc = spawn(cmd, ['--version'], { shell: process.platform === 'win32' })
      proc.on('close', (code) => {
        console.log(`[CodefetchAdapter] Verificação de instalação concluída com código: ${code}`)
        resolve(code === 0)
      })
      proc.on('error', (err) => {
        console.error(`[CodefetchAdapter] Erro ao verificar instalação: ${err.message}`, err)
        resolve(false)
      })
    })
  }

  async cleanupTemp(repoPath: string): Promise<void> {
    const codefetchDir = join(repoPath, 'codefetch')
    if (existsSync(codefetchDir)) {
      rmSync(codefetchDir, { recursive: true, force: true })
      console.log(`[CodefetchAdapter] Limpeza da pasta codefetch/ em: ${repoPath}`)
    }
  }

  private async ensureIgnoreFile(repoPath: string): Promise<void> {
    const ignorePath = join(repoPath, '.codefetchignore')
    if (!existsSync(ignorePath)) {
      const content = [
        '# Code Awareness Default Ignores',
        'AGENTS.md',
        '.codefetchignore',
        'code_awareness/',
        'node_modules/',
        'dist/',
        'out/'
      ].join('\n')
      await writeFile(ignorePath, content, 'utf-8')
      console.log(`[CodefetchAdapter] .codefetchignore criado em: ${repoPath}`)
    }
  }

  async run(repoPath: string): Promise<CodefetchResult> {
    const repoName = basename(repoPath)
    const fileName = `${repoName}.md`
    const tempPath = join(repoPath, 'codefetch', fileName)
    const destPath = join(repoPath, 'code_awareness', fileName)

    // Limpa qualquer resquício da pasta codefetch/ antes de iniciar
    await this.cleanupTemp(repoPath)

    // Garante o arquivo de exclusões .codefetchignore
    await this.ensureIgnoreFile(repoPath)

    return new Promise((resolve) => {
      let stderr = ''

      // Salva apenas o nome do arquivo (sem barras) para evitar erro no Codefetch
      const proc = spawn(this.getCommand(), ['-o', fileName], {
        cwd: repoPath,
        shell: process.platform === 'win32'
      })

      const timer = setTimeout(() => {
        proc.kill()
        resolve({ success: false, error: 'Repository analysis timed out' })
      }, TIMEOUT_MS)

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      proc.on('close', async (code) => {
        clearTimeout(timer)
        if (code === 0) {
          try {
            if (!existsSync(tempPath)) {
              resolve({
                success: false,
                error: `Arquivo temporário não encontrado em codefetch/${fileName}`
              })
              return
            }

            // Lê o conteúdo gerado pelo Codefetch
            const content = await readFile(tempPath, 'utf-8')

            // Cria a pasta code_awareness/ e copia o arquivo
            mkdirSync(join(repoPath, 'code_awareness'), { recursive: true })
            await writeFile(destPath, content, 'utf-8')

            // Limpa a pasta temporária codefetch/ (inclui resquícios antigos como codebase.md)
            rmSync(join(repoPath, 'codefetch'), { recursive: true, force: true })

            resolve({ success: true, markdown: content })
          } catch (err: any) {
            resolve({
              success: false,
              error: `Erro ao processar o arquivo gerado: ${err.message}`
            })
          }
        } else {
          resolve({
            success: false,
            error: stderr.trim() || 'Codefetch failed to analyze the repository'
          })
        }
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        resolve({ success: false, error: `Could not run codefetch: ${err.message}` })
      })
    })
  }
}
```

src/main/core/diff-service.ts
```
// Responsabilidades do Script
//
// 1. Identificar semanticamente blocos de código (funções, classes) em torno das linhas modificadas pelo Git.
// 2. Gerar a string de Markdown estruturado com os blocos funcionais (Original vs Novo).
// 3. Fornecer fallback de exibição de linhas alteradas para arquivos sem assinaturas de bloco detectáveis (CSS, JSON, etc).

import { readFile, stat } from 'fs/promises'
import { join, basename, extname } from 'path'
import { GitService } from './git-service'
import { DiffFileStatus } from '../../shared/types'

// Lista de bloqueio de arquivos que nunca devem aparecer no relatório de diff
const CORE_IGNORED_FILES = new Set([
  'AGENTS.md',
  '.codefetchignore',
  '.gitignore',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml'
])

interface SemanticBlock {
  signature: string
  startLine: number // 1-indexed
  endLine: number   // 1-indexed
  lines: string[]
}

const SIGNATURE_PATTERNS: RegExp[] = [
  /^\s*(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*\w+/,
  /^\s*(export\s+)?(abstract\s+)?(default\s+)?class\s+\w+/,
  /^\s*(export\s+)?interface\s+\w+/,
  /^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?(function|\(|[a-z_]\w*\s*=>)/i,
  /^\s*(public|private|protected|static|override|abstract|async)(\s+(public|private|protected|static|override|abstract|async))*\s+\w+\s*[<(]/,
  /^\s*def\s+\w+\s*\(/,
]

// Limite saudável de tamanho de arquivo para leitura de diff (2 MB)
const MAX_FILE_SIZE = 2 * 1024 * 1024

const CHANGE_TYPE_LABEL: Record<DiffFileStatus['changeType'], string> = {
  modified: 'modificado',
  added: 'adicionado',
  deleted: 'excluído'
}

const EXTENSION_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.md': 'markdown'
}

export class DiffService {
  private git = new GitService()

  async generateSemanticDiff(repoPath: string): Promise<string> {
    const files = await this.git.getModifiedFiles(repoPath)
    if (files.length === 0) return '# Nenhuma alteração detectada.'

    const name = basename(repoPath)
    const date = new Date().toLocaleString('pt-BR')
    const header = `# Semantic Diff — \`${name}\`\n\n*Gerado em: ${date}*`

    const sections: string[] = []
    for (const file of files) {
      if (file.relativePath.includes('code_awareness/')) continue
      if (CORE_IGNORED_FILES.has(file.relativePath)) continue
      const section = await this.analyzeFile(repoPath, file)
      if (section) sections.push(section)
    }

    if (sections.length === 0) return `${header}\n\n*Nenhum bloco semântico identificado.*`

    return [header, ...sections].join('\n\n---\n\n')
  }

  private async analyzeFile(repoPath: string, file: DiffFileStatus): Promise<string> {
    const ext = extname(file.relativePath).toLowerCase()
    const lang = EXTENSION_MAP[ext] || 'text'

    // Proteção: arquivos maiores que 2MB são ignorados para evitar travamento
    try {
      const stats = await stat(join(repoPath, file.relativePath))
      if (stats.size > MAX_FILE_SIZE) {
        return `## 📄 \`${file.relativePath}\` (${CHANGE_TYPE_LABEL[file.changeType]})\n\n` +
          `*Arquivo muito grande para gerar o diff (> 2MB).*`
      }
    } catch {
      // Se não conseguir ler o tamanho, segue o fluxo normal
    }

    // Arquivo deletado — exibe o conteúdo antigo completo como remoção
    if (file.changeType === 'deleted') {
      const oldContentRaw = await this.git.getFileAtHead(repoPath, file.relativePath)
      if (!oldContentRaw) return ''
      const oldLines = oldContentRaw.split('\n')
      return `## 📄 \`${file.relativePath}\` (${CHANGE_TYPE_LABEL.deleted})\n\n` +
        `#### 🟥 [Código Original / Removido]\n\`\`\`${lang}\n${oldLines.join('\n')}\n\`\`\``
    }

    let newContent: string
    try {
      newContent = await readFile(join(repoPath, file.relativePath), 'utf-8')
    } catch {
      return ''
    }

    const newLines = newContent.split('\n')

    // Arquivo novo (added) — exibe o conteúdo completo como adição
    if (file.changeType === 'added') {
      const block: SemanticBlock = {
        signature: `Arquivo Novo`,
        startLine: 1,
        endLine: newLines.length,
        lines: newLines
      }
      return `## 📄 \`${file.relativePath}\` (${CHANGE_TYPE_LABEL.added})\n\n` +
        this.formatDoubleBlock(block, null, lang)
    }

    const oldContentRaw = await this.git.getFileAtHead(repoPath, file.relativePath)
    const oldContent = oldContentRaw || ''

    const oldLines = oldContent.split('\n')

    const hunks = await this.git.getModifiedHunks(repoPath, file.relativePath)
    if (hunks.length === 0) return ''

    const blocksOutput: string[] = []
    const coveredNewBlocks = new Set<string>()

    for (const hunk of hunks) {
      // Tenta encontrar um bloco semântico (função, classe)
      const newBlock = this.findContainingBlock(newLines, hunk.start)

      if (newBlock) {
        const blockKey = `${newBlock.startLine}-${newBlock.endLine}`
        if (coveredNewBlocks.has(blockKey)) continue
        coveredNewBlocks.add(blockKey)

        const oldBlock = this.findContainingBlock(oldLines, hunk.oldStart)
        blocksOutput.push(this.formatDoubleBlock(newBlock, oldBlock, lang))
      } else {
        // Fallback: arquivo sem assinatura (CSS, JSON, etc) — exibe as linhas exatas do hunk com contexto
        const margin = 2
        const startLine = Math.max(1, hunk.start - margin)
        const endLine = Math.min(newLines.length, hunk.start + hunk.count - 1 + margin)
        const fallbackBlock: SemanticBlock = {
          signature: `Alteração de Linhas`,
          startLine,
          endLine,
          lines: newLines.slice(startLine - 1, endLine)
        }
        let oldFallback: SemanticBlock | null = null
        if (oldLines.length > 0 && hunk.oldStart > 0) {
          const oldStartLine = Math.max(1, hunk.oldStart - margin)
          const oldEndLine = Math.min(oldLines.length, hunk.oldStart + hunk.oldCount - 1 + margin)
          oldFallback = {
            signature: `Alteração de Linhas`,
            startLine: oldStartLine,
            endLine: oldEndLine,
            lines: oldLines.slice(oldStartLine - 1, oldEndLine)
          }
        }
        blocksOutput.push(this.formatDoubleBlock(fallbackBlock, oldFallback, lang))
      }
    }

    if (blocksOutput.length === 0) return ''

    return `## 📄 \`${file.relativePath}\` (${CHANGE_TYPE_LABEL.modified})\n\n${blocksOutput.join('\n\n')}`
  }

  private findContainingBlock(lines: string[], targetLine: number): SemanticBlock | null {
    if (lines.length === 0 || targetLine <= 0) return null
    const target = Math.min(targetLine - 1, lines.length - 1)

    let sigLine = -1
    for (let i = target; i >= 0; i--) {
      if (SIGNATURE_PATTERNS.some(p => p.test(lines[i]))) {
        sigLine = i
        break
      }
    }

    if (sigLine === -1) return null

    let depth = 0
    let foundOpen = false
    let endLine = -1

    for (let i = sigLine; i < lines.length; i++) {
      const opens = (lines[i].match(/\{/g) || []).length
      const closes = (lines[i].match(/\}/g) || []).length
      if (opens > 0) foundOpen = true
      depth += opens - closes
      if (foundOpen && depth <= 0) { endLine = i; break }
    }

    if (endLine === -1) endLine = Math.min(sigLine + 80, lines.length - 1)

    return {
      signature: lines[sigLine].trim(),
      startLine: sigLine + 1,
      endLine: endLine + 1,
      lines: lines.slice(sigLine, endLine + 1)
    }
  }

  private formatDoubleBlock(newBlock: SemanticBlock, oldBlock: SemanticBlock | null, lang: string): string {
    const label = newBlock.signature.replace(/[{].*$/, '').replace(/=>\s*$/, '').trim()
    const linesInterval = `(Linhas ${newBlock.startLine} a ${newBlock.endLine})`
    
    let output = `### Bloco: \`${label}\` ${linesInterval}\n\n`

    if (oldBlock) {
      output += `#### 🟥 [Código Original / Negativo]\n`
      output += `\`\`\`${lang}\n${oldBlock.lines.join('\n')}\n\`\`\`\n\n`
    } else {
      output += `#### 🟥 [Código Original / Negativo]\n`
      output += `*(Nenhuma versão anterior identificada)*\n\n`
    }

    output += `#### 🟩 [Código Novo / Positivo]\n`
    output += `\`\`\`${lang}\n${newBlock.lines.join('\n')}\n\`\`\``

    return output
  }
}
```

src/main/core/git-service.ts
```
// Responsabilidades do Script
//
// 1. Verificar se um diretório é um repositório Git válido.
// 2. Obter a lista de arquivos modificados (staged e unstaged) via comandos nativos do Git.
// 3. Extrair os hunks de alteração de um arquivo específico para mapeamento de linhas.
// 4. Ler o conteúdo de um arquivo no estado do commit HEAD anterior.

import { spawn } from 'child_process'
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { DiffFileStatus } from '../../shared/types'

const GIT_TIMEOUT_MS = 10_000

export interface DiffHunk {
  oldStart: number
  oldCount: number
  start: number // primeira linha modificada no novo arquivo (1-indexed)
  count: number // quantidade de linhas afetadas
}

const GIT_STATUS_CODE_MAP: Record<string, DiffFileStatus['changeType']> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  '?': 'added'
}

export class GitService {
  async isGitRepository(dirPath: string): Promise<boolean> {
    return existsSync(join(dirPath, '.git'))
  }

  private runGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      const proc = spawn('git', args, { cwd, shell: false })

      // Timeout de proteção contra processos Git travados
      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('Git process timed out'))
      }, GIT_TIMEOUT_MS)

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(stdout)
        else reject(new Error(stderr.trim() || `git exited with code ${code}`))
      })
      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  async getModifiedFiles(dirPath: string): Promise<DiffFileStatus[]> {
    try {
      const stdout = await this.runGit(['status', '--porcelain'], dirPath)
      const files = this.parseGitStatus(stdout)
      return files
        .map(f => {
          try {
            const st = statSync(join(dirPath, f.relativePath))
            return { ...f, mtime: st.mtimeMs }
          } catch {
            return { ...f, mtime: 0 }
          }
        })
        .sort((a, b) => b.mtime - a.mtime)
        .map(({ mtime, ...f }) => f)
    } catch {
      return []
    }
  }

  async getModifiedHunks(dirPath: string, relativePath: string): Promise<DiffHunk[]> {
    try {
      const stdout = await this.runGit(['diff', 'HEAD', '-U0', '--', relativePath], dirPath)
      return this.parseHunks(stdout)
    } catch {
      return []
    }
  }

  async getFileAtHead(dirPath: string, relativePath: string): Promise<string | null> {
    try {
      const stdout = await this.runGit(['show', `HEAD:${relativePath}`], dirPath)
      return stdout
    } catch {
      return null
    }
  }

  private parseHunks(diffOutput: string): DiffHunk[] {
    const pattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm
    const hunks: DiffHunk[] = []

    for (const match of diffOutput.matchAll(pattern)) {
      const oldStart = parseInt(match[1])
      const oldCount = match[2] !== undefined ? parseInt(match[2]) : 1
      const start = parseInt(match[3])
      const count = match[4] !== undefined ? parseInt(match[4]) : 1
      hunks.push({ oldStart, oldCount, start, count })
    }

    return hunks
  }

  private parseGitStatus(output: string): DiffFileStatus[] {
    return output
      .split('\n')
      .map(line => {
        if (line.trim().length === 0) return null
        
        let relativePath = line.substring(3).trim()
        
        // Handle git renames (e.g., 'old_path -> new_path')
        if (relativePath.includes(' -> ')) {
          relativePath = relativePath.split(' -> ').pop()!.trim()
        }
        
        // Remove surrounding quotes if git porcelain added them
        if (relativePath.startsWith('"') && relativePath.endsWith('"')) {
          relativePath = relativePath.substring(1, relativePath.length - 1)
        }
        
        if (!relativePath || relativePath.endsWith('/')) return null
        const name = relativePath.split('/').pop() ?? relativePath
        if (!name) return null
        
        if (relativePath === 'code_awareness' || relativePath.startsWith('code_awareness/')) return null
        if (relativePath === 'codefetch' || relativePath.startsWith('codefetch/')) return null
        if (relativePath === '.sprintdiff' || relativePath.startsWith('.sprintdiff/')) return null
        
        const code = line.substring(0, 2).trim()
        const changeType = GIT_STATUS_CODE_MAP[code[0]] ?? 'modified'
        return { relativePath, name, changeType }
      })
      .filter((item): item is DiffFileStatus => item !== null)
  }
}
```

src/main/core/settings-service.ts
```
// Responsabilidades do Script
//
// 1. Persistir e recuperar as configurações locais do aplicativo (ex: caminho do vault Obsidian).

import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { AppSettings } from '../../shared/types'

const DEFAULT_SETTINGS: AppSettings = {
  obsidianVaultPath: null,
  rootFolders: [],
  individualProjects: [],
  hiddenProjects: []
}

export class SettingsService {
  private getConfigFile(): string {
    const configDir = app.getPath('userData')
    return join(configDir, 'settings.json')
  }

  loadSettings(): AppSettings {
    const configFile = this.getConfigFile()
    if (!existsSync(configFile)) return { ...DEFAULT_SETTINGS }
    try {
      const raw = readFileSync(configFile, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        rootFolders: parsed.rootFolders || [],
        individualProjects: parsed.individualProjects || [],
        hiddenProjects: parsed.hiddenProjects || []
      }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  saveSettings(settings: AppSettings): void {
    const configDir = app.getPath('userData')
    const configFile = this.getConfigFile()
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
    writeFileSync(configFile, JSON.stringify(settings, null, 2), 'utf-8')
  }
}
```

src/main/core/vault-service.ts
```
// Responsabilidades do Script
//
// 1. Salvar o Markdown gerado no vault do Obsidian, tratando colisões de nome de arquivo.

import { writeFileSync, existsSync } from 'fs'
import { join, extname, basename } from 'path'

export class VaultService {
  async saveToVault(
    markdown: string,
    repoName: string,
    vaultPath: string
  ): Promise<void> {
    const filename = this.resolveFilename(vaultPath, repoName)
    try {
      writeFileSync(filename, markdown, 'utf-8')
    } catch (error: any) {
      throw new Error(
        `Falha ao salvar o arquivo no vault do Obsidian. Verifique as permissões de escrita do diretório ou se há espaço em disco. Detalhes: ${error.message}`
      )
    }
  }

  private resolveFilename(vaultPath: string, repoName: string): string {
    const base = repoName.replace(/[<>:"/\\|?*]/g, '-')
    const candidate = join(vaultPath, `${base}.md`)
    if (!existsSync(candidate)) return candidate

    let counter = 1
    while (true) {
      const name = join(vaultPath, `${base} (${counter}).md`)
      if (!existsSync(name)) return name
      counter++
    }
  }
}
```

src/main/core/watcher-service.ts
```
// Responsabilidades do Script
//
// 1. Monitorar em segundo plano as mudanças de arquivos de texto em um diretório raiz.
// 2. Manter em memória a lista de caminhos dos arquivos modificados desde o início da observação.

import { watch, FSWatcher } from 'fs'
import { join, extname } from 'path'

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', '.DS_Store', 'codefetch', 'code_awareness', '.sprintdiff'])

const IGNORED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp',
  '.mp4', '.mp3', '.wav', '.ogg', '.avi', '.mov',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.pdf', '.exe', '.dll', '.so', '.bin', '.wasm'
])

export class WatcherService {
  private watcher: FSWatcher | null = null
  private modifiedFiles = new Set<string>()

  start(rootPath: string, onFileChanged: (filePath: string) => void): void {
    this.stop()

    this.watcher = watch(rootPath, { recursive: true }, (_eventType, filename) => {
      if (!filename || this.shouldIgnore(filename)) return

      const fullPath = join(rootPath, filename).replace(/\\/g, '/')
      this.modifiedFiles.add(fullPath)

      console.log(`[WatcherService] Arquivo modificado: ${fullPath}`)
      onFileChanged(fullPath)
    })

    this.watcher.on('error', (err) => {
      console.error('[WatcherService] Erro no watcher:', err.message)
    })
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    this.modifiedFiles.clear()
  }

  getModifiedFiles(): string[] {
    return Array.from(this.modifiedFiles)
  }

  private shouldIgnore(filename: string): boolean {
    const parts = filename.replace(/\\/g, '/').split('/')
    if (parts.some(part => IGNORED_DIRS.has(part))) return true
    return IGNORED_EXTENSIONS.has(extname(filename).toLowerCase())
  }
}
```

src/main/core/workspace-service.ts
```
// Responsabilidades do Script
//
// 1. Escanear pastas raiz em busca de subdiretórios que representem projetos válidos.
// 2. Verificar a existência de repositórios Git nas subpastas e projetos isolados.
// 3. Consolidar e retornar a listagem final de projetos disponíveis.

import fs from 'fs'
import path from 'path'
import { AppSettings, ProjectInfo } from '../../shared/types'

export class WorkspaceService {
  /**
   * Verifica fisicamente se a pasta existe e se possui um `.git` dentro dela.
   */
  private async checkProjectGitInfo(folderPath: string): Promise<ProjectInfo | null> {
    try {
      const stats = await fs.promises.stat(folderPath)
      if (!stats.isDirectory()) return null

      const name = path.basename(folderPath)
      const gitPath = path.join(folderPath, '.git')
      
      let isGit = false
      try {
        const gitStats = await fs.promises.stat(gitPath)
        isGit = gitStats.isDirectory() || gitStats.isFile() // .git can be a file in submodules/worktrees
      } catch {
        isGit = false
      }

      return { path: folderPath, name, isGit }
    } catch {
      // Pasta não existe mais ou sem permissão
      return null
    }
  }

  /**
   * Lê o primeiro nível de uma pasta raiz e retorna todos os subdiretórios válidos.
   */
  private async scanRootFolder(rootPath: string): Promise<ProjectInfo[]> {
    const projects: ProjectInfo[] = []
    try {
      const entries = await fs.promises.readdir(rootPath, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const name = entry.name
        // Ignorar pastas ocultas, build e config comum
        if (name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'build') {
          continue
        }

        const fullPath = path.join(rootPath, name)
        const projectInfo = await this.checkProjectGitInfo(fullPath)
        
        if (projectInfo) {
          projects.push(projectInfo)
        }
      }
    } catch (err) {
      console.error(`Erro ao ler root folder ${rootPath}:`, err)
    }

    return projects
  }

  /**
   * Método consolidado que processa rootFolders e individualProjects das configurações
   * para retornar uma lista única de projetos.
   */
  async getProjectsList(settings: AppSettings): Promise<ProjectInfo[]> {
    const allProjects: Map<string, ProjectInfo> = new Map()

    // 1. Processar pastas individuais (ganham precedência)
    for (const projPath of settings.individualProjects || []) {
      const info = await this.checkProjectGitInfo(projPath)
      if (info) {
        // Normaliza chave para evitar duplicatas em Windows vs Unix
        allProjects.set(path.resolve(projPath), info)
      }
    }

    // 2. Escanear pastas raízes
    for (const rootPath of settings.rootFolders || []) {
      const scanned = await this.scanRootFolder(rootPath)
      for (const info of scanned) {
        const key = path.resolve(info.path)
        if (!allProjects.has(key)) {
          allProjects.set(key, info)
        }
      }
    }

    const hiddenSet = new Set(settings.hiddenProjects || [])
    const visibleProjects = Array.from(allProjects.values()).filter(p => !hiddenSet.has(p.path))

    // Ordenar alfabeticamente pelo nome do projeto
    return visibleProjects.sort((a, b) => a.name.localeCompare(b.name))
  }
}
```

src/main/ipc/codefetch-handler.ts
```
// Responsabilidades do Script
//
// 1. Registrar os handlers IPC para verificação e execução do Codefetch.

import { ipcMain } from 'electron'
import { CodefetchAdapter } from '../core/codefetch-adapter'

const adapter = new CodefetchAdapter()

export function registerCodefetchHandlers(): void {
  ipcMain.handle('check-codefetch', async () => {
    return adapter.checkInstallation()
  })

  ipcMain.handle('run-codefetch', async (_event, repoPath: string) => {
    return adapter.run(repoPath)
  })
}
```

src/main/ipc/file-handler.ts
```
// Responsabilidades do Script
//
// 1. Registrar os handlers IPC para salvar Markdown localmente e no vault do Obsidian.
// 2. Registrar o handler IPC para selecionar uma pasta de repositório via diálogo nativo do Electron.

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'
import { basename } from 'path'
import { VaultService } from '../core/vault-service'

const vaultService = new VaultService()

export function registerFileHandlers(): void {
  ipcMain.handle('save-markdown', async (event, markdown: string, repoName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender) as BrowserWindow
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Save Markdown',
      defaultPath: `${repoName}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })

    if (canceled || !filePath) return { success: false, error: 'Cancelled' }

    try {
      writeFileSync(filePath, markdown, 'utf-8')
      return { success: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: message }
    }
  })

  ipcMain.handle(
    'save-to-obsidian',
    async (_event, markdown: string, repoName: string, vaultPath: string) => {
      try {
        await vaultService.saveToVault(markdown, repoName, vaultPath)
        return { success: true }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        return { success: false, error: message }
      }
    }
  )

  ipcMain.handle('select-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) as BrowserWindow
    const { filePaths, canceled } = await dialog.showOpenDialog(win, {
      title: 'Select Repository Folder',
      properties: ['openDirectory']
    })

    if (canceled || !filePaths.length) return null
    const path = filePaths[0]
    return {
      path,
      name: basename(path)
    }
  })
}
```

src/main/ipc/git-handler.ts
```
// Responsabilidades do Script
//
// 1. Registrar os handlers IPC para verificação de repositório Git e listagem de arquivos modificados.
// 2. Registrar os handlers IPC para controle do ciclo de vida do WatcherService.
// 3. Emitir eventos push ao renderer via webContents.send quando arquivos forem detectados pelo watcher.
// 4. Registrar o handler IPC que dispara a geração do Semantic Diff via DiffService.

import { ipcMain } from 'electron'
import { GitService } from '../core/git-service'
import { WatcherService } from '../core/watcher-service'
import { DiffService } from '../core/diff-service'

const gitService = new GitService()
const diffService = new DiffService()

// Valida se o path recebido via IPC é uma string não vazia
function isValidPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function registerGitHandlers(watcherService: WatcherService): void {
  ipcMain.handle('git:check-repository', async (_event, dirPath: string) => {
    if (!isValidPath(dirPath)) return false
    return gitService.isGitRepository(dirPath)
  })

  ipcMain.handle('git:get-modified-files', async (_event, dirPath: string) => {
    if (!isValidPath(dirPath)) return []
    return gitService.getModifiedFiles(dirPath)
  })

  ipcMain.handle('watcher:start', async (event, dirPath: string) => {
    if (!isValidPath(dirPath)) return { success: false }
    const webContents = event.sender
    watcherService.start(dirPath, (filePath) => {
      if (!webContents.isDestroyed()) {
        webContents.send('watcher:file-changed', filePath)
      }
    })
    return { success: true }
  })

  ipcMain.handle('watcher:stop', async () => {
    watcherService.stop()
    return { success: true }
  })

  ipcMain.handle('git:generate-semantic-diff', async (_event, repoPath: string) => {
    if (!isValidPath(repoPath)) return ''
    return diffService.generateSemanticDiff(repoPath)
  })
}
```

src/main/ipc/settings-handler.ts
```
// Responsabilidades do Script
//
// 1. Registrar os handlers IPC para carregar, salvar configurações e selecionar o vault do Obsidian.

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { SettingsService } from '../core/settings-service'

const settingsService = new SettingsService()

export function registerSettingsHandlers(): void {
  ipcMain.handle('load-settings', async () => {
    return settingsService.loadSettings()
  })

  ipcMain.handle('save-settings', async (_event, settings) => {
    settingsService.saveSettings(settings)
    return { success: true }
  })

  ipcMain.handle('select-vault-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) as BrowserWindow
    const { filePaths, canceled } = await dialog.showOpenDialog(win, {
      title: 'Select Obsidian Vault Folder',
      properties: ['openDirectory']
    })

    if (canceled || !filePaths.length) return null
    return filePaths[0]
  })
}
```

src/main/ipc/workspace-handler.ts
```
// Responsabilidades do Script
//
// 1. Interceptar chamadas IPC do render process relacionadas a projetos e pastas raízes.
// 2. Acionar as caixas de diálogo nativas do sistema para seleção de pastas.
// 3. Orquestrar a persistência nas configurações e acionar o WorkspaceService para devolver a lista atualizada.

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { SettingsService } from '../core/settings-service'
import { WorkspaceService } from '../core/workspace-service'

export function registerWorkspaceHandlers(
  settingsService: SettingsService,
  workspaceService: WorkspaceService
) {
  ipcMain.handle('workspace:add-root-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) as BrowserWindow
    const result = await dialog.showOpenDialog(win, {
      title: 'Adicionar Pasta Raiz (Múltiplos Projetos)',
      properties: ['openDirectory']
    })

    if (!result.canceled && result.filePaths.length > 0) {
      const folderPath = result.filePaths[0]
      const settings = settingsService.loadSettings()
      
      if (!settings.rootFolders.includes(folderPath)) {
        settings.rootFolders.push(folderPath)
        settingsService.saveSettings(settings)
      }
      
      return await workspaceService.getProjectsList(settings)
    }

    return await workspaceService.getProjectsList(settingsService.loadSettings())
  })

  ipcMain.handle('workspace:add-individual-project', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) as BrowserWindow
    const result = await dialog.showOpenDialog(win, {
      title: 'Adicionar Projeto Único',
      properties: ['openDirectory']
    })

    if (!result.canceled && result.filePaths.length > 0) {
      const projectPath = result.filePaths[0]
      const settings = settingsService.loadSettings()
      
      if (!settings.individualProjects.includes(projectPath)) {
        settings.individualProjects.push(projectPath)
        settingsService.saveSettings(settings)
      }
      
      return await workspaceService.getProjectsList(settings)
    }

    return await workspaceService.getProjectsList(settingsService.loadSettings())
  })

  ipcMain.handle('workspace:get-projects-list', async () => {
    const settings = settingsService.loadSettings()
    return await workspaceService.getProjectsList(settings)
  })

  ipcMain.handle('workspace:hide-project', async (_event, projectPath: string) => {
    const settings = settingsService.loadSettings()
    if (!settings.hiddenProjects.includes(projectPath)) {
      settings.hiddenProjects.push(projectPath)
      settingsService.saveSettings(settings)
    }
    return await workspaceService.getProjectsList(settings)
  })
}
```

src/main/utils/env-sanitizer.ts
```
// Responsabilidades do Script
//
// 1. Normalizar a variável PATH no Windows para garantir que caminhos globais de pacotes NPM/Yarn/PNPM sejam encontrados.

import { existsSync } from 'fs'
import { join } from 'path'

/**
 * Normaliza a variável de ambiente PATH no Windows,
 * adicionando caminhos globais de pacotes NPM, Yarn e PNPM quando necessário.
 * Isso resolve problemas de detecção de comandos externos quando o aplicativo
 * é empacotado/compilado e o PATH do sistema não inclui esses diretórios.
 */
export function sanitizeEnvironment(): void {
  if (process.platform !== 'win32') {
    return
  }

  // Localizar a chave do PATH de forma case-insensitive
  let pathKey: string | undefined
  let currentPath: string | undefined

  for (const key of Object.keys(process.env)) {
    if (key.toLowerCase() === 'path') {
      pathKey = key
      currentPath = process.env[key]
      break
    }
  }

  if (!pathKey || !currentPath) {
    console.log('[EnvSanitizer] PATH não encontrado no ambiente.')
    return
  }

  const appData = process.env.APPDATA
  if (!appData) {
    console.log('[EnvSanitizer] APPDATA não encontrado, pulando saneamento.')
    return
  }

  const pathsToAdd: string[] = []

  // Verificar NPM global bin
  const npmPath = join(appData, 'npm')
  if (existsSync(npmPath)) {
    const npmBin = join(npmPath, 'bin')
    if (!currentPath.toLowerCase().includes(npmBin.toLowerCase())) {
      pathsToAdd.push(npmBin)
      console.log(`[EnvSanitizer] Adicionando ao PATH: ${npmBin}`)
    }
  }

  // Verificar Yarn global bin
  const yarnPath = join(appData, 'yarn', 'bin')
  if (existsSync(join(appData, 'yarn')) && existsSync(yarnPath)) {
    if (!currentPath.toLowerCase().includes(yarnPath.toLowerCase())) {
      pathsToAdd.push(yarnPath)
      console.log(`[EnvSanitizer] Adicionando ao PATH: ${yarnPath}`)
    }
  }

  // Verificar PNPM global bin
  const pnpmPath = join(appData, 'pnpm')
  if (existsSync(pnpmPath)) {
    if (!currentPath.toLowerCase().includes(pnpmPath.toLowerCase())) {
      pathsToAdd.push(pnpmPath)
      console.log(`[EnvSanitizer] Adicionando ao PATH: ${pnpmPath}`)
    }
  }

  if (pathsToAdd.length > 0) {
    const newPath = currentPath + ';' + pathsToAdd.join(';')
    process.env[pathKey] = newPath
    console.log(`[EnvSanitizer] PATH atualizado com sucesso.`)
  } else {
    console.log(`[EnvSanitizer] Nenhum caminho adicional necessário.`)
  }
}
```

src/renderer/src/App.css
```
.app-container {
  max-width: 1000px;
  margin: 0 auto;
  padding: 30px 20px;
  box-sizing: border-box;
}

.app-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 32px;
}

.logo-section {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo-icon {
  font-size: 24px;
  font-weight: 600;
  color: var(--accent);
}

.app-title {
  font-size: 28px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
  letter-spacing: -0.5px;
}

.app-main {
  display: flex;
  flex-direction: column;
}

/* Error Banner styling */
.error-banner {
  background-color: rgba(248, 81, 73, 0.05);
  border: 1px solid #f85149;
  border-radius: 8px;
  padding: 12px 16px;
  margin-top: 20px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.error-icon {
  font-size: 16px;
  margin-top: 1px;
}

.error-text {
  font-family: system-ui, -apple-system, sans-serif;
  color: #f85149;
  font-size: 13px;
  line-height: 1.5;
}

/* Status Toast Notification */
.status-toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  padding: 12px 20px;
  border-radius: 999px;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 13px;
  font-weight: 500;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
  z-index: 1000;
  animation: slideIn 0.3s ease-out;
  max-width: 400px;
}

.status-toast.success {
  background-color: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--accent);
}

.status-toast.error {
  background-color: #1a0f0f;
  color: #f85149;
  border: 1px solid #f85149;
}

@keyframes slideIn {
  from {
    transform: translateY(20px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

/* Tabs System - Pill Shape */
.tabs-container {
  display: inline-flex;
  background-color: #161616;
  border-radius: 9999px;
  padding: 4px;
  border: 1px solid var(--border);
  gap: 0;
}

.tab-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  padding: 8px 16px;
  border-radius: 9999px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.tab-btn:hover {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.05);
}

.tab-btn.active {
  background: rgba(120, 82, 238, 0.15);
  border: 1px solid var(--accent);
  color: var(--text-primary);
}

.tab-badge {
  background: rgba(124, 58, 237, 0.2);
  color: var(--accent-hover);
  border: 1px solid rgba(124, 58, 237, 0.3);
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 999px;
  font-weight: 700;
  text-transform: uppercase;
}

/* Code Source Flow Styles */
.active-project-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px 24px;
  margin-bottom: 24px;
}

.active-project-info h3 {
  margin: 0 0 4px 0;
  font-size: 16px;
  color: var(--text-primary);
}

.active-project-info .path-text {
  font-size: 12px;
  color: var(--text-secondary);
  font-family: monospace;
}

.empty-selection-banner {
  text-align: center;
  padding: 60px 20px;
  background: var(--bg-secondary);
  border: 1px dashed var(--border);
  border-radius: 12px;
  margin-bottom: 24px;
}

.empty-selection-banner h3 {
  margin: 0 0 8px 0;
  color: var(--text-primary);
  font-size: 18px;
}

.empty-selection-banner p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 14px;
}
```

src/renderer/src/App.tsx
```
// Responsabilidades do Script
//
// 1. Orquestrar o estado global da aplicação (status de instalação, configurações do vault, progresso de análise, markdown gerado).
// 2. Coordenar o fluxo de inicialização carregando configurações e testando a presença da CLI externa do Codefetch.
// 3. Gerenciar o fluxo principal de arrastar pasta, acionar análise externa e tratar erros/sucessos do processo.

import React, { useEffect, useState } from 'react'
import { AppSettings } from '../../shared/types'
import { SetupBanner } from './components/SetupBanner/SetupBanner'
import { ActionsBar } from './components/ActionsBar/ActionsBar'
import { OutputPanel } from './components/OutputPanel/OutputPanel'
import { CodeDiffView } from './components/CodeDiffView/CodeDiffView'
import { HomeView } from './components/HomeView/HomeView'
import './App.css'

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'home' | 'codebase' | 'diff'>('home')
  const [activeProject, setActiveProject] = useState<{ path: string; name: string } | null>(null)
  const [isCodefetchInstalled, setIsCodefetchInstalled] = useState<boolean>(true)
  const [settings, setSettings] = useState<AppSettings>({ obsidianVaultPath: null })
  const [markdown, setMarkdown] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [isProcessing, setIsProcessing] = useState<boolean>(false)
  const [repoName, setRepoName] = useState<string>('')
  const [statusMessage, setStatusMessage] = useState<{ text: string; isError: boolean } | null>(null)

  // Fluxo de Inicialização (Startup Flow)
  useEffect(() => {
    const init = async () => {
      try {
        const installed = await window.codeAwareness.checkCodefetch()
        setIsCodefetchInstalled(installed)

        const loadedSettings = await window.codeAwareness.loadSettings()
        setSettings(loadedSettings)
      } catch (err) {
        console.error('Falha na inicialização do aplicativo:', err)
        setError('Ocorreu um erro ao carregar as configurações do sistema.')
      }
    }
    init()
  }, [])

  // Gerenciamento de mensagens temporárias de status
  const handleStatusMessage = (text: string, isError = false) => {
    setStatusMessage({ text, isError })
    if (!isError) {
      setTimeout(() => {
        setStatusMessage(null)
      }, 5000)
    }
  }

  // Fluxo Principal (Main Flow)
  const handleRunAnalysis = async () => {
    if (!isCodefetchInstalled) {
      handleStatusMessage('Codefetch não está instalado. Não é possível rodar a análise.', true)
      return
    }
    
    if (!activeProject) {
      handleStatusMessage('Nenhum projeto selecionado.', true)
      return
    }

    setIsProcessing(true)
    setError('')
    setMarkdown('')
    setRepoName(activeProject.name)
    setStatusMessage(null)

    try {
      const result = await window.codeAwareness.runCodefetch(activeProject.path)

      if (result.success && result.markdown) {
        setMarkdown(result.markdown)
        handleStatusMessage(`Análise concluída com sucesso para o repositório "${activeProject.name}"!`, false)
      } else {
        setError(result.error || 'Erro desconhecido durante a execução do Codefetch.')
        handleStatusMessage('A análise falhou.', true)
      }
    } catch (err: any) {
      setError(err.message || 'Falha na comunicação com o processo principal.')
      handleStatusMessage('Ocorreu um erro técnico ao executar a análise.', true)
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo-section">
          <span className="logo-icon">{"</>"}</span>
          <h1 className="app-title">Code Awareness</h1>
        </div>
        
        <div className="tabs-container">
          <button 
            className={`tab-btn ${activeTab === 'home' ? 'active' : ''}`}
            onClick={() => setActiveTab('home')}
          >
            Projetos
          </button>
          <button 
            className={`tab-btn ${activeTab === 'codebase' ? 'active' : ''}`}
            onClick={() => setActiveTab('codebase')}
          >
            Code Source
          </button>
          <button 
            className={`tab-btn ${activeTab === 'diff' ? 'active' : ''}`}
            onClick={() => setActiveTab('diff')}
          >
            Code Diff <span className="tab-badge">Live</span>
          </button>
        </div>
      </header>

      <main className="app-main">
        {activeTab === 'home' && (
          <HomeView activeProject={activeProject} onSelectProject={setActiveProject} />
        )}
        {activeTab === 'codebase' && (
          <>
            {!isCodefetchInstalled && <SetupBanner />}

            {!activeProject ? (
              <div className="empty-selection-banner">
                <h3>Nenhum projeto selecionado</h3>
                <p>Volte para a aba <strong>Projetos</strong> e ative um repositório para gerar o código fonte.</p>
              </div>
            ) : (
              <div className="active-project-card">
                <div className="active-project-info">
                  <h3>{activeProject.name}</h3>
                  <span className="path-text">{activeProject.path}</span>
                </div>
                <button 
                  className="app-pill-btn" 
                  onClick={handleRunAnalysis}
                  disabled={isProcessing || !isCodefetchInstalled}
                >
                  {isProcessing ? 'Processando...' : 'Gerar Código Fonte'}
                </button>
              </div>
            )}

        {error && (
          <div className="error-banner">
            <span className="error-icon">❌</span>
            <div className="error-text">
              <strong>Erro na análise:</strong> {error}
            </div>
          </div>
        )}

        {statusMessage && (
          <div className={`status-toast ${statusMessage.isError ? 'error' : 'success'}`}>
            {statusMessage.text}
          </div>
        )}

        {markdown && (
          <>
            <ActionsBar
              markdown={markdown}
              repoName={repoName}
              settings={settings}
              onSettingsUpdate={setSettings}
              onStatusMessage={handleStatusMessage}
            />
            <OutputPanel markdown={markdown} />
          </>
        )}
          </>
        )}
        {activeTab === 'diff' && (
          <CodeDiffView activeProject={activeProject} />
        )}
      </main>
    </div>
  )
}
```

src/renderer/src/index.css
```
:root {
  --bg-primary: #1e1e1e;
  --bg-secondary: #1c1c1c;
  --border: #2d2d2d;
  --text-primary: #f5f5f5;
  --text-secondary: #a1a1aa;
  --accent: #7852ee;
  --accent-hover: #8b5cf6;
  --color-green: #44cf6e;
}

body {
  margin: 0;
  padding: 0;
  background-color: var(--bg-primary);
  color: var(--text-primary);
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  overflow-y: auto;
}

/* Custom Scrollbar styling for premium look */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: var(--bg-primary);
}

::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--text-secondary);
}

/* Global Pill Button - Design System Unificado */
.app-pill-btn {
  border-radius: 9999px;
  height: 38px;
  padding: 0 20px;
  font-size: 13px;
  font-weight: 600;
  border: 1px solid var(--accent);
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  white-space: nowrap;
}

.app-pill-btn:hover {
  background: var(--accent);
  color: #ffffff;
  box-shadow: 0 0 12px rgba(120, 82, 238, 0.4);
}

.app-pill-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

src/renderer/src/main.tsx
```
// Responsabilidades do Script
//
// 1. Inicializar a aplicação React montando o componente raiz App na árvore DOM.
// 2. Importar e carregar os estilos CSS globais do processo de renderização.

import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

src/renderer/src/vite-env.d.ts
```
// Responsabilidades do Script
//
// 1. Declarar a interface global do objeto codeAwareness no escopo do objeto Window do browser.
// 2. Prover suporte a tipos adicionais do ambiente do Vite para o processo renderer.

/// <reference types="vite/client" />

import { AppSettings, CodefetchResult, DiffFileStatus, ProjectInfo } from '../../shared/types'

declare global {
  interface Window {
    codeAwareness: {
      checkCodefetch: () => Promise<boolean>
      runCodefetch: (repoPath: string) => Promise<CodefetchResult>
      saveMarkdown: (markdown: string, repoName: string) => Promise<{ success: boolean; error?: string }>
      saveToObsidian: (
        markdown: string,
        repoName: string,
        vaultPath: string
      ) => Promise<{ success: boolean; error?: string }>
      loadSettings: () => Promise<AppSettings>
      saveSettings: (settings: AppSettings) => Promise<{ success: boolean }>
      selectVaultFolder: () => Promise<string | null>
      selectFolder: () => Promise<{ path: string; name: string } | null>
      getPathForFile: (file: File) => string
      checkRepository: (dirPath: string) => Promise<boolean>
      getModifiedFiles: (dirPath: string) => Promise<DiffFileStatus[]>
      startWatcher: (dirPath: string) => Promise<{ success: boolean }>
      stopWatcher: () => Promise<{ success: boolean }>
      onFileChanged: (callback: (filePath: string) => void) => () => void
      generateSemanticDiff: (repoPath: string) => Promise<string>
      addRootFolder: () => Promise<ProjectInfo[]>
      addIndividualProject: () => Promise<ProjectInfo[]>
      getProjectsList: () => Promise<ProjectInfo[]>
      hideProject: (projectPath: string) => Promise<ProjectInfo[]>
    }
  }
}
```

src/renderer/src/components/ActionsBar/ActionsBar.css
```
.actions-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  background-color: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 18px;
  margin-top: 20px;
}

.actions-group {
  display: flex;
  gap: 10px;
}

.action-btn {
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 13px;
  font-weight: 600;
  height: 42px;
  padding: 0 18px;
  border-radius: 999px;
  cursor: pointer;
  border: 1px solid var(--border);
  transition: background-color 180ms ease, border-color 180ms ease, color 180ms ease;
  background-color: var(--bg-primary);
  color: var(--text-primary);
}

.action-btn:hover:not(:disabled) {
  background-color: var(--bg-secondary);
  border-color: var(--accent);
  color: var(--accent-hover);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background-color: var(--bg-secondary);
  border-color: var(--border);
  color: var(--text-secondary);
}

/* Specific button accents */
.copy-btn:hover:not(:disabled) {
  color: var(--accent-hover);
  border-color: var(--accent);
}

.obsidian-btn {
  background-color: var(--bg-primary);
  border-color: var(--border);
  color: var(--text-primary);
}

.obsidian-btn:hover:not(:disabled) {
  background-color: var(--bg-secondary);
  border-color: var(--accent);
  color: var(--accent-hover);
}

.vault-config-info {
  display: flex;
  align-items: center;
}

.vault-path-text {
  font-family: system-ui, -apple-system, sans-serif;
  color: var(--text-secondary);
  font-size: 12px;
}

.vault-path-text code {
  background-color: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px 8px;
  margin: 0 6px;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--text-primary);
  max-width: 250px;
  display: inline-block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}

.change-vault-btn {
  background: none;
  border: none;
  color: var(--accent-hover);
  font-size: 11px;
  cursor: pointer;
  padding: 0 4px;
  text-decoration: underline;
}

.change-vault-btn:hover {
  color: var(--accent);
}

.vault-not-configured {
  font-family: system-ui, -apple-system, sans-serif;
  color: var(--text-secondary);
  font-size: 12px;
  font-style: italic;
}
```

src/renderer/src/components/ActionsBar/ActionsBar.tsx
```
// Responsabilidades do Script
//
// 1. Apresentar as opções de Copy, Save e Save to Obsidian para o Markdown gerado.
// 2. Controlar o estado de carregamento e desabilitação dos botões baseando-se no conteúdo disponível.
// 3. Orquestrar a cópia do conteúdo para o clipboard e disparar chamadas de IPC para exportação de arquivos.
// 4. Gerenciar o fluxo de seleção e salvamento de configurações do Vault do Obsidian quando ausente.

import React, { useState } from 'react'
import { AppSettings } from '../../../shared/types'
import './ActionsBar.css'

interface ActionsBarProps {
  markdown: string
  repoName: string
  settings: AppSettings
  onSettingsUpdate: (settings: AppSettings) => void
  onStatusMessage: (message: string, isError?: boolean) => void
}

export const ActionsBar: React.FC<ActionsBarProps> = ({
  markdown,
  repoName,
  settings,
  onSettingsUpdate,
  onStatusMessage
}) => {
  const [copied, setCopied] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  const isDisabled = !markdown || isSaving

  const handleCopy = async () => {
    if (isDisabled) return
    try {
      await navigator.clipboard.writeText(markdown)
      setCopied(true)
      onStatusMessage('Markdown copiado para a área de transferência!', false)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      onStatusMessage('Falha ao copiar markdown.', true)
    }
  }

  const handleSave = async () => {
    if (isDisabled) return
    setIsSaving(true)
    try {
      const res = await window.codeAwareness.saveMarkdown(markdown, repoName)
      if (res.success) {
        onStatusMessage('Markdown salvo com sucesso!', false)
      } else if (res.error !== 'Cancelled') {
        onStatusMessage(`Falha ao salvar: ${res.error}`, true)
      }
    } catch (err) {
      onStatusMessage('Falha ao acionar salvamento local.', true)
    } finally {
      setIsSaving(false)
    }
  }

  const handleSaveToObsidian = async () => {
    if (isDisabled) return
    setIsSaving(true)

    try {
      let vaultPath = settings.obsidianVaultPath

      if (!vaultPath) {
        // Fluxo de configuração do Vault pela primeira vez
        onStatusMessage('Selecione a pasta do seu Vault do Obsidian...', false)
        const selectedPath = await window.codeAwareness.selectVaultFolder()
        if (!selectedPath) {
          onStatusMessage('Seleção de Vault cancelada.', false)
          setIsSaving(false)
          return
        }

        const newSettings: AppSettings = { ...settings, obsidianVaultPath: selectedPath }
        await window.codeAwareness.saveSettings(newSettings)
        onSettingsUpdate(newSettings)
        vaultPath = selectedPath
      }

      onStatusMessage('Salvando no Obsidian Vault...', false)
      const res = await window.codeAwareness.saveToObsidian(markdown, repoName, vaultPath)

      if (res.success) {
        onStatusMessage(`Markdown salvo no Obsidian Vault: ${vaultPath}`, false)
      } else {
        onStatusMessage(`Erro ao salvar no Obsidian: ${res.error}`, true)
      }
    } catch (err) {
      onStatusMessage('Falha ao acionar salvamento no Obsidian.', true)
    } finally {
      setIsSaving(false)
    }
  }

  const handleConfigureVault = async () => {
    try {
      const selectedPath = await window.codeAwareness.selectVaultFolder()
      if (selectedPath) {
        const newSettings: AppSettings = { ...settings, obsidianVaultPath: selectedPath }
        await window.codeAwareness.saveSettings(newSettings)
        onSettingsUpdate(newSettings)
        onStatusMessage(`Vault configurado: ${selectedPath}`, false)
      }
    } catch (err) {
      onStatusMessage('Erro ao configurar Vault.', true)
    }
  }

  return (
    <div className="actions-bar" id="actions-bar">
      <div className="actions-group">
        <button
          className="action-btn copy-btn"
          onClick={handleCopy}
          disabled={isDisabled}
        >
          {copied ? 'Copiado!' : 'Copiar Markdown'}
        </button>
        <button
          className="action-btn save-btn"
          onClick={handleSave}
          disabled={isDisabled}
        >
          Salvar como arquivo
        </button>
        <button
          className="action-btn obsidian-btn"
          onClick={handleSaveToObsidian}
          disabled={isDisabled}
        >
          Salvar no Obsidian
        </button>
      </div>

      <div className="vault-config-info">
        {settings.obsidianVaultPath ? (
          <span className="vault-path-text" title={settings.obsidianVaultPath}>
            Obsidian: <code>{settings.obsidianVaultPath}</code>
            <button className="change-vault-btn" onClick={handleConfigureVault}>Alterar</button>
          </span>
        ) : (
          <span className="vault-not-configured">Obsidian Vault não configurado</span>
        )}
      </div>
    </div>
  )
}
```

src/renderer/src/components/CodeDiffView/CodeDiffView.css
```
/* CodeDiffView Layout */
.cdf-container {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 220px);
  min-height: 500px;
}

/* Topbar */
.cdf-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 10px 10px 0 0;
  flex-shrink: 0;
}

.cdf-repo-info {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}


.cdf-repo-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 400px;
}

.cdf-status-badge {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 999px;
  flex-shrink: 0;
}

.cdf-status-badge.watching {
  color: #4ade80;
  background: rgba(74, 222, 128, 0.1);
  border: 1px solid rgba(74, 222, 128, 0.25);
}

.cdf-status-badge.error {
  color: #f87171;
  background: rgba(248, 113, 113, 0.1);
  border: 1px solid rgba(248, 113, 113, 0.25);
}

.cdf-status-badge.loading {
  color: var(--text-secondary);
  background: rgba(161, 161, 170, 0.1);
  border: 1px solid var(--border);
}

.cdf-change-btn {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
  flex-shrink: 0;
}

.cdf-change-btn:hover {
  color: var(--text-primary);
  border-color: var(--text-secondary);
}

/* Split Layout */
.cdf-split {
  display: flex;
  flex: 1;
  overflow: hidden;
  border: 1px solid var(--border);
  border-top: none;
  border-radius: 0 0 12px 12px;
}

/* Sidebar */
.cdf-sidebar {
  width: 260px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  overflow: hidden;
}

.cdf-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.cdf-count-badge {
  font-size: 11px;
  font-weight: 700;
  background: rgba(124, 58, 237, 0.2);
  color: var(--accent-hover);
  border: 1px solid rgba(124, 58, 237, 0.35);
  border-radius: 999px;
  padding: 1px 7px;
}

.cdf-empty-state {
  padding: 20px 14px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
  margin: 0;
}

.cdf-file-list {
  list-style: none;
  margin: 0;
  padding: 6px 0;
  overflow-y: auto;
  flex: 1;
}

.cdf-file-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  cursor: pointer;
  border-radius: 0;
  transition: background 0.12s;
  border-left: 2px solid transparent;
}

.cdf-file-card:hover {
  background: rgba(255, 255, 255, 0.04);
}

.cdf-file-card.selected {
  background: rgba(124, 58, 237, 0.12);
  border-left-color: var(--accent);
}

.cdf-type-badge {
  font-size: 10px;
  font-weight: 700;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  flex-shrink: 0;
}

.cdf-type-badge.modified {
  background: rgba(251, 191, 36, 0.15);
  color: #fbbf24;
}

.cdf-type-badge.added {
  background: rgba(74, 222, 128, 0.15);
  color: #4ade80;
}

.cdf-type-badge.deleted {
  background: rgba(248, 113, 113, 0.15);
  color: #f87171;
}

.cdf-file-name {
  font-size: 12px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Diff Panel */
.cdf-diff-panel {
  flex: 1;
  overflow-y: auto;
  background: var(--bg-primary);
}

.cdf-diff-code-rendered {
  padding: 20px 24px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  overflow-y: auto;
  flex: 1;
}

/* Título de Arquivo H2 */
.cdf-diff-code-rendered h2 {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
  margin: 24px 0 16px 0;
}

.cdf-diff-code-rendered h2:first-child {
  margin-top: 0;
}

/* Nome de Bloco/Função H3 */
.cdf-diff-code-rendered h3 {
  font-size: 14px;
  font-weight: 600;
  color: var(--accent);
  margin: 20px 0 10px 0;
}

/* Marcadores Original/Novo H4 */
.cdf-diff-code-rendered h4 {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  margin: 12px 0 6px 0;
}

/* Blocos de Código */
.cdf-diff-code-rendered pre {
  background-color: #161616;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  margin: 0 0 12px 0;
  overflow-x: auto;
  font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-primary);
}

.cdf-diff-code-rendered pre code {
  font-family: inherit;
  font-size: inherit;
  background: none;
  padding: 0;
  border: none;
}

/* HR — separador entre arquivos */
.cdf-diff-code-rendered hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 28px 0;
}

/* Parágrafos e texto normal */
.cdf-diff-code-rendered p {
  margin: 0 0 8px 0;
  color: var(--text-secondary);
  font-size: 13px;
}

/* Inline code */
.cdf-diff-code-rendered code {
  font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
  font-size: 12px;
  background-color: rgba(255, 255, 255, 0.05);
  padding: 2px 6px;
  border-radius: 4px;
}

.cdf-diff-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 13px;
  color: var(--text-secondary);
  padding: 40px;
  text-align: center;
  line-height: 1.6;
}

/* DropZone fallback (sem repositório carregado) */
.cdf-dropzone-wrapper {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 0;
}

.cdf-dropzone {
  width: 100%;
  max-width: 500px;
  border: 1.5px dashed var(--border);
  border-radius: 14px;
  padding: 48px 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
  cursor: default;
  transition: border-color 0.2s, background 0.2s;
}

.cdf-dropzone.hover {
  border-color: var(--accent);
  background: rgba(124, 58, 237, 0.05);
}

.cdf-dropzone-icon {
  font-size: 36px;
  margin-bottom: 4px;
}

.cdf-dropzone-text {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.cdf-dropzone-sub {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.5;
}

.cdf-select-btn {
  margin-top: 12px;
  padding: 9px 22px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, transform 0.1s;
}

.cdf-select-btn:hover {
  background: var(--accent-hover);
  transform: translateY(-1px);
}

.cdf-select-btn:active {
  transform: translateY(0);
}

/* Diff Empty State */
.cdf-diff-panel.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary);
}

.cdf-empty-hero {
  text-align: center;
  max-width: 400px;
  color: var(--text-secondary);
}

.cdf-empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
  display: block;
  opacity: 0.8;
}

.cdf-empty-hero h3 {
  margin: 0 0 12px 0;
  font-size: 18px;
  color: var(--text-primary);
  font-weight: 600;
}

.cdf-empty-hero p {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
}

/* Prompt Details */
.cdf-diff-actions {
  padding: 20px 24px 10px 24px;
  background: var(--bg-primary);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cdf-prompt-details {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  overflow: hidden;
}

.cdf-prompt-details summary {
  padding: 12px 16px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}

.cdf-prompt-details summary:hover {
  color: var(--text-primary);
}

.cdf-prompt-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 16px;
  background: var(--bg-primary);
  border: none;
  border-top: 1px solid var(--border);
  color: var(--text-primary);
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
}

.cdf-prompt-textarea:focus {
  outline: none;
}

/* Bottom Actions - Botões em Pílula com Glow */
.cdf-diff-actions-bottom {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 24px 20px 24px;
  background: var(--bg-primary);
}


```

src/renderer/src/components/CodeDiffView/CodeDiffView.tsx
```
// Responsabilidades do Script
//
// 1. Gerenciar o ciclo de vida do WatcherService (iniciar, parar e escutar eventos de arquivo modificado).
// 2. Renderizar a interface dividida em lista de arquivos alterados e painel de diff semântico em tempo real.

import React, { useState, useEffect } from 'react'
import Markdown from 'markdown-to-jsx'
import { DiffFileStatus } from '../../../../shared/types'
import './CodeDiffView.css'

const CHANGE_TYPE_LABEL: Record<DiffFileStatus['changeType'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D'
}

const DEFAULT_PROMPT = `Analise as alterações de código abaixo como um Engenheiro de Software Staff extremamente rigoroso.

Seu papel é auditar o trabalho realizado pelo agente de implementação e validar se a tarefa foi cumprida de forma íntegra, segura e profissional.

Instruções da sua auditoria:
1. Avalie se os requisitos parecem ter sido completamente atendidos com base nas modificações apresentadas.
2. Identifique mentiras ou omissões (se o agente disse que fez algo, mas o diff mostra que ele não alterou as linhas necessárias).
3. Procure por bugs ocultos, problemas de lógica, quebras de arquitetura ou caminhos inacabados.
4. Identifique "code smells" ou soluções provisórias de baixa qualidade (gambiarras).
5. Forneça um veredito direto: "APROVADO" ou "REPROVADO COM AJUSTES" acompanhado de uma lista clara e numerada do que precisa ser corrigido (caso necessário).

Abaixo está o mapeamento semântico das funções alteradas:
--------------------------------------------------`

export const CodeDiffView: React.FC<{ activeProject: { path: string; name: string } | null }> = ({ activeProject }) => {
  const [isWatching, setIsWatching] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null)
  const [modifiedFiles, setModifiedFiles] = useState<DiffFileStatus[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [diffMarkdown, setDiffMarkdown] = useState<string>('')
  const [auditPromptTemplate, setAuditPromptTemplate] = useState('')
  const [isCopied, setIsCopied] = useState(false)
  const [isCopyMarkdown, setIsCopyMarkdown] = useState(false)
  const [isExporting, setIsExporting] = useState(false)

  // Inicializa o template do localStorage ou default
  useEffect(() => {
    const saved = localStorage.getItem('code_diff_prompt_template')
    if (saved) {
      setAuditPromptTemplate(saved)
    } else {
      setAuditPromptTemplate(DEFAULT_PROMPT)
      localStorage.setItem('code_diff_prompt_template', DEFAULT_PROMPT)
    }
  }, [])

  // Gerencia o watcher baseado no projeto selecionado na Home
  useEffect(() => {
    let isMounted = true

    const bootstrapProject = async () => {
      if (!activeProject) {
        if (isMounted) {
          setModifiedFiles([])
          setDiffMarkdown('')
          setIsGitRepo(null)
          setIsWatching(false)
          setSelectedFile(null)
        }
        await window.codeAwareness.stopWatcher()
        return
      }

      setIsLoading(true)
      try {
        const isGit = await window.codeAwareness.checkRepository(activeProject.path)
        if (!isMounted) return
        setIsGitRepo(isGit)

        if (!isGit) {
          setIsWatching(false)
          return
        }

        const [, files, markdown] = await Promise.all([
          window.codeAwareness.startWatcher(activeProject.path),
          window.codeAwareness.getModifiedFiles(activeProject.path),
          window.codeAwareness.generateSemanticDiff(activeProject.path)
        ])

        if (!isMounted) return
        setModifiedFiles(files)
        setDiffMarkdown(markdown)
        setIsWatching(true)
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }

    bootstrapProject()

    const unsubscribe = window.codeAwareness.onFileChanged(async () => {
      if (!activeProject || !isMounted) return
      const [files, markdown] = await Promise.all([
        window.codeAwareness.getModifiedFiles(activeProject.path),
        window.codeAwareness.generateSemanticDiff(activeProject.path)
      ])
      if (!isMounted) return
      setModifiedFiles(files)
      setDiffMarkdown(markdown)
    })

    return () => {
      isMounted = false
      unsubscribe()
      window.codeAwareness.stopWatcher() // Stop na troca de aba ou na troca de projeto
    }
  }, [activeProject])

  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newVal = e.target.value
    setAuditPromptTemplate(newVal)
    localStorage.setItem('code_diff_prompt_template', newVal)
  }

  const handleCopyPrompt = () => {
    const finalPrompt = `${auditPromptTemplate}\n\n${diffMarkdown}`
    navigator.clipboard.writeText(finalPrompt)
    setIsCopied(true)
    setTimeout(() => setIsCopied(false), 2000)
  }

  const handleCopyMarkdown = () => {
    navigator.clipboard.writeText(diffMarkdown)
    setIsCopyMarkdown(true)
    setTimeout(() => setIsCopyMarkdown(false), 2000)
  }

  const handleFileClick = (relativePath: string) => {
    setSelectedFile(relativePath)
    setTimeout(() => {
      const headings = document.querySelectorAll('.cdf-diff-code-rendered h2')
      for (const heading of headings) {
        if (heading.textContent?.includes(relativePath)) {
          heading.scrollIntoView({ behavior: 'smooth', block: 'start' })
          break
        }
      }
    }, 50)
  }

  const handleExportObsidian = async () => {
    if (!activeProject) return
    setIsExporting(true)
    try {
      const fixedPath = "C:\\Users\\ericr\\Documents\\Projetos de Softwares"
      const name = activeProject.name + "-diff"
      await window.codeAwareness.saveToObsidian(diffMarkdown, name, fixedPath)
    } catch (err) {
      console.error("Falha ao exportar:", err)
    } finally {
      setIsExporting(false)
    }
  }

  if (!activeProject) {
    return (
      <div className="cdf-dropzone-wrapper">
        <div className="empty-selection-banner" style={{ border: 'none', background: 'transparent' }}>
          <h3>Nenhum projeto selecionado</h3>
          <p>Volte para a aba <strong>Projetos</strong> e ative um repositório para inspecionar e monitorar alterações de código.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="cdf-container">
      <div className="cdf-topbar">
        <div className="cdf-repo-info">
          <span className="cdf-repo-name">{activeProject.name}</span>
          {isLoading && <span className="cdf-status-badge loading">carregando...</span>}
          {!isLoading && isWatching && <span className="cdf-status-badge watching">● Monitorando</span>}
          {!isLoading && isGitRepo === false && (
            <span className="cdf-status-badge error">Não é um repositório Git</span>
          )}
        </div>
      </div>

      <div className="cdf-split">
        <aside className="cdf-sidebar">
          <div className="cdf-sidebar-header">
            <span>Arquivos alterados</span>
            <span className="cdf-count-badge">{modifiedFiles.length}</span>
          </div>

          {modifiedFiles.length === 0 ? (
            <p className="cdf-empty-state">
              {isGitRepo === false
                ? 'O diretório não é um repositório Git.'
                : 'Nenhuma alteração detectada ainda.'}
            </p>
          ) : (
            <ul className="cdf-file-list">
              {modifiedFiles.map((file) => (
                <li
                  key={file.relativePath}
                  className={`cdf-file-card ${selectedFile === file.relativePath ? 'selected' : ''}`}
                  onClick={() => handleFileClick(file.relativePath)}
                >
                  <span className={`cdf-type-badge ${file.changeType}`}>
                    {CHANGE_TYPE_LABEL[file.changeType]}
                  </span>
                  <span className="cdf-file-name" title={file.relativePath}>
                    {file.name}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {modifiedFiles.length === 0 ? (
          <main className="cdf-diff-panel empty-state">
            <div className="cdf-empty-hero">
              <span className="cdf-empty-icon">👀</span>
              <h3>Aguardando modificações...</h3>
              <p>A pasta ativa está sendo monitorada. Salve alterações no repositório para inspecionar os blocos semânticos e realizar a auditoria.</p>
            </div>
          </main>
        ) : (
          <main className="cdf-diff-panel">
            <div className="cdf-diff-actions">
              <details className="cdf-prompt-details">
                <summary>Personalizar Instruções do Prompt (Opcional)</summary>
                <textarea
                  className="cdf-prompt-textarea"
                  value={auditPromptTemplate}
                  onChange={handlePromptChange}
                  rows={8}
                />
              </details>
            </div>

            <div className="cdf-diff-code-rendered">
              <Markdown>{diffMarkdown}</Markdown>
            </div>
          </main>
        )}
      </div>

      <div className="cdf-diff-actions-bottom">
              <button className="app-pill-btn" onClick={handleCopyPrompt}>
                {isCopied ? 'Copiado!' : 'Copiar Prompt de Auditoria'}
              </button>
              <button className="app-pill-btn" onClick={handleCopyMarkdown}>
                {isCopyMarkdown ? 'Markdown Copiado!' : 'Copiar Markdown de Diff'}
              </button>
              <button 
                className="app-pill-btn"
                onClick={handleExportObsidian}
                disabled={isExporting}
              >
                {isExporting ? 'Exportando...' : 'Exportar para Obsidian'}
              </button>
      </div>
    </div>
  )
}
```

src/renderer/src/components/DropZone/DropZone.css
```
.dropzone {
  border: 1px solid var(--border);
  border-radius: 18px;
  background-color: var(--bg-secondary);
  padding: 40px;
  text-align: center;
  cursor: pointer;
  transition: border-color 180ms ease, box-shadow 180ms ease, transform 180ms ease;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 220px;
  box-sizing: border-box;
}

.dropzone:hover:not(.disabled):not(.processing) {
  border-color: var(--accent);
  box-shadow: 0 0 24px rgba(124, 58, 237, 0.15);
  transform: scale(1.01);
}

.dropzone.hover {
  border-color: var(--accent);
  background-color: rgba(124, 58, 237, 0.02);
  box-shadow: 0 0 24px rgba(124, 58, 237, 0.2);
  transform: scale(1.01);
}

.dropzone.processing {
  border-color: #f0b234;
  background-color: rgba(240, 178, 52, 0.02);
  cursor: wait;
}

.dropzone.error {
  border-color: #f85149;
  background-color: rgba(248, 81, 73, 0.02);
}

.dropzone.disabled {
  opacity: 0.4;
  cursor: not-allowed;
  background-color: var(--bg-primary);
}

.dropzone-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.dropzone-icon {
  font-size: 32px;
  line-height: 1;
  color: var(--text-secondary);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.dropzone.hover .dropzone-icon {
  color: var(--accent-hover);
}

.dropzone-text {
  font-family: system-ui, -apple-system, sans-serif;
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 500;
  margin: 0;
}

.dropzone-subtitle {
  font-family: system-ui, -apple-system, sans-serif;
  color: var(--text-secondary);
  font-size: 13px;
  margin: 0 0 12px 0;
}

.dropzone-error-text {
  font-family: system-ui, -apple-system, sans-serif;
  color: #f85149;
  font-size: 13px;
  margin: 4px 0 12px 0;
  max-width: 400px;
  line-height: 1.4;
}

.select-folder-btn {
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 13px;
  font-weight: 600;
  background-color: var(--bg-primary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  padding: 8px 18px;
  border-radius: 999px;
  cursor: pointer;
  transition: background-color 180ms ease, border-color 180ms ease, color 180ms ease;
}

.select-folder-btn:hover:not(:disabled) {
  background-color: var(--bg-secondary);
  border-color: var(--accent);
  color: var(--accent-hover);
}

.select-folder-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Spinner Animation */
.spinner {
  display: inline-block;
  width: 32px;
  height: 32px;
  border: 3px solid rgba(240, 178, 52, 0.1);
  border-radius: 50%;
  border-top-color: #f0b234;
  animation: spin 1s ease-in-out infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
```

src/renderer/src/components/DropZone/DropZone.tsx
```
// Responsabilidades do Script
//
// 1. Detectar e gerenciar eventos de drag-and-drop nativos na interface.
// 2. Prover botão "Select Folder" que abre diálogo nativo do Electron para escolha de pasta.
// 3. Validar se o item arrastado ou selecionado é um diretório (pasta).
// 4. Invocar o callback onFolderDrop com o caminho absoluto da pasta.

import React, { useState, DragEvent } from 'react'
import './DropZone.css'

interface DropZoneProps {
  onFolderDrop: (folderPath: string, folderName: string) => void
  isProcessing: boolean
  disabled: boolean
}

export const DropZone: React.FC<DropZoneProps> = ({ onFolderDrop, isProcessing, disabled }) => {
  const [isHover, setIsHover] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (disabled || isProcessing) return
    setIsHover(true)
  }

  const handleDragLeave = () => {
    setIsHover(false)
  }

  const processRepository = (absolutePath: string, folderName: string) => {
    if (!absolutePath) {
      setErrorMsg('Não foi possível obter o caminho absoluto da pasta.')
      return
    }
    onFolderDrop(absolutePath, folderName)
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsHover(false)
    setErrorMsg(null)

    if (disabled || isProcessing) return

    const files = e.dataTransfer.files
    const items = e.dataTransfer.items

    if (!items || items.length === 0) {
      setErrorMsg('Nenhum item detectado.')
      return
    }

    const item = items[0]
    const entry = item.webkitGetAsEntry()

    if (!entry) {
      setErrorMsg('Falha ao processar o item arrastado.')
      return
    }

    if (!entry.isDirectory) {
      setErrorMsg('Por favor, arraste uma pasta (repositório), não arquivos individuais.')
      return
    }

    const file = files[0]
    if (!file) {
      setErrorMsg('Não foi possível ler a pasta arrastada. Por favor, use o botão "Select Folder".')
      return
    }
    const absolutePath = window.codeAwareness.getPathForFile(file)
    const folderName = file.name

    if (!absolutePath || !folderName) {
      setErrorMsg('Caminho absoluto ou nome da pasta inválido.')
      return
    }

    processRepository(absolutePath, folderName)
  }

  const handleSelectFolderClick = async (e: React.MouseEvent) => {
    e.stopPropagation() // Evita triggers acidentais
    if (disabled || isProcessing) return
    setErrorMsg(null)

    try {
      const res = await window.codeAwareness.selectFolder()
      if (res) {
        processRepository(res.path, res.name)
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Erro ao selecionar a pasta.')
    }
  }

  const getStatusText = () => {
    if (isProcessing) return 'Analisando repositório com Codefetch...'
    if (isHover) return 'Solte para analisar o repositório'
    return 'Drag & Drop Repository'
  }

  return (
    <div
      className={`dropzone ${isHover ? 'hover' : ''} ${isProcessing ? 'processing' : ''} ${errorMsg ? 'error' : ''} ${disabled ? 'disabled' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="dropzone-content">
        <div className="dropzone-icon">
          {isProcessing ? (
            <span className="spinner"></span>
          ) : errorMsg ? (
            '⚠️'
          ) : (
            <svg
              width="40"
              height="40"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          )}
        </div>
        <p className="dropzone-text">{getStatusText()}</p>
        {!isProcessing && !errorMsg && (
          <p className="dropzone-subtitle">or choose a folder manually</p>
        )}
        {errorMsg && <p className="dropzone-error-text">{errorMsg}</p>}
        {!isProcessing && (
          <button
            type="button"
            className="select-folder-btn"
            onClick={handleSelectFolderClick}
            disabled={disabled}
          >
            Select Folder
          </button>
        )}
      </div>
    </div>
  )
}
```

src/renderer/src/components/HomeView/HomeView.css
```
/* Layout HomeView */
.home-container {
  display: flex;
  flex-direction: column;
  padding: 24px 32px;
  height: 100%;
  box-sizing: border-box;
  overflow-y: auto;
}

/* Header */
.home-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 32px;
}

.home-title-area h2 {
  margin: 0 0 6px 0;
  font-size: 22px;
  font-weight: 600;
  color: var(--text-primary);
}

.home-title-area p {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
}

/* Menu Dropdown e Actions */
.home-actions {
  position: relative;
}

.home-add-icon {
  font-size: 18px;
  font-weight: 400;
  line-height: 1;
}

.home-dropdown-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 260px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  z-index: 100;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.home-dropdown-menu button {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s;
}

.home-dropdown-menu button:hover {
  background: rgba(255, 255, 255, 0.06);
}

.home-dropdown-menu button span {
  font-size: 16px;
}

.home-dropdown-menu button:not(:last-child) {
  border-bottom: 1px solid var(--border);
}

/* Empty State */
.home-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  text-align: center;
  padding: 40px;
}

.home-empty-icon {
  font-size: 54px;
  margin-bottom: 16px;
  opacity: 0.7;
}

.home-empty-state h3 {
  margin: 0 0 12px 0;
  font-size: 18px;
  color: var(--text-primary);
}

.home-empty-state p {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
  max-width: 400px;
  line-height: 1.5;
}

/* Grid de Projetos */
.home-projects-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 20px;
  padding-bottom: 24px;
}

/* Cards */
.project-card {
  position: relative;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 20px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.project-card:hover {
  border-color: rgba(124, 58, 237, 0.4);
  background: rgba(255, 255, 255, 0.02);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.project-card.project-card-active {
  border-color: var(--accent);
  background: rgba(124, 58, 237, 0.05);
  box-shadow: 0 0 12px rgba(124, 58, 237, 0.4);
}

.project-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.project-card-title-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

.project-card-selected {
  background-color: rgba(68, 207, 110, 0.15);
  border: 1px solid var(--color-green);
  color: var(--color-green);
  padding: 4px 10px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  line-height: 1;
}

.project-card-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  word-break: break-word;
  line-height: 1.4;
}

.project-card-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 999px;
  text-transform: uppercase;
  flex-shrink: 0;
}

.project-card-badge.git {
  background: rgba(243, 79, 41, 0.15);
  color: #f34f29; /* Cor parecida com a marca do Git */
  border: 1px solid rgba(243, 79, 41, 0.3);
}

.project-card-path {
  font-size: 12px;
  color: var(--text-secondary);
  font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.8;
}

/* Botão Excluir Card */
.project-card-delete-btn {
  background: rgba(255, 59, 48, 0.1);
  color: #ff3b30;
  border: none;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.2s, background 0.2s;
}

.project-card:hover .project-card-delete-btn {
  opacity: 1;
}

.project-card-delete-btn:hover {
  background: rgba(255, 59, 48, 0.2);
}

/* Modal de Confirmação */
.home-modal-overlay {
  position: fixed;
  top: 0; left: 0; width: 100%; height: 100%;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
}

.home-modal-content {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  padding: 32px;
  border-radius: 12px;
  max-width: 400px;
  text-align: center;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
}

.home-modal-content h3 {
  margin: 0 0 12px 0;
  color: var(--text-primary);
  font-size: 18px;
}

.home-modal-content p {
  margin: 0 0 24px 0;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.5;
}

.home-modal-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
}

.home-modal-cancel {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-primary);
  padding: 10px 16px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 500;
  transition: background 0.2s;
}
.home-modal-cancel:hover { background: rgba(255,255,255,0.05); }

.home-modal-confirm {
  background: #ff3b30;
  border: none;
  color: #fff;
  padding: 10px 16px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 600;
  transition: background 0.2s;
}
.home-modal-confirm:hover { background: #d32f2f; }
```

src/renderer/src/components/HomeView/HomeView.tsx
```
// Responsabilidades do Script
//
// 1. Apresentar o painel inicial da aplicação (Home).
// 2. Controlar o menu flutuante de adição de projetos e pastas mães.
// 3. Renderizar a grade de projetos retornados do backend e permitir a seleção do projeto ativo.

import React, { useState, useEffect, useRef } from 'react'
import { ProjectInfo } from '../../../../shared/types'
import './HomeView.css'

interface HomeViewProps {
  activeProject: { path: string; name: string } | null
  onSelectProject: (project: { path: string; name: string }) => void
}

export const HomeView: React.FC<HomeViewProps> = ({ activeProject, onSelectProject }) => {
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [projectToHide, setProjectToHide] = useState<ProjectInfo | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Carrega a listagem de projetos
  const loadProjects = async () => {
    try {
      const list = await window.codeAwareness.getProjectsList()
      setProjects(list)
    } catch (err) {
      console.error('Erro ao carregar projetos:', err)
    }
  }

  // Effect de carregamento inicial
  useEffect(() => {
    loadProjects()
  }, [])

  // Listener para fechar o menu ao clicar fora
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false)
      }
    }
    if (isMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isMenuOpen])

  // Handlers de Importação
  const handleAddRootFolder = async () => {
    setIsMenuOpen(false)
    const list = await window.codeAwareness.addRootFolder()
    if (list) setProjects(list)
  }

  const handleAddIndividualProject = async () => {
    setIsMenuOpen(false)
    const list = await window.codeAwareness.addIndividualProject()
    if (list) setProjects(list)
  }

  return (
    <div className="home-container">
      <div className="home-header">
        <div className="home-title-area">
          <h2>Seus Projetos</h2>
          <p>Selecione um projeto para usar nos modos de Análise ou Code Diff.</p>
        </div>

        <div className="home-actions" ref={menuRef}>
          <button 
            className="app-pill-btn" 
            onClick={() => setIsMenuOpen(!isMenuOpen)}
          >
            <span className="home-add-icon">+</span> Adicionar
          </button>
          
          {isMenuOpen && (
            <div className="home-dropdown-menu">
              <button onClick={handleAddRootFolder}>
                <span>📁</span> Importar Pasta Raiz (Múltiplos)
              </button>
              <button onClick={handleAddIndividualProject}>
                <span>📦</span> Importar Projeto Avulso
              </button>
            </div>
          )}
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="home-empty-state">
          <div className="home-empty-icon">📂</div>
          <h3>Nenhum projeto cadastrado ainda</h3>
          <p>Clique no botão <strong>+ Adicionar</strong> acima para carregar seus diretórios e começar.</p>
        </div>
      ) : (
        <div className="home-projects-grid">
          {projects.map((proj) => {
            const isActive = activeProject?.path === proj.path
            return (
              <div 
                key={proj.path} 
                className={`project-card ${isActive ? 'project-card-active' : ''}`}
                onClick={() => onSelectProject({ path: proj.path, name: proj.name })}
              >
                <div className="project-card-header">
                  <div className="project-card-title-row">
                    <h4 className="project-card-title">{proj.name}</h4>
                    {isActive && <span className="project-card-selected">✓ Selecionado</span>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {proj.isGit && <span className="project-card-badge git">Git</span>}
                    <button 
                      className="project-card-delete-btn" 
                      title="Ocultar Projeto"
                      onClick={(e) => {
                        e.stopPropagation()
                        setProjectToHide(proj)
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <div className="project-card-path" title={proj.path}>
                  {proj.path}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {projectToHide && (
        <div className="home-modal-overlay">
          <div className="home-modal-content">
            <h3>Remover {projectToHide.name} do aplicativo?</h3>
            <p>Isso apenas ocultará o atalho do seu painel inicial. Todos os arquivos de código no seu computador continuarão 100% seguros, intactos e intocados.</p>
            <div className="home-modal-actions">
              <button 
                className="home-modal-cancel" 
                onClick={() => setProjectToHide(null)}
              >
                Cancelar
              </button>
              <button 
                className="home-modal-confirm" 
                onClick={async () => {
                  const list = await window.codeAwareness.hideProject(projectToHide.path)
                  setProjects(list)
                  setProjectToHide(null)
                }}
              >
                Confirmar e Remover
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
```

src/renderer/src/components/OutputPanel/OutputPanel.css
```
.output-panel {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 16px;
  background-color: var(--bg-secondary);
  margin-top: 20px;
  overflow: hidden;
}

.output-panel-header {
  background-color: var(--bg-primary);
  border-bottom: 1px solid var(--border);
  padding: 12px 18px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.output-panel-title {
  font-family: system-ui, -apple-system, sans-serif;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
}

.output-panel-meta {
  font-family: system-ui, -apple-system, sans-serif;
  color: var(--text-secondary);
  font-size: 11px;
}

.output-panel-container {
  padding: 24px;
  overflow: auto;
  max-height: 500px;
  background-color: var(--bg-primary);
}

.output-panel-content {
  margin: 0;
  font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  white-space: pre;
  tab-size: 4;
}

.output-panel-content code {
  font-family: inherit;
}
```

src/renderer/src/components/OutputPanel/OutputPanel.tsx
```
// Responsabilidades do Script
//
// 1. Apresentar o conteúdo Markdown gerado de forma estruturada.
// 2. Garantir a renderização monoespaçada com quebras de linha e espaçamentos originais preservados.
// 3. Prover rolagem vertical e horizontal adequadas para códigos de qualquer extensão.

import React from 'react'
import './OutputPanel.css'

interface OutputPanelProps {
  markdown: string
}

export const OutputPanel: React.FC<OutputPanelProps> = ({ markdown }) => {
  if (!markdown) return null

  return (
    <div className="output-panel" id="output-panel">
      <div className="output-panel-header">
        <span className="output-panel-title">Código Markdown Gerado</span>
        <span className="output-panel-meta">{markdown.length} caracteres</span>
      </div>
      <div className="output-panel-container">
        <pre className="output-panel-content"><code>{markdown}</code></pre>
      </div>
    </div>
  )
}
```

src/renderer/src/components/SetupBanner/SetupBanner.css
```
.setup-banner {
  background-color: rgba(240, 178, 52, 0.1);
  border: 1px solid #f0b234;
  border-radius: 6px;
  padding: 12px 16px;
  margin-bottom: 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.setup-banner-content {
  display: flex;
  align-items: center;
  gap: 12px;
}

.setup-banner-warning-icon {
  font-size: 20px;
}

.setup-banner-text {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  color: #e6edf3;
  font-size: 14px;
  line-height: 1.5;
}

.setup-banner-code {
  display: inline-block;
  background-color: #161b22;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 2px 8px;
  margin-left: 8px;
  font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
  font-size: 13px;
  color: #58a6ff;
}

.setup-banner-copy-btn {
  background-color: #21262d;
  color: #c9d1d9;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 6px 12px;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.2s, border-color 0.2s;
}

.setup-banner-copy-btn:hover {
  background-color: #30363d;
  border-color: #8b949e;
}

.setup-banner-copy-btn:active {
  background-color: #282e38;
}
```

src/renderer/src/components/SetupBanner/SetupBanner.tsx
```
// Responsabilidades do Script
//
// 1. Renderizar um banner informativo quando a ferramenta Codefetch CLI não for detectada no sistema.
// 2. Permitir a cópia rápida do comando de instalação para a área de transferência do usuário.

import React, { useState } from 'react'
import './SetupBanner.css'

export const SetupBanner: React.FC = () => {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText('npm install -g codefetch')
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy command', err)
    }
  }

  return (
    <div className="setup-banner" id="setup-banner">
      <div className="setup-banner-content">
        <span className="setup-banner-warning-icon">⚠️</span>
        <div className="setup-banner-text">
          <strong>Codefetch CLI não detectado no sistema.</strong> Instale globalmente antes de prosseguir:
          <code className="setup-banner-code">npm install -g codefetch</code>
        </div>
      </div>
      <button className="setup-banner-copy-btn" onClick={handleCopy}>
        {copied ? 'Copiado!' : 'Copiar comando'}
      </button>
    </div>
  )
}
```

</source_code>