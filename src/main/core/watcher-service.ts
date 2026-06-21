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
