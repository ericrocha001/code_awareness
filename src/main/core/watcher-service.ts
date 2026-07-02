/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Monitorar em segundo plano as mudanças de arquivos de texto em um diretório raiz.
2. Manter em memória a lista de caminhos dos arquivos modificados desde o início da observação.

Mapa de Relacionamentos do Script

(Nenhum relacionamento arquiteturalmente relevante — o watcher apenas emite callbacks para quem o registra.)

Invariantes do Script

1. O watcher principal deve ignorar extensões binárias e pastas de build/node_modules/.git.
2. O watcher principal NUNCA deve monitorar recursivamente a pasta .git.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { watch, FSWatcher } from 'fs'
import { join, extname } from 'path'

// Pastas ignoradas pelo watcher principal (inclui .git para evitar saturação do event loop)
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', '.DS_Store', 'codefetch', 'code_awareness', '.sprintdiff', 'code_checkpoints'])

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

    // Watcher principal recursivo — ignora .git para não saturar o event loop
    this.watcher = watch(rootPath, { recursive: true }, (_eventType, filename) => {
      if (!filename) return

      const normalized = filename.replace(/\\/g, '/')

      // Ignora pastas e extensões conhecidas (inclui .git no IGNORED_DIRS)
      if (this.shouldIgnore(normalized)) return

      const fullPath = join(rootPath, filename).replace(/\\/g, '/')
      this.modifiedFiles.add(fullPath)

      console.log(`[WatcherService] Arquivo modificado: ${fullPath}`)
      onFileChanged(fullPath)
    })

    this.watcher.on('error', (err) => {
      console.error('[WatcherService] Erro no watcher principal:', err.message)
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