/**
 * RepositoryFileMembership — fronteira canônica de pertencimento ao CodeMap.
 *
 * Determina se um path pertence ao conjunto de arquivos mapeáveis.
 * Uma instância por repositório aberto (lifecycle associado ao CodeMapInstance).
 *
 * Semântica Git: respeita .gitignore da raiz, nested .gitignores e
 * excludes padrão — via `git check-ignore` em batch após debounce.
 *
 * Repositórios não-Git: usa política filesystem (IGNORED_DIRS, IGNORED_EXTENSIONS,
 * elegibilidade textual) equivalente ao scanner existente.
 */

import { existsSync, statSync } from 'fs'
import { extname, join } from 'path'
import { isEligibleTextFile, isKnownBinaryExtension } from './repository-scanner'

// Pastas internas sempre excluídas do CodeMap — independente de .gitignore
const INTERNAL_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'code_awareness',
  'code_checkpoints',
  'codefetch',
  '.sprintdiff',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
  'venv',
  '.venv',
  'out'
])

const IGNORED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp',
  '.mp4', '.mp3', '.wav', '.ogg', '.avi', '.mov',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.pdf', '.exe', '.dll', '.so', '.bin', '.wasm'
])

export type FileMembershipClass =
  | 'eligible'        // pertence ao mapa — pode ser indexado
  | 'ignored'         // presente mas ignorado (gitignore / policy)
  | 'directory'       // é um diretório, não um arquivo
  | 'ineligible'      // arquivo não mapeável (binário, muito grande, extensão excluída)
  | 'deleted-indexed' // não existe no disco mas estava indexado
  | 'deleted-unknown' // não existe no disco e nunca foi indexado

export interface MembershipResult {
  path: string
  classification: FileMembershipClass
}

/**
 * Serviço auxiliar stateless compartilhável — isola operações Git.
 * Injetado na instância de RepositoryFileMembership.
 */
export interface MembershipGitService {
  isGitRepository(dirPath: string): Promise<boolean>
  checkIgnoreBatch(repoPath: string, relativePaths: string[]): Promise<Set<string>>
}

/**
 * MembershipPort — interface de membership para injeção no RepositoryModel.
 *
 * Permite que discovery/reconcile usem a mesma semântica canônica do intake incremental.
 * Implementada por RepositoryFileMembership. Separada para evitar acoplamento de tipo.
 */
export interface MembershipPort {
  /**
   * Filtra paths retornando apenas os elegíveis (mapeáveis pelo CodeMap).
   * Paths ignorados, diretórios, inelegíveis e não-existentes são excluídos.
   * O contrato é idempotente — chamadas repetidas com o mesmo estado produzem o mesmo resultado.
   */
  filterEligible(relativePaths: string[]): Promise<string[]>
}

export class RepositoryFileMembership implements MembershipPort {
  private readonly repoPath: string
  private readonly git: MembershipGitService
  private isGit: boolean | null = null

  constructor(repoPath: string, git: MembershipGitService) {
    this.repoPath = repoPath.replace(/\\/g, '/').replace(/\/$/, '')
    this.git = git
  }

  /**
   * MembershipPort implementation: retorna somente os paths 'eligible'.
   */
  async filterEligible(relativePaths: string[]): Promise<string[]> {
    if (relativePaths.length === 0) return []
    const classifications = await this.classifyBatch(relativePaths)
    const eligible: string[] = []
    for (const [path, cls] of classifications) {
      if (cls === 'eligible') eligible.push(path)
    }
    return eligible
  }

  /**
   * Classifica um único path (incremental — chamado após debounce).
   * Usa isGit resolvido uma vez por instância.
   */
  async classify(relativePath: string, indexedPaths?: Set<string>): Promise<FileMembershipClass> {
    const results = await this.classifyBatch([relativePath], indexedPaths)
    return results.get(relativePath) ?? 'ineligible'
  }

  /**
   * Classifica um batch de paths — usa git check-ignore em lote para repositórios Git.
   * Para não-Git, aplica a política filesystem equivalente ao scanner.
   */
  async classifyBatch(
    relativePaths: string[],
    indexedPaths?: Set<string>
  ): Promise<Map<string, FileMembershipClass>> {
    if (this.isGit === null) {
      this.isGit = await this.git.isGitRepository(this.repoPath)
    }

    const result = new Map<string, FileMembershipClass>()

    // Separar paths em: não-existentes vs existentes (para leitura de stat)
    const existing: string[] = []
    const nonExisting: string[] = []

    for (const rel of relativePaths) {
      const fullPath = join(this.repoPath, rel)
      if (!existsSync(fullPath)) {
        nonExisting.push(rel)
      } else {
        existing.push(rel)
      }
    }

    // Classificar não-existentes
    for (const rel of nonExisting) {
      if (indexedPaths?.has(rel)) {
        result.set(rel, 'deleted-indexed')
      } else {
        result.set(rel, 'deleted-unknown')
      }
    }

    if (existing.length === 0) return result

    // Separar diretórios de arquivos
    const files: string[] = []
    for (const rel of existing) {
      const fullPath = join(this.repoPath, rel)
      try {
        const s = statSync(fullPath)
        if (s.isDirectory()) {
          result.set(rel, 'directory')
        } else {
          files.push(rel)
        }
      } catch {
        result.set(rel, 'ineligible')
      }
    }

    if (files.length === 0) return result

    // Checar paths em INTERNAL_DIRS — exclui antes de qualquer I/O
    const candidatesForIgnoreCheck: string[] = []
    for (const rel of files) {
      if (this.isInInternalDir(rel) || this.hasIgnoredExtension(rel)) {
        result.set(rel, 'ineligible')
      } else {
        candidatesForIgnoreCheck.push(rel)
      }
    }

    if (candidatesForIgnoreCheck.length === 0) return result

    // Determinar ignorados
    let ignoredPaths: Set<string>
    if (this.isGit) {
      // Batch Git: respeita .gitignore da raiz + nested + excludes padrão
      try {
        ignoredPaths = await this.git.checkIgnoreBatch(this.repoPath, candidatesForIgnoreCheck)
      } catch {
        // Falha do git → fail-open: nenhum path ignorado
        ignoredPaths = new Set()
      }
    } else {
      // Não-Git: sem ignorados adicionais além de INTERNAL_DIRS (já filtrado)
      ignoredPaths = new Set()
    }

    // Classificar candidatos restantes
    for (const rel of candidatesForIgnoreCheck) {
      if (ignoredPaths.has(rel)) {
        result.set(rel, 'ignored')
        continue
      }

      // Verifica elegibilidade (tamanho, binário) — async, necessário apenas aqui
      const fullPath = join(this.repoPath, rel)
      const eligible = await isEligibleTextFile(fullPath)
      result.set(rel, eligible ? 'eligible' : 'ineligible')
    }

    return result
  }

  private isInInternalDir(relativePath: string): boolean {
    const parts = relativePath.replace(/\\/g, '/').split('/')
    return parts.some((part) => INTERNAL_DIRS.has(part))
  }

  private hasIgnoredExtension(relativePath: string): boolean {
    const ext = extname(relativePath).toLowerCase()
    return IGNORED_EXTENSIONS.has(ext) || isKnownBinaryExtension(relativePath)
  }
}
