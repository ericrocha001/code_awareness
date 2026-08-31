/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Resolver a allowlist final de caminhos relativos de arquivos para a geração do One-Click XML.
2. Obter a lista base de arquivos candidatos via FileListingPort (ou fallback determinístico: GitService / scanRepository).
3. Aplicar filtros de Git Ignore baseados no arquivo .gitignore presente na raiz do repositório.
4. Aplicar filtros de Code Awareness Ignore baseados na lista exata de caminhos ignorados persistida nas configurações por repositório.
5. Normalizar separadores de caminho, remover duplicatas e ordenar os caminhos de forma determinística.

Mapa de Relacionamentos do Script

1. file-listing-port.ts
   - Tipo: Contrato / Interface
   - Relação: Consome a porta para obter lista de arquivos candidatos.
   - Criticidade: Alta

2. git-service.ts
   - Tipo: Dependência Direta
   - Relação: Utilizado como listador padrão para repositórios Git.
   - Criticidade: Média

3. repository-scanner.ts
   - Tipo: Dependência Direta
   - Relação: Utilizado como listador padrão para diretórios não-Git.
   - Criticidade: Média

4. settings-service.ts
   - Tipo: Dependência Direta
   - Relação: Lê as configurações do Code Awareness para obter ignoredDiffFiles por repositório.
   - Criticidade: Alta

Invariantes do Script

1. A política é pura no que tange a regras de negócio: não interpreta conteúdo de arquivos, não comprime e não gera XML.
2. Code Awareness Ignore é aplicado estritamente como caminhos relativos exatos (não como padrões glob).
3. Git Ignore é derivado exclusivamente do .gitignore da raiz do repositório se existir; na ausência, nenhum filtro Git Ignore é aplicado.
4. A lista resultante é sempre deduplicada, normalizada para barras normais (/) e ordenada alfabeticamente.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import ignore, { Ignore } from 'ignore'
import type { FileListingPort } from './file-listing-port'
import { GitService } from './git-service'
import { scanRepository } from './repository-scanner'
import { settingsService } from './settings-service'

export interface SettingsReader {
  loadSettings(): { ignoredDiffFiles?: Record<string, string[]> }
}

export class IgnorePolicy {
  constructor(
    private readonly fileLister?: FileListingPort,
    private readonly settingsReader?: SettingsReader
  ) {}

  /**
   * Resolve a allowlist final de caminhos relativos de arquivos para o repositório informado.
   */
  public async resolveAllowlist(repoPath: string): Promise<string[]> {
    // 1. Obter arquivos candidatos
    const candidatePaths = await this.fetchCandidates(repoPath)

    // 2. Carregar regras de Git Ignore (.gitignore na raiz do repo)
    const gitignoreFilter = this.loadGitignore(repoPath)

    // 3. Carregar regras de Code Awareness Ignore (caminhos exatos configurados)
    const codeAwarenessIgnored = this.loadCodeAwarenessIgnores(repoPath)

    // 4. Filtrar, normalizar e deduplicar
    const allowlistSet = new Set<string>()

    for (const rawPath of candidatePaths) {
      if (!rawPath || typeof rawPath !== 'string') continue
      const normalizedPath = this.normalizePath(rawPath)
      if (normalizedPath.length === 0) continue

      // Filtro Git Ignore
      if (gitignoreFilter && gitignoreFilter.ignores(normalizedPath)) {
        continue
      }

      // Filtro Code Awareness Ignore (caminho exato)
      if (codeAwarenessIgnored.has(normalizedPath)) {
        continue
      }

      allowlistSet.add(normalizedPath)
    }

    // 5. Retornar ordenado de forma determinística
    return Array.from(allowlistSet).sort((a, b) => a.localeCompare(b))
  }

  /**
   * Obtém a lista de caminhos relativos candidatos usando o listador injetado ou o padrão.
   */
  private async fetchCandidates(repoPath: string): Promise<string[]> {
    if (this.fileLister) {
      const files = await this.fileLister.listAllFiles(repoPath)
      return files.map((f) => f.relativePath)
    }

    const git = new GitService()
    if (await git.isGitRepository(repoPath)) {
      const files = await git.listAllFiles(repoPath)
      return files.map((f) => f.relativePath)
    }

    const scanned = await scanRepository(repoPath)
    return scanned.map((f) => f.relativePath)
  }

  /**
   * Lê o arquivo .gitignore na raiz do repositório e retorna a instância de Ignore.
   * Retorna null caso o arquivo não exista ou ocorra erro na leitura.
   */
  private loadGitignore(repoPath: string): Ignore | null {
    const gitignorePath = join(repoPath, '.gitignore')
    if (!existsSync(gitignorePath)) {
      return null
    }

    try {
      const content = readFileSync(gitignorePath, 'utf-8').replace(/\r\n/g, '\n')
      return ignore().add(content)
    } catch {
      return null
    }
  }

  /**
   * Lê os arquivos ignorados pelo Code Awareness para o repositório a partir das configurações.
   */
  private loadCodeAwarenessIgnores(repoPath: string): Set<string> {
    const reader = this.settingsReader ?? settingsService
    const ignoredSet = new Set<string>()

    try {
      const settings = reader.loadSettings()
      const ignores =
        settings.ignoredDiffFiles?.[repoPath] ??
        settings.ignoredDiffFiles?.[this.normalizePath(repoPath)] ??
        []

      if (Array.isArray(ignores)) {
        for (const item of ignores) {
          if (typeof item === 'string') {
            ignoredSet.add(this.normalizePath(item))
          }
        }
      }
    } catch {
      // Falha ao ler configurações resulta em nenhum arquivo ignorado pelo Code Awareness
    }

    return ignoredSet
  }

  /**
   * Normaliza o caminho para barras normais (/) e remove barras iniciais/finais redundantes.
   */
  private normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\/+/, '').trim()
  }
}
