/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Gerenciar o ciclo de vida do Repository Model e do Synchronizer por repositório.
2. Expor operações de alto nível para os handlers IPC (indexar, sincronizar, consultar, verificar integridade, gerar escopo).
3. Manter cache de instâncias ativas por repoPath e serializar aberturas concorrentes.
4. Coordenar a reconciliação disco-vs-banco e o Watcher Bridge com o Synchronizer ao abrir um repositório.
5. Ser o único ponto de entrada para o Code Map — handlers IPC nunca acessam o Model ou Synchronizer diretamente.
6. Delegar recorte de trechos de código, leitura de arquivo integral e abertura no VS Code para o Model do repositório.
7. Gerar markdown do escopo (completo ou comprimido com o esqueleto do Repomix) para o arquivo âncora e seus relacionados, dependendo exclusivamente das portas CompressionPort (compressão) e ContentIdentityPort (hash SHA-256), composta no bootstrap.

Mapa de Relacionamentos do Script

1. repository-model.ts
   - Tipo: Dependência Direta
   - Relação: Cria e gerencia instâncias do Repository Model e executa a reconciliação com o disco.
   - Criticidade: Alta

2. repository-synchronizer.ts
   - Tipo: Dependência Direta
   - Relação: Cria e gerencia instâncias do Synchronizer.
   - Criticidade: Alta

3. watcher-bridge.ts
   - Tipo: Dependência Direta
   - Relação: Cria o bridge entre WatcherService e Event Bus e obtém a função de desassinatura.
   - Criticidade: Alta

4. watcher-service.ts
   - Tipo: Dependência Direta
   - Relação: Instância existente injetada no bootstrap.
   - Criticidade: Alta

5. code-map-handler.ts (Sprint 6)
   - Tipo: Dependência Inversa
   - Relação: Consumirá as operações expostas por este serviço.
   - Criticidade: Alta

6. compression-port.ts
   - Tipo: Contrato / Interface
   - Relação: Porta de compressão injetada via construtor; gera o esqueleto comprimido e detecta a falha total via COMPRESSION_TOTAL_FAILURE_MARKER (re-exportado).
   - Criticidade: Alta

7. content-identity-port.ts
   - Tipo: Contrato / Interface
   - Relação: Porta de identidade de conteúdo; o CodeMapService expõe getFileContentHash para que o bootstrap componha a implementação concreta.
   - Criticidade: Alta

Invariantes do Script

1. Apenas uma instância de Repository Model por repoPath pode existir simultaneamente.
2. O Synchronizer é criado junto com o Model e destruído junto com ele.
3. O Watcher Bridge é assinado junto com o Model e sua desassinatura executada ao fechar o repositório.
4. Operações de consulta nunca modificam o estado do modelo.
5. O serviço não conhece SQLite, Tree-sitter ou IPC — apenas orquestra componentes.
6. Handlers IPC nunca acessam o Model diretamente — toda operação passa por este serviço.
7. Aberturas concorrentes do mesmo repositório são serializadas usando um mapa de promessas pendentes limpo ao concluir.
8. Ao abrir um repositório, o backfill de hashes (backfillContentHashes) e a reconciliação com o disco (reconcileWithDisk) devem ser concluídos antes da liberação do repositório.
9. O markdown do escopo comprimido nunca pode ser retornado com success: true quando todos os arquivos falharam ou conteúdo vazio.
10. O cabeçalho do markdown de escopo (completo ou comprimido) é sempre construído pelo mesmo método privado — nunca duplicado.
11. O timer de varredura periódica é opcional e configurável por repositório.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { basename, extname } from 'path'
import type {
  CodeMapElement,
  CodeMapFile,
  CodeMapRelationship,
  CodeMapRepository,
  CodeMapSyncStatus,
  IntegrityCheckOptions
} from '../../shared/types'
import { RepositoryModel, type ElementSnippet, type FileContent } from './repository-model'
import { RepositorySynchronizer } from './repository-synchronizer'
import { createWatcherBridge } from './watcher-bridge'
import { WatcherService } from './watcher-service'
import { COMPRESSION_TOTAL_FAILURE_MARKER, type CompressionPort } from './compression-port'
import type { ContentIdentityPort } from './content-identity-port'

