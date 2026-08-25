/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Executar compressões de arquivos não cacheados via RepomixAdapter em lotes (batch) com controle de concorrência.
2. Deduplicar chamadas concorrentes através do gerenciador inFlight para evitar execuções redundantes.
3. Realizar fallback transparente para compressão individual quando o lote falhar ou omitir arquivos.
4. Consolidar e retornar o mapeamento de resultados comprimidos e registros detalhados de erros e motivos de falha.
5. Executar o Direct Output (markdown/xml) via RepomixAdapter.generateDirectOutput, deduplicando chamadas idênticas simultâneas via directInFlight (sem compartilhar o inFlight do Core).

Mapa de Relacionamentos do Script

1. repomix-adapter.ts
   - Tipo: Dependência Direta
   - Relação: Consome compressMultipleFiles e compressSingleFile para acionamento do processo Repomix (Core) e generateDirectOutput para o Direct Output.
   - Criticidade: Alta

2. repomix-request.ts
   - Tipo: Contrato / Interface
   - Relação: Consome o tipo RepomixRequest para parametrizar execuções individuais e em lote.
   - Criticidade: Alta

3. repomix-arguments-builder.ts
   - Tipo: Dependência Direta
   - Relação: Consome buildRepomixRequest para estruturar sub-requisições de lote.
   - Criticidade: Alta

4. compression-constants.ts
   - Tipo: Dependência Direta
   - Relação: Consome COMPRESSION_VERSION para composição da chave inFlight.
   - Criticidade: Alta

5. compression-profile.ts
   - Tipo: Dependência Direta
   - Relação: Consome computeProfileHash para incluir o hash do perfil efetivo na chave do directInFlight.
   - Criticidade: Alta

Invariantes do Script

1. inFlight keys são limpas obrigatoriamente via finally — Promises rejeitadas nunca travam execuções futuras.
2. O executor é desacoplado de caching e de formatação de Markdown, operando exclusivamente sobre listas de arquivos não cacheados.
3. Resultados parciais de lotes são preservados, acionando fallback apenas para arquivos ausentes.
4. A chave do directInFlight inclui o hash do EffectiveProfile — chamadas concorrentes com perfis efetivos diferentes nunca são deduplicadas entre si.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { basename } from 'path'
import { RepomixAdapter } from './repomix-adapter'
import { buildRepomixRequest } from './repomix-arguments-builder'
import { COMPRESSION_VERSION } from './compression-constants'
import { computeProfileHash } from './compression-profile'
import type { RepomixRequest } from './repomix-request'

export interface ExecutionResult {
  results: Record<string, string>      // relativePath → compressedContent
  errors: string[]                     // relativePaths que falharam
  errorReasons: Record<string, string> // relativePath → motivo
}

export interface DirectOutputResult {
  content: string | null
  error?: string
}

export class CompressionExecutor {
  private readonly repomix: RepomixAdapter
  // Gerenciador inFlight para deduplicação de chamadas concorrentes
  private inFlight = new Map<string, Promise<string>>()
  // Gerenciador inFlight dedicado ao Direct Output — chaves semanticamente distintas do Core.
  private directInFlight = new Map<string, Promise<DirectOutputResult>>()

  constructor(adapter: RepomixAdapter) {
    this.repomix = adapter
  }

