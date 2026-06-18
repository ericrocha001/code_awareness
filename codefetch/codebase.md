<source_code>
AGENTS.md
```
---
aliases: []
tags: [IDE/antigravity, IDE/antigravity/rules/rule, programação, software, software/engenharia_de_software, software/engenharia_de_software/arquitetura_de_software, software/mecanismo_software, software/resiliencia_software, software/segurança_software, software/software_agentivo, software/software_erro]
title: AGENTS
source:
  - https://chatgpt.com/g/g-p-6981cf9c38988191932b596154a84f94-google-antigravity/c/69cac95e-f804-8328-995e-f5c0f2ce1526
author:
  - Eric Rocha
project:
connections:
date created: 2026-03-30 15:53
date modified: 2026-06-16 00:22
---

# AGENTS

## Blindagem Arquitetural

### Responsabilidades Do Script

Todo script criado pelo agente **deve obrigatoriamente iniciar** com uma seção chamada:

```
Responsabilidades do Script
```

Essa seção deve aparecer nas primeiras linhas do arquivo.

### Objetivo

Permitir entendimento imediato do propósito do arquivo sem leitura completa do código, reduzindo custo cognitivo humano, consumo de contexto por agentes de IA e complexidade arquitetural do sistema.

### Regras Obrigatórias

1. Escrever sempre em português do Brasil.
2. Listar apenas responsabilidades reais do arquivo.
3. Cada responsabilidade deve:
    - começar com verbo de ação;
    - descrever claramente o que o script faz;
    - indicar o domínio ou contexto do sistema quando aplicável;
    - evitar descrições genéricas.
4. Responsabilidade significa **um único motivo futuro de modificação do arquivo**.
5. A lista deve ser escrita em formato numerado.
6. Não descrever detalhes de implementação interna.
7. Não repetir nomes de funções (`def`) ou classes.

### Limite Arquitetural De Responsabilidades

O arquivo deve possuir:

- Ideal: **1 a 3 responsabilidades**
- Limite máximo aceitável: **4 responsabilidades**

Se o número ultrapassar 4, o agente deve:

- sugerir divisão do arquivo;
- propor novos scripts especializados;
- separar responsabilidades por domínio.

### Critérios De Divisão Automática

O agente deve sugerir refatoração quando o script:

- executa múltiplos papéis distintos;
- conversa com mais de um sistema externo;
- mistura regras de negócio, validação e persistência;
- possui responsabilidades parcialmente reutilizáveis.

### Estrutura Padrão Obrigatória

Exemplo correto:

```
Responsabilidades do Script

1. Validar dados de entrada do usuário no módulo de autenticação.
2. Converter respostas da API externa para o modelo interno do sistema.
3. Persistir logs estruturados no sistema de observabilidade.
```

### Benefícios Esperados

- Arquivos pequenos e especializados
- Manutenção simplificada
- Debugging mais rápido
- Melhor navegação do código
- Menor consumo de tokens por agentes de IA
- Arquitetura naturalmente modular

### Atualização Das Responsabilidades

Sempre que o script for modificado, refatorado ou tiver seu comportamento alterado, o agente deve:

1. revisar a seção "Responsabilidades do Script";
2. atualizar, adicionar ou remover responsabilidades quando necessário;
3. garantir que a lista reflita exatamente o estado atual do arquivo.
  
A lista de responsabilidades nunca deve ficar desatualizada em relação ao código.

### Princípio Arquitetural Aplicado

Todo arquivo deve representar **uma unidade clara de responsabilidade dentro do sistema**.
Se o propósito do arquivo não puder ser explicado rapidamente na lista inicial, o design do script deve ser reconsiderado.

-------------------------

## Código Limpo E Enxuto

Todo código criado ou modificado pelo agente deve priorizar simplicidade, legibilidade e baixa complexidade.

## Regras Obrigatórias

1. Preferir sempre a solução mais simples que funcione.
2. Evitar abstrações, padrões ou otimizações prematuras.
3. Manter funções pequenas e fáceis de entender.
4. Utilizar nomes claros e autoexplicativos.
5. Evitar níveis profundos de indentação.
6. Remover automaticamente:
    - código morto;
    - variáveis não utilizadas;
    - imports desnecessários;
    - comentários obsoletos.
7. Não adicionar lógica, configurações ou estruturas que não sejam necessárias no momento atual.
8. Sempre que modificar código existente, simplificar o que for possível.

## Regra De Decisão

Se existir dúvida entre uma solução simples e uma solução sofisticada, escolher sempre a mais simples.
```

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
// 1. Inicializar o ciclo de vida do aplicativo Electron.
// 2. Criar e configurar a janela principal do navegador (BrowserWindow) com segurança (contextIsolation, sandbox, etc).
// 3. Carregar a interface do usuário correspondente (desenvolvimento vs produção).
// 4. Registrar todos os manipuladores de IPC (Inter-Process Communication) do aplicativo.

import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerCodefetchHandlers } from './ipc/codefetch-handler'
import { registerFileHandlers } from './ipc/file-handler'
import { registerSettingsHandlers } from './ipc/settings-handler'

