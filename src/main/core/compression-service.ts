/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Orquestrar a pipeline de compressão de arquivos selecionados, integrando resolução de perfil, cache, execução e montagem do documento.
2. Validar defensivamente os parâmetros de entrada (retornando erro claro para lista de arquivos vazia).
3. Gerenciar o fluxo de identificação de cache em disco através de CompressionCache e CompressionContentIdentity.
4. Delegar a execução de arquivos não cacheados ao CompressionExecutor e atualizar o cache com os novos resultados.
5. Delegar a montagem do documento Markdown final ao assembleCompressionDocument, incorporando seções de Context Enrichment.
6. Aceitar injeção opcional de RepomixAdapter, ContentIdentityPort, CompressionCache, CompressionExecutor e CompressionServiceOptions para viabilizar testes determinísticos sem CLI real.
7. Decidir o caminho arquitetural via resolveCompressionPath e, para markdown/xml, delegar ao Direct Output (sem cache por arquivo).

Mapa de Relacionamentos do Script

1. RepomixAdapter
   - Tipo: Dependência Direta
   - Relação: Injetado opcionalmente no construtor e repassado ao CompressionExecutor.
   - Criticidade: Alta

2. repomix-request.ts
   - Tipo: Contrato / Interface
   - Relação: Consome o tipo RepomixRequest para parametrizar execuções de compressão.
   - Criticidade: Alta

3. repomix-arguments-builder.ts
   - Tipo: Dependência Direta
   - Relação: Consome buildRepomixRequest para construir o contrato RepomixRequest.
   - Criticidade: Alta

4. effective-profile.ts
   - Tipo: Dependência Direta
   - Relação: Consome resolveEffectiveProfile para obtenção do EffectiveProfile ativo.
   - Criticidade: Alta

5. compression-profile.ts
   - Tipo: Dependência Direta
   - Relação: Consome DEFAULT_PROFILE, normalizeCompressionProfile, computeProfileHash e resolveCompressionPath (decisão de caminho).
   - Criticidade: Alta

6. compression-cache.ts
   - Tipo: Dependência Direta
   - Relação: Consome CompressionCache para gerenciar o armazenamento e recenticidade LRU das entradas comprimidas.
   - Criticidade: Alta

7. compression-content-identity.ts
   - Tipo: Dependência Direta
   - Relação: Consome resolveContentIdentity para verificação de fast path e resolução de hash.
   - Criticidade: Alta

8. compression-executor.ts
   - Tipo: Dependência Direta
   - Relação: Consome CompressionExecutor para execução concorrente, lotes e fallback de arquivos uncached, e executeDirectOutput para o caminho Direct Output.
   - Criticidade: Alta

9. compression-document-assembler.ts
   - Tipo: Dependência Direta
   - Relação: Consome assembleCompressionDocument para estruturação do documento Markdown final.
   - Criticidade: Alta

10. context-enrichment-service.ts
    - Tipo: Dependência Direta
    - Relação: Consome buildEnrichmentSections para gerar as seções de enriquecimento.
    - Criticidade: Alta

11. code-map-service.ts
    - Tipo: Dependência Inversa
    - Relação: Consome CompressionService via a porta CompressionPort; não importa mais este serviço nem ContentIdentityPort. COMPRESSION_TOTAL_FAILURE_MARKER é consumida via compression-port.ts.
    - Criticidade: Alta

11.1. compression-port.ts
    - Tipo: Contrato / Interface
    - Relação: CompressionService implementa esta porta, formalizando o contrato consumido pelo CodeMapService.
    - Criticidade: Alta

11.2. content-identity-port.ts
    - Tipo: Contrato / Interface
    - Relação: CompressionService depende desta porta (via construtor) para resolução do hash SHA-256.
    - Criticidade: Alta

12. git-handler.ts
    - Tipo: Dependência Inversa
    - Relação: Instância injetada via construtor pelo bootstrap (main.ts) para gerar o Markdown de compressão.
    - Criticidade: Alta

13. compression-constants.ts
    - Tipo: Dependência Direta
    - Relação: Consome COMPRESSION_VERSION e COMPRESSION_TOTAL_FAILURE_MARKER para composição da chave de cache e validação de entrada vazia.
    - Criticidade: Alta

Invariantes do Script

