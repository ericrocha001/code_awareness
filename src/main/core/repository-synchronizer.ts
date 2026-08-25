/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Assinar eventos do Repository Event Bus (file:modified, file:created, file:deleted).
2. Enfileirar eventos de mudança com deduplicação por caminho relativo.
3. Aplicar debounce de 500ms para absorver tempestades de eventos do sistema de arquivos.
4. Verificar estabilização do arquivo antes de processar (stat duas vezes com intervalo).
5. Comparar hash do disco com hash indexado para confirmar mudanças reais.
6. Autocurar metadados (mtime, size) quando o hash é igual, sem marcar como modified.
7. Executar reindexação seletiva quando solicitado pelo Code Map Service.
8. Gravar o carimbo de última sincronização após sincronização bem-sucedida.
9. Recarregar do banco o conjunto de pendentes (união com o que já está em memória) sob demanda.
10. Publicar evento de mudança confirmada (file:confirmed) após verificação de conteúdo, nunca na autocura.

Mapa de Relacionamentos do Script

1. repository-events.ts
   - Tipo: Dependência Direta
   - Relação: Assina eventos file:modified, file:created, file:deleted.
   - Criticidade: Alta

2. repository-model.ts
   - Tipo: Dependência Direta
   - Relação: Chama markFileModified, updateFileContent, getFileByRelativePath, updateFileMetadata.
   - Criticidade: Alta

3. code-map-service.ts
   - Tipo: Dependência Inversa
   - Relação: Consumirá synchronizeModified para disparar reindexação.
   - Criticidade: Alta

4. telemetry-service.ts
   - Tipo: Dependência Direta
   - Relação: Registra todas as etapas de detecção verificada (CHANGE_DETECTION).
   - Criticidade: Alta

Invariantes do Script

1. O Synchronizer nunca parseia código — delega ao Repository Model.
2. O Synchronizer nunca acessa o banco diretamente — delega ao Repository Model.
3. Eventos de file:created e file:deleted são tratados como file:modified (o Model decide o que fazer).
4. Arquivos legados sem contentHash são sempre marcados como modified até serem reindexados.
5. Múltiplos eventos para o mesmo arquivo resultam em uma única entrada na fila (deduplicação).
6. O status modified só é marcado após verificação de hash confirmar mudança real ou erro de acesso.
7. A autocura (mtime/size) nunca marca o arquivo como modified — apenas atualiza metadados.
8. O recarregamento de pendentes (reloadModifiedFilesFromDatabase) é união — nunca substituição.
9. A telemetria é puramente aditiva — nunca altera o fluxo de marcação, reindexação ou sincronização.
10. O debounceTimer é sempre limpo no dispose para evitar vazamento de timers.
11. O timer de varredura periódica (quando habilitado) verifica por hash antes de marcar como modified e cura status obsoletos quando o conteúdo corresponde ao índice, preservando o caminho barato de stat para arquivos indexed inalterados.
12. O conjunto em memória é reconciliado com o estado persistido confirmado; caminhos cujo banco não confirma como `modified` são removidos; a fila de verificação nunca é afetada.
13. O evento file:confirmed é emitido apenas após mudança confirmada (ou erro de acesso), sempre com o caminho normalizado do repositório — nunca na autocura e nunca com o ID hash.
14. A cura de status obsoleto no Synchronizer delega exclusivamente ao Model (markFileIndexed) — nunca manipula o banco diretamente; a autocura de metadados (updateFileMetadata/autocureFileMetadata) nunca altera status.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { stat, readFile } from 'fs/promises'
import { join } from 'path'
import { repositoryEventBus, RepositoryFileEvent } from './repository-events'
import { RepositoryModel } from './repository-model'
import { telemetryService } from './telemetry-service'
import type { CodeMapFile } from '../../shared/types'

interface PendingFileEntry {
  addedAt: number
  attempts: number
}

const DEBOUNCE_MS = 500
const MAX_STABILIZE_ATTEMPTS = 3
const STABILIZE_INTERVAL_MS = 100

