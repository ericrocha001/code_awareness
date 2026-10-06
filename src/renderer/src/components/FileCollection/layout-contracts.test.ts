/*
-T ---
*/

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const read = (file: string): string =>
  readFileSync(path.resolve(dir, file), 'utf-8')

/**
 * Extrai o bloco de declarações de um seletor em CSS plano (sem aninhamento).
 * Âncora em início de linha evita capturar seletores compostos que apenas
 * CONTÊM o nome procurado. Retorna null se o seletor não existir.
 */
const extractBlock = (css: string, selector: string): string | null => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm')
  const match = re.exec(css)
  return match ? match[1] : null
}

const declarationsOf = (block: string | null): string[] =>
  block
    ? block
        .split(';')
        .map((d) => d.replace(/\/\*[\s\S]*?\*\//g, '').trim())
        .filter(Boolean)
        .map((d) => d.replace(/\s+/g, ' ').toLowerCase())
    : []

const has = (decls: string[], prop: string, value?: string): boolean =>
  decls.some((d) =>
    value !== undefined ? d === `${prop}: ${value}` : d.startsWith(`${prop}:`)
  )

const gridTracks = (decls: string[]): string[] => {
  const template = decls.find((d) => d.startsWith('grid-template-columns:'))
  if (!template) return []
  // Remove espaço após vírgula para não dividir tracks dentro de minmax(...)
  return template
    .slice('grid-template-columns:'.length)
    .replace(/,\s+/g, ',')
    .split(/\s+/)
    .filter(Boolean)
}

const fileCardCss = () => read('../FileCard/FileCard.css')
const collectionViewCss = () => read('./FileCollectionView.css')
const fileViewCss = () => read('./FileView.css')
const fileRowCss = () => read('./FileRow.css')
const compressionViewCss = () => read('../CodeCompressionView/CodeCompressionView.css')
const sourceViewCss = () => read('../CodeSourceView/CodeSourceView.css')
const diffViewCss = () => read('../CodeDiffView/CodeDiffView.css')
const codeMapViewCss = () => read('../CodeMapView/CodeMapView.css')
const indexCss = () => read('../../index.css')

/**
 * Extrai as declarações de um seletor COMPOSTO (com ">", ex. .x > .y) em CSS
 * plano. Âncora em início de linha + escape de caracteres especiais — padrão
 * do extractBlock, porém adaptado a seletores compostos. Sprint 5.
 */
const compoundDecls = (css: string, selector: string): string[] => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? ''
  return declarationsOf(block)
}
/**
 * Extrae o valor da custom property --fv-grid-template declarada no bloque
 * .fv-container (fonte única de geometría). Sprint 1: .fr-row e .fv-header
 * consumen esse valor via var(), de modo que os tracks concretos só se leen aquí.
 */
const fvContainerTemplate = (): string => {
  const block = extractBlock(fileViewCss(), '.fv-container')
  const value = /--fv-grid-template:\s*([^;]+);/.exec(block ?? '')?.[1] ?? ''
  return value.replace(/\s+/g, ' ').trim()
}

describe('Contratos de layout — regressões B2–B6', () => {
  // Sprint 2.3: o bloco R-B1 foi removido junto com a eliminação do FileGridView
  // (.fgv-row, altura percentual em .file-card). Ver docs/architecture/filegridview-removal.md.

  describe('R-B2: scroll duplo na cadeia de virtualização', () => {
    it('R-B2.1: containers sem height: 100% e cadeia com min-height: 0', () => {
      const fcv = declarationsOf(extractBlock(collectionViewCss(), '.fcv-container'))
      const dv = declarationsOf(extractBlock(fileViewCss(), '.fv-container'))

      expect(fcv.some((d) => d === 'height: 100%')).toBe(false)
      expect(dv.some((d) => d === 'height: 100%')).toBe(false)

      expect(has(fcv, 'min-height', '0')).toBe(true)
      expect(
        has(declarationsOf(extractBlock(collectionViewCss(), '.fcv-body')), 'min-height', '0')
      ).toBe(true)
      expect(has(dv, 'min-height', '0')).toBe(true)

      // Containers roláveis mantêm flex: 1 + width: 100%
      for (const decls of [fcv, dv]) {
        expect(has(decls, 'flex', '1')).toBe(true)
        expect(has(decls, 'width', '100%')).toBe(true)
      }
    })
  })

  describe('R-B3/R-B4: tokens sobre ações e header amontoado', () => {
    it('R-B3.1: .fr-row e .fv-header consumen a custom property --fv-grid-template', () => {
      const row = declarationsOf(extractBlock(fileRowCss(), '.fr-row'))
      const header = declarationsOf(extractBlock(fileViewCss(), '.fv-header'))

      // Identidade header↔rows agora fica garantida por construção: ambos consumem
      // a MESMA custom property via var(). O teste valida que ambos declaram o mesmo
      // var() e que o valor da custom property preserves os tracks contractans.
      expect(has(row, 'grid-template-columns', 'var(--fv-grid-template)')).toBe(true)
      expect(has(header, 'grid-template-columns', 'var(--fv-grid-template)')).toBe(true)

      const tracks = gridTracks([`grid-template-columns: ${fvContainerTemplate()}`])
      expect(tracks.length).toBe(5)
      // Quinto track (tokens) = 120px fixos (>= mínimo exigido). Sprint 8: a
      // coluna de ações foi removida (o botão é absoluto, .fr-action-btn).
      expect(tracks[4]).toBe('120px')
    })

    it('R-B4.1: o primeiro track do template canónico (custom property) é 48px', () => {
      const tracks = gridTracks([`grid-template-columns: ${fvContainerTemplate()}`])
      // Sprint 4: toggle passa a ser redimensionável; default desce de 64px para
      // 48px para eliminar espaço morto à direita do ToggleSwitch. La lectura se
      // faz da custom property porque a geometría agora fica no .fv-container.
      expect(tracks[0]).toBe('48px')
    })

    it('R-B4.2: células de toggle ancoram a alça (position: relative)', () => {
      for (const selector of ['.fv-col-toggle']) {
        const decls = declarationsOf(extractBlock(fileViewCss(), selector))
        expect(has(decls, 'position', 'relative'), `bloco/track ausente: ${selector}`)
          .toBe(true)
      }
    })
  })

  it('R-B3.2: gap: 12px em ambos e badge de tokens alinhado à esquerda (Sprint 4)', () => {
    const row = declarationsOf(extractBlock(fileRowCss(), '.fr-row'))
    const header = declarationsOf(extractBlock(fileViewCss(), '.fv-header'))
    expect(has(row, 'gap', '12px')).toBe(true)
    expect(has(header, 'gap', '12px')).toBe(true)

    const tokens = declarationsOf(extractBlock(fileRowCss(), '.fr-tokens'))
    // Sprint 4: Tokens alinhado à esquerda para que o redimensionamento afaste
    // visualmente Tokens de Actions (o TokenBadge permanece à esquerda enquanto
    // o botão de Actions se desloca para a direita).
    expect(has(tokens, 'justify-content', 'flex-start')).toBe(true)
  })

  it('R-B3.2b: .fv-col-tokens declara text-align: left (consistente com .fr-tokens)', () => {
    // .fv-col-tokens também aparece agrupado com as demais células redimensionáveis
    // (position: relative). Procuramos o bloco standalone que declara text-align.
    const css = fileViewCss()
    const re = /^\.fv-col-tokens\s*\{([^}]*)\}/gm
    let found = false
    let match: RegExpExecArray | null
    while ((match = re.exec(css)) !== null) {
      const decls = declarationsOf(match[1])
      if (has(decls, 'text-align', 'left')) found = true
    }
    expect(found).toBe(true)
  })

  // Sprint 4: superfície de scroll bidirecional única + header sticky.
  describe('R-B8: scroll bidirecional e header sticky', () => {
    it('R-B8.1: .fv-scroll-container declara overflow: auto (sem overflow-y/x separados)', () => {
      const decls = declarationsOf(extractBlock(fileViewCss(), '.fv-scroll-container'))
      expect(has(decls, 'overflow', 'auto')).toBe(true)
      expect(decls.some((d) => d.startsWith('overflow-x:'))).toBe(false)
      expect(decls.some((d) => d.startsWith('overflow-y:'))).toBe(false)
    })

    it('R-B8.2: .fv-header declara position: sticky e top: 0', () => {
      const decls = declarationsOf(extractBlock(fileViewCss(), '.fv-header'))
      expect(has(decls, 'position', 'sticky')).toBe(true)
      expect(has(decls, 'top', '0')).toBe(true)
    })

    it('R-B8.3: .fv-header declara z-index: 1 (acima das rows no scroll)', () => {
      const decls = declarationsOf(extractBlock(fileViewCss(), '.fv-header'))
      expect(has(decls, 'z-index', '1')).toBe(true)
    })

    it('R-B8.4: .fv-scroll-container declara width: 100% (largura definida p/ detectar overflow)', () => {
      // Sprint 4.1: o scroll container precisa de largura definida (100% do pai)
      // para que o overflow do virtual container seja detectado. Sem width definido,
      // o container se expande para caber o conteúdo e a scrollbar horizontal não
      // aparece.
      const decls = declarationsOf(extractBlock(fileViewCss(), '.fv-scroll-container'))
      expect(has(decls, 'width', '100%')).toBe(true)
    })
  })

  // Sprint 2.2: evolução ratificada da Invariante D9 — contenção visual de tags
  // aprovada pelo dono do produto; consultabilidade preservada em três níveis
  // (contador "+N", tooltip com lista integral e TagPopover no clique). Este bloco
  // congela o novo contrato sem enfraquecer R-B1..R-B5.
  describe('R-B6: contenção de tags com consultabilidade', () => {
    it('R-B6.1: .file-card-tags declara max-height: 40px, overflow: hidden e position: relative', () => {
      const decls = declarationsOf(extractBlock(fileCardCss(), '.file-card-tags'))
      expect(has(decls, 'max-height', '40px')).toBe(true)
      expect(has(decls, 'overflow', 'hidden')).toBe(true)
      expect(has(decls, 'position', 'relative')).toBe(true)
    })

    it('R-B6.2: .fr-tags declara overflow: hidden e position: relative', () => {
      const decls = declarationsOf(extractBlock(fileRowCss(), '.fr-tags'))
      expect(has(decls, 'overflow', 'hidden')).toBe(true)
      expect(has(decls, 'position', 'relative')).toBe(true)
    })

    it('R-B6.3: classes do "+N" declaram position: absolute e pointer-events: none', () => {
      for (const selector of ['.file-card-tags-more', '.fr-tags-more']) {
        const css = selector === '.file-card-tags-more' ? fileCardCss() : fileRowCss()
        const decls = declarationsOf(extractBlock(css, selector))
        expect(decls, `bloco ausente: ${selector}`).not.toHaveLength(0)
        expect(has(decls, 'position', 'absolute')).toBe(true)
        expect(has(decls, 'pointer-events', 'none')).toBe(true)
      }
    })
  })

  // Sprint 3: gatilho universal "+" de tags e fim do artefato de fade.
  describe('R-B7: gatilho "+" universal e ausência de fade', () => {
    it('R-B7.1: FileRow.css não contém fade permanente (.fr-tags::after removido)', () => {
      expect(fileRowCss()).not.toMatch(/\.fr-tags::after/)
    })

    it('R-B7.2: classes do gatilho "+" existem nas duas superfícies, com flex-shrink: 0', () => {
      for (const [css, selector] of [
        [fileRowCss(), '.fr-tags-add'],
        [fileCardCss(), '.file-card-tags-add']
      ] as const) {
        const decls = declarationsOf(extractBlock(css, selector))
        expect(decls, `bloco ausente: ${selector}`).not.toHaveLength(0)
        expect(has(decls, 'flex-shrink', '0')).toBe(true)
      }
    })

    it('R-B7.3: .fr-row e .fv-header permanecem token-idênticos com o quinto track em 120px (Sprint 8)', () => {
      const row = declarationsOf(extractBlock(fileRowCss(), '.fr-row'))
      const header = declarationsOf(extractBlock(fileViewCss(), '.fv-header'))
      expect(has(row, 'grid-template-columns', 'var(--fv-grid-template)')).toBe(true)
      expect(has(header, 'grid-template-columns', 'var(--fv-grid-template)')).toBe(true)

      const tracks = gridTracks([`grid-template-columns: ${fvContainerTemplate()}`])
      expect(tracks.length).toBe(5)
      expect(tracks[4]).toBe('120px')
    })
  })

  // Sprint 8: remoção da coluna de ações do grid — o botão passa a ser absoluto
  // no final da row (.fr-action-btn) e os seletores de coluna de ações não existem.
  describe('R-B12: coluna de ações removida e botão absoluto (Sprint 8)', () => {
    it('R-B12.1: .fr-col-action não existe no FileRow.css', () => {
      expect(fileRowCss()).not.toMatch(/\.fr-col-action/)
    })

    it('R-B12.2: .fv-col-action não existe no FileView.css', () => {
      expect(fileViewCss()).not.toMatch(/\.fv-col-action/)
    })

    it('R-B12.3: .fr-action-btn declara position: absolute (overlay no final da row)', () => {
      const decls = declarationsOf(extractBlock(fileRowCss(), '.fr-action-btn'))
      expect(decls, 'bloco .fr-action-btn ausente').not.toHaveLength(0)
      expect(has(decls, 'position', 'absolute')).toBe(true)
    })

    it('R-B12.4: .fr-row declara padding-right: 44px para acomodar o botão absoluto', () => {
      const decls = declarationsOf(extractBlock(fileRowCss(), '.fr-row'))
      expect(has(decls, 'padding-right', '44px')).toBe(true)
    })
  })

  // Sprint (Correção): altura constrita ao viewport — o .app-main não tem mais
  // padding vertical, então a altura é 100vh direto, mantendo o scroll
  // bidirecional acessível nas três views que compartilham a FileCollectionView.
  describe('R-B9: altura constrita nas views com FileCollectionView', () => {
    it('R-B9.1: .cc-container declara height: 100vh e overflow: hidden', () => {
      const decls = declarationsOf(extractBlock(compressionViewCss(), '.cc-container'))
      expect(has(decls, 'height', '100vh')).toBe(true)
      expect(has(decls, 'overflow', 'hidden')).toBe(true)
    })

    it('R-B9.2: .cs-container declara height: 100vh e overflow: hidden', () => {
      const decls = declarationsOf(extractBlock(sourceViewCss(), '.cs-container'))
      expect(has(decls, 'height', '100vh')).toBe(true)
      expect(has(decls, 'overflow', 'hidden')).toBe(true)
    })

    it('R-B9.3: .cdf-container declara height: 100vh e overflow: hidden', () => {
      const decls = declarationsOf(extractBlock(diffViewCss(), '.cdf-container'))
      expect(has(decls, 'height', '100vh')).toBe(true)
      expect(has(decls, 'overflow', 'hidden')).toBe(true)
    })

    it('R-B9.4: o .fcv-container estilizado pelos view containers não tem overflow próprio', () => {
      // Spring 1.1: o fcv-container não deve ter overflow próprio — o scroll é
      // responsabilidade exclusiva do fv-scroll-container (superfície bidirecional
      // única). Scroll duplicado quebra o modelo viewport-constrained.
      // Liga local para seletores compostos com ">"; extractBlock só lida com
      // seletores simples.
      const compoundBlocks: Array<[string, string]> = [
        [compressionViewCss(), '.cc-container > .fcv-container'],
        [sourceViewCss(), '.cs-container > .fcv-container'],
        [diffViewCss(), '.cdf-container > .fcv-container']
      ]

      for (const [css, selector] of compoundBlocks) {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const block = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? ''
        const decls = declarationsOf(block)
        expect(decls.some((d) => d.startsWith('overflow-y:'))).toBe(false)
        expect(decls.some((d) => d.startsWith('overflow:'))).toBe(false)
      }
    })
  })

  // Sprint 1 (Refinamento): as variáveis de tema que faltavam são definidas nos
  // temas claro (:root) e escuro ([data-theme="dark"]) do index.css.
  describe('R-B10: variáveis de tema da File View definidas no index.css', () => {
    const themeVars: Array<[string, string]> = [
      ['--text-subtle', 'R-B10.1'],
      ['--border-subtle', 'R-B10.2'],
      ['--hover-bg', 'R-B10.3'],
      ['--selected-bg', 'R-B10.4'],
      ['--bg-tertiary', 'R-B10.5']
    ]

    for (const [variable, name] of themeVars) {
      it(`${name}: ${variable} definida em :root e [data-theme="dark"]`, () => {
        const root = declarationsOf(extractBlock(indexCss(), ':root'))
        const dark = declarationsOf(extractBlock(indexCss(), '[data-theme="dark"]'))
        expect(has(root, variable), `faltante em :root: ${variable}`).toBe(true)
        expect(has(dark, variable), `faltante em [data-theme="dark"]: ${variable}`).toBe(true)
      })
    }
  })

  // Sprint 5: normalização da cadeia de altura ao padrão funcional do CodeMap
  // (.cmv-container). A raiz não participa do flex-grow; elementos fixos não
  // encolhem; o FileCollectionView recebe o espaço restante exclusivamente via
  // flex: 1 no filho.
  describe('R-B11: normalização da cadeia de altura nas views com FileCollectionView', () => {
    it('R-B11.1: .cc-container não declara flex: 1 nem flex-grow', () => {
      const decls = declarationsOf(extractBlock(compressionViewCss(), '.cc-container'))
      expect(decls.some((d) => d.startsWith('flex-grow:'))).toBe(false)
      expect(decls.some((d) => d.startsWith('flex: 1'))).toBe(false)
    })

    it('R-B11.2: .cs-container não declara flex: 1 nem flex-grow', () => {
      const decls = declarationsOf(extractBlock(sourceViewCss(), '.cs-container'))
      expect(decls.some((d) => d.startsWith('flex-grow:'))).toBe(false)
      expect(decls.some((d) => d.startsWith('flex: 1'))).toBe(false)
    })

    it('R-B11.3: .cdf-container não declara flex: 1 nem flex-grow', () => {
      const decls = declarationsOf(extractBlock(diffViewCss(), '.cdf-container'))
      expect(decls.some((d) => d.startsWith('flex-grow:'))).toBe(false)
      expect(decls.some((d) => d.startsWith('flex: 1'))).toBe(false)
    })

    it('R-B11.4: .cc-container > .ab-root declara flex-shrink: 0', () => {
      expect(has(compoundDecls(compressionViewCss(), '.cc-container > .ab-root'), 'flex-shrink', '0')).toBe(true)
    })

    it('R-B11.5: .cs-container > .ab-root declara flex-shrink: 0', () => {
      expect(has(compoundDecls(sourceViewCss(), '.cs-container > .ab-root'), 'flex-shrink', '0')).toBe(true)
    })

    it('R-B11.6: .cdf-container > .ab-root declara flex-shrink: 0', () => {
      expect(has(compoundDecls(diffViewCss(), '.cdf-container > .ab-root'), 'flex-shrink', '0')).toBe(true)
    })

    it('R-B11.7: .cdf-container > .ss-root declara flex-shrink: 0', () => {
      expect(has(compoundDecls(diffViewCss(), '.cdf-container > .ss-root'), 'flex-shrink', '0')).toBe(true)
    })

    it('R-B11.8: .cs-container > .processing-status-bar declara flex-shrink: 0', () => {
      expect(has(compoundDecls(sourceViewCss(), '.cs-container > .processing-status-bar'), 'flex-shrink', '0')).toBe(true)
    })
  })

  // Sprint 9: a row e o header têm largura autónoma para acompanhar os tracks do grid.
  // Sem isso, tracks que excedem o viewport invadiriam a região do botão de ações
  // (absoluto no final da row). O padding-right permanece como reserva visual,
  // não como mecanismo de contenção.
  describe('R-B13: geometria de row autónoma (Sprint 9)', () => {
    it('R-B13.1: .fr-row declara width: max-content e min-width: 100%', () => {
      const decls = declarationsOf(extractBlock(fileRowCss(), '.fr-row'))
      expect(has(decls, 'width', 'max-content')).toBe(true)
      expect(has(decls, 'min-width', '100%')).toBe(true)
    })

    it('R-B13.2: .fv-header declara width: max-content e min-width: 100%', () => {
      const decls = declarationsOf(extractBlock(fileViewCss(), '.fv-header'))
      expect(has(decls, 'width', 'max-content')).toBe(true)
      expect(has(decls, 'min-width', '100%')).toBe(true)
    })
  })

  // Sprint 4: otimização browser-side (content-visibility)na FileRow. O contrato
  // protege contra remoção acidental em refatorações futuras.
  describe('R-B14: content-visibility da FileRow (Sprint 4)', () => {
    it('R-B14.1: .fr-row declara content-visibility: auto', () => {
      const decls = declarationsOf(extractBlock(fileRowCss(), '.fr-row'))
      expect(has(decls, 'content-visibility', 'auto')).toBe(true)
    })

    it('R-B14.2: .fr-row declara contain-intrinsic-size: 36px (igual à height do grid)', () => {
      const decls = declarationsOf(extractBlock(fileRowCss(), '.fr-row'))
      expect(has(decls, 'contain-intrinsic-size', '36px')).toBe(true)
    })
  })
})