function formatTimestampForFilename(date: Date = new Date()): string {
  const pad = (num: number) => String(num).padStart(2, '0')
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())
  return `${year}-${month}-${day}_${hours}-${minutes}`
}

function sanitizeFilenamePart(part: string): string {
  return part.replace(/[/\\:*?"<>|]/g, '_')
}

interface CodeMapInstance {
  model: RepositoryModel
  synchronizer: RepositorySynchronizer
  unsubscribeWatcherBridge: () => void
}

const instances = new Map<string, CodeMapInstance>()

export class CodeMapService {
  private readonly watcherService: WatcherService
  private readonly compressionService: CompressionPort
  private readonly pendingOpenRequests = new Map<string, Promise<void>>()

  constructor(watcherService: WatcherService, compressionService: CompressionPort) {
    this.watcherService = watcherService
    this.compressionService = compressionService
  }

  /**
   * Resolve o contentHash de um arquivo do repositório sem I/O redundante de disco.
   * Retorna null se o repositório não estiver aberto ou o arquivo não constar no índice.
   * Consumido pela implementação concreta de ContentIdentityPort composta no bootstrap.
   */
  getFileContentHash(repoPath: string, relativePath: string): string | null {
    const normalizedPath = repoPath.replace(/\\/g, '/').replace(/\/$/, '')
    const instance = instances.get(normalizedPath)
    if (!instance) return null
    const file = instance.model.getFileByRelativePath(relativePath)
    return file?.contentHash ?? null
  }

  async openRepository(
    repoPath: string,
    options?: { periodicScanIntervalMs?: number }
  ): Promise<void> {
    const normalizedPath = repoPath.replace(/\\/g, '/').replace(/\/$/, '')
    if (instances.has(normalizedPath)) return

    const pending = this.pendingOpenRequests.get(normalizedPath)
    if (pending) return pending

    const openPromise = (async () => {
      try {
        const model = new RepositoryModel(normalizedPath)
        // Backfill de hashes ausentes (arquivos legados indexados antes da Sprint 2)
        // Deve rodar ANTES da reconciliação para que arquivos legados já tenham hash
        // quando reconcileWithDisk comparar disco vs. índice.
        await model.backfillContentHashes()
        await model.reconcileWithDisk()
        const repositoryId = model.getRepositoryId()
        const synchronizer = new RepositorySynchronizer(model, repositoryId, {
          periodicScanIntervalMs: options?.periodicScanIntervalMs
        })
        const unsubscribeWatcherBridge = createWatcherBridge(normalizedPath, this.watcherService)

        instances.set(normalizedPath, {
          model,
          synchronizer,
          unsubscribeWatcherBridge
        })
      } finally {
        this.pendingOpenRequests.delete(normalizedPath)
      }
    })()

    this.pendingOpenRequests.set(normalizedPath, openPromise)
    return openPromise
  }

  closeRepository(repoPath: string): void {
    const normalizedPath = repoPath.replace(/\\/g, '/').replace(/\/$/, '')
    const instance = instances.get(normalizedPath)
    if (!instance) return

    instance.synchronizer.dispose()
    instance.model.close()
    instance.unsubscribeWatcherBridge()

    instances.delete(normalizedPath)
  }

  async indexRepository(repoPath: string): Promise<{ filesIndexed: number; elementsExtracted: number }> {
    const instance = this.ensureInstance(repoPath)
    return instance.model.indexRepository()
  }

  async synchronizeModified(repoPath: string): Promise<{ filesUpdated: number; errors: string[] }> {
    const instance = this.ensureInstance(repoPath)
    return instance.synchronizer.synchronizeModified()
  }

  getRepository(repoPath: string): CodeMapRepository | null {
    const instance = this.ensureInstance(repoPath)
    return instance.model.getRepository()
  }

  getFiles(repoPath: string): CodeMapFile[] {
    const instance = this.ensureInstance(repoPath)
    return instance.model.getFiles()
  }

  getElements(repoPath: string): CodeMapElement[] {
    const instance = this.ensureInstance(repoPath)
    return instance.model.getElementsByRepository()
  }

  getRelationships(repoPath: string): CodeMapRelationship[] {
    const instance = this.ensureInstance(repoPath)
    return instance.model.getRelationships()
  }

  getSyncStatus(repoPath: string): CodeMapSyncStatus {
    const instance = this.ensureInstance(repoPath)
    return instance.model.getSyncStatus()
  }

  getModifiedFilesCount(repoPath: string): number {
    const normalizedPath = repoPath.replace(/\\/g, '/').replace(/\/$/, '')
    const instance = instances.get(normalizedPath)
    if (!instance) return 0
    return instance.synchronizer.getModifiedFilesCount()
  }

  /**
   * Verifica integridade completa do Code Map: hashes, elementos órfãos, relacionamentos inválidos.
   * Opcionalmente executa autocorreção (reindexação de arquivos divergentes, indexação de arquivos inesperados).
   *
   * @param repoPath Caminho do repositório.
   * @param options.autoRepair Se true, executa reparação automática após descoberta.
   * @returns Relatório estruturado com inconsistências e resultado da reparação (se executada).
   */
  async verifyIntegrity(
    repoPath: string,
    options: IntegrityCheckOptions = {}
  ): Promise<import('../../shared/types').IntegrityCheckResult> {
    const instance = this.ensureInstance(repoPath)
    const result = await instance.model.verifyIntegrity(options)

    // Sempre reconcilia os pendentes do sincronizador com o banco após verificação,
    // para que ele reflita a cura de status e remoções de forma sincronizada.
    instance.synchronizer.reconcileMemoryWithDatabase()

    return result
  }

  /**
   * Deriva a lista de arquivos do escopo (âncora + relacionados ordenados por relativePath).
   */
  private getScopeFiles(
    repoPath: string,
    anchorFileId: string
  ): { anchorFile: CodeMapFile; relatedFiles: CodeMapFile[] } | null {
    const instance = this.ensureInstance(repoPath)
    const model = instance.model

    const files = model.getFiles()
    const anchorFile = files.find((f) => f.id === anchorFileId)
    if (!anchorFile) return null

    const elements = model.getElementsByRepository()
    const relationships = model.getRelationships()

    // Deriva relacionamentos de importação (imports + importedBy)
    const fileIds = new Set(files.map((f) => f.id))
    const elementFileIds = new Map(elements.map((e) => [e.id, e.fileId]))

    const importsMap = new Map<string, Set<string>>()
    const importedByMap = new Map<string, Set<string>>()

    for (const rel of relationships) {
      if (rel.type !== 'imports') continue
      const sourceFileId = elementFileIds.get(rel.sourceId)
      const targetFileId = rel.targetId

      if (!sourceFileId || !fileIds.has(sourceFileId) || !fileIds.has(targetFileId)) continue
      if (sourceFileId === targetFileId) continue

      if (!importsMap.has(sourceFileId)) importsMap.set(sourceFileId, new Set())
      importsMap.get(sourceFileId)!.add(targetFileId)

      if (!importedByMap.has(targetFileId)) importedByMap.set(targetFileId, new Set())
      importedByMap.get(targetFileId)!.add(sourceFileId)
    }

    const relatedIds = new Set<string>()
    const imported = importsMap.get(anchorFileId)
    if (imported) {
      for (const id of imported) relatedIds.add(id)
    }
    const importers = importedByMap.get(anchorFileId)
    if (importers) {
      for (const id of importers) relatedIds.add(id)
    }

    const relatedFiles = files
      .filter((f) => relatedIds.has(f.id) && f.id !== anchorFileId)
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))

    return { anchorFile, relatedFiles }
  }

  /**
   * Monta o cabeçalho comum do markdown de escopo (completo ou comprimido).
   */
  private buildScopeHeader(
    anchorFile: CodeMapFile,
    relatedFiles: CodeMapFile[],
    projectName: string,
    titlePrefix: string
  ): string[] {
    return [
      `# ${titlePrefix}: ${anchorFile.relativePath}`,
      '',
      `- **Projeto:** ${projectName}`,
      `- **Arquivo Âncora:** \`${anchorFile.relativePath}\``,
      `- **Arquivos Relacionados:** ${relatedFiles.length} arquivo(s)`,
      '',
      '---',
      ''
    ]
  }

  /**
   * Gera o markdown completo do escopo (arquivo âncora + relacionados diretos)
   * e o nome-base do arquivo: escopo_<projeto>_<arquivo-âncora>_<AAAA-MM-DD_HH-MM>.
   * A extensão é derivada pelo canal de exportação (save-to-downloads) a partir do formato.
   */
  async generateScopeMarkdown(
    repoPath: string,
    anchorFileId: string
  ): Promise<{ success: boolean; markdown?: string; fileName?: string; error?: string }> {
    const instance = this.ensureInstance(repoPath)
    const model = instance.model

    const scope = this.getScopeFiles(repoPath, anchorFileId)
    if (!scope) {
      return { success: false, error: 'Arquivo âncora não encontrado no repositório' }
    }

    const { anchorFile, relatedFiles } = scope

    // Lê conteúdo do âncora
    const anchorContent = await model.getFileContent(anchorFile.relativePath)
    if (!anchorContent) {
      return { success: false, error: `Não foi possível ler o arquivo âncora: ${anchorFile.relativePath}` }
    }

    const projectName = basename(model.getRepoPath())
    const anchorBaseName = basename(anchorFile.relativePath, extname(anchorFile.relativePath))
    const timestampStr = formatTimestampForFilename()
    const fileName = `escopo_${sanitizeFilenamePart(projectName)}_${sanitizeFilenamePart(anchorBaseName)}_${timestampStr}`

    const mdLines: string[] = [...this.buildScopeHeader(anchorFile, relatedFiles, projectName, 'Escopo')]
    mdLines.push(`## Arquivo Âncora: \`${anchorFile.relativePath}\``)
    mdLines.push('')
    mdLines.push(`\`\`\`${anchorFile.language}`)
    mdLines.push(anchorContent.content)
    mdLines.push('```')
    if (anchorContent.truncated) {
      mdLines.push('')
      mdLines.push('> ⚠️ *Conteúdo truncado por exceder o limite de segurança (2MB).*')
    }
    mdLines.push('')

    if (relatedFiles.length > 0) {
      mdLines.push('---')
      mdLines.push('')
      mdLines.push('## Arquivos Relacionados')
      mdLines.push('')

      for (const relFile of relatedFiles) {
        const relContent = await model.getFileContent(relFile.relativePath)
        mdLines.push(`### \`${relFile.relativePath}\``)
        mdLines.push('')
        if (relContent) {
          mdLines.push(`\`\`\`${relFile.language}`)
          mdLines.push(relContent.content)
          mdLines.push('```')
          if (relContent.truncated) {
            mdLines.push('')
            mdLines.push('> ⚠️ *Conteúdo truncado por exceder o limite de segurança (2MB).*')
          }
        } else {
          mdLines.push('*Falha ao ler conteúdo do arquivo.*')
        }
        mdLines.push('')
      }
    }

    return {
      success: true,
      markdown: mdLines.join('\n'),
      fileName
    }
  }

  /**
   * Gera o markdown do escopo comprimido (esqueleto estrutural dos mesmos arquivos do escopo completo).
   * Nome-base padronizado: escopo-comprimido_<projeto>_<arquivo-âncora>_<AAAA-MM-DD_HH-MM>.
   * A extensão é derivada pelo canal de exportação (save-to-downloads) a partir do formato.
   */
  async generateCompressedScopeMarkdown(
    repoPath: string,
    anchorFileId: string
  ): Promise<{ success: boolean; markdown?: string; fileName?: string; error?: string }> {
    const instance = this.ensureInstance(repoPath)
    const model = instance.model

    const scope = this.getScopeFiles(repoPath, anchorFileId)
    if (!scope) {
      return { success: false, error: 'Arquivo âncora não encontrado no repositório' }
    }

    const { anchorFile, relatedFiles } = scope
    const selectedRelativePaths = [anchorFile.relativePath, ...relatedFiles.map((f) => f.relativePath)]

    let compressedContent = ''
    try {
      compressedContent = await this.compressionService.generateCompressionMarkdown(repoPath, selectedRelativePaths)
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }

    // BUGFIX: A porta de compressão pode retornar apenas mensagens de erro em vez de lançar exceção.
    // Quando todos os arquivos falham, o retorno é apenas o cabeçalho de erro sem conteúdo útil.
    // Falhas parciais (com ⚠️) ainda contêm conteúdo válido e não devem ser rejeitadas.
    // Conteúdo vazio (selectedFiles vazio) também não deve gerar markdown sem corpo.
    // A detecção usa a constante exportada pela porta (fonte única de verdade em compression-constants).
    if (compressedContent.startsWith(COMPRESSION_TOTAL_FAILURE_MARKER) || compressedContent.trim() === '') {
      return { success: false, error: 'Falha ao comprimir todos os arquivos do escopo' }
    }

    const projectName = basename(model.getRepoPath())
    const anchorBaseName = basename(anchorFile.relativePath, extname(anchorFile.relativePath))
    const timestampStr = formatTimestampForFilename()
    const fileName = `escopo-comprimido_${sanitizeFilenamePart(projectName)}_${sanitizeFilenamePart(anchorBaseName)}_${timestampStr}`

    const mdLines: string[] = [...this.buildScopeHeader(anchorFile, relatedFiles, projectName, 'Escopo Comprimido')]
    mdLines.push(compressedContent)

    return {
      success: true,
      markdown: mdLines.join('\n'),
      fileName
    }
  }

  getElementCodeSnippet(repoPath: string, elementId: string): Promise<ElementSnippet | null> {
    const instance = this.ensureInstance(repoPath)
    return instance.model.getElementCodeSnippet(elementId)
  }

  getFileContent(repoPath: string, relativePath: string): Promise<FileContent | null> {
    const instance = this.ensureInstance(repoPath)
    return instance.model.getFileContent(relativePath)
  }

  private ensureInstance(repoPath: string): CodeMapInstance {
    const normalizedPath = repoPath.replace(/\\/g, '/').replace(/\/$/, '')
    let instance = instances.get(normalizedPath)
    if (!instance) {
      this.openRepository(normalizedPath)
      instance = instances.get(normalizedPath)!
    }
    return instance
  }

  closeAll(): void {
    for (const repoPath of Array.from(instances.keys())) {
      this.closeRepository(repoPath)
    }
  }
}

let codeMapServiceInstance: CodeMapService | null = null

export function getCodeMapService(
  watcherService: WatcherService,
  compressionService: CompressionPort
): CodeMapService {
  if (!codeMapServiceInstance) {
    codeMapServiceInstance = new CodeMapService(watcherService, compressionService)
  }
  return codeMapServiceInstance
}

export function closeCodeMapService(): void {
  if (codeMapServiceInstance) {
    codeMapServiceInstance.closeAll()
    codeMapServiceInstance = null
  }
}