export class RepositorySynchronizer {
  private readonly model: RepositoryModel
  private readonly repositoryId: string
  private readonly normalizedRepoPath: string
  private readonly correlationId: string
  private readonly modifiedFiles: Set<string> = new Set()
  private readonly pendingFiles = new Map<string, PendingFileEntry>()
  private debounceTimer: NodeJS.Timeout | null = null
  private readonly periodicScanIntervalMs: number
  private periodicScanTimer: NodeJS.Timeout | null = null
  private isPeriodicScanRunning = false
  private readonly boundHandlers: {
    onModified: (event: RepositoryFileEvent) => void
    onCreated: (event: RepositoryFileEvent) => void
    onDeleted: (event: RepositoryFileEvent) => void
  }

  constructor(
    model: RepositoryModel,
    repositoryId: string,
    options?: { periodicScanIntervalMs?: number }
  ) {
    this.model = model
    this.repositoryId = repositoryId
    this.normalizedRepoPath = model.getRepoPath()
    this.correlationId = telemetryService.startOperation('SYNCHRONIZER_INIT')
    this.boundHandlers = {
      onModified: this.handleFileEvent.bind(this),
      onCreated: this.handleFileEvent.bind(this),
      onDeleted: this.handleFileEvent.bind(this)
    }
    this.subscribe()
    this.initModifiedFilesFromDatabase()

    this.periodicScanIntervalMs = options?.periodicScanIntervalMs ?? 0
    if (this.periodicScanIntervalMs > 0) {
      this.periodicScanTimer = setInterval(() => this.runPeriodicScan(), this.periodicScanIntervalMs)
    }
  }

  private initModifiedFilesFromDatabase(): void {
    const dbModifiedFiles = this.model.getModifiedFiles()
    for (const file of dbModifiedFiles) {
      this.modifiedFiles.add(file.relativePath)
    }
  }

  private subscribe(): void {
    repositoryEventBus.onFileModified(this.boundHandlers.onModified)
    repositoryEventBus.onFileCreated(this.boundHandlers.onCreated)
    repositoryEventBus.onFileDeleted(this.boundHandlers.onDeleted)
  }

  private handleFileEvent(event: RepositoryFileEvent): void {
    // Ignora eventos de outros repositórios
    if (event.repositoryId !== this.repositoryId && event.repositoryId !== this.normalizedRepoPath) {
      return
    }

    const relativePath = event.relativePath
    const cid = event.correlationId ?? telemetryService.startOperation('EVENT_RECEIVED')

    // Deduplicação: se já está na fila, apenas atualiza o timestamp e loga
    if (this.pendingFiles.has(relativePath)) {
      const existing = this.pendingFiles.get(relativePath)!
      existing.addedAt = Date.now()
      telemetryService.log(cid, 'CHANGE_DETECTION', 'QUEUE_DEDUP', { relativePath })
      return
    }

    this.pendingFiles.set(relativePath, { addedAt: Date.now(), attempts: 0 })
    telemetryService.log(cid, 'CHANGE_DETECTION', 'QUEUED', { relativePath })

    // Agenda debounce se ainda não estiver ativo
    if (!this.debounceTimer) {
      this.debounceTimer = setTimeout(() => this.processQueue(), DEBOUNCE_MS)
    }
  }

  /**
   * Drena a fila de arquivos pendentes e verifica cada um.
   * Executado após o debounce de 500ms para absorver tempestades de eventos.
   */
  private async processQueue(): Promise<void> {
    this.debounceTimer = null

    const correlationId = telemetryService.startOperation('PROCESS_QUEUE')
    const filesToProcess = Array.from(this.pendingFiles.entries())
    this.pendingFiles.clear()

    telemetryService.log(correlationId, 'CHANGE_DETECTION', 'QUEUE_PROCESSING', {
      fileCount: filesToProcess.length
    })

    for (const [relativePath, metadata] of filesToProcess) {
      try {
        await this.verifyAndMarkIfChanged(relativePath, metadata, correlationId)
      } catch (err) {
        telemetryService.logError(correlationId, 'CHANGE_DETECTION', 'VERIFY_FAILED', {
          relativePath,
          error: err instanceof Error ? err.message : String(err)
        })
        // Em caso de erro não antecipado, marca como modified por segurança
        this.modifiedFiles.add(relativePath)
        this.model.markFileModified(relativePath)
      }
    }

    telemetryService.log(correlationId, 'CHANGE_DETECTION', 'QUEUE_PROCESSED', {
      fileCount: filesToProcess.length
    })
  }

