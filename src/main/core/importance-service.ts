/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Orquestrar as 4 camadas de heurísticas de classificação de importância arquitetural.
2. Gerenciar cache em memória por mtime para evitar reprocessamento desnecessário.
3. Persistir as classificações no settings.json usando fingerprint resiliente do repositório.

Mapa de Relacionamentos do Script

1. importance-heuristics.ts
   - Tipo: Dependência Direta
   - Relação: Consome as 4 funções de heurística (classifyByExtensionAndPath, scoreByNameAndPath, scoreByContent, consolidateScore).
   - Criticidade: Alta

2. importance-fingerprint.ts
   - Tipo: Dependência Direta
   - Relação: Consome calculateRepoFingerprint para persistência resiliente.
   - Criticidade: Alta

3. settings-service.ts
   - Tipo: Fluxo de Dados
   - Relação: Consome settingsService singleton para carregar/salvar settings.
   - Criticidade: Alta

Invariantes do Script

1. O cache em memória nunca deve exceder MAX_CACHE_SIZE itens.
2. Se o mtime do arquivo não mudou, a classificação deve ser reutilizada do cache.
3. Se a Camada 1 retornar 'low', as Camadas 2 e 3 não devem ser executadas (otimização).
4. Falhas na persistência não devem quebrar a classificação (degradação graciosa).

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { stat, readFile } from 'fs/promises'
import { join } from 'path'
import { AppSettings, ImportanceLevel, ImportanceSource, FileImportance } from '../../shared/types'
import { calculateRepoFingerprint } from './importance-fingerprint'
import { settingsService } from './settings-service'
import {
  classifyByExtensionAndPath,
  scoreByNameAndPath,
  scoreByContent,
  consolidateScore
} from './importance-heuristics'

// Limite máximo de itens no cache em memória para evitar vazamento
const MAX_CACHE_SIZE = 5000

// Cache item armazenando todos os metadados de uma classificação
interface CacheItem {
  mtime: number
  level: ImportanceLevel
  score: number
  tokenEstimate: number
}

export class ImportanceService {
  // Cache em memória: chave única por repositório + arquivo
  private cache = new Map<string, CacheItem>()

  /**
   * Calcula estimativa de tokens baseada no tamanho do conteúdo.
   * Usa a heurística: 1 token ≈ 4 caracteres (boa aproximação para código-fonte).
   *
   * @param content - Conteúdo do arquivo
   * @returns Estimativa de tokens (arredondada para cima)
   */
  private estimateTokens(content: string): number {
    return Math.ceil(content.length / 4)
  }

  /**
   * Classifica um único arquivo usando as 4 camadas de heurísticas.
   * Utiliza cache indexado por mtime para evitar reprocessamentos caros de E/S.
   *
   * @param repoPath Caminho absoluto para a raiz do repositório.
   * @param relativePath Caminho relativo do arquivo dentro do repositório.
   * @returns Nível de importância, pontuação final, origem e estimativa de tokens.
   */
  async classifyFile(
    repoPath: string,
    relativePath: string
  ): Promise<{ level: ImportanceLevel; score: number; source: ImportanceSource; tokenEstimate: number }> {
    const filePath = join(repoPath, relativePath)

    // Obtém o mtime atual do arquivo no sistema de arquivos para validação do cache
    let currentMtime: number
    try {
      const fileStat = await stat(filePath)
      currentMtime = fileStat.mtimeMs
    } catch {
      // Arquivo não existe ou não está acessível no disco — retorna 'low' como fallback seguro
      return { level: 'low', score: 0, source: 'heuristic', tokenEstimate: 0 }
    }

    // Chave única para o cache em memória combinando o caminho do repositório e o caminho do arquivo
    const cacheKey = `${repoPath}::${relativePath}`
    const cached = this.cache.get(cacheKey)

    // Cache válido: se o arquivo não foi modificado (mtimes iguais), reutiliza a classificação em cache
    if (cached && cached.mtime === currentMtime) {
      return {
        level: cached.level,
        score: cached.score,
        source: 'heuristic',
        tokenEstimate: cached.tokenEstimate
      }
    }

    // Cache inválido ou ausente: processa as heurísticas pelas 4 camadas

    // Camada 1: Filtro de exclusão automática baseado em extensão, nome e caminhos de ruído conhecido
    const extensionScore = classifyByExtensionAndPath(relativePath)

    // Se a Camada 1 já determinou que o arquivo é ruído ('low'), ainda lemos para estimativa de tokens
    if (extensionScore === 'low') {
      let tokenEstimate = 0
      try {
        const content = await readFile(filePath, 'utf-8')
        tokenEstimate = this.estimateTokens(content)
      } catch {
        tokenEstimate = 0
      }

      const result = {
        level: 'low' as ImportanceLevel,
        score: 0,
        source: 'heuristic' as ImportanceSource,
        tokenEstimate
      }
      this.updateCache(cacheKey, currentMtime, result.level, result.score, result.tokenEstimate)
      return result
    }

    // Camada 2: Heurísticas baseadas em nome e caminho (lógica de negócios, entry points, etc.)
    const namePathScore = scoreByNameAndPath(relativePath)

    // Camada 3: Heurísticas baseadas no conteúdo do arquivo (assíncrona com leitura)
    const contentScore = await scoreByContent(repoPath, relativePath)

    // Calcula estimativa de tokens lendo o arquivo para contar caracteres
    let tokenEstimate = 0
    try {
      const content = await readFile(filePath, 'utf-8')
      tokenEstimate = this.estimateTokens(content)
    } catch {
      tokenEstimate = 0
    }

    // Camada 4: Consolidação e mapeamento para nível de importância
    const finalLevel = consolidateScore(extensionScore, namePathScore, contentScore)
    const totalScore = namePathScore + contentScore

    const result = {
      level: finalLevel,
      score: totalScore,
      source: 'heuristic' as ImportanceSource,
      tokenEstimate
    }

    // Atualiza o cache em memória com o novo resultado
    this.updateCache(cacheKey, currentMtime, result.level, result.score, result.tokenEstimate)

    return result
  }

