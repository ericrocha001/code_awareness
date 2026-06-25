// Responsabilidades do Script
//
// 1. Gerar o relatório Markdown estruturado de diff semântico para arquivos selecionados do repositório Git,
//    usando o gitdiff-parser para extrair hunks precisos.

import { spawn } from 'child_process'
import { extname, basename, join } from 'path'
import * as gitdiffParser from 'gitdiff-parser'
import { readFile } from 'fs/promises'
import { GitService } from './git-service'
import { DiffFileStatus } from '../../shared/types'

// Mapa de extensão para nome de linguagem usado nos blocos de código Markdown
const EXTENSION_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.md': 'markdown'
}

// Rótulo em português para cada tipo de alteração
const CHANGE_TYPE_LABEL: Record<DiffFileStatus['changeType'], string> = {
  modified: 'modificado',
  added: 'adicionado',
  deleted: 'excluído'
}

// Timeout máximo para execuções de subprocesso Git
const GIT_TIMEOUT_MS = 10_000

// Limite saudável de tamanho de arquivo para leitura de diff (2 MB)
const MAX_FILE_SIZE = 2 * 1024 * 1024

export class DiffService {
  private git = new GitService()

  /**
   * Ponto de entrada principal.
   * Se `selectedFiles` for informado, processa apenas esses arquivos.
   * Caso contrário, usa todos os arquivos modificados detectados pelo Git.
   */
  async generateSemanticDiff(repoPath: string, selectedFiles?: string[]): Promise<string> {
    // Obtém a lista completa de alterados para usar como fallback ou para filtrar
    const allModified = await this.git.getModifiedFiles(repoPath)

    // Determina quais arquivos serão processados
    const filesToProcess = (selectedFiles && selectedFiles.length > 0)
      ? allModified.filter(f => selectedFiles.includes(f.relativePath))
      : allModified

    if (filesToProcess.length === 0) return '# Nenhuma alteração detectada.'

    const repoName = basename(repoPath)
    const date = new Date().toLocaleString('pt-BR')

    // Cabeçalho global do relatório com instrução para a IA
    const header = [
      `# Semantic Diff — \`${repoName}\``,
      ``,
      `*Gerado em: ${date}*`,
      ``,
      `> Este documento foi gerado automaticamente para auxiliar modelos de linguagem na compreensão das alterações do repositório.`,
      `> Cada seção contém os blocos exatos de código removido (🟥) e adicionado (🟩), organizados por hunk de diff.`
    ].join('\n')

    // Processa cada arquivo e coleta as seções
    const sections: string[] = []
    for (const file of filesToProcess) {
      const section = await this.buildFileSection(repoPath, file)
      if (section) sections.push(section)
    }

    if (sections.length === 0) return `${header}\n\n*Nenhuma alteração significativa encontrada.*`

    // Une o cabeçalho e as seções com divisores horizontais
    return [header, ...sections].join('\n\n---\n\n')
  }

