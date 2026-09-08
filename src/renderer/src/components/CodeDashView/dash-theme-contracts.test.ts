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

const dashCss = () => read('./CodeDashView.css')
const summaryCss = () => read('./DashResolutionSummary.css')
const previewCss = () => read('./DashXmlPreview.css')

const NONEXISTENT_VARS = [
  '--border-color',
  '--bg-code',
  '--text-code',
  '--btn-bg',
  '--btn-hover-bg',
  '--btn-secondary-bg',
  '--border-hover-color'
]

const HARDCODED_HEX = /#[0-9a-fA-F]{3,8}\b/
const HARDCODED_RGBA_SURFACE = /rgba\(\s*(255,\s*255,\s*255|0,\s*0,\s*0)/

const assertNoHardcodedColors = (css: string, label: string) => {
  const lines = css.split('\n')
  lines.forEach((line, idx) => {
    const withoutComment = line.replace(/\/\*[\s\S]*?\*\//g, '').trim()
    if (withoutComment.startsWith('/*') || withoutComment.startsWith('//')) return
    // Declarações reais: ignorar linhas de comentário e o bloco de arquitetura.
    if (!withoutComment.includes(':')) return
    expect(HARDCODED_HEX.test(withoutComment), `${label}:${idx + 1} hex hardcoded: "${withoutComment}"`).toBe(false)
    expect(HARDCODED_RGBA_SURFACE.test(withoutComment), `${label}:${idx + 1} rgba surface hardcoded: "${withoutComment}"`).toBe(false)
  })
}

const assertNoNonexistentVars = (css: string, label: string) => {
  NONEXISTENT_VARS.forEach((v) => {
    expect(css.includes(v), `${label}: variável inexistente ${v} referenciada`).toBe(false)
  })
}

describe('CodeDashView — contratos visuais (Sprint 2)', () => {
  describe('CodeDashView.css', () => {
    it('não possui cores hex hardcoded nem superfícies rgba(255/0) hardcoded', () => {
      const css = dashCss()
      assertNoHardcodedColors(css, 'CodeDashView.css')
    })

    it('não referencia variáveis inexistentes', () => {
      assertNoNonexistentVars(dashCss(), 'CodeDashView.css')
    })
  })

  describe('DashResolutionSummary.css', () => {
    const css = summaryCss()

    it('não possui cores hex hardcoded nem superfícies rgba(255/0) hardcoded', () => {
      assertNoHardcodedColors(css, 'DashResolutionSummary.css')
    })

    it('não referencia variáveis inexistentes', () => {
      assertNoNonexistentVars(css, 'DashResolutionSummary.css')
    })

    it('dash-item-row é transparente por padrão e hover consome --hover-bg', () => {
      const row = declarationsOf(extractBlock(css, '.dash-item-row'))
      expect(has(row, 'background-color', 'transparent')).toBe(true)

      const hover = declarationsOf(extractBlock(css, '.dash-item-row:hover'))
      expect(hover.some((d) => d.includes('--hover-bg'))).toBe(true)
    })

    it('dash-status-ok usa --color-green sem fundo/borda', () => {
      const ok = declarationsOf(extractBlock(css, '.dash-status-ok'))
      expect(has(ok, 'color', 'var(--color-green)')).toBe(true)
      expect(ok.some((d) => d.startsWith('background'))).toBe(false)
      expect(ok.some((d) => d.startsWith('border'))).toBe(false)
    })
  })

  describe('DashXmlPreview.css', () => {
    const css = previewCss()

    it('não possui cores hex hardcoded nem superfícies rgba(255/0) hardcoded', () => {
      assertNoHardcodedColors(css, 'DashXmlPreview.css')
    })

    it('não referencia variáveis inexistentes', () => {
      assertNoNonexistentVars(css, 'DashXmlPreview.css')
    })

    it('dash-code-block não possui max-height fixo (output protagonista)', () => {
      const block = declarationsOf(extractBlock(css, '.dash-code-block'))
      expect(block.some((d) => d.startsWith('max-height'))).toBe(false)
    })
  })

  describe('index.css — tokens novos e foco global', () => {
    const css = indexCss()

    it('declara --color-warning e --font-mono em :root', () => {
      const root = extractBlock(css, ':root')
      expect(root).not.toBeNull()
      expect(root!.includes('--color-warning')).toBe(true)
      expect(root!.includes('--font-mono')).toBe(true)
    })

    it('declara --color-warning no bloco escuro (data-theme="dark")', () => {
      // O bloco [data-theme="dark"] é o primeiro bloco temático após :root.
      const afterRoot = css.slice(css.indexOf('['))
      const darkBlock = afterRoot.slice(0, afterRoot.indexOf('}'))
      expect(darkBlock.includes('--color-warning')).toBe(true)
    })

    it('regra de foco visível para .app-pill-btn e .app-ghost-btn', () => {
      expect(css.includes('.app-pill-btn:focus-visible')).toBe(true)
      expect(css.includes('.app-ghost-btn:focus-visible')).toBe(true)
      expect(css.includes('outline: 2px solid var(--accent)')).toBe(true)
    })
  })
})
const indexCss = () => read('../../index.css')