/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Monitorar em segundo plano as mudanças de arquivos de texto em múltiplas raízes de diretório simultaneamente.
2. Manter um registro de ouvintes por raiz vigiada, gerenciando o ciclo de vida do vigia do sistema por contagem de assinaturas.
3. Manter em memória a lista global de caminhos de arquivos modificados desde o início da observação.

Mapa de Relacionamentos do Script

1. watcher-bridge.ts
   - Tipo: Dependência Inversa
   - Relação: Consome o serviço via assinatura por raiz para alimentar o Event Bus.
   - Criticidade: Alta

2. git-handler.ts
   - Tipo: Dependência Inversa
   - Relação: Consome o serviço via assinatura por raiz para enviar pushes via IPC.
   - Criticidade: Alta

Invariantes do Script

1. O watcher principal deve ignorar extensões binárias e pastas de build/node_modules/.git.
2. O watcher principal NUNCA deve monitorar recursivamente a pasta .git.
3. Cada raiz de repositório deve possuir no máximo um vigia do sistema (FSWatcher) ativo, compartilhado entre todos os ouvintes daquela raiz.
4. Quando o número de ouvintes de uma raiz chegar a zero, o vigia do sistema correspondente deve ser imediatamente encerrado e removido.
5. Uma exceção lançada por um ouvinte não pode interromper nem impedir a notificação dos demais ouvintes registrados.

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

export type FileChangeListener = (filePath: string) => void

interface WatchedRoot {
  watcher: FSWatcher
  listeners: Set<FileChangeListener>
}

export class WatcherService {
  private roots = new Map<string, WatchedRoot>()
  private modifiedFiles = new Set<string>()

  /**
   * Assina a observação de alterações de arquivos para uma raiz de repositório.
   * Cria o vigia do sistema na primeira assinatura da raiz e devolve a função de desassinatura.
   */
  subscribe(rootPath: string, listener: FileChangeListener): () => void {
    const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/$/, '')

    let rootEntry = this.roots.get(normalizedRoot)

    if (!rootEntry) {
      const watcher = watch(normalizedRoot, { recursive: true }, (_eventType, filename) => {
        if (!filename) return

        const normalizedFilename = filename.replace(/\\/g, '/')

        // Ignora pastas e extensões conhecidas (inclui .git no IGNORED_DIRS)
        if (this.shouldIgnore(normalizedFilename)) return

        const fullPath = join(normalizedRoot, filename).replace(/\\/g, '/')
        this.modifiedFiles.add(fullPath)

        console.debug(`[WatcherService] Arquivo modificado: ${fullPath}`)

        const currentEntry = this.roots.get(normalizedRoot)
        if (currentEntry) {
          for (const callback of Array.from(currentEntry.listeners)) {
            try {
              callback(fullPath)
            } catch (err) {
              console.error(`[WatcherService] Erro no ouvinte da raiz ${normalizedRoot}:`, err)
            }
          }
        }
      })

      watcher.on('error', (err) => {
        console.error(`[WatcherService] Erro no watcher da raiz ${normalizedRoot}:`, err.message)
      })

      rootEntry = {
        watcher,
        listeners: new Set<FileChangeListener>()
      }
      this.roots.set(normalizedRoot, rootEntry)
    }

    rootEntry.listeners.add(listener)

    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true

      const entry = this.roots.get(normalizedRoot)
      if (!entry) return

      entry.listeners.delete(listener)
      if (entry.listeners.size === 0) {
        try {
          entry.watcher.close()
        } catch (err) {
          console.error(`[WatcherService] Erro ao fechar watcher da raiz ${normalizedRoot}:`, err)
        }
        this.roots.delete(normalizedRoot)
      }
    }
  }

  /**
   * Método legado mantido para compatibilidade. Delega para `subscribe`.
   */
  start(rootPath: string, onFileChanged: FileChangeListener): () => void {
    return this.subscribe(rootPath, onFileChanged)
  }

  /**
   * Encerra todas as raízes vigiadas, limpa todos os ouvintes e reseta os arquivos modificados.
   * Chamado no encerramento da aplicação.
   */
  stop(): void {
    for (const [rootPath, entry] of this.roots.entries()) {
      try {
        entry.watcher.close()
      } catch (err) {
        console.error(`[WatcherService] Erro ao fechar watcher da raiz ${rootPath}:`, err)
      }
    }
    this.roots.clear()
    this.modifiedFiles.clear()
  }

  /**
   * Retorna a lista acumulada de caminhos modificados.
   */
  getModifiedFiles(): string[] {
    return Array.from(this.modifiedFiles)
  }

  private shouldIgnore(filename: string): boolean {
    const parts = filename.replace(/\\/g, '/').split('/')
    if (parts.some(part => IGNORED_DIRS.has(part))) return true
    return IGNORED_EXTENSIONS.has(extname(filename).toLowerCase())
  }
}