// Responsabilidades do Script
//
// 1. Extrair o esqueleto estrutural de arquivos rastreados via Repomix para Compressão de Código.
// 2. Gerar o documento Markdown consolidado contendo a compressão dos arquivos selecionados.
// 3. Armazenar em cache os resultados por mtime para evitar reprocessamento desnecessário via Repomix.
// 4. Reportar falhas individuais de compressão em seção "⚠️ Falhas na Compressão" no Markdown.
// 5. Retornar mensagem de erro clara quando todos os arquivos selecionados falharem.
// 6. Extrair nome do repositório com basename() para padronização com os demais serviços.

import { stat } from 'fs/promises'
import { join, basename } from 'path'
import { RepomixAdapter } from './repomix-adapter'

// Limite máximo de itens no cache em memória para evitar vazamento de memória
const MAX_CACHE_SIZE = 1000

export class CompressionService {
  private repomix = new RepomixAdapter()

  // Cache em memória: chave única por repositório + arquivo, com mtime e conteúdo comprimido
  private cache = new Map<string, { mtime: number; content: string }>()

  async generateCompressionMarkdown(repoPath: string, selectedFiles: string[]): Promise<string> {
    const repoName = basename(repoPath) || 'Repository'
    const dateStr = new Date().toLocaleString('pt-BR')

    let markdown = ''
    let markdownStarted = false
    const errors: string[] = []

    for (const relativePath of selectedFiles) {
      try {
        // Obtém o mtime atual para validar o cache
        const fileStat = await stat(join(repoPath, relativePath))
        const currentMtime = fileStat.mtimeMs

        const cacheKey = `${repoPath}::${relativePath}`
        const cached = this.cache.get(cacheKey)

        let compressedContent: string

        if (cached && cached.mtime === currentMtime) {
          // Cache válido: reutiliza o conteúdo sem chamar o Repomix
          compressedContent = cached.content
        } else {
          // Cache inválido ou ausente: processa e atualiza o cache
          compressedContent = await this.repomix.compressSingleFile(repoPath, relativePath)
          this.cache.set(cacheKey, { mtime: currentMtime, content: compressedContent })

          // Estratégia LRU simplificada: se o cache excedeu o limite, remove o item mais antigo
          // A condição .size > MAX_CACHE_SIZE garante que a chave existe, justificando o "!"
          if (this.cache.size > MAX_CACHE_SIZE) {
            this.cache.delete(this.cache.keys().next().value!)
          }
        }

        if (compressedContent && compressedContent.trim().length > 0) {
          // Adiciona conteúdo ao markdown apenas na primeira iteração bem-sucedida
          if (!markdownStarted) {
            markdown += `# Code Compression — [${repoName}] (${dateStr})\n\n`
            markdown += `> Este documento contém o esqueleto estrutural (Code Compression) dos arquivos solicitados.\n\n`
            markdownStarted = true
          }
          markdown += `---\n\n## 📄 \`${relativePath}\`\n\n\`\`\`plain\n${compressedContent}\n\`\`\`\n\n`
        }
      } catch (error) {
        // Arquivo pode ter sido deletado fisicamente — registra o erro para exibição ao final
        console.error(`Error compressing file ${relativePath}:`, error)
        errors.push(relativePath)
      }
    }

    // Se todos os arquivos falharam, retorna apenas a string de erro
    if (!markdownStarted && errors.length > 0) {
      return `# ❌ Falha na Compressão\n\nNenhum dos ${errors.length} arquivo(s) selecionado(s) pôde ser comprimido.`
    }

    // Se houve falhas parciais, adiciona seção de aviso ao final
    if (errors.length > 0) {
      markdown += `## ⚠️ Falhas na Compressão\n\nOs seguintes arquivos não puderam ser comprimidos:\n\n`
      for (const errPath of errors) {
        markdown += `- \`${errPath}\`\n`
      }
      markdown += '\n'
    }

    return markdown
  }
}
