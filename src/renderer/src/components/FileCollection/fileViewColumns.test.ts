// @vitest-environment jsdom
/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Congelar a identidade entre o default de buildFileViewTemplate e o template declarado no FileView.css.
2. Validar overrides de coluna, sanitização de preferências corrompidas e os limites de clamp.

Mapa de Relacionamentos do Script

1. ./fileViewColumns.ts
   - Tipo: Dependência Direta
   - Relação: Módulo puro sob teste.
   - Criticidade: Alta

2. ./FileView.css
   - Tipo: Contrato / Interface
   - Relação: Fonte da verdade do template default em CSS — lido como texto e comparado ao builder.
   - Criticidade: Alta

Invariantes do Script

1. O default do builder e o CSS devem permanecer byte-idênticos (normalizando apenas whitespace); divergir quebra este teste E R-B3.1 — intencional.
2. Sanitização nunca lança: qualquer unknown produz um override válido ou vazio.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  buildFileViewTemplate,
  sanitizeColumnWidths,
  FILE_VIEW_COLUMN_MIN
} from './fileViewColumns'

const dir = path.dirname(fileURLToPath(import.meta.url))

/** Extrae o valor del la custom property `--fv-grid-template` declara em `.fv-container`, normalizando whitespace. Sprint 1: la plantilla literal ya no vie em `.fv-header`; esta custom property es la única fonte de geometría. */
const cssDefaultTemplate = (): string => {
  const css = readFileSync(path.resolve(dir, 'FileView.css'), 'utf-8')
  const block = /^\.fv-container\s*\{([^}]*)\}/m.exec(css)?.[1] ?? ''
  const decl = /--fv-grid-template:\s*([^;]+);/.exec(block)?.[1] ?? ''
  return decl.replace(/\s+/g, ' ').trim()
}

describe('buildFileViewTemplate', () => {
  it('default é byte-idêntico à la custom property `--fv-grid-template` do .fv-container (identidade builder↔CSS)', () => {
    expect(buildFileViewTemplate()).toBe(cssDefaultTemplate())
    expect(buildFileViewTemplate()).toBe(
      '48px minmax(180px, 1.2fr) minmax(120px, 1fr) minmax(200px, 2fr) 120px'
    )
  })

  it('override de tags produz track px na posição correta, demais inalterados', () => {
    expect(buildFileViewTemplate({ tags: 300 })).toBe(
      '48px minmax(180px, 1.2fr) minmax(120px, 1fr) 300px 120px'
    )
    expect(buildFileViewTemplate({ identity: 250, tokens: 100 })).toBe(
      '48px 250px minmax(120px, 1fr) minmax(200px, 2fr) 100px'
    )
  })

  it('override de toggle produz track px na primeira posição (Sprint 4)', () => {
    expect(buildFileViewTemplate({ toggle: 60 })).toBe(
      '60px minmax(180px, 1.2fr) minmax(120px, 1fr) minmax(200px, 2fr) 120px'
    )
  })

  it('override de actions é ignorado (coluna removida — Sprint 8)', () => {
    // A chave actions não faz mais parte de FILE_VIEW_RESIZABLE_COLUMNS: o override
    // é descartado e o default de 5 tracks permanece intacto.
    expect(buildFileViewTemplate({ actions: 80 } as any)).toBe(
      '48px minmax(180px, 1.2fr) minmax(120px, 1fr) minmax(200px, 2fr) 120px'
    )
  })

  it('overrides inválidos (NaN/Infinity) caem no default/clamp', () => {
    expect(buildFileViewTemplate({ tags: NaN })).toBe(buildFileViewTemplate())
    expect(buildFileViewTemplate({ tags: Infinity })).toBe(buildFileViewTemplate())
    expect(buildFileViewTemplate({ tags: 10 })).toBe(
      '48px minmax(180px, 1.2fr) minmax(120px, 1fr) 10px 120px'
    )
  })
})

describe('sanitizeColumnWidths', () => {
  it('aceita parciais válidos (inclusive valores pequenos)', () => {
    expect(sanitizeColumnWidths({ tags: 320 })).toEqual({ tags: 320 })
    expect(sanitizeColumnWidths({ identity: 200, tokens: 110 })).toEqual({
      identity: 200,
      tokens: 110
    })
    expect(sanitizeColumnWidths({ tags: 15 })).toEqual({ tags: 15 })
  })

  it('backward compatibility: preferências antigas com 4 chaves são preservadas (Sprint 4)', () => {
    expect(sanitizeColumnWidths({ identity: 200, path: 150, tags: 300, tokens: 120 })).toEqual({
      identity: 200,
      path: 150,
      tags: 300,
      tokens: 120
    })
  })

  it('backward compatibility: preferências antigas com chave actions são ignoradas (Sprint 8)', () => {
    // Sprint 8 removeu a coluna de ações do grid: uma preferência persistida com a
    // chave 'actions' deve ser silenciosamente descartada pelo sanitizer.
    expect(sanitizeColumnWidths({ toggle: 60, actions: 80 })).toEqual({ toggle: 60 })
    expect(sanitizeColumnWidths({ actions: 0 })).toEqual({})
  })

  it('clampa negativos em 0 e acima de 10000', () => {
    expect(sanitizeColumnWidths({ tags: -50 })).toEqual({})
    expect(sanitizeColumnWidths({ tags: 99999 }).tags).toBe(10000)
  })

  it('descarta lixo: chaves desconhecidas, non-number, non-finite e non-object', () => {
    expect(sanitizeColumnWidths({ foo: 100, tags: 'abc', path: null, identity: NaN })).toEqual({})
    expect(sanitizeColumnWidths('corrompido')).toEqual({})
    expect(sanitizeColumnWidths(null)).toEqual({})
    expect(sanitizeColumnWidths(undefined)).toEqual({})
    expect(sanitizeColumnWidths(42)).toEqual({})
  })
})
