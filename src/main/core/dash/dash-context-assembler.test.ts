/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar unitariamente a composição do documento XML canônico gerado pelo Code Dash.
2. Garantir conformidade com schema XML, ordenação de itens, inclusão de falhas e escape seguro em CDATA.

Mapa de Relacionamentos do Script

1. src/main/core/dash/dash-context-assembler.ts
   - Tipo: Dependência Direta
   - Relação: Executa assembleContext e valida o XML gerado.
   - Criticidade: Alta

Invariantes do Script

1. Testes devem rodar puramente em memória sem qualquer I/O.
2. O XML produzido deve ser parseável sem erros sintáticos por parsers XML padrão.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import type { DashContextPlan } from '../../../shared/types/dash-types'
import { assembleContext } from './dash-context-assembler'

describe('assembleContext', () => {
  const fixedTimestamp = '2026-08-28T20:00:00.000Z'

  it('deve montar XML completo com 3 itens na ordem correta', () => {
    const plan: DashContextPlan = {
      metadata: {
        requestedCount: 3,
        resolvedCount: 3,
        failedCount: 0
      },
      plannedItems: [
        { index: 0, path: 'src/a.ts', representation: 'source' },
        { index: 1, path: 'src/b.ts', representation: 'compression' },
        { index: 2, path: 'src/c.ts', representation: 'source' }
      ],
      failures: []
    }

    const results = new Map<number, string>([
      [0, 'export const a = 1;'],
      [1, '// compressed b'],
      [2, 'export const c = 3;']
    ])

    const xml = assembleContext(plan, results, fixedTimestamp)

    expect(xml).toContain('version="code-dash/v1"')
    expect(xml).toContain(`generated-at="${fixedTimestamp}"`)
    expect(xml).toContain('<requested-count>3</requested-count>')
    expect(xml).toContain('<resolved-count>3</resolved-count>')
    expect(xml).toContain('<failed-count>0</failed-count>')
    expect(xml).toContain('item index="0" path="src/a.ts" representation="source"')
    expect(xml).toContain('item index="1" path="src/b.ts" representation="compression"')
    expect(xml).toContain('item index="2" path="src/c.ts" representation="source"')
    expect(xml).toContain('export const a = 1;')
  })

  it('deve montar XML com falhas e itens quando houver resolução parcial', () => {
    const plan: DashContextPlan = {
      metadata: {
        requestedCount: 5,
        resolvedCount: 3,
        failedCount: 2
      },
      plannedItems: [
        { index: 0, path: 'src/a.ts', representation: 'source' },
        { index: 2, path: 'src/c.ts', representation: 'compression' },
        { index: 4, path: 'src/e.ts', representation: 'source' }
      ],
      failures: [
        { index: 1, path: 'missing.ts', reason: 'not_found' },
        { index: 3, path: 'ambiguous.ts', reason: 'ambiguous' }
      ]
    }

    const results = new Map<number, string>([
      [0, 'content a'],
      [2, 'content c'],
      [4, 'content e']
    ])

    const xml = assembleContext(plan, results, fixedTimestamp)

    expect(xml).toContain('<requested-count>5</requested-count>')
    expect(xml).toContain('<resolved-count>3</resolved-count>')
    expect(xml).toContain('<failed-count>2</failed-count>')
    expect(xml).toContain('<failure index="1" path="missing.ts" reason="not_found" />')
    expect(xml).toContain('<failure index="3" path="ambiguous.ts" reason="ambiguous" />')
    expect(xml).toContain('item index="0"')
    expect(xml).toContain('item index="2"')
    expect(xml).toContain('item index="4"')
  })

  it('deve encapsular caracteres especiais e sequências CDATA aninhadas com segurança', () => {
    const plan: DashContextPlan = {
      metadata: {
        requestedCount: 1,
        resolvedCount: 1,
        failedCount: 0
      },
      plannedItems: [
        { index: 0, path: 'src/tricky.ts', representation: 'source' }
      ],
      failures: []
    }

    // Código contendo tags, ampersands e a sequência proibida ]]>
    const trickyCode = `
      function test() {
        const html = "<div>&amp; test</div>";
        const cdataEnd = "]]>";
        return 1 < 2 && 3 > 2;
      }
    `

    const results = new Map<number, string>([[0, trickyCode]])
    const xml = assembleContext(plan, results, fixedTimestamp)

    // O XML gerado não pode conter ]]> desprotegido dentro do bloco CDATA
    expect(xml).toContain('<![CDATA[')

    // Parse com JSDOM DOMParser para verificar validade estrita do XML
    const dom = new JSDOM()
    const parser = new dom.window.DOMParser()
    const doc = parser.parseFromString(xml, 'application/xml')

    const parserError = doc.querySelector('parsererror')
    expect(parserError).toBeNull()

    const itemNode = doc.querySelector('item[index="0"]')
    expect(itemNode).not.toBeNull()
    expect(itemNode?.textContent).toContain('<div>&amp; test</div>')
    expect(itemNode?.textContent).toContain(']]>')
  })

  it('deve preservar a ordem não sequencial de itens planejados', () => {
    const plan: DashContextPlan = {
      metadata: {
        requestedCount: 4,
        resolvedCount: 2,
        failedCount: 2
      },
      plannedItems: [
        { index: 3, path: 'src/last.ts', representation: 'source' },
        { index: 1, path: 'src/first.ts', representation: 'compression' }
      ],
      failures: [
        { index: 0, path: 'fail0.ts', reason: 'not_found' },
        { index: 2, path: 'fail2.ts', reason: 'not_found' }
      ]
    }

    const results = new Map<number, string>([
      [3, 'content last'],
      [1, 'content first']
    ])

    const xml = assembleContext(plan, results, fixedTimestamp)

    const index3Pos = xml.indexOf('index="3"')
    const index1Pos = xml.indexOf('index="1"')

    expect(index3Pos).toBeGreaterThan(-1)
    expect(index1Pos).toBeGreaterThan(-1)
    expect(index3Pos).toBeLessThan(index1Pos)
  })

  it('deve gerar XML parseável por DOMParser padrão', () => {
    const plan: DashContextPlan = {
      metadata: {
        requestedCount: 1,
        resolvedCount: 1,
        failedCount: 0
      },
      plannedItems: [
        { index: 0, path: 'src/app.ts', representation: 'source' }
      ],
      failures: []
    }

    const results = new Map<number, string>([[0, 'const x = 42;']])
    const xml = assembleContext(plan, results)

    const dom = new JSDOM()
    const parser = new dom.window.DOMParser()
    const doc = parser.parseFromString(xml, 'application/xml')

    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.querySelector('code-dash-context')?.getAttribute('version')).toBe('code-dash/v1')
    expect(doc.querySelector('metadata requested-count')?.textContent).toBe('1')
    expect(doc.querySelector('item')?.getAttribute('path')).toBe('src/app.ts')
  })
})
