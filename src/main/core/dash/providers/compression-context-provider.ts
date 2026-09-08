/*
-T ---
*/

import type { DashPlannedItem } from '../../../../shared/types/dash-types'
import { DEFAULT_PROFILE } from '../../compression-profile'
import type {
  StructuredCompressionPort,
  StructuredCompressionResult
} from '../../structured-compression-port'
import type { CompressionProfile } from '../../../../shared/types'
import type {
  ContextProvider,
  DashExecutionOptions,
  DashProviderFailure,
  DashProviderResult
} from './context-provider'

export class CompressionContextProvider implements ContextProvider {
  constructor(private readonly structuredPort: StructuredCompressionPort) {}

  /**
   * Fornece o conteúdo comprimido dos itens planejados consumindo a API estruturada.
   * Agrupa itens por profile e mapeia resultados e falhas para os índices originais.
   */
  public async provide(
    items: DashPlannedItem[],
    options: DashExecutionOptions
  ): Promise<DashProviderResult> {
    const contents = new Map<number, string>()
    const failures: DashProviderFailure[] = []

    if (items.length === 0) {
      return { contents, failures }
    }

    if (options.signal?.aborted) {
      throw new Error('Operação cancelada pelo usuário')
    }

    // 1. Agrupa itens por profile (ou usa DEFAULT_PROFILE)
    const profileGroups = new Map<string, { profile: CompressionProfile; items: DashPlannedItem[] }>()

    for (const item of items) {
      let parsedProfile: CompressionProfile = DEFAULT_PROFILE

      if (typeof item.profile === 'string') {
        try {
          parsedProfile = JSON.parse(item.profile)
        } catch {
          parsedProfile = DEFAULT_PROFILE
        }
      } else if (item.profile && typeof item.profile === 'object') {
        parsedProfile = item.profile as CompressionProfile
      }

      // Aplica o merge das configurações globais de economia ANTES do cálculo da profileKey,
      // garantindo que o agrupamento reflita o perfil efetivo real de cada item.
      // O merge sobrescreve apenas os três campos econômicos; os demais campos do profile base são preservados.
      if (options.settings) {
        parsedProfile = {
          ...parsedProfile,
          removeComments: options.settings.removeComments,
          removeEmptyLines: options.settings.removeEmptyLines,
          truncateBase64: options.settings.truncateBase64
        }
      }

      const profileKey = JSON.stringify(parsedProfile)
      const group = profileGroups.get(profileKey) ?? { profile: parsedProfile, items: [] }
      group.items.push(item)
      profileGroups.set(profileKey, group)
    }

    // 2. Executa a compressão para cada grupo de profile
    for (const [, { profile, items: groupItems }] of profileGroups) {
      if (options.signal?.aborted) {
        throw new Error('Operação cancelada pelo usuário')
      }

      const selectedFiles = groupItems.map((it) => it.path)

      try {
        let result: StructuredCompressionResult
        if (typeof this.structuredPort?.compressFilesStructured === 'function') {
          result = await this.structuredPort.compressFilesStructured(
            options.repoPath,
            selectedFiles,
            profile,
            'plain'
          )
        } else if (typeof (this.structuredPort as any)?.generateCompressionMarkdown === 'function') {
          const markdown = await (this.structuredPort as any).generateCompressionMarkdown(
            options.repoPath,
            selectedFiles,
            profile,
            'plain'
          )
          result = this.parseLegacyMarkdown(markdown, selectedFiles)
        } else {
          throw new Error('Porta de compressão inválida: compressFilesStructured não encontrado')
        }

        // Mapeia por caminho normalizado para correspondência segura
        const itemByPath = new Map<string, DashPlannedItem>()
        for (const item of groupItems) {
          itemByPath.set(item.path.replace(/\\/g, '/'), item)
          itemByPath.set(item.path, item)
        }

        // Processa sucessos
        for (const [filePath, content] of Object.entries(result.results)) {
          const item = itemByPath.get(filePath) ?? itemByPath.get(filePath.replace(/\\/g, '/'))
          if (item) {
            contents.set(item.index, content)
          }
        }

        // Processa erros reportados
        for (const errPath of result.errors) {
          const item = itemByPath.get(errPath) ?? itemByPath.get(errPath.replace(/\\/g, '/'))
          if (item) {
            failures.push({
              index: item.index,
              reason: result.errorReasons[errPath] ?? `Falha na compressão de ${errPath}`
            })
          }
        }

        // Verifica itens do grupo que não constam em results nem em errors
        for (const item of groupItems) {
          if (
            !contents.has(item.index) &&
            !failures.some((f) => f.index === item.index)
          ) {
            failures.push({
              index: item.index,
              reason: `Conteúdo não retornado para ${item.path}`
            })
          }
        }
      } catch (error) {
        if (options.signal?.aborted) {
          throw error
        }
        for (const item of groupItems) {
          failures.push({
            index: item.index,
            reason:
              error instanceof Error
                ? error.message
                : `Erro inesperado ao comprimir ${item.path}`
          })
        }
      }
    }

    return {
      contents,
      failures
    }
  }

  /**
   * Fallback defensivo para mocks de testes legados que retornam markdown string.
   */
  private parseLegacyMarkdown(
    markdown: string,
    selectedFiles: string[]
  ): StructuredCompressionResult {
    const results: Record<string, string> = {}
    const errors: string[] = []
    const errorReasons: Record<string, string> = {}

    const fileSectionRegex =
      /## 📄 [`']?([^`'\r\n]+)[`']?\s*```(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)\r?\n```/g

    let match: RegExpExecArray | null
    while ((match = fileSectionRegex.exec(markdown)) !== null) {
      const filePath = match[1].trim().replace(/\\/g, '/')
      const codeContent = match[2]
      results[filePath] = codeContent
    }

    if (Object.keys(results).length === 0 && selectedFiles.length === 1 && !markdown.includes('⚠️')) {
      results[selectedFiles[0]] = markdown
    }

    for (const f of selectedFiles) {
      const norm = f.replace(/\\/g, '/')
      if (results[norm] === undefined && results[f] === undefined) {
        errors.push(f)
        errorReasons[f] = 'Falha na compressão'
      }
    }

    return { results, errors, errorReasons }
  }
}
