/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

 1. Representar o estado estrutural do repositório em memória.
 2. Coordenar Scanner, Language Adapter, Structure Reader e Repository Database.
 3. Gerar IDs estáveis para arquivos e substituir o fileId placeholder do Structure Reader.
 4. Resolver relacionamentos cross-file (extends, implements, imports) usando dados brutos coletados pelo Structure Reader e re-resolver relacionamentos cross-file completos após reindexação seletiva.
 5. Expor operações de alto nível para o Code Map Service.
 6. Ser a única fonte de verdade estrutural — nenhum outro componente deve ler o banco diretamente.
 7. Recortar trechos de código de elementos por coordenadas já armazenadas, com limite de segurança.
 8. Ler arquivos inteiros com defesa em profundidade (path traversal, binário e teto de segurança).
 9. Reconciliar o estado dos arquivos cadastrados no banco de dados com o disco ao abrir o repositório, devolvendo resumo numérico.
10. Gravar o carimbo de última sincronização (updateLastSyncAt) delegando ao banco.
11. Preencher hashes ausentes de arquivos legados via backfillContentHashes.
12. Curar status 'modified' obsoleto de volta para 'indexed' quando o conteúdo do disco corresponde ao hash indexado (markFileIndexed).

Mapa de Relacionamentos do Script

1. repository-scanner.ts
   - Tipo: Dependência Direta
   - Relação: Consome scanRepository para descobrir arquivos.
   - Criticidade: Alta

2. structure-reader.ts
   - Tipo: Dependência Direta
   - Relação: Consome readStructure para extrair elementos.
   - Criticidade: Alta

3. repository-database.ts
   - Tipo: Dependência Direta
   - Relação: Consome operações CRUD do contrato RepositoryRepository.
   - Criticidade: Alta

4. code-map-service.ts
   - Tipo: Dependência Inversa
   - Relação: Consumirá as operações de alto nível expostas por este módulo.
   - Criticidade: Alta

5. telemetry-service.ts
   - Tipo: Dependência Direta
   - Relação: Registra indexação completa e reindexação seletiva (CODE_MAP).
   - Criticidade: Alta

 Invariantes do Script

 1. O Repository Model nunca parseia código diretamente — delega ao Structure Reader.
 2. O Repository Model nunca acessa SQLite diretamente — delega ao Repository Database.
 3. O fileId do CodeMapFile é gerado deterministicamente: hash(repositoryId + relativePath).
 4. Relacionamentos cross-file são resolvidos apenas quando o target existe no repositório.
 5. Referências não resolvidas (classe base inexistente, interface inexistente, import externo) são descartadas silenciosamente.
 6. O modelo em memória é reconstruído a cada indexação completa — não há cache de estado entre indexações.
 7. O Repository Model não emite eventos — isso é responsabilidade do Synchronizer.
 8. O registro do repositório é sempre persistido antes de qualquer arquivo ou relacionamento — a chave estrangeira files.repository_id → repositories.id exige essa ordem.
 9. O recorte de trecho nunca excede 300 linhas — elementos maiores são truncados com flag `truncated`.
 10. A leitura de arquivo inteiro nunca escapa do repoPath — path traversal é rejeitada.
 11. Conteúdo binário nunca é retornado como texto — arquivos binários retornam null.
 12. Arquivos acima de 2 MB são truncados com flag `truncated` — nunca retornados integralmente.
 13. O `mtime` gravado em `updateFileContent` deve ser o tempo real de modificação do arquivo no disco em milissegundos (`Math.floor(stat.mtimeMs)`).
 14. A reconciliação com o disco (reconcileWithDisk) deve tratar exceções individualmente por arquivo para que falhas em um arquivo não abortem o processo.
 15. A reindexação seletiva (updateFileContent) deve carregar os dados de todo o repositório para re-resolver as conexões cross-file mantendo o grafo íntegro.
 16. A indexação completa (indexRepository) grava tanto lastIndexedAt quanto lastSyncAt ao concluir com sucesso.
 17. A telemetria é puramente aditiva — logs e contadores nunca alteram o resultado nem o fluxo de indexação/reindexação.
 18. O hash SHA-256 (contentHash) é calculado sobre o conteúdo UTF-8 exato do arquivo no disco durante a indexação e reindexação.
 19. updateFileMetadata nunca muda o status do arquivo — preserva o status existente para não interferir com a fila de reindexação.
 20. A reconciliação de abertura (reconcileWithDisk) usa hash SHA-256 como prova de conteúdo, executando autocura de metadados quando o hash for igual e marcando arquivos legados (sem hash) como 'modified'.
 21. Verificar integridade do Code Map com descoberta, reparação e revalidação.
 22. O verifyIntegrity nunca modifica o estado do Code Map a menos que autoRepair seja true.
 23. Um arquivo só pode permanecer 'modified' enquanto existir divergência de conteúdo confirmada ou alteração ainda não verificada; a reconciliação cura o status quando o conteúdo corresponde ao índice.

