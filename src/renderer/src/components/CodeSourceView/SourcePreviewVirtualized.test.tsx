// @vitest-environment jsdom
/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar a renderização do SourcePreviewVirtualized com documentos pequenos e grandes.
2. Validar o estado de documento vazio sem falhas ou exceções.
3. Validar a decisão entre modo realçado (Highlight) e modo puro (Plain) com base no teto de caracteres.
4. Validar a renderização para formatos Markdown e XML.

Mapa de Relacionamentos do Script

1. SourcePreviewVirtualized.tsx
   - Tipo: Dependência Direta
   - Relação: Componente sob teste.
   - Criticidade: Alta

2. @testing-library/react
   - Tipo: Dependência Direta
   - Relação: Fornece render e screen para validação de nós no DOM.
   - Criticidade: Alta

Invariantes do Script

1. Documentos vazios sempre exibem a mensagem segura sem lançar exceções.
2. Documentos cujo tamanho exceda MAX_HIGHLIGHT_CHARS renderizam o aviso de texto puro (.spv-plain-notice).

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  SourcePreviewVirtualized,
  MAX_HIGHLIGHT_CHARS
} from './SourcePreviewVirtualized'

describe('SourcePreviewVirtualized', () => {
  beforeEach(() => {
    // Mock simples de ResizeObserver para o ambiente jsdom
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any

    // Mock simples de matchMedia para useTheme no ambiente jsdom
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false
      })
    })
  })

  it('exibe estado seguro quando o documento está vazio', () => {
    render(<SourcePreviewVirtualized content="" format="markdown" />)
    expect(screen.getByText('Nenhuma saída gerada ainda.')).toBeDefined()
  })

  it('renderiza documento pequeno com syntax highlighting para markdown', () => {
    const code = '# Title\nconst x = 1;\nconsole.log(x);'
    const { container } = render(
      <SourcePreviewVirtualized content={code} format="markdown" />
    )

    // Não deve conter o aviso de texto puro
    expect(container.querySelector('.spv-plain-notice')).toBeNull()
    // Deve conter container virtualizado
    expect(container.querySelector('.spv-virtual-container')).not.toBeNull()
    // Deve conter números de linha renderizados
    expect(container.querySelector('.spv-line-num')).not.toBeNull()
  })

  it('renderiza documento pequeno com syntax highlighting para XML', () => {
    const xml = '<root><child id="1">Valor</child></root>'
    const { container } = render(
      <SourcePreviewVirtualized content={xml} format="xml" />
    )

    expect(container.querySelector('.spv-plain-notice')).toBeNull()
    expect(container.querySelector('.spv-virtual-container')).not.toBeNull()
  })

  it('degrada para modo texto puro quando o tamanho excede MAX_HIGHLIGHT_CHARS', () => {
    // Gera documento que ultrapassa o teto de highlighting
    const largeLine = 'const a = "long text repeating here";\n'
    const repeatCount = Math.ceil((MAX_HIGHLIGHT_CHARS + 1000) / largeLine.length)
    const largeContent = largeLine.repeat(repeatCount)

    const { container } = render(
      <SourcePreviewVirtualized content={largeContent} format="markdown" />
    )

    // Deve exibir o container no modo plain
    expect(container.querySelector('.spv-virtual-container--plain')).not.toBeNull()
    // Deve exibir o aviso explicativo
    expect(
      screen.getByText('Documento muito grande para realce de sintaxe — exibindo texto puro.')
    ).toBeDefined()
  })

  it('aplica classes CSS customizadas passadas via props', () => {
    const { container } = render(
      <SourcePreviewVirtualized
        content="hello world"
        format="markdown"
        className="custom-preview-class"
      />
    )

    expect(container.querySelector('.custom-preview-class')).not.toBeNull()
  })
})
