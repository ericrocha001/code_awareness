/*
-T ---
*/

import type { DashPlannedItem } from '../../../../shared/types/dash-types'
import { DEFAULT_SOURCE_PROFILE } from '../../../../shared/utils/source-profile'
import type { CodeSourceService } from '../../code-source-service'
import type {
  ContextProvider,
  DashExecutionOptions,
  DashProviderFailure,
  DashProviderResult
} from './context-provider'

export class SourceContextProvider implements ContextProvider {
  constructor(private readonly codeSourceService: CodeSourceService) {}

  public async provide(
    items: DashPlannedItem[],
    options: DashExecutionOptions
  ): Promise<DashProviderResult> {
    const contents = new Map<number, string>()
    const failures: DashProviderFailure[] = []

    for (const item of items) {
      if (options.signal?.aborted) {
        throw new Error('Operação cancelada pelo usuário')
      }

      try {
        // Resolve o profile base do item e aplica o merge das configurações globais de economia.
        // O merge sobrescreve apenas os três campos econômicos; os demais campos do profile base são preservados.
        const baseProfile = item.profile ?? DEFAULT_SOURCE_PROFILE
        const effectiveProfile = options.settings
          ? {
              ...baseProfile,
              removeComments: options.settings.removeComments,
              removeEmptyLines: options.settings.removeEmptyLines,
              truncateBase64: options.settings.truncateBase64
            }
          : baseProfile

        const result = await this.codeSourceService.generateWithProfile({
          repoPath: options.repoPath,
          selectedFiles: [item.path],
          format: 'xml',
          profile: effectiveProfile,
          signal: options.signal
        })

        if (result.success && typeof result.content === 'string') {
          contents.set(item.index, result.content)
        } else {
          failures.push({
            index: item.index,
            reason: result.error || `Falha ao extrair código-fonte de ${item.path}`
          })
        }
      } catch (error) {
        if (options.signal?.aborted) {
          throw error
        }
        failures.push({
          index: item.index,
          reason:
            error instanceof Error
              ? error.message
              : `Erro inesperado ao gerar ${item.path}`
        })
      }
    }

    return {
      contents,
      failures
    }
  }
}