24. Quando o verifyIntegrity recebe issues pré-descobertas válidas com autoRepair, ele pula a autocura (Fase 0) e a descoberta (Fase 1) e executa diretamente a reparação cirúrgica sobre essas issues.

--- FIM ARQUITETURA DO SCRIPT ---
*/

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
import { scanRepository } from './repository-scanner'
import { readStructure } from './structure-reader'
import { getLanguageForExtension } from './language-adapter'
import { createRepositoryDatabase, closeRepositoryDatabase } from './repository-database'
import type { RepositoryRepository } from './repository-repository'
import { telemetryService } from './telemetry-service'

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

  constructor(repoPath: string) {
    this.repoPath = repoPath.replace(/\\/g, '/').replace(/\/$/, '')
    this.repositoryId = this.generateRepositoryId(this.repoPath)
    this.db = createRepositoryDatabase(this.repoPath)
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

  /**
   * Calcula o SHA-256 do conteúdo do arquivo.
   * Retorna hash hexadecimal de 64 caracteres.
   */
  private calculateContentHash(content: string): string {
    return createHash('sha256').update(content, 'utf-8').digest('hex')
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

  /**
   * Reconcilia os arquivos armazenados no banco de dados com o estado atual no disco.
   * Usa o hash SHA-256 como prova de conteúdo para evitar falsos positivos por mtime/size.
   * Marca arquivos alterados como 'modified' e remove do banco os que foram deletados.
   * Executa autocura de mtime/size quando o hash é idêntico.
   * Devolve um resumo: { checked, markedModified, removed }.
   */
  /**
   * Reconcilia os arquivos cadastrados no banco de dados com o disco ao abrir o repositório.
   *
   * Algoritmo autocurativo:
   * 1. Arquivo não existe no disco -> exclui do banco.
   * 2. Arquivo sem hash (legado) -> marca como 'modified' para reindexação.
   * 3. Arquivo com status 'indexed':
   *    - Caminho rápido: se mtime e size forem iguais ao índice, NÃO lê o disco.
   *    - Se diferirem, lê e compara SHA-256. Se igual -> autocura mtime/size. Se diferente -> marca 'modified'.
   * 4. Arquivo com status 'modified':
   *    - Hash obrigatório (sem atalho de stat). Lê e compara SHA-256 com o índice.
   *    - Se igual -> cura o status para 'indexed', atualiza mtime/size, e incrementa healed.
   *    - Se diferente ou erro de leitura -> permanece 'modified'.
   *
   * @returns Resumo numérico: { checked, markedModified, removed, healed }.
   */
  async reconcileWithDisk(
    correlationId?: string
  ): Promise<{ checked: number; markedModified: number; removed: number; healed: number }> {
    const cid = correlationId ?? telemetryService.startOperation('RECONCILE_DISK')
    const startedAt = Date.now()
    try {
      const dbFiles = this.db.getFilesByRepository(this.repositoryId)
      telemetryService.log(cid, 'CODE_MAP', 'RECONCILE_STARTED', { checked: dbFiles.length })
      let markedModified = 0
      let removed = 0
      let healed = 0

      for (const file of dbFiles) {
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

          // Arquivo legado sem hash → marca como modified para forçar reindexação
          if (!file.contentHash) {
            this.db.updateFileStatus(file.id, 'modified')
            markedModified++
            telemetryService.log(cid, 'CODE_MAP', 'RECONCILE_LEGACY_MODIFIED', { relativePath: file.relativePath })
            continue
          }

          if (file.status === 'indexed') {
            // Caminho rápido: se mtime e size coincidem, não lê o arquivo do disco
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
              // Conteúdo divergiu (ou erro de leitura) -> indexed → modified
              this.db.updateFileStatus(file.id, 'modified')
              markedModified++
              telemetryService.log(cid, 'CODE_MAP', 'RECONCILE_INDEXED_DIVERGED', { relativePath: file.relativePath })
            }
          } else if (file.status === 'modified') {
            // Hash obrigatório para arquivos com status 'modified' (sem caminho rápido de stat)
            const check = await this.verifyContentMatches(fullPath, file.contentHash)
            if (check.matches) {
              // Conteúdo idêntico ao índice -> cura o status para 'indexed' e atualiza mtime/size
              this.updateFileMetadata(file.id, { mtime: diskMtime, sizeBytes: diskSize })
              this.db.updateFileStatus(file.id, 'indexed')
              healed++
              telemetryService.log(cid, 'CODE_MAP', 'RECONCILE_STALE_HEALED', { relativePath: file.relativePath })
            } else {
              // Conteúdo continua divergente (ou erro de leitura) -> permanece 'modified'
              telemetryService.log(cid, 'CODE_MAP', 'RECONCILE_MODIFIED_STILL_DIVERGED', { relativePath: file.relativePath })
            }
          } else {
            try {
              const diskContent = await readFile(fullPath, 'utf-8')
              const diskHash = this.calculateContentHash(diskContent)

              if (diskHash === file.contentHash) {
                if (file.mtime !== diskMtime || file.sizeBytes !== diskSize) {
                  this.updateFileMetadata(file.id, { mtime: diskMtime, sizeBytes: diskSize })
                }
              } else {
                this.db.updateFileStatus(file.id, 'modified')
                markedModified++
              }
            } catch {
              this.db.updateFileStatus(file.id, 'modified')
              markedModified++
            }
          }
        } catch (err) {
          console.error(`[RepositoryModel] Erro ao reconciliar arquivo "${file.relativePath}":`, err)
        }
      }

      telemetryService.log(cid, 'CODE_MAP', 'RECONCILE_COMPLETED', {
        checked: dbFiles.length,
        markedModified,
        removed,
        healed,
        durationMs: Date.now() - startedAt
      })

      return { checked: dbFiles.length, markedModified, removed, healed }
    } catch (err) {
      telemetryService.logError(cid, 'CODE_MAP', 'RECONCILE_FAILED', {
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
    const cid = correlationId ?? telemetryService.startOperation('BACKFILL_HASHES')
    const startedAt = Date.now()

    telemetryService.log(cid, 'CODE_MAP', 'BACKFILL_STARTED')

    const dbFiles = this.db.getFilesByRepository(this.repositoryId)
    const legacyFiles = dbFiles.filter((f) => !f.contentHash)

    if (legacyFiles.length === 0) {
      telemetryService.log(cid, 'CODE_MAP', 'BACKFILL_COMPLETED', {
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

    // BUGFIX: o registro do repositório é persistido ANTES de qualquer arquivo, pois a tabela
    // `files` (e, por extensão, `elements` e `relationships`) possui chave estrangeira para
    // `repositories.id` e o SQLite roda com foreign-key enforcement ativo. Persistir arquivos
    // primeiro faz o banco rejeitá-los com "FOREIGN KEY constraint failed" na primeira
    // indexação, já que o repositório ainda não estava cadastrado.
    // O lastIndexedAt é deixado como null aqui e preenchido apenas ao final da indexação,
    // garantindo que falhas parciais não marquem o repositório como "indexado".
    const repoName = basename(this.repoPath)
    const repositoryRecord: CodeMapRepository = {
      id: this.repositoryId,
      path: this.repoPath,
      name: repoName,
      modelVersion: 1,
      lastIndexedAt: null
    }

    this.db.saveRepository(repositoryRecord)

    // Limpa dados anteriores do repositório para indexação completa limpa
    this.db.deleteAllFiles(this.repositoryId)

    const allElements: CodeMapElement[] = []
    const allElementInterfaces: Array<{ elementId: string; interfaceNames: string[] }> = []
    const allImportSources: ImportSourceEntry[] = []
    const allFiles: CodeMapFile[] = []
    let elementsExtractedCount = 0

    for (const scanned of scannedFiles) {
      const fileId = this.generateFileId(scanned.relativePath)
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
        relativePath: scanned.relativePath,
        language: scanned.language,
        extension: scanned.extension,
        lines,
        sizeBytes: scanned.sizeBytes,
        mtime: scanned.mtime,
        contentHash,
        status: 'indexed'
      }

      const structureResult = readStructure(
        this.repositoryId,
        scanned.relativePath,
        scanned.extension,
        content
      )

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
   * Referências não encontradas são ignoradas silenciosamente.
   */
  private resolveRelationships(
    elements: CodeMapElement[],
    elementInterfaces: Array<{ elementId: string; interfaceNames: string[] }>,
    importSources: ImportSourceEntry[],
    files: CodeMapFile[]
  ): CodeMapRelationship[] {
    const relationships: CodeMapRelationship[] = []

    // Indexa classes por nome simples (primeira ocorrência)
    const classesByName = new Map<string, CodeMapElement>()
    for (const elem of elements) {
      if (elem.kind === 'class' && elem.name && elem.name !== '(anonymous)') {
        if (!classesByName.has(elem.name)) {
          classesByName.set(elem.name, elem)
        }
      }
    }

    // Indexa interfaces por nome simples (primeira ocorrência)
    const interfacesByName = new Map<string, CodeMapElement>()
    for (const elem of elements) {
      if (elem.kind === 'interface' && elem.name && elem.name !== '(anonymous)') {
        if (!interfacesByName.has(elem.name)) {
          interfacesByName.set(elem.name, elem)
        }
      }
    }

    // Indexa arquivos por relativePath
    const filesByPath = new Map<string, CodeMapFile>()
    for (const f of files) {
      filesByPath.set(f.relativePath, f)
    }

    // i) Resolução de baseClass (extends)
    for (const elem of elements) {
      if (elem.kind === 'class' && elem.baseClass) {
        const targetClass = classesByName.get(elem.baseClass)
        if (targetClass && targetClass.id !== elem.id) {
          relationships.push({
            id: this.generateRelationshipId(elem.id, targetClass.id, 'extends'),
            repositoryId: this.repositoryId,
            sourceId: elem.id,
            targetId: targetClass.id,
            type: 'extends'
          })
        }
      }
    }

    // ii) Resolução de interfaceNames (implements)
    for (const entry of elementInterfaces) {
      for (const ifaceName of entry.interfaceNames) {
        const targetIface = interfacesByName.get(ifaceName)
        if (targetIface) {
          relationships.push({
            id: this.generateRelationshipId(entry.elementId, targetIface.id, 'implements'),
            repositoryId: this.repositoryId,
            sourceId: entry.elementId,
            targetId: targetIface.id,
            type: 'implements'
          })
        }
      }
    }

    // iii) Resolução de importSources (imports)
    for (const entry of importSources) {
      const targetRelativePath = this.resolveImportPath(
        entry.source,
        entry.importerRelativePath,
        filesByPath
      )
      if (targetRelativePath) {
        const targetFile = filesByPath.get(targetRelativePath)
        if (targetFile) {
          relationships.push({
            id: this.generateRelationshipId(entry.elementId, targetFile.id, 'imports'),
            repositoryId: this.repositoryId,
            sourceId: entry.elementId,
            targetId: targetFile.id,
            type: 'imports'
          })
        }
      }
    }

    return relationships
  }

  /**
   * Tenta resolver um import source relativo para o relativePath de um arquivo existente.
   * Retorna null para imports de pacotes externos ou caminhos não encontrados.
   */
  private resolveImportPath(
    source: string,
    importerRelativePath: string,
    filesByPath: Map<string, CodeMapFile>
  ): string | null {
    // Ignora imports de pacotes externos (não começam com . ou /)
    if (!source.startsWith('.') && !source.startsWith('/')) {
      return null
    }

    const importerDir = dirname(importerRelativePath)
    const resolvedBase = normalize(join(importerDir, source)).replace(/\\/g, '/')

    const candidates = [
      resolvedBase + '.ts',
      resolvedBase + '.tsx',
      resolvedBase + '/index.ts',
      resolvedBase + '/index.tsx'
    ]

    for (const candidate of candidates) {
      if (filesByPath.has(candidate)) {
        return candidate
      }
    }

    return null
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
    const fileId = this.generateFileId(relativePath)

    if (!existsSync(fullPath)) {
      const existingFile = this.db.getFileByPath(this.repositoryId, relativePath)
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
      relativePath,
      language,
      extension,
      lines,
      sizeBytes,
      mtime,
      contentHash,
      status: 'indexed'
    }

    const structureResult = readStructure(this.repositoryId, relativePath, extension, content)

    for (const element of structureResult.elements) {
      element.fileId = fileId
    }

    // Remove elementos e relacionamentos antigos desse arquivo
    this.db.deleteElementsByFile(fileId)
    this.db.deleteRelationshipsByFile(fileId)

    this.db.saveFile(fileRecord)
    this.db.saveElements(structureResult.elements)
    this.db.saveRelationships(structureResult.relationships) // contains
    this.db.saveElementInterfaces(structureResult.elementInterfaces)

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
      discovery = await this.discoverIntegrityIssues(cid, options.scanForUnexpectedFiles ?? true)
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

  private async discoverIntegrityIssues(correlationId: string, scanForUnexpectedFiles = true): Promise<{
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
          
          // Se mtime e size não mudaram, o hash provavelmente não mudou — pula leitura completa
          if (dbFile.mtime === diskMtime && dbFile.sizeBytes === diskSize) {
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
      // Relacionamentos 'contains' são intra-arquivo (source=element, target=element)
      // Relacionamentos cross-file (extends, implements, imports) usam element→element ou element→file
      const sourceValid = allElementIds.has(rel.sourceId)
      const targetValid = allElementIds.has(rel.targetId) || allFileIds.has(rel.targetId)
      
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

/** Fábrica conveniente para criar instâncias de RepositoryModel. */
export function createRepositoryModel(repoPath: string): RepositoryModel {
  return new RepositoryModel(repoPath)
}
