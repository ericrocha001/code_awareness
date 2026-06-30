/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Monitorar em segundo plano as mudanças de arquivos de texto em um diretório raiz.
2. Manter em memória a lista de caminhos dos arquivos modificados desde o início da observação.
3. Detectar commits via polling de .git/HEAD (leve e confiável).

Mapa de Relacionamentos do Script

1. checkpoint-service.ts
   - Tipo: Dependência Direta
   - Relação: Invoca checkForCommits e handleCommitDetected ao detectar mudanças no HEAD.
   - Criticidade: Alta

Invariantes do Script

1. O watcher principal deve ignorar extensões binárias e pastas de build/node_modules/.git.
2. O watcher principal NUNCA deve monitorar recursivamente a pasta .git — usa polling de HEAD.
3. A detecção de commits deve ser assíncrona e usar debounce de 2s para evitar execuções concorrentes.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { existsSync, readFileSync } from 'fs'
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

// Intervalo de polling para detecção de commits (ms)
const GIT_POLL_INTERVAL = 2000

export class WatcherService {
  private watcher: FSWatcher | null = null
  private modifiedFiles = new Set<string>()
  private repoPath: string = ''
  private onCommitDetected: (() => void) | null = null
  private isProcessingCommit = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastHeadContent: string = ''

  /**
   * Define o callback a ser chamado quando um commit é detectado.
   * O CheckpointService registrará handleCommitDetected aqui.
   */
  setOnCommitDetected(callback: () => void): void {
    this.onCommitDetected = callback
  }

  start(rootPath: string, onFileChanged: (filePath: string) => void): void {
    this.stop()
    this.repoPath = rootPath

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

    // Polling leve para detectar commits via .git/HEAD
    // Motivo: o watcher de arquivo no .git/HEAD sozinho não detecta commits
    // em modo branch (HEAD continua apontando para refs/heads/main, só o
    // arquivo da ref muda). Polling de HEAD + resolução da ref atual é
    // mais leve e confiável que watch recursivo na pasta .git/
    this.startGitPolling()
  }

  /**
   * Inicia o polling periódico do .git/HEAD para detectar commits.
   * Lê o conteúdo do HEAD e, se for uma ref, lê o conteúdo da ref também.
   * Se o hash composto mudar, dispara o callback de commit detectado.
   */
  private startGitPolling(): void {
    const headPath = join(this.repoPath, '.git', 'HEAD')
    if (!existsSync(headPath)) {
      console.warn('[WatcherService] .git/HEAD não encontrado, detecção de commits desabilitada')
      return
    }

    // Lê o conteúdo inicial do HEAD para estabelecer a baseline
    this.lastHeadContent = this.resolveHeadContent()
    if (!this.lastHeadContent) return

    console.log('[WatcherService] Git polling iniciado, HEAD baseline:', this.lastHeadContent.substring(0, 12))

    this.pollTimer = setInterval(() => {
      // Evita execução concorrente se o callback ainda estiver rodando
      if (this.isProcessingCommit || !this.onCommitDetected) return

      const currentContent = this.resolveHeadContent()
      if (!currentContent) return

      // Se o hash mudou, um commit ocorreu
      if (currentContent !== this.lastHeadContent) {
        console.log('[WatcherService] HEAD mudou, commit detectado via polling')
        this.lastHeadContent = currentContent
        this.isProcessingCommit = true

        // Dispara o callback de forma assíncrona (não bloqueia o intervalo)
        const callback = this.onCommitDetected
        if (callback) {
          Promise.resolve(callback()).then(() => {
            this.isProcessingCommit = false
          })
        }
      }
    }, GIT_POLL_INTERVAL)
  }

  /**
   * Lê e resolve o hash do HEAD atual.
   * Se HEAD é simbólico (ex: "ref: refs/heads/main"), resolve a ref real.
   * Retorna o hash SHA completo ou string vazia se falhar.
   */
  private resolveHeadContent(): string {
    try {
      const headPath = join(this.repoPath, '.git', 'HEAD')
      const headRaw = readFileSync(headPath, 'utf-8').trim()

      // HEAD simbólico: "ref: refs/heads/main" → lê o arquivo da ref
      if (headRaw.startsWith('ref: ')) {
        const refPath = join(this.repoPath, '.git', headRaw.slice(5))
        if (existsSync(refPath)) {
          return readFileSync(refPath, 'utf-8').trim()
        }
        // Se a ref não existir (ex: repo vazio), retorna o conteúdo do HEAD
        return headRaw
      }

      // HEAD direto (detached): contém o hash
      return headRaw
    } catch {
      return ''
    }
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null

    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    this.modifiedFiles.clear()
    this.repoPath = ''
    this.lastHeadContent = ''
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