let mainWindow: BrowserWindow | null = null

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

  // Registrar handlers passando a janela onde for necessário (ex: dialogs)
  registerCodefetchHandlers()
  registerFileHandlers(mainWindow)
  registerSettingsHandlers(mainWindow)

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
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

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { AppSettings, CodefetchResult } from '../shared/types'

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
  }
})
```

src/shared/types.ts
```
// Responsabilidades do Script
//
// 1. Definir os tipos compartilhados entre o processo principal e o renderer do Electron.

export interface AppSettings {
  obsidianVaultPath: string | null
}

export interface CodefetchResult {
  success: boolean
  markdown?: string
  error?: string
}
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

src/main/core/codefetch-adapter.ts
```
// Responsabilidades do Script
//
// 1. Verificar se o Codefetch CLI está instalado no sistema.
// 2. Executar o Codefetch em um repositório e ler o Markdown gerado a partir do arquivo codebase.md.

import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
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
      const proc = spawn(cmd, ['--version'], { shell: true })
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

  async run(repoPath: string): Promise<CodefetchResult> {
    return new Promise((resolve) => {
      let stderr = ''

      const proc = spawn(this.getCommand(), [], {
        cwd: repoPath,
        shell: true
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
          const outputPath = join(repoPath, 'codefetch', 'codebase.md')
          try {
            if (existsSync(outputPath)) {
              const content = await readFile(outputPath, 'utf-8')
              resolve({ success: true, markdown: content })
            } else {
              resolve({
                success: false,
                error: 'Arquivo codebase.md não encontrado no diretório do projeto em <repo>/codefetch/codebase.md'
              })
            }
          } catch (err: any) {
            resolve({
              success: false,
              error: `Erro ao ler o arquivo codebase.md: ${err.message}`
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

src/main/core/settings-service.ts
```
// Responsabilidades do Script
//
// 1. Persistir e recuperar as configurações locais do aplicativo (ex: caminho do vault Obsidian).

import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { AppSettings } from '../../shared/types'

const CONFIG_DIR = app.getPath('userData')
const CONFIG_FILE = join(CONFIG_DIR, 'settings.json')

const DEFAULT_SETTINGS: AppSettings = {
  obsidianVaultPath: null
}

export class SettingsService {
  loadSettings(): AppSettings {
    if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_SETTINGS }
    try {
      const raw = readFileSync(CONFIG_FILE, 'utf-8')
      return JSON.parse(raw) as AppSettings
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  saveSettings(settings: AppSettings): void {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2), 'utf-8')
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

export function registerFileHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle('save-markdown', async (_event, markdown: string, repoName: string) => {
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
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

  ipcMain.handle('select-folder', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
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

src/main/ipc/settings-handler.ts
```
// Responsabilidades do Script
//
// 1. Registrar os handlers IPC para carregar, salvar configurações e selecionar o vault do Obsidian.

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { SettingsService } from '../core/settings-service'

const settingsService = new SettingsService()

export function registerSettingsHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle('load-settings', async () => {
    return settingsService.loadSettings()
  })

  ipcMain.handle('save-settings', async (_event, settings) => {
    settingsService.saveSettings(settings)
    return { success: true }
  })

  ipcMain.handle('select-vault-folder', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Obsidian Vault Folder',
      properties: ['openDirectory']
    })

    if (canceled || !filePaths.length) return null
    return filePaths[0]
  })
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
  height: 72px;
  display: flex;
  align-items: center;
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
import { DropZone } from './components/DropZone/DropZone'
import { ActionsBar } from './components/ActionsBar/ActionsBar'
import { OutputPanel } from './components/OutputPanel/OutputPanel'
import './App.css'

export const App: React.FC = () => {
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
  const handleFolderDrop = async (folderPath: string, folderName: string) => {
    if (!isCodefetchInstalled) {
      handleStatusMessage('Codefetch não está instalado. Não é possível rodar a análise.', true)
      return
    }

    setIsProcessing(true)
    setError('')
    setMarkdown('')
    setRepoName(folderName)
    setStatusMessage(null)

    try {
      const result = await window.codeAwareness.runCodefetch(folderPath)

      if (result.success && result.markdown) {
        setMarkdown(result.markdown)
        handleStatusMessage(`Análise concluída com sucesso para o repositório "${folderName}"!`, false)
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
      </header>

      <main className="app-main">
        {!isCodefetchInstalled && <SetupBanner />}

        <DropZone
          onFolderDrop={handleFolderDrop}
          isProcessing={isProcessing}
          disabled={!isCodefetchInstalled}
        />

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
      </main>
    </div>
  )
}
```

src/renderer/src/index.css
```
:root {
  --bg-primary: #000000;
  --bg-secondary: #111111;
  --border: #262626;
  --text-primary: #f5f5f5;
  --text-secondary: #a1a1aa;
  --accent: #7c3aed;
  --accent-hover: #8b5cf6;
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

import { AppSettings, CodefetchResult } from '../../shared/types'

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