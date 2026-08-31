/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar unitariamente o planejador de execução de contexto do Code Dash.
2. Garantir preservação de ordem, mapeamento de índices e filtragem de falhas parciais.

Mapa de Relacionamentos do Script

1. src/main/core/dash/dash-execution-planner.ts
   - Tipo: Dependência Direta
   - Relação: Executa a função planExecution e valida os planos gerados.
   - Criticidade: Alta

Invariantes do Script

1. Operar puramente em memória sem qualquer I/O ou dependência de filesystem.
2. Cobrir todos os cenários obrigatórios de planejamento da Sprint 2.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, expect, it } from 'vitest'
import type {
  DashRequest,
  DashResolutionReport
} from '../../../shared/types/dash-types'
import { planExecution } from './dash-execution-planner'

describe('planExecution', () => {
  it('deve gerar plano preservando a ordem quando todos os itens forem resolvidos', () => {
    const request: DashRequest = {
      protocol: 'code-dash/v1',
      output: { format: 'xml' },
      items: [
        { path: 'src/a.ts', representation: 'source' },
        { path: 'src/b.ts', representation: 'compression' },
        { path: 'src/c.ts', representation: 'source' }
      ]
    }

    const resolution: DashResolutionReport = {
      valid: true,
      request: {
        protocol: 'code-dash/v1',
        output: { format: 'xml' },
        items: [
          { path: 'src/a.ts', representation: 'source' },
          { path: 'src/b.ts', representation: 'compression' },
          { path: 'src/c.ts', representation: 'source' }
        ]
      },
      failures: []
    }

    const plan = planExecution(request, resolution)

    expect(plan.metadata).toEqual({
      requestedCount: 3,
      resolvedCount: 3,
      failedCount: 0
    })
    expect(plan.plannedItems).toEqual([
      { index: 0, path: 'src/a.ts', representation: 'source' },
      { index: 1, path: 'src/b.ts', representation: 'compression' },
      { index: 2, path: 'src/c.ts', representation: 'source' }
    ])
    expect(plan.failures).toHaveLength(0)
  })

  it('deve filtrar itens que falharam e preservar a ordem dos itens resolvidos', () => {
    const request: DashRequest = {
      protocol: 'code-dash/v1',
      output: { format: 'xml' },
      items: [
        { path: 'item-0.ts', representation: 'source' },
        { path: 'item-1.ts', representation: 'compression' },
        { path: 'item-2.ts', representation: 'source' },
        { path: 'item-3.ts', representation: 'compression' },
        { path: 'item-4.ts', representation: 'source' }
      ]
    }

    const resolution: DashResolutionReport = {
      valid: false,
      request: {
        protocol: 'code-dash/v1',
        output: { format: 'xml' },
        items: [
          { path: 'src/item-0.ts', representation: 'source' },
          { path: 'src/item-2.ts', representation: 'source' },
          { path: 'src/item-4.ts', representation: 'source' }
        ]
      },
      failures: [
        { index: 1, path: 'item-1.ts', reason: 'not_found' },
        { index: 3, path: 'item-3.ts', reason: 'ambiguous' }
      ]
    }

    const plan = planExecution(request, resolution)

    expect(plan.metadata).toEqual({
      requestedCount: 5,
      resolvedCount: 3,
      failedCount: 2
    })
    expect(plan.plannedItems).toEqual([
      { index: 0, path: 'src/item-0.ts', representation: 'source' },
      { index: 2, path: 'src/item-2.ts', representation: 'source' },
      { index: 4, path: 'src/item-4.ts', representation: 'source' }
    ])
    expect(plan.failures).toEqual(resolution.failures)
  })

  it('deve manter itens que resolveram para o mesmo path físico com índices e ordens preservados', () => {
    const request: DashRequest = {
      protocol: 'code-dash/v1',
      output: { format: 'xml' },
      items: [
        { path: 'helper.ts', representation: 'source' },
        { path: 'src/utils/helper.ts', representation: 'compression' }
      ]
    }

    const resolution: DashResolutionReport = {
      valid: true,
      request: {
        protocol: 'code-dash/v1',
        output: { format: 'xml' },
        items: [
          { path: 'src/utils/helper.ts', representation: 'source' },
          { path: 'src/utils/helper.ts', representation: 'compression' }
        ]
      },
      failures: []
    }

    const plan = planExecution(request, resolution)

    expect(plan.plannedItems).toEqual([
      { index: 0, path: 'src/utils/helper.ts', representation: 'source' },
      { index: 1, path: 'src/utils/helper.ts', representation: 'compression' }
    ])
  })

  it('deve suportar mixed mode (source + compression) preservando tipos', () => {
    const request: DashRequest = {
      protocol: 'code-dash/v1',
      output: { format: 'xml' },
      items: [
        { path: 'src/types.ts', representation: 'source' },
        { path: 'src/service.ts', representation: 'compression' }
      ]
    }

    const resolution: DashResolutionReport = {
      valid: true,
      request,
      failures: []
    }

    const plan = planExecution(request, resolution)

    expect(plan.plannedItems[0].representation).toBe('source')
    expect(plan.plannedItems[1].representation).toBe('compression')
  })
})