1. O serviço é um orquestrador puro sem lógica inline de batch, inFlight, fallback ou formatação de Markdown.
2. Chamada com selectedFiles vazio retorna COMPRESSION_TOTAL_FAILURE_MARKER imediatamente sem I/O ou spawn.
3. Cache hit por mtime+size é O(1) — zero I/O de conteúdo, zero hash.
4. O documento final é sempre montado na ordem estrita do array selectedFiles original.
5. Invalidação automática de cache é garantida pelo COMPRESSION_VERSION e pelo profileHash na cacheKey.
6. markdown/xml/json (Direct Output) não usam cache por arquivo nem o inFlight do Core; falha total retorna COMPRESSION_TOTAL_FAILURE_MARKER. O envelope do Direct Output é consciente do formato: markdown recebe envelope completo (com enrichment); xml/json são passthrough puro do Repomix (sem envelope, sem enrichment). plain é documento-esqueleto do Core (code map).
7. Um OutputFormat inválido em runtime é sanitizado para 'plain' (Compression Core) como defesa em profundidade.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { stat } from 'fs/promises'
import { basename, join } from 'path'
import { RepomixAdapter } from './repomix-adapter'
import {
  DEFAULT_PROFILE,
  normalizeCompressionProfile,
  computeProfileHash,
  resolveCompressionPath
} from './compression-profile'
import { resolveEffectiveProfile } from './effective-profile'
import type { RepomixRequest } from './repomix-request'
import { buildRepomixRequest } from './repomix-arguments-builder'
import { buildEnrichmentSections } from './context-enrichment-service'
import { COMPRESSION_VERSION, COMPRESSION_TOTAL_FAILURE_MARKER } from './compression-constants'
import { CompressionCache, CacheEntry } from './compression-cache'
import { resolveContentIdentity } from './compression-content-identity'
import { CompressionExecutor, ExecutionResult } from './compression-executor'
import { assembleCompressionDocument } from './compression-document-assembler'
import type { CompressionProfile, OutputFormat, ContextEnrichment } from '../../shared/types'
import type { CompressionPort } from './compression-port'
import type { ContentIdentityPort } from './content-identity-port'

// Re-exportação para contratos externos e retrocompatibilidade
export type { CacheEntry }

// Limite máximo padrão de bytes no cache em memória (50 MB)
export const MAX_CACHE_BYTES = 50 * 1024 * 1024

// Limite secundário padrão de quantidade de entradas (defesa em profundidade)
export const MAX_CACHE_ENTRIES = 5000

export interface CompressionServiceOptions {
  maxCacheBytes?: number
  maxCacheEntries?: number
}

/** Formatos de transporte válidos conhecidos pelo serviço (defesa em profundidade). */
const VALID_OUTPUT_FORMATS: readonly OutputFormat[] = ['plain', 'json', 'markdown', 'xml']

interface CacheAnalysisResult {
  results: Record<string, string>
  uncachedFiles: string[]
  fileHashes: Record<string, string>
  fileStats: Record<string, { mtimeMs: number; size: number }>
  finalErrors: string[]
  errorReasons: Record<string, string>
}

export class CompressionService implements CompressionPort {
  private readonly cache: CompressionCache
  private readonly executor: CompressionExecutor
  private readonly hashProvider?: ContentIdentityPort

  constructor(
    adapter?: RepomixAdapter,
    hashProvider?: ContentIdentityPort,
    options?: CompressionServiceOptions,
    cache?: CompressionCache,
    executor?: CompressionExecutor
  ) {
    this.cache = cache ?? new CompressionCache(
      options?.maxCacheBytes ?? MAX_CACHE_BYTES,
      options?.maxCacheEntries ?? MAX_CACHE_ENTRIES
    )
    this.executor = executor ?? new CompressionExecutor(adapter ?? new RepomixAdapter())
    this.hashProvider = hashProvider
  }

