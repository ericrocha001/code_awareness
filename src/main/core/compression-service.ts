/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Extrair o esqueleto estrutural de arquivos rastreados via Repomix para Compressão de Código.
2. Gerar o documento Markdown consolidado contendo a compressão dos arquivos selecionados.
3. Armazenar em cache os resultados por mtime para evitar reprocessamento desnecessário via Repomix.
4. Processar arquivos não cacheados em lote via compressMultipleFiles, com fallback individual em caso de falha.
5. Reportar falhas individuais de compressão em seção "⚠️ Falhas na Compressão" no Markdown.
6. Retornar mensagem de erro clara quando todos os arquivos selecionados falharem.

Mapa de Relacionamentos do Script

1. RepomixAdapter
   - Tipo: Dependência Direta
   - Relação: Consome compressMultipleFiles (primário) e compressSingleFile (fallback).
   - Criticidade: Alta

Invariantes do Script

1. O Markdown final deve ser montado na ordem exata do array selectedFiles original.
2. O cache nunca deve exceder MAX_CACHE_SIZE (1000 itens).
3. Falhas no stat de um arquivo devem ir para finalErrors, sem tentar comprimir.
4. Fallback para compressSingleFile nunca deve quebrar a operação inteira.

--- FIM ARQUITETURA DO SCRIPT ---
*/

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

    // Etapa 1 — Análise de Cache: separa arquivos em cacheados e não cacheados
    const results: Record<string, string> = {}
    const uncachedFiles: string[] = []
    const finalErrors: string[] = []

    for (const relativePath of selectedFiles) {
      try {
        const fileStat = await stat(join(repoPath, relativePath))
        const currentMtime = fileStat.mtimeMs
        const cacheKey = `${repoPath}::${relativePath}`
        const cached = this.cache.get(cacheKey)

        if (cached && cached.mtime === currentMtime) {
          // Cache válido: reutiliza o conteúdo sem chamar o Repomix
          results[relativePath] = cached.content
        } else {
          // Cache inválido ou ausente: precisa processar
          uncachedFiles.push(relativePath)
        }
      } catch {
        // Arquivo pode ter sido deletado fisicamente — registra o erro
        finalErrors.push(relativePath)
      }
    }

    // Etapa 2 — Processamento: comprime arquivos não cacheados em lote
    if (uncachedFiles.length > 0) {
      try {
        // Tenta compressão em lote (elimina overhead de N inicializações CLI)
        const batchResults = await this.repomix.compressMultipleFiles(repoPath, uncachedFiles)

        for (const relativePath of uncachedFiles) {
          const content = batchResults[relativePath]

          if (content && content.trim().length > 0) {
            results[relativePath] = content

            // Atualiza cache com o mtime atual
            try {
              const fileStat = await stat(join(repoPath, relativePath))
              const cacheKey = `${repoPath}::${relativePath}`
              this.cache.set(cacheKey, { mtime: fileStat.mtimeMs, content })

              // Estratégia LRU simplificada: se o cache excedeu o limite, remove o mais antigo
              if (this.cache.size > MAX_CACHE_SIZE) {
                this.cache.delete(this.cache.keys().next().value!)
              }
            } catch {
              // stat falhou após compressão bem-sucedida — não atualiza cache, mas mantém resultado
            }
          } else {
            // Conteúdo vazio: o arquivo não apareceu no stdout do lote
            finalErrors.push(relativePath)
          }
        }
      } catch (batchError) {
        // Falha no lote: fallback para compressão individual arquivo por arquivo
        console.warn('compressMultipleFiles falhou, acionando fallback individual:', batchError)

        for (const relativePath of uncachedFiles) {
          // Pula arquivos que já foram resolvidos por resultados parciais do lote (não ocorre aqui,
          // mas a verificação mantém a lógica resiliente)
          if (results[relativePath]) continue

          try {
            const content = await this.repomix.compressSingleFile(repoPath, relativePath)

            if (content && content.trim().length > 0) {
              results[relativePath] = content

              // Atualiza cache com o mtime atual
              try {
                const fileStat = await stat(join(repoPath, relativePath))
                const cacheKey = `${repoPath}::${relativePath}`
                this.cache.set(cacheKey, { mtime: fileStat.mtimeMs, content })

                if (this.cache.size > MAX_CACHE_SIZE) {
                  this.cache.delete(this.cache.keys().next().value!)
                }
              } catch {
                // stat falhou — não atualiza cache
              }
            } else {
              finalErrors.push(relativePath)
            }
          } catch (singleError) {
            console.error(`Fallback falhou para ${relativePath}:`, singleError)
            finalErrors.push(relativePath)
          }
        }
      }
    }

    // Etapa 3 — Montagem: constrói o Markdown na ordem original de selectedFiles
    let markdown = ''
    let markdownStarted = false
    const errorsInOrder: string[] = []

    for (const relativePath of selectedFiles) {
      const compressedContent = results[relativePath]

      if (compressedContent && compressedContent.trim().length > 0) {
        // Adiciona conteúdo ao markdown apenas na primeira iteração bem-sucedida
        if (!markdownStarted) {
          markdown += `# Code Compression — [${repoName}] (${dateStr})\n\n`
          markdown += `> Este documento contém o esqueleto estrutural (Code Compression) dos arquivos solicitados.\n\n`
          markdownStarted = true
        }
        markdown += `---\n\n## 📄 \`${relativePath}\`\n\n\`\`\`plain\n${compressedContent}\n\`\`\`\n\n`
      } else {
        // Arquivo não está em results — é um erro (já deve estar em finalErrors)
        errorsInOrder.push(relativePath)
      }
    }

    // Combina erros detectados em qualquer etapa
    const allErrors = [...new Set([...finalErrors, ...errorsInOrder])]

    // Se todos os arquivos falharam, retorna apenas a string de erro
    if (!markdownStarted && allErrors.length > 0) {
      return `# ❌ Falha na Compressão\n\nNenhum dos ${allErrors.length} arquivo(s) selecionado(s) pôde ser comprimido.`
    }

    // Se houve falhas parciais, adiciona seção de aviso ao final
    if (allErrors.length > 0) {
      markdown += `## ⚠️ Falhas na Compressão\n\nOs seguintes arquivos não puderam ser comprimidos:\n\n`
      for (const errPath of allErrors) {
        markdown += `- \`${errPath}\`\n`
      }
      markdown += '\n'
    }

    return markdown
  }
}