/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar a divisão de strings em linhas através de splitDocumentLines.
2. Validar a normalização de quebras de linha CRLF (\r\n) e CR (\r) para LF (\n).
3. Validar a robustez com entradas vazias, nulas e indefinidas.
4. Validar a preservação de linhas vazias intermediárias.

Mapa de Relacionamentos do Script

1. source-document-lines.ts
   - Tipo: Dependência Direta
   - Relação: Função pura sob teste.
   - Criticidade: Alta

Invariantes do Script

1. Testes são determinísticos, síncronos e sem efeitos colaterais.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect } from 'vitest'
import { splitDocumentLines } from './source-document-lines'

describe('splitDocumentLines', () => {
  it('divide corretamente um documento multilinha com LF', () => {
    const content = 'linha 1\nlinha 2\nlinha 3'
    const result = splitDocumentLines(content)
    expect(result).toEqual(['linha 1', 'linha 2', 'linha 3'])
  })

  it('normaliza quebras CRLF (\\r\\n) e CR (\\r) para LF antes da divisão', () => {
    const contentCrlf = 'linha 1\r\nlinha 2\r\nlinha 3'
    expect(splitDocumentLines(contentCrlf)).toEqual(['linha 1', 'linha 2', 'linha 3'])

    const contentCr = 'linha 1\rlinha 2\rlinha 3'
    expect(splitDocumentLines(contentCr)).toEqual(['linha 1', 'linha 2', 'linha 3'])
  })

  it('retorna array vazio para documento vazio, nulo ou indefinido', () => {
    expect(splitDocumentLines('')).toEqual([])
    expect(splitDocumentLines(null)).toEqual([])
    expect(splitDocumentLines(undefined)).toEqual([])
  })

  it('preserva estritamente linhas vazias intermediárias e finais', () => {
    const content = 'inicio\n\nmeio\n\n\nfim\n'
    const result = splitDocumentLines(content)
    expect(result).toEqual(['inicio', '', 'meio', '', '', 'fim', ''])
  })

  it('retorna array com elemento único para documento com uma única linha sem quebra', () => {
    const content = 'apenas uma linha'
    const result = splitDocumentLines(content)
    expect(result).toEqual(['apenas uma linha'])
  })
})
