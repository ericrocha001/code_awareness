/*
-T ---
*/

import { existsSync, readFileSync } from 'fs'
import { resolve, relative, isAbsolute, sep } from 'path'
import { spawn } from 'child_process'
import type { ContextEnrichment } from '../../shared/types'

/** Limite máximo (em caracteres) para o Header Text (16KB). */
export const MAX_HEADER_TEXT_LENGTH = 16384
/**
 * Constrói as seções de Context Enrichment para a montagem final do documento.
 * Validações:
 * - Header Text acima de 16KB lança erro claro (único caso que interrompe).
 * - Instruction File inexistente/inválido → warning e omissão (não interrompe).
 * - Git diff/log com falha → warning e omissão (não interrompe).
 */
export async function buildEnrichmentSections(
  enrichment: ContextEnrichment | undefined,
  repoPath: string
): Promise<EnrichmentSections> {
  let header: string | null = null
  let instruction: string | null = null
  let diffs: string | null = null
  let logs: string | null = null

  // Header Text — validado contra o limite de 16KB
  if (enrichment && typeof enrichment.headerText === 'string' && enrichment.headerText.length > 0) {
    if (enrichment.headerText.length > MAX_HEADER_TEXT_LENGTH) {
      throw new Error(
        `Header text excede o limite de 16KB (recebidos ${enrichment.headerText.length} caracteres).`
      )
    }
    header = `## 📋 Contexto Adicional\n\n${enrichment.headerText}\n`
  }

  // Instruction File — validado contra path traversal e existência
  if (enrichment && typeof enrichment.instructionFilePath === 'string' && enrichment.instructionFilePath.length > 0) {
    const fullPath = validateInstructionPath(repoPath, enrichment.instructionFilePath)
    if (!fullPath || !existsSync(fullPath)) {
      console.warn(
        `[ContextEnrichmentService] Arquivo de instruções não encontrado ou inválido: ${enrichment.instructionFilePath} — seção omitida.`
      )
    } else {
      const content = readFileSync(fullPath, 'utf-8').trim()
      instruction = `## 📖 Instruções\n\n${content}\n`
    }
  }

  // Git Diffs — falha é graceful (warning + omissão)
  if (enrichment && enrichment.includeDiffs) {
    try {
      const out = await runGit(['diff', '--no-color'], repoPath)
      if (out) diffs = `## 🔀 Alterações Recentes (Git Diff)\n\n${out}\n`
    } catch (err) {
      console.warn('[ContextEnrichmentService] Falha ao obter Git diff — seção omitida.', err)
    }
  }

  // Git Logs — falha é graceful (warning + omissão)
  if (enrichment && enrichment.includeLogs) {
    const count = clampLogsCount(enrichment.includeLogsCount)
    try {
      const out = await runGit(
        ['log', '--no-color', '-n', String(count), '--pretty=format:%h %ad %s', '--date=short'],
        repoPath
      )
      if (out) logs = `## 📜 Histórico Recente (Git Log)\n\n${out}\n`
    } catch (err) {
      console.warn('[ContextEnrichmentService] Falha ao obter Git log — seção omitida.', err)
    }
  }

  return { header, instruction, diffs, logs }
}

/** Coage includeLogsCount para o intervalo [1, 100], aplicando o default quando inválido. */
export function clampLogsCount(count: number | undefined): number {
  if (typeof count !== 'number' || !Number.isFinite(count)) return DEFAULT_LOGS_COUNT
  return Math.min(MAX_LOGS_COUNT, Math.max(MIN_LOGS_COUNT, Math.floor(count)))
}

/** Número padrão de commits exibidos nos logs do Git. */
export const DEFAULT_LOGS_COUNT = 10

/** Limites do includeLogsCount. */
export const MIN_LOGS_COUNT = 1
export const MAX_LOGS_COUNT = 100

/** Seções de enriquecimento formatadas para inserção na montagem final. */
export interface EnrichmentSections {
  header: string | null
  instruction: string | null
  diffs: string | null
  logs: string | null
}

/**
 * Valida o instructionFilePath contra path traversal e retorna o caminho
 * absoluto se seguro, ou null se inválido (absoluto, fora do repo ou com `..`).
 */
function validateInstructionPath(repoPath: string, instructionFilePath: string): string | null {
  if (!instructionFilePath || isAbsolute(instructionFilePath)) return null
  const base = resolve(repoPath)
  const full = resolve(base, instructionFilePath)
  if (full !== base && !full.startsWith(base + sep)) return null
  if (relative(base, full).split(sep).includes('..')) return null
  return full
}

/** Executa um comando git no diretório informado e resolve o stdout em sucesso. */
function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn('git', args, { cwd, shell: false })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', (err) => reject(err))
    proc.on('close', (code) => {
      if (code === 0) resolvePromise(stdout.trim())
      else reject(new Error(stderr.trim() || `git exit ${code}`))
    })
  })
}