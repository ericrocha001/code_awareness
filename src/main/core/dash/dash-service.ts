/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Orquestrar a pipeline completa de execução do Code Dash: Parsing, Validação, Resolução, Planejamento, Provedores e Montagem XML.
2. Coordenar a execução concorrente dos provedores de conteúdo mantendo integridade e tratamento de falhas parciais.
3. Retornar o documento canônico final com metadados e relatório estruturado de erros.
4. Instrumentar a pipeline com timings de observabilidade para diagnóstico no processo principal.

Mapa de Relacionamentos do Script

1. dash-request-parser.ts
   - Tipo: Dependência Direta
   - Relação: Executa o parsing inicial do texto de entrada.
   - Criticidade: Alta

2. dash-request-validator.ts
   - Tipo: Dependência Direta
   - Relação: Valida a conformidade de schema e segurança do protocolo.
   - Criticidade: Alta

3. dash-file-resolver.ts
   - Tipo: Dependência Direta
   - Relação: Reconcilia caminhos com o sistema de arquivos.
   - Criticidade: Alta

4. dash-execution-planner.ts
   - Tipo: Dependência Direta
   - Relação: Estrutura o plano determinístico de execução.
   - Criticidade: Alta

5. providers/context-provider.ts
   - Tipo: Contrato / Interface
   - Relação: Interage com os provedores Source e Compression via interface comum.
   - Criticidade: Alta

6. dash-context-assembler.ts
   - Tipo: Dependência Direta
   - Relação: Compõe o XML canônico com nós de conteúdo e falhas.
   - Criticidade: Alta

Invariantes do Script

1. O serviço é um orquestrador puro, sem implementar lógica inline de parsing, cache, resolução ou formatação XML.
2. Falhas parciais em arquivos ou provedores não interrompem a geração dos arquivos bem-sucedidos.
3. A ordem original dos itens declarada no pedido é preservada em todos os estágios do pipeline.
4. Timings são apenas informativos — nunca governam decisões de abortar ou escalar.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import type { DashContextPlan } from '../../../shared/types/dash-types'
import { assembleContext } from './dash-context-assembler'
import { planExecution } from './dash-execution-planner'
import { DashFileResolver } from './dash-file-resolver'
import { parseDashRequest } from './dash-request-parser'
import { validateDashRequest } from './dash-request-validator'
import type {
  ContextProvider,
  DashExecutionOptions
} from './providers/context-provider'

export interface DashExecutionResult {
  success: boolean
  xml?: string
  metadata?: {
    requested: number
    resolved: number
    generated: number
    failed: number
  }
  timings?: {
    parseMs: number
    validateMs: number
    resolveMs: number
    planMs: number
    generateMs: number
    assembleMs: number
    totalMs: number
  }
  failures?: Array<{ index: number; path: string; reason: string }>
  error?: string
}

export class DashService {
  constructor(
    private readonly resolver:
      | DashFileResolver
      | ((repoPath: string) => DashFileResolver),
    private readonly sourceProvider: ContextProvider,
    private readonly compressionProvider: ContextProvider
  ) {}

