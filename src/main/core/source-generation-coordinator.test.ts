/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar o contrato do SourceGenerationCoordinator: geração única, auto-cancelamento por sessão, descarte de resultado cancelado, isolamento entre sessões distintas e limpeza do mapa de sessões.

Mapa de Relacionamentos do Script

1. source-generation-coordinator.ts
   - Tipo: Dependência Direta
   - Relação: Testa o método generate com CodeSourceService falsificado injetado.
   - Criticidade: Alta

2. generation-errors.ts
   - Tipo: Dependência Direta
   - Relação: Importa GenerationCancelledError para simular cancelamento no service falsificado.
   - Criticidade: Alta

Invariantes do Script

1. Nenhum teste executa Repomix real nem acessa filesystem real.
2. O service falsificado controla resolução e rejeição para simular todos os fluxos.
3. Auto-cancelamento é verificado pela ausência de resultado da primeira geração.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect, vi } from 'vitest'
import { SourceGenerationCoordinator } from './source-generation-coordinator'
import { GenerationCancelledError } from './generation-errors'
import { CodeSourceService } from './code-source-service'

const SESSION = 'repo/path|modal'
const BASE_INPUT = {
  repoPath: 'C:\\repos\\demo',
  selectedFiles: ['src/a.ts']
}

/** Cria um CodeSourceService falsificado com generateWithProfile controlável. */
function makeFakeService(
  impl: (input: { signal?: AbortSignal; [key: string]: unknown }) => Promise<{ success: boolean; content?: string; tokenCount?: number; error?: string }>
): CodeSourceService {
  return {
    generateWithProfile: vi.fn(impl)
  } as unknown as CodeSourceService
}

describe('SourceGenerationCoordinator', () => {
  it('geração única: invoca o service uma vez e ecoa o generationId', async () => {
    const service = makeFakeService(async () => ({ success: true, content: 'ok', tokenCount: 1 }))
    const coordinator = new SourceGenerationCoordinator(service)

    const result = await coordinator.generate(SESSION, 1, BASE_INPUT)

    expect(result.success).toBe(true)
    expect(result.content).toBe('ok')
    expect(result.generationId).toBe(1)
    expect(service.generateWithProfile).toHaveBeenCalledTimes(1)
  })

  it('auto-cancelamento: segunda chamada aborta a primeira geração da mesma sessão', async () => {
    let capturedSignal: AbortSignal | undefined
    let callCount = 0

    const service = makeFakeService(async (input) => {
      callCount++
      const signal = input.signal as AbortSignal | undefined
      if (callCount === 1) {
        capturedSignal = signal
        // Primeira geração: suspensa até o signal ser abortado.
        return new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new GenerationCancelledError()))
        })
      }
      // Segunda geração: retorna imediatamente.
      return { success: true, content: 'second', tokenCount: 2 }
    })

    const coordinator = new SourceGenerationCoordinator(service)

    // Lança a primeira geração sem aguardar.
    const firstPromise = coordinator.generate(SESSION, 1, BASE_INPUT).catch(() => 'cancelled')

    // Cede o event loop para o service registrar o signal da primeira geração.
    await new Promise(resolve => setTimeout(resolve, 20))

    // Segunda geração — aborta a primeira e executa normalmente.
    const secondResult = await coordinator.generate(SESSION, 2, { ...BASE_INPUT, selectedFiles: ['src/b.ts'] })
    const firstResult = await firstPromise

    expect(firstResult).toBe('cancelled')
    expect(capturedSignal?.aborted).toBe(true)
    expect(secondResult.success).toBe(true)
    expect(secondResult.generationId).toBe(2)
  }, 3000)

  it('descarte de resultado cancelado: GenerationCancelledError é relançado pelo coordenador', async () => {
    const service = makeFakeService(async () => {
      throw new GenerationCancelledError('cancelado')
    })
    const coordinator = new SourceGenerationCoordinator(service)

    await expect(coordinator.generate(SESSION, 1, BASE_INPUT)).rejects.toBeInstanceOf(GenerationCancelledError)
  })

  it('gerações em sessões diferentes não se cancelam mutuamente', async () => {
    let resolveFirst!: (value: { success: boolean; content: string; tokenCount: number }) => void
    const firstSettled = new Promise<{ success: boolean; content: string; tokenCount: number }>(
      resolve => { resolveFirst = resolve }
    )

    const service = makeFakeService(async ({ signal }) => {
      if (signal?.aborted) throw new GenerationCancelledError()
      return firstSettled
    })

    const coordinator = new SourceGenerationCoordinator(service)

    const firstPromise = coordinator.generate('session-A', 1, BASE_INPUT)
    const secondPromise = coordinator.generate('session-B', 1, BASE_INPUT)

    // Resolve ambas manualmente
    resolveFirst({ success: true, content: 'A', tokenCount: 1 })

    const [first, second] = await Promise.all([firstPromise, secondPromise])

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
  })

  it('propagação de sinal: AbortSignal é passado ao service', async () => {
    let receivedSignal: AbortSignal | undefined

    const service = makeFakeService(async ({ signal }) => {
      receivedSignal = signal
      return { success: true, content: 'ok', tokenCount: 1 }
    })
    const coordinator = new SourceGenerationCoordinator(service)

    await coordinator.generate(SESSION, 1, BASE_INPUT)

    expect(receivedSignal).toBeInstanceOf(AbortSignal)
    expect(receivedSignal?.aborted).toBe(false)
  })

  it('limpeza do mapa: entrada é removida após geração concluída com sucesso', async () => {
    const service = makeFakeService(async () => ({ success: true, content: 'ok', tokenCount: 1 }))
    const coordinator = new SourceGenerationCoordinator(service)

    await coordinator.generate(SESSION, 1, BASE_INPUT)

    // Segunda geração com o mesmo generationId não deve abortar nada (mapa foi limpo).
    const result = await coordinator.generate(SESSION, 1, BASE_INPUT)
    expect(result.success).toBe(true)
    expect(service.generateWithProfile).toHaveBeenCalledTimes(2)
  })
})