  /**
   * Constrói a seção Markdown completa para um único arquivo.
   */
  private async buildFileSection(repoPath: string, file: DiffFileStatus): Promise<string> {
    const ext = extname(file.relativePath).toLowerCase()
    const lang = EXTENSION_MAP[ext] || 'text'
    const label = CHANGE_TYPE_LABEL[file.changeType]
    const fileHeader = `## 📄 \`${file.relativePath}\` (${label})`

    // --- Proteção contra Arquivos Gigantes ---
    if (file.size > MAX_FILE_SIZE) {
      return [
        fileHeader,
        ``,
        `*Arquivo muito grande para gerar o diff semântico (> 2MB).*`,
        `> Nota para IA: Devido ao tamanho excessivo, este arquivo não foi processado para extração de contexto ou de mudanças linha a linha.`
      ].join('\n')
    }

    // --- Arquivo Deletado ---
    // Exibe o conteúdo completo do HEAD no bloco negativo.
    if (file.changeType === 'deleted') {
      const oldContent = await this.git.getFileAtHead(repoPath, file.relativePath)
      if (!oldContent) return ''

      // Checagem de limite também para o conteúdo histórico
      if (Buffer.byteLength(oldContent, 'utf-8') > MAX_FILE_SIZE) {
        return [
          fileHeader,
          ``,
          `*Arquivo original removido era muito grande (> 2MB).*`
        ].join('\n')
      }

      return [
        fileHeader,
        ``,
        `#### 🟥 [Código Original / Removido]`,
        `\`\`\`${lang}`,
        oldContent.trimEnd(),
        `\`\`\``
      ].join('\n')
    }

    // --- Arquivo Adicionado ---
    // Não há hunks de diff — exibe o arquivo inteiro como bloco positivo.
    if (file.changeType === 'added') {
      const newContent = await this.readFileContent(repoPath, file.relativePath)
      // Evita renderizar se o arquivo não existe (ex: renomeado mas o git status listou o nome antigo)
      if (!newContent && newContent !== '') return ''

      const parts: string[] = [fileHeader]

      parts.push(
        `### 🔍 Hunk 1 (Arquivo novo)`,
        ``,
        `#### 🟥 [Código Original / Removido]`,
        `*(Nenhuma versão anterior identificada)*`,
        ``,
        `#### 🟩 [Código Novo / Adicionado]`,
        `\`\`\`${lang}`,
        newContent,
        `\`\`\``
      )

      return parts.join('\n')
    }

    // --- Arquivo Modificado ---
    // Obtém o diff raw via Git e parseia com gitdiff-parser
    const rawDiff = await this.runGitDiff(repoPath, file.relativePath)
    if (!rawDiff.trim()) return ''

    const parsedFiles = gitdiffParser.parse(rawDiff)
    if (!parsedFiles.length || !parsedFiles[0].hunks.length) return ''

    const hunks = parsedFiles[0].hunks
    const hunkSections: string[] = []

    // Monta uma seção Markdown para cada hunk identificado pelo parser
    hunks.forEach((hunk, index) => {
      // Separa as linhas removidas das adicionadas dentro deste hunk
      const removedLines = hunk.changes
        .filter(c => c.type === 'delete')
        .map(c => c.content)

      const addedLines = hunk.changes
        .filter(c => c.type === 'insert')
        .map(c => c.content)

      // --- Formatação do intervalo de linhas original (removido) ---
      let originalRange: string
      if (hunk.oldLines === 0) {
        originalRange = 'Sem alterações no arquivo original'
      } else if (hunk.oldLines === 1) {
        originalRange = `Linha ${hunk.oldStart}`
      } else {
        const oldEnd = hunk.oldStart + hunk.oldLines - 1
        originalRange = `Linhas ${hunk.oldStart} a ${oldEnd}`
      }

      // --- Formatação do intervalo de linhas novo (adicionado) ---
      let newRange: string
      if (hunk.newLines === 0) {
        newRange = 'Sem linhas no arquivo novo'
      } else if (hunk.newLines === 1) {
        newRange = `Linha ${hunk.newStart}`
      } else {
        const newEnd = hunk.newStart + hunk.newLines - 1
        newRange = `Linhas ${hunk.newStart} a ${newEnd}`
      }

      // Título do hunk com as descrições formatadas
      const hunkTitle = `### 🔍 Hunk ${index + 1} (${originalRange} ➔ ${newRange})`

      // Bloco negativo (removido)
      const negativeBlock = removedLines.length > 0
        ? [`#### 🟥 [Código Original / Removido]`, `\`\`\`${lang}`, removedLines.join('\n'), `\`\`\``].join('\n')
        : [`#### 🟥 [Código Original / Removido]`, `*(Nenhuma versão anterior identificada)*`].join('\n')

      // Bloco positivo (adicionado)
      const positiveBlock = addedLines.length > 0
        ? [`#### 🟩 [Código Novo / Adicionado]`, `\`\`\`${lang}`, addedLines.join('\n'), `\`\`\``].join('\n')
        : [`#### 🟩 [Código Novo / Adicionado]`, `*(Nenhuma linha adicionada neste hunk)*`].join('\n')

      hunkSections.push([hunkTitle, '', negativeBlock, '', positiveBlock].join('\n'))
    })

    const parts: string[] = [fileHeader]
    parts.push(...hunkSections)

    return parts.join('\n\n')
  }

  /**
   * Executa `git diff HEAD --no-color --no-ext-diff -U0 -- <relativePath>`
   * e retorna a saída raw do diff como string.
   * O -U0 garante zero linhas de contexto, focando estritamente nas mudanças.
   */
  private runGitDiff(repoPath: string, relativePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''

      const proc = spawn('git', [
        'diff', 'HEAD',
        '--no-color',
        '--no-ext-diff',
        '-U0',
        '--',
        relativePath
      ], { cwd: repoPath, shell: false })

      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('git diff timed out'))
      }, GIT_TIMEOUT_MS)

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      proc.on('close', (code) => {
        clearTimeout(timer)
        // git diff retorna 0 (sem erros) mesmo quando há diferenças
        if (code === 0 || code === 1) resolve(stdout)
        else reject(new Error(stderr.trim() || `git diff exited with code ${code}`))
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  /**
   * Lê o conteúdo atual de um arquivo em disco como string.
   * Retorna string vazia em caso de falha.
   */
  private async readFileContent(repoPath: string, relativePath: string): Promise<string | null> {
    try {
      return (await readFile(join(repoPath, relativePath), 'utf-8')).trimEnd()
    } catch {
      return null
    }
  }
}