  /**
   * Executa a orquestração do Code Dash de ponta a ponta a partir de uma entrada bruta de texto.
   * Inclui instrumentação de timings para observabilidade no processo principal.
   */
  public async execute(
    input: string,
    repoPath: string,
    options?: DashExecutionOptions
  ): Promise<DashExecutionResult> {
    const totalStart = performance.now()

    // 1. Parsing tolerante
    const parseStart = performance.now()
    const parseResult = parseDashRequest(input)
    const parseMs = performance.now() - parseStart
    if (!parseResult.success) {
      return {
        success: false,
        error: `Falha no parsing da requisição: ${parseResult.error}`
      }
    }

    // 2. Validação estrita
    const validateStart = performance.now()
    const validationResult = validateDashRequest(parseResult.request)
    const validateMs = performance.now() - validateStart
    if (!validationResult.success) {
      return {
        success: false,
        error: `Falha na validação da requisição: ${validationResult.error}`
      }
    }
    const validRequest = validationResult.request

    // 3. Resolução no sistema de arquivos
    const resolveStart = performance.now()
    const resolverInstance =
      typeof this.resolver === 'function'
        ? this.resolver(repoPath)
        : this.resolver ?? new DashFileResolver(repoPath)

    const resolution = resolverInstance.resolve(validRequest.items, validRequest)
    const resolveMs = performance.now() - resolveStart

    // 4. Planejamento determinístico
    const planStart = performance.now()
    const plan = planExecution(validRequest, resolution)
    const planMs = performance.now() - planStart

    // 5. Separação por representação
    const sourceItems = plan.plannedItems.filter(
      (it) => it.representation === 'source'
    )
    const compressionItems = plan.plannedItems.filter(
      (it) => it.representation === 'compression'
    )

    // 6. Execução paralela dos provedores apropriados
    const execOptions: DashExecutionOptions = {
      repoPath,
      signal: options?.signal
    }

    const generateStart = performance.now()
    const [sourceResult, compressionResult] = await Promise.all([
      sourceItems.length > 0
        ? this.sourceProvider.provide(sourceItems, execOptions)
        : Promise.resolve({
            contents: new Map<number, string>(),
            failures: []
          }),
      compressionItems.length > 0
        ? this.compressionProvider.provide(compressionItems, execOptions)
        : Promise.resolve({
            contents: new Map<number, string>(),
            failures: []
          })
    ])
    const generateMs = performance.now() - generateStart

    // 7. Consolidação de conteúdos
    const combinedContents = new Map<number, string>()
    for (const [index, content] of sourceResult.contents) {
      combinedContents.set(index, content)
    }
    for (const [index, content] of compressionResult.contents) {
      combinedContents.set(index, content)
    }

    // 8. Consolidação de falhas (resolução + provedores)
    const allFailures: Array<{ index: number; path: string; reason: string }> = [
      ...resolution.failures.map((f) => ({
        index: f.index,
        path: f.path,
        reason: f.reason
      }))
    ]

    for (const sf of sourceResult.failures) {
      const origItem = validRequest.items[sf.index]
      allFailures.push({
        index: sf.index,
        path: origItem?.path ?? '',
        reason: sf.reason
      })
    }

    for (const cf of compressionResult.failures) {
      const origItem = validRequest.items[cf.index]
      allFailures.push({
        index: cf.index,
        path: origItem?.path ?? '',
        reason: cf.reason
      })
    }

    // 9. Montagem do XML canônico
    const assembleStart = performance.now()
    const generatedPlannedItems = plan.plannedItems.filter((it) =>
      combinedContents.has(it.index)
    )

    const finalPlan: DashContextPlan = {
      metadata: {
        requestedCount: validRequest.items.length,
        resolvedCount: generatedPlannedItems.length,
        failedCount: allFailures.length
      },
      plannedItems: generatedPlannedItems,
      failures: allFailures.map((f) => ({
        index: f.index,
        path: f.path,
        reason: f.reason as any
      }))
    }

    const xml = assembleContext(finalPlan, combinedContents)
    const assembleMs = performance.now() - assembleStart
    const totalMs = performance.now() - totalStart

    const timings = {
      parseMs: Math.round(parseMs),
      validateMs: Math.round(validateMs),
      resolveMs: Math.round(resolveMs),
      planMs: Math.round(planMs),
      generateMs: Math.round(generateMs),
      assembleMs: Math.round(assembleMs),
      totalMs: Math.round(totalMs)
    }

    console.log(
      `[DashService] execute completed: parse=${timings.parseMs}ms, ` +
        `validate=${timings.validateMs}ms, resolve=${timings.resolveMs}ms, ` +
        `plan=${timings.planMs}ms, generate=${timings.generateMs}ms, ` +
        `assemble=${timings.assembleMs}ms, total=${timings.totalMs}ms`
    )

    // 10. Retorno estruturado do resultado
    return {
      success: true,
      xml,
      metadata: {
        requested: validRequest.items.length,
        resolved: plan.plannedItems.length,
        generated: combinedContents.size,
        failed: allFailures.length
      },
      timings,
      failures: allFailures
    }
  }

  /**
   * Executa apenas as etapas de parsing, validação e resolução de arquivos sem gerar conteúdo.
   */
  public parseAndResolve(
    input: string,
    repoPath: string
  ): {
    success: boolean
    data?: import('../../../shared/types/dash-types').DashResolutionReport
    error?: string
  } {
    const parseResult = parseDashRequest(input)
    if (!parseResult.success) {
      return {
        success: false,
        error: `Falha no parsing da requisição: ${parseResult.error}`
      }
    }

    const validationResult = validateDashRequest(parseResult.request)
    if (!validationResult.success) {
      return {
        success: false,
        error: `Falha na validação da requisição: ${validationResult.error}`
      }
    }
    const validRequest = validationResult.request

    const resolverInstance =
      typeof this.resolver === 'function'
        ? this.resolver(repoPath)
        : this.resolver ?? new DashFileResolver(repoPath)

    const resolution = resolverInstance.resolve(validRequest.items, validRequest)

    return {
      success: true,
      data: resolution
    }
  }
}
