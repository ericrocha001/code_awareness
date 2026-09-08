import { createHash } from 'crypto'
import { open, readFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname, basename, extname, normalize } from 'path'
import type {
  CodeMapElement,
  CodeMapFile,
  CodeMapRelationship,
  CodeMapRepository,
  CodeMapSyncStatus,
  CodeMapFileStatus,
  CodeMapRelationshipType,
  IntegrityCheckResult,
  IntegrityIssue,
  IntegrityRepairResult,
  IntegrityRepair,
  IntegrityCheckOptions
} from '../../shared/types'
import { isEligibleTextFile, isKnownBinaryExtension, scanRepository } from './repository-scanner'
import { getLanguageForExtension } from './language-adapter'
import { createRepositoryDatabase, closeRepositoryDatabase } from './repository-database'
import type { RepositoryRepository } from './repository-repository'
import { telemetryService } from './telemetry-service'
import type { StructureExtractionPort } from './extraction/structure-extraction-port'
import { TypeScriptStructureExtractor } from './extraction/typescript-extractor'
import { JavaScriptStructureExtractor } from './extraction/javascript-extractor'
import { CssStructureExtractor } from './extraction/css-extractor'
import { RelationshipResolver } from './relationship-resolver'
import { getCanonicalTokenizer, type TokenizerPort } from './tokenizer'

export interface ImportSourceEntry {
  elementId: string
  source: string
  importerRelativePath: string
}

/** Recorte de código de um elemento indexado, com limite de segurança de linhas. */
export interface ElementSnippet {
  content: string
  startLine: number
  startColumn: number
  endLine: number
  truncated: boolean
  relativePath: string
}

/** Resultado da recuperação espacial precisa de um elemento Level A. */
export interface ExactElementSource {
  content: string
  relativePath: string
  startByte: number
  endByte: number
}

/** Conteúdo integral de um arquivo, com flag de truncamento por teto de segurança. */
export interface FileContent {
  content: string
  relativePath: string
  truncated: boolean
  lines: number
  sizeBytes: number
}

const MAX_SNIPPET_LINES = 300
const MAX_FILE_CONTENT_BYTES = 2 * 1024 * 1024

export class RepositoryModel {
  private readonly repoPath: string
  private readonly repositoryId: string
  private readonly db: RepositoryRepository
  private readonly extractors: ReadonlyArray<StructureExtractionPort>
  private readonly tokenizer: TokenizerPort

  constructor(repoPath: string, extractors: StructureExtractionPort[] = [], tokenizer: TokenizerPort = getCanonicalTokenizer()) {
    this.repoPath = repoPath.replace(/\\/g, '/').replace(/\/$/, '')
    this.repositoryId = this.generateRepositoryId(this.repoPath)
    this.db = createRepositoryDatabase(this.repoPath)
    this.extractors = extractors
    this.tokenizer = tokenizer
  }

  getRepositoryId(): string {
    return this.repositoryId
  }

  getRepoPath(): string {
    return this.repoPath
  }

  private generateRepositoryId(repoPath: string): string {
    return createHash('sha256').update(repoPath).digest('hex').substring(0, 16)
  }

  private generateFileId(relativePath: string): string {
    return createHash('sha256').update(`${this.repositoryId}:${relativePath}`).digest('hex').substring(0, 16)
  }

  private generateRelationshipId(sourceId: string, targetId: string, type: CodeMapRelationshipType): string {
    return createHash('sha256').update(`${sourceId}:${targetId}:${type}`).digest('hex').substring(0, 16)
  }

  private ensureRepositoryRecord(): void {
    if (this.db.getRepositoryByPath(this.repoPath)) return

    this.db.saveRepository({
      id: this.repositoryId,
      path: this.repoPath,
      name: basename(this.repoPath),
      modelVersion: 1,
      lastIndexedAt: null
    })
  }

  /**
   * Percorre o array de portas em ordem e retorna a primeira que suporta a extensão.
   * Retorna null se nenhuma porta suportar — arquivo tratado como "sem extração estrutural".
   */
  private findExtractorForExtension(extension: string): StructureExtractionPort | null {
    for (const extractor of this.extractors) {
      if (extractor.supports(extension)) return extractor
    }
    return null
  }

  /**
   * Calcula o SHA-256 do conteúdo do arquivo.
   * Retorna hash hexadecimal de 64 caracteres.
   */
  private calculateContentHash(content: string): string {
    return createHash('sha256').update(content, 'utf-8').digest('hex')
  }

  private tokenIdentity(content: string, contentHash: string, existing?: CodeMapFile | null): Pick<CodeMapFile, 'tokenCount' | 'tokenizerId' | 'tokenizerEncoding' | 'tokenizedContentHash'> {
    if (
      existing?.tokenizedContentHash === contentHash &&
      existing.tokenizerId === this.tokenizer.id &&
      existing.tokenizerEncoding === this.tokenizer.encoding &&
      typeof existing.tokenCount === 'number'
    ) {
      return {
        tokenCount: existing.tokenCount,
        tokenizerId: existing.tokenizerId,
        tokenizerEncoding: existing.tokenizerEncoding,
        tokenizedContentHash: existing.tokenizedContentHash
      }
    }
    return {
      tokenCount: this.tokenizer.count(content),
      tokenizerId: this.tokenizer.id,
      tokenizerEncoding: this.tokenizer.encoding,
      tokenizedContentHash: contentHash
    }
  }

  async backfillTokenMetadata(): Promise<number> {
    let updated = 0
    let processed = 0
    for (const file of this.db.getFilesByRepository(this.repositoryId)) {
      processed++
      if (processed % 50 === 0) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      if (
        file.contentHash &&
        file.tokenizedContentHash === file.contentHash &&
        file.tokenizerId === this.tokenizer.id &&
        file.tokenizerEncoding === this.tokenizer.encoding &&
        typeof file.tokenCount === 'number'
      ) continue

      try {
        const content = await readFile(join(this.repoPath, file.relativePath), 'utf-8')
        const contentHash = file.contentHash ?? this.calculateContentHash(content)
        this.db.saveFile({ ...file, contentHash, ...this.tokenIdentity(content, contentHash, file) })
        updated++
      } catch {
        continue
      }
    }
    return updated
  }

  async backfillContextReferences(): Promise<number> {
    return this.db.backfillContextReferences(this.repositoryId)
  }

  pruneKnownBinaryFiles(): number {
    const binaryFiles = this.db.getFilesByRepository(this.repositoryId)
      .filter((file) => isKnownBinaryExtension(file.relativePath))
    for (const file of binaryFiles) this.db.deleteFile(file.id)
    return binaryFiles.length
  }

  /**
   * Lê o arquivo do disco e compara seu hash SHA-256 com o hash esperado do índice.
   * Em caso de erro de leitura (binário, permissão, arquivo removido), retorna matches=false e error=true,
   * conservadoramente tratado como divergência pelo chamador.
   */
  private async verifyContentMatches(
    fullPath: string,
    expectedHash: string
  ): Promise<{ matches: boolean; error?: boolean }> {
    try {
      const content = await readFile(fullPath, 'utf-8')
      const hash = this.calculateContentHash(content)
      return { matches: hash === expectedHash }
    } catch {
      return { matches: false, error: true }
    }
  }