  /**
   * Classifica todos os arquivos de um repositório em paralelo.
   *
   * @param repoPath Caminho absoluto para a raiz do repositório.
   * @param files Lista de arquivos contendo seus caminhos relativos.
   * @returns Registro associando cada relativePath aos seus dados de FileImportance.
   */
  async classifyAllFiles(
    repoPath: string,
    files: { relativePath: string }[]
  ): Promise<Record<string, FileImportance>> {
    const results: Record<string, FileImportance> = {}

    // Processa a classificação de todos os arquivos de forma concorrente em paralelo
    const classifications = await Promise.all(
      files.map(async (file) => {
        const { level, score, source, tokenEstimate } = await this.classifyFile(repoPath, file.relativePath)
        return { relativePath: file.relativePath, level, score, source, tokenEstimate }
      })
    )

    // Monta o mapa de resultados associando o mtime correspondente
    for (const { relativePath, level, score, source, tokenEstimate } of classifications) {
      const cacheKey = `${repoPath}::${relativePath}`
      const cached = this.cache.get(cacheKey)
      const mtime = cached?.mtime || 0

      results[relativePath] = {
        level,
        source,
        mtime,
        score,
        tokenEstimate
      }
    }

    return results
  }

  /**
   * Carrega as classificações persistidas para um repositório específico de forma resiliente.
   * Usa o fingerprint de conteúdo do repositório como chave de indexação.
   *
   * @param repoPath Caminho absoluto para a raiz do repositório.
   * @param repoName Nome do repositório.
   * @returns O registro com a importância dos arquivos ou null caso não encontre/falhe.
   */
  async loadPersistedImportance(
    repoPath: string,
    repoName: string
  ): Promise<Record<string, FileImportance> | null> {
    try {
      const fingerprint = await calculateRepoFingerprint(repoPath)
      const settings = this.loadSettings()
      const repoData = settings.fileImportance[fingerprint]

      if (!repoData) return null

      // Atualiza o lastKnownPath e o repoName caso tenham mudado no disco
      if (repoData.lastKnownPath !== repoPath) {
        repoData.lastKnownPath = repoPath
        repoData.repoName = repoName
        this.saveSettings(settings)
      }

      return repoData.files
    } catch (error) {
      console.error('[ImportanceService] Falha ao carregar persistência:', error)
      return null
    }
  }

  /**
   * Salva as classificações de arquivos de um repositório no settings.json, indexadas por fingerprint.
   *
   * @param repoPath Caminho absoluto para a raiz do repositório.
   * @param repoName Nome do repositório.
   * @param files Mapa de caminhos relativos para dados de importância de arquivos.
   */
  async savePersistedImportance(
    repoPath: string,
    repoName: string,
    files: Record<string, FileImportance>
  ): Promise<void> {
    try {
      const fingerprint = await calculateRepoFingerprint(repoPath)
      const settings = this.loadSettings()

      settings.fileImportance[fingerprint] = {
        repoName,
        lastKnownPath: repoPath,
        files
      }

      this.saveSettings(settings)
    } catch (error) {
      console.error('[ImportanceService] Falha ao salvar persistência:', error)
    }
  }

  /**
   * Invalida o cache em memória de um arquivo específico para forçar recarregamento.
   */
  invalidateCache(repoPath: string, relativePath: string): void {
    const cacheKey = `${repoPath}::${relativePath}`
    this.cache.delete(cacheKey)
  }

  /**
   * Atualiza o cache em memória com estratégia de expiração LRU simplificada.
   */
  private updateCache(
    cacheKey: string,
    mtime: number,
    level: ImportanceLevel,
    score: number,
    tokenEstimate: number
  ): void {
    this.cache.set(cacheKey, { mtime, level, score, tokenEstimate })

    // Se o limite de tamanho foi excedido, remove o item mais antigo
    if (this.cache.size > MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) {
        this.cache.delete(firstKey)
      }
    }
  }

  private loadSettings(): AppSettings {
    return settingsService.loadSettings()
  }

  private saveSettings(settings: AppSettings): void {
    settingsService.saveSettings(settings)
  }
}

// Instância singleton do serviço para ser compartilhada pelos handlers IPC
export const importanceService = new ImportanceService()