  /**
   * Verificação completa: estabilização → comparação de hash → autocura ou marcação.
   * Centraliza toda a lógica de decisão para um único arquivo.
   */
  private async verifyAndMarkIfChanged(
    relativePath: string,
    metadata: PendingFileEntry,
    correlationId: string
  ): Promise<void> {
    const fullPath = join(this.model.getRepoPath(), relativePath)

    // Arquivo deletado → marca como modified para o Model remover na reindexação
    if (!existsSync(fullPath)) {
      this.modifiedFiles.add(relativePath)
      this.model.markFileModified(relativePath)
      telemetryService.log(correlationId, 'CHANGE_DETECTION', 'CONFIRMED_DELETED', { relativePath })
      repositoryEventBus.emitFileConfirmed(this.normalizedRepoPath, relativePath, correlationId)
      return
    }

    // Estabilização: garante que o arquivo não está sendo escrito ativamente
    const stabilized = await this.waitForStabilization(fullPath, metadata.attempts, correlationId)
    if (!stabilized) {
      if (metadata.attempts < MAX_STABILIZE_ATTEMPTS) {
        // Re-enfileira com tentativa incrementada para nova verificação após debounce
        this.pendingFiles.set(relativePath, {
          addedAt: Date.now(),
          attempts: metadata.attempts + 1
        })
        telemetryService.log(correlationId, 'CHANGE_DETECTION', 'RESTABILIZE_SCHEDULED', {
          relativePath,
          attempt: metadata.attempts + 1
        })
        if (!this.debounceTimer) {
          this.debounceTimer = setTimeout(() => this.processQueue(), DEBOUNCE_MS)
        }
        return
      }
      // Excedeu tentativas → marca como modified por segurança
      this.modifiedFiles.add(relativePath)
      this.model.markFileModified(relativePath)
      telemetryService.log(correlationId, 'CHANGE_DETECTION', 'CONFIRMED_UNSTABLE', { relativePath })
      repositoryEventBus.emitFileConfirmed(this.normalizedRepoPath, relativePath, correlationId)
      return
    }

    // Busca o arquivo indexado para comparação de hash
    const indexedFile = this.model.getFileByRelativePath(relativePath)
    if (!indexedFile) {
      // Arquivo novo (não indexado) → marca para indexação
      this.modifiedFiles.add(relativePath)
      this.model.markFileModified(relativePath)
      telemetryService.log(correlationId, 'CHANGE_DETECTION', 'CONFIRMED_NEW', { relativePath })
      repositoryEventBus.emitFileConfirmed(this.normalizedRepoPath, relativePath, correlationId)
      return
    }

    // Arquivo legado sem hash → trata como always-modified até ser reindexado
    if (!indexedFile.contentHash) {
      this.modifiedFiles.add(relativePath)
      this.model.markFileModified(relativePath)
      telemetryService.log(correlationId, 'CHANGE_DETECTION', 'LEGACY_FILE_MODIFIED', { relativePath })
      repositoryEventBus.emitFileConfirmed(this.normalizedRepoPath, relativePath, correlationId)
      return
    }

    // Compara hash do disco com hash indexado para confirmar mudança real
    const diskHash = await this.calculateDiskHash(fullPath, correlationId)

    if (diskHash === indexedFile.contentHash) {
      // Hash igual → autocura (atualiza mtime/size sem marcar modified)
      await this.autocureFileMetadata(indexedFile, fullPath, correlationId)
      // Se o arquivo estava indevidamente marcado como modified, cura o status obsoleto
      if (indexedFile.status === 'modified') {
        this._healObsoleteStatus(relativePath, correlationId, 'CHANGE_DETECTION')
      } else {
        telemetryService.log(correlationId, 'CHANGE_DETECTION', 'AUTOCURED', { relativePath })
      }
      return
    }

    // Hash diferente → mudança real confirmada
    this.modifiedFiles.add(relativePath)
    this.model.markFileModified(relativePath)
    telemetryService.log(correlationId, 'CHANGE_DETECTION', 'CONFIRMED_MODIFIED', { relativePath })
    repositoryEventBus.emitFileConfirmed(this.normalizedRepoPath, relativePath, correlationId)
  }

