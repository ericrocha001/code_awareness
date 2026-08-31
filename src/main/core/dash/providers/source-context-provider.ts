/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Adaptar o CodeSourceService para a interface ContextProvider do protocolo Code Dash.
2. Executar a geração sequencial de código-fonte em formato XML para os arquivos planejados.
3. Tratar falhas individuais de geração e respeitar sinais de cancelamento AbortSignal.

Mapa de Relacionamentos do Script

1. context-provider.ts
   - Tipo: Contrato / Interface
   - Relação: Implementa a interface ContextProvider.
   - Criticidade: Alta

2. src/main/core/code-source-service.ts
   - Tipo: Dependência Direta
   - Relação: Delega a extração de código-fonte ao CodeSourceService.
   - Criticidade: Alta

3. src/shared/utils/source-profile.ts
   - Tipo: Dependência Direta
   - Relação: Utiliza DEFAULT_SOURCE_PROFILE como perfil padrão de extração.
   - Criticidade: Média

Invariantes do Script

1. Executar os itens de forma estritamente sequencial para não sobrecarregar processos externos do Repomix.
2. Usar invariavelmente o formato 'xml' como formato canônico de extração.
3. Não criar cache próprio ou duplicar lógica de geração de arquivos.

--- FIM ARQUITETURA DO SCRIPT ---
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
        const result = await this.codeSourceService.generateWithProfile({
          repoPath: options.repoPath,
          selectedFiles: [item.path],
          format: 'xml',
          profile: item.profile ?? DEFAULT_SOURCE_PROFILE,
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
