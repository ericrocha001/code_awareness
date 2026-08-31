/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Adaptar a porta StructuredCompressionPort para a interface ContextProvider do protocolo Code Dash.
2. Agrupar itens por perfil de compressão e delegar a compressão estruturada em lote ao serviço subjacente.
3. Mapear resultados individuais (sucessos e falhas) diretamente para os índices originais dos itens sem parsing de texto.
4. Fornecer compatibilidade defensiva caso mocks legados com generateCompressionMarkdown sejam injetados em testes.

Mapa de Relacionamentos do Script

1. context-provider.ts
   - Tipo: Contrato / Interface
   - Relação: Implementa a interface ContextProvider.
   - Criticidade: Alta

2. src/main/core/structured-compression-port.ts
   - Tipo: Contrato / Interface
   - Relação: Consome a porta StructuredCompressionPort para execução estruturada da compressão.
   - Criticidade: Alta

3. src/main/core/compression-profile.ts
   - Tipo: Dependência Direta
   - Relação: Utiliza DEFAULT_PROFILE como configuração padrão de compressão.
   - Criticidade: Média

4. src/shared/types/dash-types.ts
   - Tipo: Contrato / Interface
   - Relação: Consome o tipo DashPlannedItem para tipagem dos itens a processar.
   - Criticidade: Alta

Invariantes do Script

1. O provider consome prioritariamente a API estruturada de compressão sem parsing textual frágil.
2. Cada resultado de sucesso ou falha é indexado estritamente pela propriedade index original do DashPlannedItem.
3. Itens com o mesmo perfil de compressão são agrupados para execução em lote único (batch).

--- FIM ARQUITETURA DO SCRIPT ---
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
      let profileKey = 'default'

      if (typeof item.profile === 'string') {
        try {
          parsedProfile = JSON.parse(item.profile)
          profileKey = item.profile
        } catch {
          parsedProfile = DEFAULT_PROFILE
          profileKey = 'default'
        }
      } else if (item.profile && typeof item.profile === 'object') {
        parsedProfile = item.profile as CompressionProfile
        profileKey = JSON.stringify(parsedProfile)
      }

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