// Sprint 6.1: com o .app-main sem padding, as toolbars de cada view carregam o
// próprio respiro (30px topo / 20px laterais) — enquanto o FileView permanece
// full-bleed para a scrollbar grudar na borda da janela.
describe('R-B15: respiro das toolbars e full-bleed do FileView (Sprint 6.1)', () => {
  const viewToolbars: Array<[string, () => string, string]> = [
    ['.cc-container', compressionViewCss, '.cc-container > .vt-root'],
    ['.cs-container', sourceViewCss, '.cs-container > .vt-root'],
    ['.cdf-container', diffViewCss, '.cdf-container > .vt-root']
  ]

  for (const [name, css, selector] of viewToolbars) {
    it(`R-B15.${viewToolbars.findIndex((v) => v[0] === name) + 1}: ${name} > .vt-root declara padding: 30px 20px 0`, () => {
      expect(has(compoundDecls(css(), selector), 'padding', '30px 20px 0')).toBe(true)
    })
  }

  it('R-B15.5: .cc-container > .ab-root declara padding: 0 20px', () => {
    expect(has(compoundDecls(compressionViewCss(), '.cc-container > .ab-root'), 'padding', '0 20px')).toBe(true)
  })

  it('R-B15.6: .cs-container > .ab-root declara padding: 0 20px', () => {
    expect(has(compoundDecls(sourceViewCss(), '.cs-container > .ab-root'), 'padding', '0 20px')).toBe(true)
  })

  it('R-B15.7: .cdf-container > .ab-root declara padding: 0 20px', () => {
    expect(has(compoundDecls(diffViewCss(), '.cdf-container > .ab-root'), 'padding', '0 20px')).toBe(true)
  })

  it('R-B15.8: CodeMap mantém respiro no container e cabeçalho independente', () => {
    const css = codeMapViewCss()
    const container = declarationsOf(extractBlock(css, '.cmv-container'))
    expect(has(container, 'padding', '16px')).toBe(true)
    expect(has(container, 'gap', '12px')).toBe(true)
    expect(has(declarationsOf(extractBlock(css, '.cmv-awareness-header')), 'flex-shrink', '0')).toBe(true)
  })

  it('R-B15.9: .cs-container > .processing-status-bar declara padding: 0 20px', () => {
    expect(has(compoundDecls(sourceViewCss(), '.cs-container > .processing-status-bar'), 'padding', '0 20px')).toBe(true)
  })

  it('R-B15.10: .cdf-container > .ss-root declara padding: 0 20px', () => {
    expect(has(compoundDecls(diffViewCss(), '.cdf-container > .ss-root'), 'padding', '0 20px')).toBe(true)
  })

  it('R-B15.11: conteúdo CodeMap ocupa o espaço interno sem duplicar padding do container', () => {
    const content = declarationsOf(extractBlock(codeMapViewCss(), '.cmv-content'))
    expect(content.some(declaration => declaration.startsWith('padding'))).toBe(false)
    expect(has(content, 'min-height', '0')).toBe(true)
    expect(has(content, 'overflow', 'hidden')).toBe(true)
  })

  it('R-B15.12 (guarda full-bleed): .fcv-container não declara padding', () => {
    expect(declarationsOf(extractBlock(collectionViewCss(), '.fcv-container')).some((d) => d.startsWith('padding'))).toBe(false)
  })

  it('R-B15.13 (guarda full-bleed): .fv-scroll-container não declara padding', () => {
    expect(declarationsOf(extractBlock(fileViewCss(), '.fv-scroll-container')).some((d) => d.startsWith('padding'))).toBe(false)
  })
})