  /**
   * Verifica se o arquivo estabilizou (stat idêntico em dois momentos com intervalo).
   * Retorna false em caso de erro de stat ou quando os valores diferem.
   */
  private async waitForStabilization(
    fullPath: string,
    attempt: number,
    correlationId: string
  ): Promise<boolean> {
    try {
      const stat1 = await stat(fullPath)
      await new Promise<void>(resolve => setTimeout(resolve, STABILIZE_INTERVAL_MS))
      const stat2 = await stat(fullPath)

      const stabilized = stat1.mtimeMs === stat2.mtimeMs && stat1.size === stat2.size

      telemetryService.log(correlationId, 'CHANGE_DETECTION', 'STABILIZE_CHECK', {
        fullPath,
        attempt,
        stabilized,
        mtime1: stat1.mtimeMs,
        mtime2: stat2.mtimeMs
      })

      return stabilized
    } catch {
      return false
    }
  }

  /**
   * Calcula SHA-256 do arquivo no disco.
   * Usa o mesmo algoritmo que RepositoryModel.calculateContentHash para garantir consistência.
   */
  private async calculateDiskHash(fullPath: string, correlationId: string): Promise<string> {
    const content = await readFile(fullPath, 'utf-8')
    const hash = createHash('sha256').update(content, 'utf-8').digest('hex')

    telemetryService.log(correlationId, 'CHANGE_DETECTION', 'HASH_CALCULATED', {
      fullPath,
      hashPrefix: hash.substring(0, 8)
    })

    return hash
  }

  /**
   * Atualiza mtime e sizeBytes do arquivo indexado sem marcar como modified.
   * INVARIANT: nunca altera o status do arquivo — apenas metadados físicos.
   */
  private async autocureFileMetadata(
    indexedFile: CodeMapFile,
    fullPath: string,
    correlationId: string
  ): Promise<void> {
    const fileStat = await stat(fullPath)
    const newMtime = Math.floor(fileStat.mtimeMs)
    const newSize = fileStat.size

    if (indexedFile.mtime !== newMtime || indexedFile.sizeBytes !== newSize) {
      this.model.updateFileMetadata(indexedFile.id, { mtime: newMtime, sizeBytes: newSize })

      telemetryService.log(correlationId, 'CHANGE_DETECTION', 'METADATA_UPDATED', {
        relativePath: indexedFile.relativePath,
        oldMtime: indexedFile.mtime,
        newMtime,
        oldSize: indexedFile.sizeBytes,
        newSize
      })
    }
  }

  /**
   * Cura o status obsoleto de um arquivo de volta para 'indexed' e o remove do conjunto
   * de pendentes em memória, delegando a gravação ao Model (invariante: nunca manipula o banco).
   * O componente é parametrizado porque os caminhos usam telemetria com componentes distintos.
   */
  private _healObsoleteStatus(
    relativePath: string,
    correlationId: string,
    component: 'CHANGE_DETECTION' | 'CODE_MAP'
  ): void {
    this.model.markFileIndexed(relativePath)
    this.modifiedFiles.delete(relativePath)
    telemetryService.log(correlationId, component, 'STATUS_HEALED', { relativePath })
  }

  getModifiedFilesCount(): number {
    return this.modifiedFiles.size
  }

