// Responsabilidades do Script
//
// 1. Identificar semanticamente blocos de código (funções, classes) em torno das linhas modificadas pelo Git.
// 2. Gerar a string de Markdown estruturado com os blocos funcionais (Original vs Novo).
// 3. Fornecer fallback de exibição de linhas alteradas para arquivos sem assinaturas de bloco detectáveis (CSS, JSON, etc).

import { readFile, stat } from 'fs/promises'
import { join, basename, extname } from 'path'
import { GitService } from './git-service'
import { DiffFileStatus } from '../../shared/types'

// Lista de bloqueio de arquivos que nunca devem aparecer no relatório de diff
const CORE_IGNORED_FILES = new Set([
  'AGENTS.md',
  '.codefetchignore',
  '.gitignore',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml'
])

interface SemanticBlock {
  signature: string
  startLine: number // 1-indexed
  endLine: number   // 1-indexed
  lines: string[]
}

const SIGNATURE_PATTERNS: RegExp[] = [
  /^\s*(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*\w+/,
  /^\s*(export\s+)?(abstract\s+)?(default\s+)?class\s+\w+/,
  /^\s*(export\s+)?interface\s+\w+/,
  /^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?(function|\(|[a-z_]\w*\s*=>)/i,
  /^\s*(public|private|protected|static|override|abstract|async)(\s+(public|private|protected|static|override|abstract|async))*\s+\w+\s*[<(]/,
  /^\s*def\s+\w+\s*\(/,
]

// Limite saudável de tamanho de arquivo para leitura de diff (2 MB)
const MAX_FILE_SIZE = 2 * 1024 * 1024

const CHANGE_TYPE_LABEL: Record<DiffFileStatus['changeType'], string> = {
  modified: 'modificado',
  added: 'adicionado',
  deleted: 'excluído'
}

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

export class DiffService {
  private git = new GitService()

  async generateSemanticDiff(repoPath: string): Promise<string> {
    const files = await this.git.getModifiedFiles(repoPath)
    if (files.length === 0) return '# Nenhuma alteração detectada.'

    const name = basename(repoPath)
    const date = new Date().toLocaleString('pt-BR')
    const header = `# Semantic Diff — \`${name}\`\n\n*Gerado em: ${date}*`

    const sections: string[] = []
    for (const file of files) {
      if (file.relativePath.includes('code_awareness/')) continue
      if (CORE_IGNORED_FILES.has(file.relativePath)) continue
      const section = await this.analyzeFile(repoPath, file)
      if (section) sections.push(section)
    }

    if (sections.length === 0) return `${header}\n\n*Nenhum bloco semântico identificado.*`

    return [header, ...sections].join('\n\n---\n\n')
  }

  private async analyzeFile(repoPath: string, file: DiffFileStatus): Promise<string> {
    const ext = extname(file.relativePath).toLowerCase()
    const lang = EXTENSION_MAP[ext] || 'text'

    // Proteção: arquivos maiores que 2MB são ignorados para evitar travamento
    try {
      const stats = await stat(join(repoPath, file.relativePath))
      if (stats.size > MAX_FILE_SIZE) {
        return `## 📄 \`${file.relativePath}\` (${CHANGE_TYPE_LABEL[file.changeType]})\n\n` +
          `*Arquivo muito grande para gerar o diff (> 2MB).*`
      }
    } catch {
      // Se não conseguir ler o tamanho, segue o fluxo normal
    }

    // Arquivo deletado — exibe o conteúdo antigo completo como remoção
    if (file.changeType === 'deleted') {
      const oldContentRaw = await this.git.getFileAtHead(repoPath, file.relativePath)
      if (!oldContentRaw) return ''
      const oldLines = oldContentRaw.split('\n')
      return `## 📄 \`${file.relativePath}\` (${CHANGE_TYPE_LABEL.deleted})\n\n` +
        `#### 🟥 [Código Original / Removido]\n\`\`\`${lang}\n${oldLines.join('\n')}\n\`\`\``
    }

    let newContent: string
    try {
      newContent = await readFile(join(repoPath, file.relativePath), 'utf-8')
    } catch {
      return ''
    }

    const newLines = newContent.split('\n')

    // Arquivo novo (added) — exibe o conteúdo completo como adição
    if (file.changeType === 'added') {
      const block: SemanticBlock = {
        signature: `Arquivo Novo`,
        startLine: 1,
        endLine: newLines.length,
        lines: newLines
      }
      return `## 📄 \`${file.relativePath}\` (${CHANGE_TYPE_LABEL.added})\n\n` +
        this.formatDoubleBlock(block, null, lang)
    }

    const oldContentRaw = await this.git.getFileAtHead(repoPath, file.relativePath)
    const oldContent = oldContentRaw || ''

    const oldLines = oldContent.split('\n')

    const hunks = await this.git.getModifiedHunks(repoPath, file.relativePath)
    if (hunks.length === 0) return ''

    const blocksOutput: string[] = []
    const coveredNewBlocks = new Set<string>()

    for (const hunk of hunks) {
      // Tenta encontrar um bloco semântico (função, classe)
      const newBlock = this.findContainingBlock(newLines, hunk.start)

      if (newBlock) {
        const blockKey = `${newBlock.startLine}-${newBlock.endLine}`
        if (coveredNewBlocks.has(blockKey)) continue
        coveredNewBlocks.add(blockKey)

        const oldBlock = this.findContainingBlock(oldLines, hunk.oldStart)
        blocksOutput.push(this.formatDoubleBlock(newBlock, oldBlock, lang))
      } else {
        // Fallback: arquivo sem assinatura (CSS, JSON, etc) — exibe as linhas exatas do hunk com contexto
        const margin = 2
        const startLine = Math.max(1, hunk.start - margin)
        const endLine = Math.min(newLines.length, hunk.start + hunk.count - 1 + margin)
        const fallbackBlock: SemanticBlock = {
          signature: `Alteração de Linhas`,
          startLine,
          endLine,
          lines: newLines.slice(startLine - 1, endLine)
        }
        let oldFallback: SemanticBlock | null = null
        if (oldLines.length > 0 && hunk.oldStart > 0) {
          const oldStartLine = Math.max(1, hunk.oldStart - margin)
          const oldEndLine = Math.min(oldLines.length, hunk.oldStart + hunk.oldCount - 1 + margin)
          oldFallback = {
            signature: `Alteração de Linhas`,
            startLine: oldStartLine,
            endLine: oldEndLine,
            lines: oldLines.slice(oldStartLine - 1, oldEndLine)
          }
        }
        blocksOutput.push(this.formatDoubleBlock(fallbackBlock, oldFallback, lang))
      }
    }

    if (blocksOutput.length === 0) return ''

    return `## 📄 \`${file.relativePath}\` (${CHANGE_TYPE_LABEL.modified})\n\n${blocksOutput.join('\n\n')}`
  }

  private findContainingBlock(lines: string[], targetLine: number): SemanticBlock | null {
    if (lines.length === 0 || targetLine <= 0) return null
    const target = Math.min(targetLine - 1, lines.length - 1)

    let sigLine = -1
    for (let i = target; i >= 0; i--) {
      if (SIGNATURE_PATTERNS.some(p => p.test(lines[i]))) {
        sigLine = i
        break
      }
    }

    if (sigLine === -1) return null

    let depth = 0
    let foundOpen = false
    let endLine = -1

    for (let i = sigLine; i < lines.length; i++) {
      const opens = (lines[i].match(/\{/g) || []).length
      const closes = (lines[i].match(/\}/g) || []).length
      if (opens > 0) foundOpen = true
      depth += opens - closes
      if (foundOpen && depth <= 0) { endLine = i; break }
    }

    if (endLine === -1) endLine = Math.min(sigLine + 80, lines.length - 1)

    return {
      signature: lines[sigLine].trim(),
      startLine: sigLine + 1,
      endLine: endLine + 1,
      lines: lines.slice(sigLine, endLine + 1)
    }
  }

  private formatDoubleBlock(newBlock: SemanticBlock, oldBlock: SemanticBlock | null, lang: string): string {
    const label = newBlock.signature.replace(/[{].*$/, '').replace(/=>\s*$/, '').trim()
    const linesInterval = `(Linhas ${newBlock.startLine} a ${newBlock.endLine})`
    
    let output = `### Bloco: \`${label}\` ${linesInterval}\n\n`

    if (oldBlock) {
      output += `#### 🟥 [Código Original / Negativo]\n`
      output += `\`\`\`${lang}\n${oldBlock.lines.join('\n')}\n\`\`\`\n\n`
    } else {
      output += `#### 🟥 [Código Original / Negativo]\n`
      output += `*(Nenhuma versão anterior identificada)*\n\n`
    }

    output += `#### 🟩 [Código Novo / Positivo]\n`
    output += `\`\`\`${lang}\n${newBlock.lines.join('\n')}\n\`\`\``

    return output
  }
}