  async reconcileWithDisk(
    correlationIdOrOptions?: string | { correlationId?: string; indexUnexpected?: boolean }
  ): Promise<{ checked: number; markedModified: number; removed: number; healed: number; indexedUnexpected?: number }> {
    const options = typeof correlationIdOrOptions === 'string'
      ? { correlationId: correlationIdOrOptions }
      : (correlationIdOrOptions ?? {})
    const cid = options.correlationId ?? telemetryService.startOperation('RECONCILE_DISK')
    const startedAt = Date.now()
    try {
      const dbFiles = this.db.getFilesByRepository(this.repositoryId)
      telemetryService.log(cid, 'CODE_MAP', 'RECONCILE_STARTED', { checked: dbFiles.length })
      let markedModified = 0
      let removed = 0
      let healed = 0
      let processed = 0
      let scannedFiles: Awaited<ReturnType<typeof scanRepository>> | null = null
      const movedFileIds = new Set<string>()

      if (options.indexUnexpected === true && dbFiles.length > 0) {
        scannedFiles = await scanRepository(this.repoPath)
        const diskPaths = new Set(scannedFiles.map((file) => file.relativePath))
        const indexedPaths = new Set(dbFiles.map((file) => file.relativePath))
        const missingByHash = new Map<string, CodeMapFile[]>()
        const unexpectedByHash = new Map<string, string[]>()

        for (const file of dbFiles) {
          if (diskPaths.has(file.relativePath) || !file.contentHash) continue
          const entries = missingByHash.get(file.contentHash) ?? []
          entries.push(file)
          missingByHash.set(file.contentHash, entries)
        }
        for (const file of scannedFiles) {
          if (indexedPaths.has(file.relativePath)) continue
          try {
            const content = await readFile(join(this.repoPath, file.relativePath), 'utf-8')
            const hash = this.calculateContentHash(content)
            const entries = unexpectedByHash.get(hash) ?? []
            entries.push(file.relativePath)
            unexpectedByHash.set(hash, entries)
          } catch {
            continue
          }
        }
        for (const [hash, missing] of missingByHash) {
          const unexpected = unexpectedByHash.get(hash) ?? []
          if (missing.length !== 1 || unexpected.length !== 1) continue
          const [file] = missing
          const [relativePath] = unexpected
          this.db.moveFile(file.id, relativePath)
          await this.updateFileContent(relativePath, cid)
          movedFileIds.add(file.id)
        }
      }

      for (const file of dbFiles) {
        if (movedFileIds.has(file.id)) continue
        processed++
        if (processed % 50 === 0) {
          await new Promise((resolve) => setImmediate(resolve))
        }
        try {
          const fullPath = join(this.repoPath, file.relativePath)
          if (!existsSync(fullPath)) {
            this.db.deleteFile(file.id)
            removed++
            continue
          }

          let fileStat
          try {
            fileStat = await stat(fullPath)
          } catch {
            this.db.deleteFile(file.id)
            removed++
            continue
          }

          const diskMtime = Math.floor(fileStat.mtimeMs)
          const diskSize = fileStat.size

          if (!file.contentHash) {
            this.db.updateFileStatus(file.id, 'modified')
            markedModified++
            telemetryService.log(cid, 'CODE_MAP', 'RECONCILE_LEGACY_MODIFIED', { relativePath: file.relativePath })
            continue
          }

          if (file.status === 'indexed') {
            if (file.mtime === diskMtime && file.sizeBytes === diskSize) {
              continue
            }

            const check = await this.verifyContentMatches(fullPath, file.contentHash)
            if (check.matches) {
              if (file.mtime !== diskMtime || file.sizeBytes !== diskSize) {
                this.updateFileMetadata(file.id, { mtime: diskMtime, sizeBytes: diskSize })
              }
              telemetryService.log(cid, 'CODE_MAP', 'RECONCILE_HASH_MATCH', { relativePath: file.relativePath })
            } else {
              this.db.updateFileStatus(file.id, 'modified')
              markedModified++
              telemetryService.log(cid, 'CODE_MAP', 'RECONCILE_INDEXED_DIVERGED', { relativePath: file.relativePath })
            }
          } else if (file.status === 'modified') {
            const check = await this.verifyContentMatches(fullPath, file.contentHash)
            if (check.matches) {
              this.updateFileMetadata(file.id, { mtime: diskMtime, sizeBytes: diskSize })
              this.db.updateFileStatus(file.id, 'indexed')
              healed++
              telemetryService.log(cid, 'CODE_MAP', 'RECONCILE_STALE_HEALED', { relativePath: file.relativePath })
            } else {
              telemetryService.log(cid, 'CODE_MAP', 'RECONCILE_MODIFIED_STILL_DIVERGED', { relativePath: file.relativePath })
            }
          }
        } catch (err) {
          console.error(`[RepositoryModel] Erro ao reconciliar arquivo "${file.relativePath}":`, err)
        }
      }

      let indexedUnexpected = 0
      if (options.indexUnexpected === true && dbFiles.length > 0) {
        this.ensureRepositoryRecord()
        const scanned = scannedFiles ?? await scanRepository(this.repoPath)
        const dbPaths = new Set(this.db.getFilesByRepository(this.repositoryId).map((file) => file.relativePath))
        let scannedProcessed = 0
        for (const scannedFile of scanned) {
          scannedProcessed++
          if (scannedProcessed % 25 === 0) {
            await new Promise((resolve) => setImmediate(resolve))
          }
          if (!dbPaths.has(scannedFile.relativePath)) {
            try {
              const ok = await this.updateFileContent(scannedFile.relativePath, cid)
              if (ok) indexedUnexpected++
            } catch (err) {
              console.error(`[RepositoryModel] Falha ao indexar arquivo novo "${scannedFile.relativePath}":`, err)
            }
          }
        }
        telemetryService.log(cid, "CODE_MAP", "RECONCILE_UNEXPECTED_INDEXED", { indexedUnexpected })
      }

      telemetryService.log(cid, "CODE_MAP", "RECONCILE_COMPLETED", {
        checked: dbFiles.length,
        markedModified,
        removed,
        healed,
        indexedUnexpected,
        durationMs: Date.now() - startedAt
      })

      return { checked: dbFiles.length, markedModified, removed, healed, indexedUnexpected }
    } catch (err) {
      telemetryService.logError(cid, "CODE_MAP", "RECONCILE_FAILED", {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt
      })
      throw err
    }
  }