  /** Expõe o tamanho da fila de pendentes para testes e debugging. */
  getPendingFilesCount(): number {
    return this.pendingFiles.size
  }

  async synchronizeModified(): Promise<{ filesUpdated: number; errors: string[] }> {
    const startedAt = Date.now()
    const correlationId = telemetryService.startOperation('SYNC_BATCH')
    const files = Array.from(this.modifiedFiles)
    telemetryService.log(correlationId, 'CHANGE_DETECTION', 'SYNC_BATCH_STARTED', {
      fileCount: files.length
    })
    const errors: string[] = []
    let filesUpdated = 0

    try {
    for (const relativePath of files) {
      try {
        const success = await this.model.updateFileContent(relativePath, correlationId)
        if (success) {
          filesUpdated++
          this.modifiedFiles.delete(relativePath)
        }
      } catch (err) {
        errors.push(`${relativePath}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (filesUpdated > 0) {
      this.model.updateLastSyncAt(new Date().toISOString())
    }

    telemetryService.log(correlationId, 'CHANGE_DETECTION', 'SYNC_BATCH_COMPLETED', {
      filesUpdated,
      errorCount: errors.length,
      durationMs: Date.now() - startedAt
    })

    return { filesUpdated, errors }
    } catch (err) {
      // try/catch exclusivo para telemetria: loga a falha e relança, mantendo o comportamento externo idêntico.
      telemetryService.logError(correlationId, 'CHANGE_DETECTION', 'SYNC_BATCH_FAILED', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt
      })
      throw err
    }
  }

  /**
   * Recarrega do banco a lista de arquivos pendentes e faz união com o conjunto em memória.
   * INVARIANT: é união — nunca substituição, para não perder eventos recebidos ao vivo.
   */
  reloadModifiedFilesFromDatabase(): number {
    const dbModifiedFiles = this.model.getModifiedFiles()
    for (const file of dbModifiedFiles) {
      this.modifiedFiles.add(file.relativePath)
    }
    return this.modifiedFiles.size
  }

  /**
   * Reconcilia o conjunto em memória (modifiedFiles) com o banco de dados.
   * (a) Remove do conjunto em memória qualquer caminho cujo arquivo no banco não exista ou cujo status não seja 'modified'.
   * (b) Em seguida faz a união com os arquivos 'modified' do banco.
   * INVARIANT: Nunca altera pendingFiles (eventos em verificação ao vivo).
   */
  reconcileMemoryWithDatabase(): number {
    const dbFiles = this.model.getFiles()
    const dbModifiedPaths = new Set(
      dbFiles.filter(f => f.status === 'modified').map(f => f.relativePath)
    )

    for (const relativePath of Array.from(this.modifiedFiles)) {
      if (!dbModifiedPaths.has(relativePath)) {
        this.modifiedFiles.delete(relativePath)
      }
    }

    for (const relativePath of dbModifiedPaths) {
      this.modifiedFiles.add(relativePath)
    }

    return this.modifiedFiles.size
  }

  /**
   * Varredura periódica de stat para detectar mudanças sem evento do watcher.
   *
   * LIMITAÇÃO CONTRATUAL: este scan percorre APENAS arquivos já indexados
   * (model.getFiles()). Arquivos novos no disco NÃO são descobertos por este
   * mecanismo. Para descoberta de arquivos novos, o caminho oficial é o
   * WatcherService + WatcherBridge + EventBus (eventos file:created).
   *
   * O scan aplica três estratégias por arquivo:
   * - Legado sem hash: marca como 'modified' para forçar reindexação.
   * - Status 'modified': verifica por hash; cura se igual, mantém se divergente.
   * - Status 'indexed': caminho barato (mtime+size); se divergir, verifica hash;
   *   autocura metadados se igual, marca 'modified' se divergente.
   */
  private async runPeriodicScan(): Promise<void> {
    if (this.isPeriodicScanRunning) return // evita sobreposição de scans concorrentes

    this.isPeriodicScanRunning = true
    const startedAt = Date.now()
    const correlationId = telemetryService.startOperation('PERIODIC_SCAN')

    telemetryService.log(correlationId, 'CODE_MAP', 'PERIODIC_SCAN_STARTED')

    try {
      const files = this.model.getFiles()
      let markedModified = 0
      let healed = 0

      for (const file of files) {
        const fullPath = join(this.model.getRepoPath(), file.relativePath)

        try {
          // Legado sem hash — marca para forçar reindexação e geração do hash
          if (!file.contentHash) {
            this.model.markFileModified(file.relativePath)
            this.modifiedFiles.add(file.relativePath)
            markedModified++
            repositoryEventBus.emitFileConfirmed(this.normalizedRepoPath, file.relativePath, correlationId)
            continue
          }

          const fileStat = await stat(fullPath)
          const diskMtime = Math.floor(fileStat.mtimeMs)
          const diskSize = fileStat.size

          // Arquivo já marcado como 'modified' (pendente): decide por hash sempre
          if (file.status === 'modified') {
            const diskHash = await this.calculateDiskHash(fullPath, correlationId)
            if (diskHash === file.contentHash) {
              // Conteúdo idêntico ao índice → cura o status obsoleto
              this._healObsoleteStatus(file.relativePath, correlationId, 'CODE_MAP')
              healed++
            } else {
              // Conteúdo realmente divergente → o arquivo já está 'modified' no banco;
              // garante apenas sua presença no conjunto em memória (pendência confirmada)
              this.modifiedFiles.add(file.relativePath)
            }
            continue
          }

          // Caminho barato para 'indexed': mtime e size iguais → não lê conteúdo
          if (file.mtime === diskMtime && file.sizeBytes === diskSize) {
            continue
          }

          // mtime/size divergentes → verifica por hash para distinguir touch de mudança real
          const diskHash = await this.calculateDiskHash(fullPath, correlationId)
          if (diskHash === file.contentHash) {
            // Conteúdo idêntico → apenas autocura metadados, sem marcar
            this.model.updateFileMetadata(file.id, { mtime: diskMtime, sizeBytes: diskSize })
            telemetryService.log(correlationId, 'CODE_MAP', 'METADATA_UPDATED', {
              relativePath: file.relativePath,
              oldMtime: file.mtime,
              newMtime: diskMtime,
              oldSize: file.sizeBytes,
              newSize: diskSize
            })
          } else {
            // Divergência de conteúdo confirmada → marca modified
            this.model.markFileModified(file.relativePath)
            this.modifiedFiles.add(file.relativePath)
            markedModified++
            repositoryEventBus.emitFileConfirmed(this.normalizedRepoPath, file.relativePath, correlationId)
          }
        } catch {
          // stat ou leitura falhou (deletado/inacessível) → marca modified por segurança
          this.model.markFileModified(file.relativePath)
          this.modifiedFiles.add(file.relativePath)
          markedModified++
          repositoryEventBus.emitFileConfirmed(this.normalizedRepoPath, file.relativePath, correlationId)
        }
      }

      telemetryService.log(correlationId, 'CODE_MAP', 'PERIODIC_SCAN_COMPLETED', {
        filesChecked: files.length,
        markedModified,
        healed,
        durationMs: Date.now() - startedAt
      })
    } catch (err) {
      telemetryService.logError(correlationId, 'CODE_MAP', 'PERIODIC_SCAN_FAILED', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt
      })
    } finally {
      this.isPeriodicScanRunning = false
    }
  }

  dispose(): void {
    if (this.periodicScanTimer) {
      clearInterval(this.periodicScanTimer)
      this.periodicScanTimer = null
    }

    repositoryEventBus.off('file:modified', this.boundHandlers.onModified)
    repositoryEventBus.off('file:created', this.boundHandlers.onCreated)
    repositoryEventBus.off('file:deleted', this.boundHandlers.onDeleted)

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    this.pendingFiles.clear()
    this.modifiedFiles.clear()
  }
}