  /**
   * Normaliza um caminho para compor a chave de cache.
   */
  private normalizeCachePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+$/, '')
  }

  /**
   * Compõe a chave de cache de forma estável.
   */
  private buildCacheKey(repoPath: string, relativePath: string, profileHash: string): string {
    return `${this.normalizeCachePath(repoPath)}::${this.normalizeCachePath(relativePath)}::${COMPRESSION_VERSION}::${profileHash}`
  }

  /**
   * Executa a análise de cache com Fast Path O(1) e verificação de contentHash.
   */
  private async analyzeCache(
    repoPath: string,
    selectedFiles: string[],
    profileHash: string
  ): Promise<CacheAnalysisResult> {
    const results: Record<string, string> = {}
    const uncachedFiles: string[] = []
    const finalErrors: string[] = []
    const errorReasons: Record<string, string> = {}
    const fileStats: Record<string, { mtimeMs: number; size: number }> = {}
    const fileHashes: Record<string, string> = {}

    for (const relativePath of selectedFiles) {
      const fullPath = join(repoPath, relativePath)
      let currentMtime: number
      let currentSize: number

      try {
        const fileStat = await stat(fullPath)
        currentMtime = fileStat.mtimeMs
        currentSize = fileStat.size
        fileStats[relativePath] = { mtimeMs: currentMtime, size: currentSize }
      } catch {
        finalErrors.push(relativePath)
        errorReasons[relativePath] = 'arquivo não encontrado no disco'
        continue
      }

      const cacheKey = this.buildCacheKey(repoPath, relativePath, profileHash)
      const cached = this.cache.get(cacheKey)

      const identity = await resolveContentIdentity(
        repoPath,
        relativePath,
        fullPath,
        cached,
        { mtimeMs: currentMtime, size: currentSize },
        this.hashProvider
      )

      if (identity.fastPathHit && identity.cachedContent !== null) {
        results[relativePath] = identity.cachedContent
        this.cache.touch(cacheKey)
        continue
      }

      if (!identity.hash) {
        uncachedFiles.push(relativePath)
        continue
      }

      fileHashes[relativePath] = identity.hash

      if (identity.cachedContent !== null) {
        results[relativePath] = identity.cachedContent
        if (cached) {
          cached.mtime = currentMtime
          cached.size = currentSize
        }
        this.cache.touch(cacheKey)
        continue
      }

      // MISS real: conteúdo novo ou não cacheado
      uncachedFiles.push(relativePath)
    }

    return {
      results,
      uncachedFiles,
      fileHashes,
      fileStats,
      finalErrors,
      errorReasons
    }
  }

  /**
   * Atualiza o cache com as compressões bem-sucedidas do executor.
   */
  private updateCacheWithResults(
    repoPath: string,
    executionResult: ExecutionResult,
    fileHashes: Record<string, string>,
    fileStats: Record<string, { mtimeMs: number; size: number }>,
    profileHash: string
  ): void {
    for (const [relativePath, content] of Object.entries(executionResult.results)) {
      if (content && content.trim().length > 0) {
        const st = fileStats[relativePath]
        const hash = fileHashes[relativePath] || ''
        this.cache.set(this.buildCacheKey(repoPath, relativePath, profileHash), {
          mtime: st?.mtimeMs ?? Date.now(),
          size: st?.size ?? 0,
          contentHash: hash,
          compressedContent: content,
          sizeBytes: Buffer.byteLength(content, 'utf-8'),
          lastAccessed: Date.now()
        })
      }
    }
  }

  async generateCompressionMarkdown(
    repoPath: string,
    selectedFiles: string[],
    profile?: CompressionProfile,
    outputFormat: OutputFormat = 'plain',
    enrichment?: ContextEnrichment
  ): Promise<string> {
    // 1. Validação defensiva (ME-1)
    if (selectedFiles.length === 0) {
      return `${COMPRESSION_TOTAL_FAILURE_MARKER}\n\nNenhum arquivo selecionado para compressão.`
    }

    // 2. Normalização de profile (com sanitização defensiva do formato de transporte)
    const safeOutputFormat: OutputFormat =
      (VALID_OUTPUT_FORMATS as readonly string[]).includes(outputFormat) ? outputFormat : 'plain'
    const normalizedProfile = normalizeCompressionProfile(profile ?? DEFAULT_PROFILE)
    const effectiveProfile = resolveEffectiveProfile(normalizedProfile, safeOutputFormat)
    const profileHash = computeProfileHash(effectiveProfile)
    const request = buildRepomixRequest(repoPath, selectedFiles, effectiveProfile, safeOutputFormat)

    // 2b. Decisão de caminho: Direct Output (markdown/xml) não usa cache por arquivo.
    if (resolveCompressionPath(safeOutputFormat) === 'direct-output') {
      return this.generateDirectOutput(repoPath, request, enrichment)
    }

    // 3. Análise de cache (Etapa 1)
    const { results, uncachedFiles, fileHashes, fileStats, finalErrors, errorReasons } =
      await this.analyzeCache(repoPath, selectedFiles, profileHash)

    // 4. Execução de arquivos uncached (Etapa 2 — delegada ao CompressionExecutor)
    if (uncachedFiles.length > 0) {
      const executionResult = await this.executor.execute(
        repoPath,
        uncachedFiles,
        fileHashes,
        fileStats,
        request,
        profileHash
      )

      // Atualiza o cache com as novas compressões
      this.updateCacheWithResults(repoPath, executionResult, fileHashes, fileStats, profileHash)

      // Consolida resultados e erros
      Object.assign(results, executionResult.results)
      finalErrors.push(...executionResult.errors)
      Object.assign(errorReasons, executionResult.errorReasons)
    }

    // 5. Context Enrichment (aplicado exclusivamente na montagem final)
    const enrichmentSections = await buildEnrichmentSections(enrichment, repoPath)

    // 6. Montagem do documento (Etapa 3 — delegada ao assembleCompressionDocument)
    return assembleCompressionDocument({
      repoPath,
      selectedFiles,
      results,
      errors: finalErrors,
      errorReasons,
      enrichmentSections
    })
  }

  /**
   * Monta o documento do Direct Output de forma consciente do formato:
   * - markdown: envelope completo (cabeçalho, blockquote, enrichment pré-conteúdo,
   *   conteúdo do Repomix, enrichment pós-conteúdo).
   * - xml/json: passthrough puro do conteúdo do Repomix (sem envelope, sem enrichment).
   *   Injeta seções Markdown corromperia o documento nativo (XML/JSON válido).
   * - plain: defesa em profundidade (não deveria chegar aqui — cai para o Core);
   *   se por ventura chegar, loga aviso e aplica o envelope Markdown como fallback.
   *
   * Em falha total, retorna COMPRESSION_TOTAL_FAILURE_MARKER independente do formato.
   */
  private async generateDirectOutput(
    repoPath: string,
    request: RepomixRequest,
    enrichment?: ContextEnrichment
  ): Promise<string> {
    const { outputFormat } = request
    const result = await this.executor.executeDirectOutput(request)

    if (result.error || !result.content) {
      return `${COMPRESSION_TOTAL_FAILURE_MARKER}\n\n${result.error || 'Falha ao gerar Direct Output.'}`
    }

    // XML e JSON: passthrough puro — sem cabeçalho Markdown, sem blockquote, sem enrichment.
    // A ausência de enrichment aqui é LIMITAÇÃO atual de implementação; injetar seções
    // Markdown corromperia o documento nativo (XML/JSON válido produzido pelo Repomix).
    if (outputFormat === 'xml' || outputFormat === 'json') {
      console.log(`[CompressionService] direct-output: formato ${outputFormat}, passthrough sem envelope`)
      return result.content
    }

    // Defesa em profundidade: plain não deveria chegar ao Direct Output. Se chegar,
    // loga aviso e aplica o envelope Markdown como fallback (comportamento atual).
    if (outputFormat !== 'markdown') {
      console.warn(
        `[CompressionService] direct-output: formato inesperado "${outputFormat}" — aplicando envelope Markdown como fallback.`
      )
    }

    const enrichmentSections = await buildEnrichmentSections(enrichment, repoPath)
    const repoName = basename(repoPath) || 'Repository'
    const dateStr = new Date().toLocaleString('pt-BR')

    let markdown = `# Code Compression — [${repoName}] (${dateStr})\n\n`
    markdown += `> Este documento contém o esqueleto estrutural (Code Compression) dos arquivos solicitados.\n\n`
    if (enrichmentSections.header) markdown += `${enrichmentSections.header}\n`
    if (enrichmentSections.instruction) markdown += `${enrichmentSections.instruction}\n`
    markdown += `\n${result.content}\n`
    if (enrichmentSections.diffs) markdown += `\n${enrichmentSections.diffs}\n`
    if (enrichmentSections.logs) markdown += `\n${enrichmentSections.logs}\n`
    return markdown
  }
}