  /**
   * Preenche contentHash de arquivos legados (indexados antes da Sprint 2).
   * Percorre todos os arquivos do repositório com contentHash null,
   * lê o conteúdo do disco, calcula SHA-256 e atualiza no banco.
   *
   * Arquivos que não puderam ser lidos (deletados, binários, erro de I/O)
   * são marcados como modified para reindexação posterior.
   *
   * @returns Número de arquivos atualizados com hash.
   */
  async backfillContentHashes(correlationId?: string): Promise<number> {
    const cid = correlationId ?? telemetryService.startOperation("BACKFILL_HASHES")
    const startedAt = Date.now()

    telemetryService.log(cid, "CODE_MAP", "BACKFILL_STARTED")

    const dbFiles = this.db.getFilesByRepository(this.repositoryId)
    const legacyFiles = dbFiles.filter((f) => !f.contentHash)

    if (legacyFiles.length === 0) {
      telemetryService.log(cid, "CODE_MAP", "BACKFILL_COMPLETED", {
        updated: 0,
        failed: 0,
        durationMs: Date.now() - startedAt
      })
      return 0
    }

    let updated = 0
    let failed = 0

    const CHUNK_SIZE = 50
    for (let i = 0; i < legacyFiles.length; i += CHUNK_SIZE) {
      const chunk = legacyFiles.slice(i, i + CHUNK_SIZE)
      await Promise.all(
        chunk.map(async (file) => {
          const fullPath = join(this.repoPath, file.relativePath)

          try {
            if (!existsSync(fullPath)) {
              // Arquivo deletado do disco — marca para reindexação
              this.db.updateFileStatus(file.id, 'modified')
              failed++
              return
            }

            const fileStat = await stat(fullPath)
            if (fileStat.size > MAX_FILE_CONTENT_BYTES) {
              // Arquivo muito grande — marca para reindexação (que tem proteção de tamanho)
              this.db.updateFileStatus(file.id, 'modified')
              failed++
              return
            }

            const content = await readFile(fullPath, 'utf-8')
            const hash = this.calculateContentHash(content)

            const updatedFile: CodeMapFile = {
              ...file,
              contentHash: hash
            }
            this.db.saveFile(updatedFile)
            updated++
          } catch {
            // Erro de leitura (binário, permissão, etc.) — marca para reindexação
            this.db.updateFileStatus(file.id, 'modified')
            failed++
          }
        })
      )
    }

    telemetryService.log(cid, 'CODE_MAP', 'BACKFILL_COMPLETED', {
      updated,
      failed,
      total: legacyFiles.length,
      durationMs: Date.now() - startedAt
    })

    return updated
  }