  /**
   * Normaliza um caminho para compor a chave do inFlight manager.
   */
  private normalizeCachePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+$/, '')
  }

  /**
   * Compõe a chave do inFlight manager para deduplicação concorrente por identidade completa.
   */
  private buildInFlightKey(repoPath: string, relativePath: string, contentHash: string, profileHash: string): string {
    return `${this.normalizeCachePath(repoPath)}::${this.normalizeCachePath(relativePath)}::${contentHash}::${COMPRESSION_VERSION}::${profileHash}`
  }

  /**
   * Comprime um arquivo individualmente com deduplicação de chamadas concorrentes via inFlight.
   */
  private async compressSingleWithDedup(
    request: RepomixRequest,
    relativePath: string,
    contentHash: string,
    profileHash: string
  ): Promise<string> {
    const inflightKey = this.buildInFlightKey(request.repoPath, relativePath, contentHash, profileHash)

    const existing = this.inFlight.get(inflightKey)
    if (existing) return existing

    const promise = this.repomix.compressSingleFile(request, relativePath)
      .finally(() => {
        this.inFlight.delete(inflightKey)
      })
    promise.catch(() => {})

    this.inFlight.set(inflightKey, promise)
    return promise
  }

  /**
   * Executa a compressão de arquivos não cacheados com batch e fallback individual.
   */
  async execute(
    repoPath: string,
    uncachedFiles: string[],
    fileHashes: Record<string, string>,
    fileStats: Record<string, { mtimeMs: number; size: number }>,
    request: RepomixRequest,
    profileHash: string
  ): Promise<ExecutionResult> {
    const repoName = basename(repoPath) || 'Repository'
    const etapa2Start = Date.now()
    console.log(`[CompressionExecutor] Etapa 2: ${uncachedFiles.length} arquivo(s) não cacheado(s) para compressão em ${repoName}`)

    const results: Record<string, string> = {}
    const finalErrors: string[] = []
    const errorReasons: Record<string, string> = {}

    const inFlightWaiters: Array<{ relativePath: string; promise: Promise<string> }> = []
    const filesToBatch: string[] = []
    const batchInFlightKeys: Array<{
      relativePath: string
      inflightKey: string
      deferred: { promise: Promise<string>; resolve: (v: string) => void; reject: (err?: any) => void }
    }> = []

    for (const relativePath of uncachedFiles) {
      const hash = fileHashes[relativePath] || ''
      const inflightKey = this.buildInFlightKey(repoPath, relativePath, hash, profileHash)
      const existing = this.inFlight.get(inflightKey)

      if (existing) {
        inFlightWaiters.push({ relativePath, promise: existing })
      } else {
        filesToBatch.push(relativePath)
        let resolve!: (v: string) => void
        let reject!: (err?: any) => void
        const promise = new Promise<string>((res, rej) => {
          resolve = res
          reject = rej
        })
        promise.catch(() => {})
        batchInFlightKeys.push({
          relativePath,
          inflightKey,
          deferred: { promise, resolve, reject }
        })
        this.inFlight.set(inflightKey, promise)
      }
    }

    // Processa lote para arquivos não cobertos por promessa inFlight existente
    if (filesToBatch.length > 0) {
      try {
        const batchRequest = buildRepomixRequest(repoPath, filesToBatch, request.profile, request.outputFormat)
        const batchResults = await this.repomix.compressMultipleFiles(batchRequest)

        for (const item of batchInFlightKeys) {
          const { relativePath, inflightKey, deferred } = item
          const content = batchResults[relativePath]

          if (content && content.trim().length > 0) {
            results[relativePath] = content
            deferred.resolve(content)
            this.inFlight.delete(inflightKey)
          } else {
            // Arquivo ausente no lote: limpa reserva do batch e tenta fallback individual deduplicado
            this.inFlight.delete(inflightKey)
            console.warn(`[CompressionExecutor] arquivo ausente no batch, tentando fallback individual: "${relativePath}"`)

            try {
              const hash = fileHashes[relativePath] || ''
              const fallbackContent = await this.compressSingleWithDedup(request, relativePath, hash, profileHash)

              if (fallbackContent && fallbackContent.trim().length > 0) {
                results[relativePath] = fallbackContent
                deferred.resolve(fallbackContent)
              } else {
                finalErrors.push(relativePath)
                errorReasons[relativePath] = 'conteúdo vazio (batch + fallback)'
                deferred.reject(new Error(`Conteúdo vazio para ${relativePath}`))
              }
            } catch (singleErr) {
              finalErrors.push(relativePath)
              errorReasons[relativePath] = singleErr instanceof Error ? singleErr.message : 'erro desconhecido no fallback'
              deferred.reject(singleErr)
            }
          }
        }
      } catch (batchError) {
        // Falha no lote: fallback para compressão individual arquivo por arquivo via compressSingleWithDedup
        console.warn('compressMultipleFiles falhou, acionando fallback individual:', batchError)

        for (const item of batchInFlightKeys) {
          const { relativePath, inflightKey, deferred } = item
          if (results[relativePath]) continue

          // Libera a chave temporária do batch para que compressSingleWithDedup gerencie seu próprio ciclo
          this.inFlight.delete(inflightKey)

          const hash = fileHashes[relativePath] || ''
          try {
            const content = await this.compressSingleWithDedup(request, relativePath, hash, profileHash)

            if (content && content.trim().length > 0) {
              results[relativePath] = content
              deferred.resolve(content)
            } else {
              finalErrors.push(relativePath)
              errorReasons[relativePath] = 'conteúdo vazio no fallback'
              deferred.reject(new Error(`Conteúdo vazio no fallback para ${relativePath}`))
            }
          } catch (singleError) {
            console.error(`Fallback falhou para ${relativePath}:`, singleError)
            finalErrors.push(relativePath)
            errorReasons[relativePath] = singleError instanceof Error ? singleError.message : 'erro desconhecido no fallback'
            deferred.reject(singleError)
          }
        }
      }
    }

    // Aguarda promessas inFlight de chamadas concorrentes
    if (inFlightWaiters.length > 0) {
      for (const { relativePath, promise } of inFlightWaiters) {
        try {
          const content = await promise
          if (content && content.trim().length > 0) {
            results[relativePath] = content
          } else {
            finalErrors.push(relativePath)
            errorReasons[relativePath] = 'conteúdo vazio (inFlight)'
          }
        } catch (err) {
          finalErrors.push(relativePath)
          errorReasons[relativePath] = err instanceof Error ? err.message : 'erro desconhecido (inFlight)'
        }
      }
    }

    const etapa2DurationMs = Date.now() - etapa2Start
    const successCount = Object.keys(results).length
    const failCount = finalErrors.length
    if (failCount > 0) {
      const firstFails = finalErrors.slice(0, 10)
      console.warn(
        `[CompressionExecutor] Etapa 2 concluída em ${etapa2DurationMs}ms: ${successCount} sucesso(s), ${failCount} falha(s) de ${uncachedFiles.length} arquivo(s). Primeiros: ${firstFails.join(', ')}`
      )
    } else {
      console.log(`[CompressionExecutor] Etapa 2 concluída em ${etapa2DurationMs}ms: ${successCount}/${uncachedFiles.length} arquivo(s) comprimido(s) com sucesso`)
    }

    return {
      results,
      errors: finalErrors,
      errorReasons
    }
  }

  /**
   * Executa o Direct Output (documento inteiro markdown/xml) para um RepomixRequest.
   * Não compartilha inFlight com o Compression Core — deduplica apenas chamadas
   * idênticas simultâneas via directInFlight (ex.: duplo clique no exportar).
   */
  async executeDirectOutput(request: RepomixRequest): Promise<DirectOutputResult> {
    // A chave inclui o hash do perfil EFETIVO (semântico): formatos, arquivos e formato de
    // transporte idênticos com perfis com flags efetivas diferentes devem ser executados
    // separadamente (ex.: removeComments true vs false), sem deduplicação incorreta.
    const profileHash = computeProfileHash(request.profile)
    const directKey = `${this.normalizeCachePath(request.repoPath)}::${request.selectedFiles.join('|')}::${request.outputFormat}::${profileHash}`
    const existing = this.directInFlight.get(directKey)
    if (existing) return existing

    const promise = (async (): Promise<DirectOutputResult> => {
      try {
        const result = await this.repomix.generateDirectOutput(request)
        if (result.failed) {
          return { content: null, error: result.reason || 'Falha ao gerar Direct Output.' }
        }
        return { content: result.content }
      } catch (err) {
        return { content: null, error: err instanceof Error ? err.message : 'erro desconhecido no Direct Output' }
      }
    })().finally(() => {
      this.directInFlight.delete(directKey)
    })

    this.directInFlight.set(directKey, promise)
    return promise
  }
}