  /**
   * Executa o pipeline completo de indexação inicial do repositório.
   */
  async indexRepository(
    correlationId?: string
  ): Promise<{ filesIndexed: number; elementsExtracted: number }> {
    const startedAt = Date.now()
    const cid = correlationId ?? telemetryService.startOperation('INDEX_REPOSITORY')
    telemetryService.log(cid, 'CODE_MAP', 'INDEX_STARTED')
    try {
    const scannedFiles = await scanRepository(this.repoPath)
    telemetryService.log(cid, 'CODE_MAP', 'INDEX_SCANNED', { fileCount: scannedFiles.length })

    this.db.saveRepository({
      id: this.repositoryId,
      path: this.repoPath,
      name: basename(this.repoPath),
      modelVersion: 1,
      lastIndexedAt: null
    })

    const previousFiles = new Map(
      this.db.getFilesByRepository(this.repositoryId).map((file) => [file.relativePath, file])
    )

    const scannedPaths = new Set(scannedFiles.map((file) => file.relativePath))
    for (const previous of previousFiles.values()) {
      if (!scannedPaths.has(previous.relativePath) && previous.contextReference) {
        this.db.retireContextReference(this.repositoryId, previous.contextReference)
      }
    }

    // Limpa dados anteriores do repositório para indexação completa limpa
    this.db.deleteAllFiles(this.repositoryId)

    const allElements: CodeMapElement[] = []
    const allElementInterfaces: Array<{ elementId: string; interfaceNames: string[] }> = []
    const allImportSources: ImportSourceEntry[] = []
    const allFiles: CodeMapFile[] = []
    let elementsExtractedCount = 0

    for (const scanned of scannedFiles) {
      const previousFile = previousFiles.get(scanned.relativePath)
      const fileId = previousFile?.id ?? this.generateFileId(scanned.relativePath)
      const fullPath = join(this.repoPath, scanned.relativePath)
      let content = ''
      try {
        content = await readFile(fullPath, 'utf-8')
      } catch (err) {
        console.warn(`[RepositoryModel] Falha ao ler arquivo "${scanned.relativePath}":`, err)
        continue
      }

      const lines = content.split(/\r?\n/).length
      const contentHash = this.calculateContentHash(content)
      telemetryService.log(cid, 'CODE_MAP', 'HASH_CALCULATED', {
        relativePath: scanned.relativePath,
        hashPrefix: contentHash.substring(0, 8)
      })

      const fileRecord: CodeMapFile = {
        id: fileId,
        repositoryId: this.repositoryId,
        contextReference: previousFile?.contextReference ?? this.db.allocateContextReference(this.repositoryId),
        relativePath: scanned.relativePath,
        language: scanned.language,
        extension: scanned.extension,
        lines,
        sizeBytes: scanned.sizeBytes,
        mtime: scanned.mtime,
        contentHash,
        ...this.tokenIdentity(content, contentHash, previousFile),
        status: 'indexed'
      }

      const extractor = this.findExtractorForExtension(scanned.extension)
      const structureResult = extractor
        ? extractor.extract({ repositoryId: this.repositoryId, relativePath: scanned.relativePath, extension: scanned.extension, content })
        : { elements: [], relationships: [], elementInterfaces: [] }

      // Substitui o fileId placeholder (que era o relativePath) pelo fileId real gerado
      for (const element of structureResult.elements) {
        element.fileId = fileId
      }

      this.db.saveFile(fileRecord)
      this.db.saveElements(structureResult.elements)
      this.db.saveRelationships(structureResult.relationships) // salva relacionamentos contains

      allFiles.push(fileRecord)
      allElements.push(...structureResult.elements)
      allElementInterfaces.push(...structureResult.elementInterfaces)
      elementsExtractedCount += structureResult.elements.length

      // Coleta imports para resolução cross-file
      for (const element of structureResult.elements) {
        if (element.kind === 'import' && element.name !== '(unknown-import)') {
          allImportSources.push({
            elementId: element.id,
            source: element.name,
            importerRelativePath: scanned.relativePath
          })
        }
      }
    }

    // Salva as interfaces implementadas por elementos
    this.db.saveElementInterfaces(allElementInterfaces)

    // Resolve relacionamentos cross-file (extends, implements, imports)
    const crossRelationships = this.resolveRelationships(
      allElements,
      allElementInterfaces,
      allImportSources,
      allFiles
    )

    this.db.saveRelationships(crossRelationships)

    // WARNING: o lastIndexedAt só é gravado após a indexação completar com sucesso.
    // Se a indexação falhar no meio (OOM, permissão negada, timeout), o registro permanece
    // com lastIndexedAt = null, permitindo que a UI detecte o estado "nunca indexado" e
    // ofereça reindexação completa em vez de sincronização parcial.
    const nowIso = new Date().toISOString()
    this.db.updateRepositoryLastIndexedAt(this.repositoryId, nowIso)
    // Indexar também é ficar coerente com o disco — grava o carimbo de última sincronização.
    this.db.updateLastSyncAt(this.repositoryId, nowIso)

    const result = {
      filesIndexed: scannedFiles.length,
      elementsExtracted: elementsExtractedCount
    }
    telemetryService.log(cid, 'CODE_MAP', 'INDEX_COMPLETED', {
      filesIndexed: result.filesIndexed,
      elementsExtracted: result.elementsExtracted,
      durationMs: Date.now() - startedAt
    })
    return result
    } catch (err) {
      // try/catch exclusivo para telemetria: loga a falha e relança, mantendo o comportamento externo idêntico.
      telemetryService.logError(cid, 'CODE_MAP', 'INDEX_FAILED', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt
      })
      throw err
    }
  }

  /**
   * Resolve relacionamentos cross-file (extends, implements, imports).
   * Referências não encontradas são ignoradas silenciosamente (não fabrica arestas).
   * Delega a construção do grafo ao RelationshipResolver.
   */
  private resolveRelationships(
    elements: CodeMapElement[],
    elementInterfaces: Array<{ elementId: string; interfaceNames: string[] }>,
    importSources: ImportSourceEntry[],
    files: CodeMapFile[]
  ): CodeMapRelationship[] {
    const resolver = new RelationshipResolver(this.repositoryId, this.repoPath)
    return resolver.resolve(elements, elementInterfaces, importSources, files)
  }

  /**
   * Reindexa um único arquivo modificado. Se o arquivo foi removido do disco, deleta do índice.
   */
  async updateFileContent(relativePath: string, correlationId?: string): Promise<boolean> {
    const startedAt = Date.now()
    const cid = correlationId ?? telemetryService.startOperation('UPDATE_FILE_CONTENT')
    telemetryService.log(cid, 'CODE_MAP', 'REINDEX_STARTED', { relativePath })
    try {
    const fullPath = join(this.repoPath, relativePath)
    const existingFile = this.db.getFileByPath(this.repositoryId, relativePath)
    const fileId = existingFile?.id ?? this.generateFileId(relativePath)

    if (!existsSync(fullPath)) {
      if (existingFile) {
        this.db.deleteFile(existingFile.id)
      }
      telemetryService.log(cid, 'CODE_MAP', 'REINDEX_COMPLETED', {
        relativePath,
        durationMs: Date.now() - startedAt,
        removed: true
      })
      return true
    }

    if (!(await isEligibleTextFile(fullPath))) {
      if (existingFile) this.db.deleteFile(existingFile.id)
      telemetryService.log(cid, 'CODE_MAP', 'REINDEX_COMPLETED', {
        relativePath,
        durationMs: Date.now() - startedAt,
        removed: true
      })
      return true
    }

    let content = ''
    try {
      content = await readFile(fullPath, 'utf-8')
    } catch {
      // Se não conseguir ler, deleta do banco
      this.db.deleteFile(fileId)
      telemetryService.log(cid, 'CODE_MAP', 'REINDEX_COMPLETED', {
        relativePath,
        durationMs: Date.now() - startedAt,
        removed: true
      })
      return true
    }

    const extension = extname(relativePath)
    const language = getLanguageForExtension(extension) ?? 'unknown'
    const lines = content.split(/\r?\n/).length
    const sizeBytes = Buffer.byteLength(content, 'utf-8')
    const contentHash = this.calculateContentHash(content)
    telemetryService.log(cid, 'CODE_MAP', 'HASH_CALCULATED', {
      relativePath,
      hashPrefix: contentHash.substring(0, 8)
    })

    let mtime = Date.now()
    try {
      const fileStat = await stat(fullPath)
      mtime = Math.floor(fileStat.mtimeMs)
    } catch {
      // Fallback para Date.now() se o stat falhar
    }

    const fileRecord: CodeMapFile = {
      id: fileId,
      repositoryId: this.repositoryId,
      contextReference: existingFile?.contextReference ?? this.db.allocateContextReference(this.repositoryId),
      relativePath,
      language,
      extension,
      lines,
      sizeBytes,
      mtime,
      contentHash,
      ...this.tokenIdentity(content, contentHash, existingFile),
      status: 'indexed'
    }

    const extractor = this.findExtractorForExtension(extension)
    const structureResult = extractor
      ? extractor.extract({ repositoryId: this.repositoryId, relativePath, extension, content })
      : { elements: [], relationships: [], elementInterfaces: [] }

    for (const element of structureResult.elements) {
      element.fileId = fileId
    }

    // Substituição atômica: tudo dentro de UMA transação (rollback em entrada envenenada)
    this.db.replaceIndexedFileState(fileRecord, structureResult.elements, structureResult.relationships, structureResult.elementInterfaces)

    // Re-resolve relacionamentos cross-file para todo o repositório
    const allElements = this.db.getElementsByRepository(this.repositoryId)
    const allFiles = this.db.getFilesByRepository(this.repositoryId)
    const allElementInterfaces = this.db.getElementInterfacesByRepository(this.repositoryId)

    const fileMap = new Map<string, string>()
    for (const file of allFiles) {
      fileMap.set(file.id, file.relativePath)
    }

    const allImportSources: ImportSourceEntry[] = []
    for (const element of allElements) {
      if (element.kind === 'import' && element.name !== '(unknown-import)') {
        const importerRelativePath = fileMap.get(element.fileId)
        if (importerRelativePath) {
          allImportSources.push({
            elementId: element.id,
            source: element.name,
            importerRelativePath
          })
        }
      }
    }

    const crossRelationships = this.resolveRelationships(
      allElements,
      allElementInterfaces,
      allImportSources,
      allFiles
    )

    this.db.saveRelationships(crossRelationships)
    telemetryService.log(cid, 'CODE_MAP', 'REINDEX_COMPLETED', {
      relativePath,
      durationMs: Date.now() - startedAt
    })
    return true
    } catch (err) {
      // try/catch exclusivo para telemetria: loga a falha e relança, mantendo o comportamento externo idêntico.
      telemetryService.logError(cid, 'CODE_MAP', 'REINDEX_FAILED', {
        relativePath,
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }
  }

  /**
   * Marca um arquivo como Modified no banco de dados.
   */
  markFileModified(relativePath: string): void {
    const file = this.db.getFileByPath(this.repositoryId, relativePath)
    if (file) {
      this.db.updateFileStatus(file.id, 'modified')
    }
  }

  /**
   * Cura o status de um arquivo de volta para 'indexed' no banco de dados.
   * Só atua se o arquivo existir e estiver com status 'modified' — não toca em metadados.
   * Usado quando o conteúdo do disco corresponde ao hash indexado (status obsoleto).
   */
  markFileIndexed(relativePath: string): void {
    const file = this.db.getFileByPath(this.repositoryId, relativePath)
    if (file && file.status === 'modified') {
      this.db.updateFileStatus(file.id, 'indexed')
    }
  }

  /**
   * Grava o carimbo de última sincronização bem-sucedida.
   */
  updateLastSyncAt(timestamp: string): void {
    this.db.updateLastSyncAt(this.repositoryId, timestamp)
  }

  // ─── Métodos de Consulta ──────────────────────────────────────────────────

  getRepository(): CodeMapRepository | null {
    return this.db.getRepositoryByPath(this.repoPath)
  }

  getFiles(): CodeMapFile[] {
    return this.db.getFilesByRepository(this.repositoryId)
  }

  getElementsByFile(fileId: string): CodeMapElement[] {
    return this.db.getElementsByFile(fileId)
  }

  getElementsByRepository(): CodeMapElement[] {
    return this.db.getElementsByRepository(this.repositoryId)
  }

  getRelationships(): CodeMapRelationship[] {
    return this.db.getRelationshipsByRepository(this.repositoryId)
  }

  getSyncStatus(): CodeMapSyncStatus {
    return this.db.getSyncStatus(this.repositoryId)
  }

  getModifiedFiles(): CodeMapFile[] {
    return this.db.getModifiedFilesByRepository(this.repositoryId)
  }

  /**
   * Busca um arquivo pelo caminho relativo.
   * Retorna null se não encontrado.
   */
  getFileByRelativePath(relativePath: string): CodeMapFile | null {
    return this.db.getFileByPath(this.repositoryId, relativePath)
  }

  /**
   * Atualiza metadados de um arquivo (mtime, sizeBytes) sem reindexar.
   * Usado para autocura quando o hash é igual mas os metadados mudaram.
   * INVARIANT: o status do arquivo é preservado integralmente — nunca alterado por este método.
   */
  updateFileMetadata(fileId: string, patch: { mtime?: number; sizeBytes?: number }): void {
    const file = this.db.getFileById(fileId)
    if (!file) return

    const updatedFile: CodeMapFile = {
      ...file,
      mtime: patch.mtime ?? file.mtime,
      sizeBytes: patch.sizeBytes ?? file.sizeBytes
    }

    this.db.saveFile(updatedFile)
  }

  /**
   * Recorta o trecho exato de código de um elemento pelas coordenadas já armazenadas.
   * Retorna null se o elemento ou o arquivo não forem encontrados.
   */
  async getElementCodeSnippet(elementId: string): Promise<ElementSnippet | null> {
    const element = this.getElementsByRepository().find((e) => e.id === elementId)
    if (!element) return null

    // Busca o arquivo pelo id do elemento (getFileByPath não serve aqui — precisa buscar por id)
    const file = this.getFiles().find((f) => f.id === element.fileId)
    if (!file) return null

    let content = ''
    try {
      content = await readFile(join(this.repoPath, file.relativePath), 'utf-8')
    } catch {
      return null
    }

    const lines = content.split(/\r?\n/)
    // WARNING: startLine/endLine do elemento são 1-indexed; o slice do array é 0-indexed.
    // Usar startLine - 1 como início e endLine como fim (exclusivo) para alinhar os índices.
    const startLine = element.location.start.line
    const rawEndLine = element.location.end.line
    const lineCount = rawEndLine - startLine + 1
    const truncated = lineCount > MAX_SNIPPET_LINES
    const endLine = truncated ? startLine + MAX_SNIPPET_LINES - 1 : rawEndLine

    return {
      content: lines.slice(startLine - 1, endLine).join('\n'),
      startLine,
      startColumn: element.location.start.column,
      endLine,
      truncated,
      relativePath: file.relativePath
    }
  }

  /**
   * Recupera o código fonte exato de um elemento Level A a partir de seu ID (Exact Retrieval).
   * Valida a integridade do conteúdo via contentHash (recusa conteúdo stale)
   * e extrai apenas o range de bytes persistido no banco via slice em Buffer.
   * Retorna null se o elemento não for encontrado, não for Level A, o arquivo estiver
   * inacessível ou o hash do disco divergir do hash persistido.
   */
  async getElementExactSource(elementId: string): Promise<ExactElementSource | null> {
    try {
      const element = this.db.getElementsByRepository(this.repositoryId).find((e) => e.id === elementId)
      if (!element) return null

      // Apenas elementos recuperáveis são elegíveis para Exact Retrieval
      if (element.retrievable !== true) {
        return null
      }

      const file = this.db.getFileById(element.fileId)
      if (!file) return null

      // Se o arquivo não possuir contentHash no banco, não é possível validar integridade
      if (!file.contentHash) {
        return null
      }

      const fullPath = join(this.repoPath, file.relativePath)
      if (!existsSync(fullPath)) {
        return null
      }

      // Lê como Buffer binário (sem encoding) para preservar offsets de bytes exatos
      const buffer = await readFile(fullPath)

      // Validação de integridade: compara hash SHA-256 do disco com o hash persistido
      const diskHash = createHash('sha256').update(buffer).digest('hex')
      if (diskHash !== file.contentHash) {
        return null
      }

      const startByte = element.location.start.byte
      const endByte = element.location.end.byte

      // Garante que os limites estão dentro do tamanho do buffer
      if (startByte < 0 || endByte > buffer.length || startByte > endByte) {
        return null
      }

      const slice = buffer.subarray(startByte, endByte)
      const content = slice.toString('utf-8')

      return {
        content,
        relativePath: file.relativePath,
        startByte,
        endByte
      }
    } catch {
      return null
    }
  }

  async getElementExactSources(elementIds: string[]): Promise<Map<string, ExactElementSource>> {
    const requested = new Set(elementIds)
    const elements = this.db.getElementsByRepository(this.repositoryId)
      .filter((element) => requested.has(element.id) && element.retrievable === true)
    const filesById = new Map(this.db.getFilesByRepository(this.repositoryId).map((file) => [file.id, file]))
    const elementsByFile = new Map<string, CodeMapElement[]>()
    for (const element of elements) {
      const entries = elementsByFile.get(element.fileId) ?? []
      entries.push(element)
      elementsByFile.set(element.fileId, entries)
    }

    const results = new Map<string, ExactElementSource>()
    await Promise.all([...elementsByFile].map(async ([fileId, fileElements]) => {
      const file = filesById.get(fileId)
      if (!file?.contentHash) return
      try {
        const buffer = await readFile(join(this.repoPath, file.relativePath))
        if (createHash('sha256').update(buffer).digest('hex') !== file.contentHash) return
        for (const element of fileElements) {
          const startByte = element.location.start.byte
          const endByte = element.location.end.byte
          if (startByte < 0 || endByte > buffer.length || startByte > endByte) continue
          results.set(element.id, {
            content: buffer.subarray(startByte, endByte).toString('utf-8'),
            relativePath: file.relativePath,
            startByte,
            endByte
          })
        }
      } catch {
        return
      }
    }))
    return results
  }

  /**
   * Lê o conteúdo integral de um arquivo com defesa em profundidade:
   * rejeita path traversal, recusa binário e trunca arquivos acima do teto de segurança.
   * Retorna null em qualquer caso de rejeição ou erro de leitura.
   */
  async getFileContent(relativePath: string): Promise<FileContent | null> {
    // Defesa 1 — path traversal: normaliza, rejeita vazio, "..", absoluto e drive Windows
    const normalized = relativePath.replace(/\\/g, '/')
    if (normalized.length === 0 || normalized.includes('..') || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
      return null
    }

    const fullPath = normalize(join(this.repoPath, normalized)).replace(/\\/g, '/')
    // Confere que o caminho resolvido está contido no repoPath (defesa em profundidade)
    if (fullPath !== this.repoPath && !fullPath.startsWith(this.repoPath + '/')) {
      return null
    }

    // Defesa 2 — existência
    if (!existsSync(fullPath)) {
      return null
    }

    // Defesa 3 — binário: lê apenas os primeiros 4096 bytes e procura byte nulo
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(fullPath, 'r')
      const buffer = Buffer.alloc(4096)
      const { bytesRead } = await handle.read(buffer, 0, 4096, 0)
      const head = buffer.subarray(0, bytesRead)
      if (head.includes(0)) {
        return null
      }
    } catch {
      return null
    } finally {
      // Fecha o handle mesmo em caso de erro para evitar vazamento de file descriptors
      if (handle) {
        await handle.close().catch(() => {})
      }
    }

    // Leitura integral
    let content = ''
    try {
      content = await readFile(fullPath, 'utf-8')
    } catch {
      return null
    }

    // Teto de segurança: trunca no limite de bytes UTF-8 seguro e marca a flag
    const sizeBytes = Buffer.byteLength(content, 'utf-8')
    let truncated = false
    if (sizeBytes > MAX_FILE_CONTENT_BYTES) {
      content = Buffer.from(content, 'utf-8').toString('utf-8', 0, MAX_FILE_CONTENT_BYTES)
      truncated = true
    }

    return {
      content,
      relativePath: normalized,
      truncated,
      lines: content.split(/\r?\n/).length,
      sizeBytes
    }
  }

  close(): void {
    closeRepositoryDatabase(this.repoPath)
  }

  // ─── Integrity Check ────────────────────────────────────────────────────────
  
  /**
   * Verificação de integridade completa do Code Map.
   * 
   * Fase 1 — Descoberta:
   * - Verifica hash de todos os arquivos (disco vs. índice)
   * - Detecta arquivos ausentes no disco mas presentes no índice
   * - Detecta arquivos inesperados no disco mas ausentes no índice
   * - Valida invariantes do banco (elementos órfãos, relacionamentos inválidos)
   * 
   * Fase 2 — Reparação (opcional):
   * - Reindexa arquivos com hash divergente
   * - Remove elementos órfãos
   * - Remove relacionamentos inválidos
   * 
   * Fase 3 — Revalidação:
   * - Executa verificação novamente para confirmar consistência
   * 
   * @param options.autoRepair Se true, executa reparação automática após descoberta.
   * @param options.scanForUnexpectedFiles Se false, pula o scan do disco para arquivos inesperados (mais rápido). Padrão: true.
   * @returns Relatório estruturado com inconsistências e resultado da reparação (se executada).
   */
  async verifyIntegrity(options: IntegrityCheckOptions = {}): Promise<IntegrityCheckResult> {
    const cid = options.correlationId ?? telemetryService.startOperation('INTEGRITY_CHECK')
    const startedAt = Date.now()
    
    telemetryService.log(cid, 'INTEGRITY', 'CHECK_STARTED', {
      autoRepair: options.autoRepair ?? false,
      scanForUnexpectedFiles: options.scanForUnexpectedFiles ?? true,
      selectedCount: options.selectedIssues?.length,
      preDiscovered: Array.isArray(options.issues) ? options.issues.length : 0
    })

    // Modo reparação cirúrgica: o frontend já descobriu as issues. Quando fornecidas
    // (e válidas), pula-se a autocura (Fase 0) e a redescoberta (Fase 1), reconstruindo
    // a estrutura de descoberta a partir das issues enviadas e indo direto à reparação.
    const preDiscoveredIssues =
      options.autoRepair === true &&
      Array.isArray(options.issues) &&
      options.issues.length > 0 &&
      options.issues.every(issue => this.isValidIntegrityIssue(issue))

    let discovery: Awaited<ReturnType<typeof this.discoverIntegrityIssues>>
    let staleHealed = 0

    if (preDiscoveredIssues) {
      discovery = this.reconstructDiscoveryFromIssues(options.issues ?? [])
    } else {
      // ─── Fase 0: Autocura de status obsoleto ──────────────────────────
      const reconcileRes = await this.reconcileWithDisk(cid)
      staleHealed = reconcileRes.healed

      // ─── Fase 1: Descoberta ───────────────────────────────────────────
      discovery = await this.discoverIntegrityIssues(cid, options.scanForUnexpectedFiles ?? true, options.deep === true)
    }
    
    const totalIssues = 
      discovery.hashesMismatched +
      discovery.filesMissing +
      discovery.filesUnexpected +
      discovery.orphanElements +
      discovery.invalidRelationships +
      discovery.databaseInconsistencies
    
    const status = totalIssues === 0 ? 'healthy' : 'inconsistent'
    
    const result: IntegrityCheckResult = {
      status,
      filesChecked: discovery.filesChecked,
      hashesChecked: discovery.hashesChecked,
      hashesMismatched: discovery.hashesMismatched,
      filesMissing: discovery.filesMissing,
      filesUnexpected: discovery.filesUnexpected,
      orphanElements: discovery.orphanElements,
      invalidRelationships: discovery.invalidRelationships,
      databaseInconsistencies: discovery.databaseInconsistencies,
      details: discovery.details.slice(0, 100), // Limita a 100 para não sobrecarregar
      durationMs: Date.now() - startedAt,
      staleHealed
    }
    
    telemetryService.log(cid, 'INTEGRITY', 'CHECK_COMPLETED', {
      deep: options.deep === true,
      status,
      totalIssues,
      durationMs: result.durationMs
    })
    
    // ─── Fase 2: Reparação (se solicitada e há inconsistências) ─────────
    if (options.autoRepair && totalIssues > 0) {
      const repairResult = await this.repairIntegrityIssues(
        discovery,
        cid,
        options.scanForUnexpectedFiles ?? true,
        options.selectedIssues
      )
      result.repairResult = repairResult

      // Revalidação pós-repair: nova descoberta reflete o estado atual
      // (o repair pode curar hashes divergentes, remover órfãos e reindexar arquivos).
      if (repairResult.status !== 'failed') {
        const revalidation = await this.discoverIntegrityIssues(cid, options.scanForUnexpectedFiles ?? true, options.deep === true)
        const revalidatedIssues =
          revalidation.hashesMismatched +
          revalidation.filesMissing +
          revalidation.filesUnexpected +
          revalidation.orphanElements +
          revalidation.invalidRelationships +
          revalidation.databaseInconsistencies
        result.status = revalidatedIssues === 0 ? 'healthy' : 'inconsistent'
        result.hashesMismatched = revalidation.hashesMismatched
        result.filesMissing = revalidation.filesMissing
        result.filesUnexpected = revalidation.filesUnexpected
        result.orphanElements = revalidation.orphanElements
        result.invalidRelationships = revalidation.invalidRelationships
        result.databaseInconsistencies = revalidation.databaseInconsistencies
        result.details = revalidation.details.slice(0, 100)
        telemetryService.log(cid, 'INTEGRITY', 'REVALIDATION_COMPLETED', { revalidatedIssues })
      }
    }

    return result
  }

  /**
   * Fase 1: Descobre todas as inconsistências sem corrigir.
   * @param scanForUnexpectedFiles Se false, pula o scan do disco (mais rápido para verificações frequentes).
   */
  /** Valida se uma issue enviada pelo frontend tem o formato esperado. */
  private isValidIntegrityIssue(issue: IntegrityIssue): boolean {
    return (
      !!issue &&
      typeof issue === 'object' &&
      typeof issue.type === 'string' &&
      typeof issue.target === 'string'
    )
  }

  /**
   * Reconstrói a estrutura de descoberta a partir de issues já descobertas pelo frontend,
   * poupando a varredura do disco na reparação cirúrgica. Os campos dependentes de scan
   * (filesChecked/hashesChecked) são zerados — são informativos e irrelevantes nesse caminho.
   */
  private reconstructDiscoveryFromIssues(issues: IntegrityIssue[]): Awaited<ReturnType<typeof this.discoverIntegrityIssues>> {
    const hashMismatch = issues.filter(i => i.type === 'hash_mismatch')

    const filesByPath = new Map(this.db.getFilesByRepository(this.repositoryId).map(f => [f.relativePath, f]))
    const mismatchedFiles = hashMismatch
      .map(i => filesByPath.get(i.target))
      .filter((f): f is CodeMapFile => f !== undefined)

    const orphanElementIds = issues
      .filter(i => i.type === 'orphan_element' && typeof i.id === 'string' && i.id.startsWith('orphan_element:'))
      .map(i => (i.id as string).slice('orphan_element:'.length))

    const invalidRelationshipIds = issues
      .filter(i => i.type === 'invalid_relationship' && typeof i.id === 'string' && i.id.startsWith('invalid_relationship:'))
      .map(i => (i.id as string).slice('invalid_relationship:'.length))

    return {
      filesChecked: 0,
      hashesChecked: 0,
      hashesMismatched: hashMismatch.length,
      filesMissing: issues.filter(i => i.type === 'file_missing').length,
      filesUnexpected: issues.filter(i => i.type === 'file_unexpected').length,
      orphanElements: orphanElementIds.length,
      invalidRelationships: invalidRelationshipIds.length,
      databaseInconsistencies: issues.filter(i => i.type === 'database_inconsistency').length,
      details: issues,
      mismatchedFiles,
      orphanElementIds,
      invalidRelationshipIds
    }
  }

  private async discoverIntegrityIssues(correlationId: string, scanForUnexpectedFiles = true, deep = false): Promise<{
    filesChecked: number
    hashesChecked: number
    hashesMismatched: number
    filesMissing: number
    filesUnexpected: number
    orphanElements: number
    invalidRelationships: number
    databaseInconsistencies: number
    details: IntegrityIssue[]
    /** Arquivos com hash divergente (para reparação) */
    mismatchedFiles: CodeMapFile[]
    /** IDs de elementos órfãos (para reparação) */
    orphanElementIds: string[]
    /** IDs de relacionamentos inválidos (para reparação) */
    invalidRelationshipIds: string[]
  }> {
    const details: IntegrityIssue[] = []
    const mismatchedFiles: CodeMapFile[] = []
    const orphanElementIds: string[] = []
    const invalidRelationshipIds: string[] = []
    
    let hashesMismatched = 0
    let filesMissing = 0
    let filesUnexpected = 0
    let orphanElements = 0
    let invalidRelationships = 0
    let databaseInconsistencies = 0
    
    // ─── Verificação de arquivos (hash disco vs. índice) ─────────────
    const filesCheckStartedAt = Date.now()
    const dbFiles = this.db.getFilesByRepository(this.repositoryId)
    const dbFilesByPath = new Map(dbFiles.map(f => [f.relativePath, f]))
    
    for (const dbFile of dbFiles) {
      const fullPath = join(this.repoPath, dbFile.relativePath)
      
      if (!existsSync(fullPath)) {
        // Arquivo ausente no disco
        filesMissing++
        details.push({
          id: `file_missing:${dbFile.relativePath}`,
          type: 'file_missing',
          severity: 'error',
          description: 'Arquivo presente no índice mas ausente no disco',
          target: dbFile.relativePath
        })
        continue
      }
      
      // Verifica hash se disponível — usa mtime+size como heurística para evitar leitura desnecessária
      // INVARIANT: só lemos o arquivo se mtime ou size divergirem do índice
      if (dbFile.contentHash) {
        try {
          const fileStat = await stat(fullPath)
          const diskMtime = Math.floor(fileStat.mtimeMs)
          const diskSize = fileStat.size
          
          // Se mtime e size não mudaram, o hash provavelmente não mudou — pula leitura completa.
          // INVARIANT (Deep Integrity): em modo deep o atalho é IGNORADO — todo arquivo é hasheado,
          // tornando a auditoria autoritativa mesmo quando mtime/size são restaurados artificialmente.
          if (!deep && dbFile.mtime === diskMtime && dbFile.sizeBytes === diskSize) {
            continue
          }
          
          // mtime ou size mudaram — calcula hash completo para confirmar
          const content = await readFile(fullPath, 'utf-8')
          const diskHash = this.calculateContentHash(content)
          
          if (diskHash !== dbFile.contentHash) {
            hashesMismatched++
            mismatchedFiles.push(dbFile)
            details.push({
              id: `hash_mismatch:${dbFile.relativePath}`,
              type: 'hash_mismatch',
              severity: 'error',
              description: 'Hash do disco diverge do hash indexado',
              target: dbFile.relativePath
            })
          }
        } catch {
          // Erro de stat ou leitura — trata como divergente para forçar reindexação
          hashesMismatched++
          mismatchedFiles.push(dbFile)
          details.push({
            id: `hash_mismatch:${dbFile.relativePath}`,
            type: 'hash_mismatch',
            severity: 'warning',
            description: 'Erro ao verificar arquivo no disco',
            target: dbFile.relativePath
          })
        }
      }
    }
    
    telemetryService.log(correlationId, 'INTEGRITY', 'FILES_CHECK_COMPLETED', {
      durationMs: Date.now() - filesCheckStartedAt,
      filesChecked: dbFiles.length
    })
    
    // ─── Detecção de arquivos inesperados (no disco mas não no índice) ─
    // Scan completo do disco — opcional via scanForUnexpectedFiles para verificações rápidas.
    if (scanForUnexpectedFiles) {
      const unexpectedCheckStartedAt = Date.now()
      const scannedFiles = await scanRepository(this.repoPath)
      for (const scanned of scannedFiles) {
        if (!dbFilesByPath.has(scanned.relativePath)) {
          filesUnexpected++
          details.push({
            id: `file_unexpected:${scanned.relativePath}`,
            type: 'file_unexpected',
            severity: 'warning',
            description: 'Arquivo presente no disco mas ausente no índice — pode ser arquivo novo não indexado ainda',
            target: scanned.relativePath
          })
        }
      }
      telemetryService.log(correlationId, 'INTEGRITY', 'UNEXPECTED_CHECK_COMPLETED', {
        durationMs: Date.now() - unexpectedCheckStartedAt,
        filesUnexpected
      })
    }
    
    // ─── Validação de elementos (órfãos) ─────────────────────────────
    const elementsCheckStartedAt = Date.now()
    const allElements = this.db.getElementsByRepository(this.repositoryId)
    const allFileIds = new Set(dbFiles.map(f => f.id))
    
    for (const element of allElements) {
      if (!allFileIds.has(element.fileId)) {
        orphanElements++
        orphanElementIds.push(element.id)
        details.push({
          id: `orphan_element:${element.id}`,
          type: 'orphan_element',
          severity: 'error',
          description: 'Elemento sem arquivo pai válido',
          target: `${element.kind}:${element.name} (fileId: ${element.fileId})`
        })
      }
    }
    
    telemetryService.log(correlationId, 'INTEGRITY', 'ELEMENTS_CHECK_COMPLETED', {
      durationMs: Date.now() - elementsCheckStartedAt,
      orphanElements
    })
    
    // ─── Validação de relacionamentos (inválidos) ────────────────────
    const relsCheckStartedAt = Date.now()
    const allRelationships = this.db.getRelationshipsByRepository(this.repositoryId)
    const allElementIds = new Set(allElements.map(e => e.id))
    
    for (const rel of allRelationships) {
      // Valida os endpoints POR KIND (sourceKind/targetKind):
      // - element → deve existir em allElementIds
      // - file → deve existir em allFileIds
      const sourceValid = rel.sourceKind === 'element'
        ? allElementIds.has(rel.sourceId)
        : allFileIds.has(rel.sourceId)
      const targetValid = rel.targetKind === 'element'
        ? allElementIds.has(rel.targetId)
        : allFileIds.has(rel.targetId)
      
      if (!sourceValid || !targetValid) {
        invalidRelationships++
        invalidRelationshipIds.push(rel.id)
        details.push({
          id: `invalid_relationship:${rel.id}`,
          type: 'invalid_relationship',
          severity: 'error',
          description: `Relacionamento ${rel.type} com source ou target inexistente`,
          target: `${rel.sourceId} → ${rel.targetId}`
        })
      }
    }
    
    telemetryService.log(correlationId, 'INTEGRITY', 'RELATIONSHIPS_CHECK_COMPLETED', {
      durationMs: Date.now() - relsCheckStartedAt,
      invalidRelationships
    })
    
    // ─── Validação de banco (duplicatas, violações de FK) ────────────
    // Por ora, não há verificações adicionais de banco além das acima
    // Futuro: validar unicidade de (repository_id, relative_path), integridade de FK, etc.
    
    telemetryService.log(correlationId, 'INTEGRITY', 'DISCOVERY_COMPLETED', {
      filesChecked: dbFiles.length,
      hashesMismatched,
      filesMissing,
      filesUnexpected,
      orphanElements,
      invalidRelationships,
      databaseInconsistencies
    })
    
    return {
      filesChecked: dbFiles.length,
      hashesChecked: dbFiles.filter(f => f.contentHash).length,
      hashesMismatched,
      filesMissing,
      filesUnexpected,
      orphanElements,
      invalidRelationships,
      databaseInconsistencies,
      details,
      mismatchedFiles,
      orphanElementIds,
      invalidRelationshipIds
    }
  }

  /**
   * Fase 2: Repara as inconsistências descobertas.
   * - Reindexa arquivos com hash divergente
   * - Remove elementos órfãos
   * - Remove relacionamentos inválidos
   * 
   * Após reparação, executa revalidação (Fase 3).
   */
  private async repairIntegrityIssues(
    discovery: Awaited<ReturnType<typeof this.discoverIntegrityIssues>>,
    correlationId: string,
    scanForUnexpectedFiles = true,
    selectedIssues?: string[]
  ): Promise<IntegrityRepairResult> {
    const startedAt = Date.now()
    const repairs: IntegrityRepair[] = []
    let issuesFixed = 0
    let issuesRemaining = 0
    
    telemetryService.log(correlationId, 'INTEGRITY', 'REPAIR_STARTED', {
      mismatchedFiles: discovery.mismatchedFiles.length,
      orphanElements: discovery.orphanElementIds.length,
      invalidRelationships: discovery.invalidRelationshipIds.length,
      selectedCount: selectedIssues?.length
    })

    const isSelected = (id: string, target?: string, type?: string): boolean => {
      if (!selectedIssues) return true
      return (
        selectedIssues.includes(id) ||
        (target ? selectedIssues.includes(target) : false) ||
        (type && target ? selectedIssues.includes(`${type}:${target}`) : false)
      )
    }
    
    // ─── Reparação 1: Reindexar arquivos com hash divergente ─────────
    const filesToRepair = discovery.mismatchedFiles.filter(f =>
      isSelected(`hash_mismatch:${f.relativePath}`, f.relativePath, 'hash_mismatch')
    )
    for (const file of filesToRepair) {
      try {
        await this.updateFileContent(file.relativePath, correlationId)
        repairs.push({
          type: 'reindex_file',
          description: 'Arquivo reindexado com conteúdo atualizado',
          target: file.relativePath,
          success: true
        })
        issuesFixed++
      } catch (err) {
        repairs.push({
          type: 'reindex_file',
          description: 'Falha ao reindexar arquivo',
          target: file.relativePath,
          success: false,
          error: err instanceof Error ? err.message : String(err)
        })
        issuesRemaining++
      }
    }
    
    // ─── Reparação 2: Elementos órfãos ───────────────────────────────
    const orphanSelected = discovery.orphanElementIds.some(id =>
      isSelected(`orphan_element:${id}`, id, 'orphan_element')
    )
    if (discovery.orphanElementIds.length > 0 && orphanSelected) {
      const allFiles = this.db.getFilesByRepository(this.repositoryId)
      for (const file of allFiles) {
        this.markFileModified(file.relativePath)
      }
      repairs.push({
        type: 'reindex_file',
        description: `Todos os arquivos marcados para reindexação (${discovery.orphanElementIds.length} elementos órfãos detectados)`,
        target: `${allFiles.length} arquivos`,
        success: true
      })
      issuesFixed += discovery.orphanElementIds.length
    }
    
    // ─── Reparação 3: Relacionamentos inválidos ──────────────────────
    const relsSelected = discovery.invalidRelationshipIds.some(id =>
      isSelected(`invalid_relationship:${id}`, id, 'invalid_relationship')
    )
    if (discovery.invalidRelationshipIds.length > 0 && relsSelected) {
      issuesRemaining += discovery.invalidRelationshipIds.length
      repairs.push({
        type: 'delete_invalid_relationship',
        description: 'Relacionamentos inválidos não puderam ser removidos (limitação do contrato)',
        target: `${discovery.invalidRelationshipIds.length} relacionamentos`,
        success: false,
        error: 'Método deleteRelationship não disponível no contrato'
      })
    }
    
    // ─── Reparação 4: Indexar arquivos inesperados ───────────────────
    const unexpectedFiles = discovery.details
      .filter(d => d.type === 'file_unexpected' && isSelected(d.id || `file_unexpected:${d.target}`, d.target, 'file_unexpected'))
      .map(d => d.target)
    
    for (const relativePath of unexpectedFiles) {
      try {
        await this.updateFileContent(relativePath, correlationId)
        repairs.push({
          type: 'index_unexpected_file',
          description: 'Arquivo inesperado indexado com sucesso',
          target: relativePath,
          success: true
        })
        issuesFixed++
      } catch (err) {
        repairs.push({
          type: 'index_unexpected_file',
          description: 'Falha ao indexar arquivo inesperado',
          target: relativePath,
          success: false,
          error: err instanceof Error ? err.message : String(err)
        })
        issuesRemaining++
      }
    }
    
    telemetryService.log(correlationId, 'INTEGRITY', 'REPAIR_COMPLETED', {
      issuesFixed,
      issuesRemaining,
      durationMs: Date.now() - startedAt
    })
    
    // ─── Fase 3: Revalidação ─────────────────────────────────────────
    // Revalidação não precisa re-escanear o disco — arquivos inesperados não são removidos pela reparação
    const revalidationDiscovery = await this.discoverIntegrityIssues(correlationId, scanForUnexpectedFiles)
    
    const revalidationTotalIssues = 
      revalidationDiscovery.hashesMismatched +
      revalidationDiscovery.filesMissing +
      revalidationDiscovery.filesUnexpected +
      revalidationDiscovery.orphanElements +
      revalidationDiscovery.invalidRelationships +
      revalidationDiscovery.databaseInconsistencies
    
    const revalidationStatus = revalidationTotalIssues === 0 ? 'healthy' : 'inconsistent'
    
    const repairStatus = issuesRemaining === 0 ? 'success' : (issuesFixed > 0 ? 'partial' : 'failed')
    
    return {
      status: repairStatus,
      issuesFixed,
      issuesRemaining,
      repairs,
      durationMs: Date.now() - startedAt,
      revalidation: {
        status: revalidationStatus,
        filesChecked: revalidationDiscovery.filesChecked,
        hashesMismatched: revalidationDiscovery.hashesMismatched,
        orphanElements: revalidationDiscovery.orphanElements,
        invalidRelationships: revalidationDiscovery.invalidRelationships
      }
    }
  }
}

/** Fábrica conveniente para criar instâncias de RepositoryModel com o conjunto padrão de extratores. */
export function createRepositoryModel(repoPath: string, tokenizer: TokenizerPort = getCanonicalTokenizer()): RepositoryModel {
  return new RepositoryModel(repoPath, [
    new TypeScriptStructureExtractor(),
    new JavaScriptStructureExtractor(),
    new CssStructureExtractor()
  ], tokenizer)
}
