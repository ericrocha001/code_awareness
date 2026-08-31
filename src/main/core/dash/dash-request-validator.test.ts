/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar unitariamente a conformidade estrutural, regras de segurança e detecção de anomalias no validador de requisições Code Dash.
2. Garantir cobertura de todos os cenários obrigatórios de validação de protocolo, paths, formatos e campos desconhecidos.

Mapa de Relacionamentos do Script

1. src/main/core/dash/dash-request-validator.ts
   - Tipo: Dependência Direta
   - Relação: Executa a função validateDashRequest sobre diferentes payloads e validações.
   - Criticidade: Alta

Invariantes do Script

1. Executar testes estritamente em memória sem qualquer acesso ao sistema de arquivos.
2. Cobrir integralmente todos os casos de teste obrigatórios descritos na Sprint 1.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect } from 'vitest'
import { validateDashRequest } from './dash-request-validator'

describe('dash-request-validator', () => {
  it('deve validar com sucesso um pedido válido completo', () => {
    const payload = {
      protocol: 'code-dash/v1',
      output: {
        format: 'xml',
        name: 'custom-output'
      },
      items: [
        { path: 'src/main.ts', representation: 'source' },
        { path: 'src/utils.ts', representation: 'compression' }
      ]
    }

    const result = validateDashRequest(payload)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.request).toEqual({
        protocol: 'code-dash/v1',
        output: {
          format: 'xml',
          name: 'custom-output'
        },
        items: [
          { path: 'src/main.ts', representation: 'source' },
          { path: 'src/utils.ts', representation: 'compression' }
        ]
      })
    }
  })

  it('deve validar pedido válido sem o campo opcional output.name', () => {
    const payload = {
      protocol: 'code-dash/v1',
      output: {
        format: 'xml'
      },
      items: [{ path: 'src/index.ts', representation: 'source' }]
    }

    const result = validateDashRequest(payload)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.request.output.name).toBeUndefined()
    }
  })

  it('deve rejeitar versão de protocolo inválida', () => {
    const payload = {
      protocol: 'code-dash/v2',
      output: { format: 'xml' },
      items: [{ path: 'src/main.ts', representation: 'source' }]
    }

    const result = validateDashRequest(payload)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toBe('unknown_protocol')
      expect(result.error).toMatch(/Invalid or missing protocol/)
    }
  })

  it('deve rejeitar output.format diferente de "xml"', () => {
    const payload = {
      protocol: 'code-dash/v1',
      output: { format: 'markdown' },
      items: [{ path: 'src/main.ts', representation: 'source' }]
    }

    const result = validateDashRequest(payload)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toBe('invalid_format')
      expect(result.error).toMatch(/Invalid output format/)
    }
  })

  it('deve rejeitar items vazio', () => {
    const payload = {
      protocol: 'code-dash/v1',
      output: { format: 'xml' },
      items: []
    }

    const result = validateDashRequest(payload)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toBe('empty_items')
      expect(result.error).toMatch(/at least one item/)
    }
  })

  it('deve rejeitar representation inválida', () => {
    const payload = {
      protocol: 'code-dash/v1',
      output: { format: 'xml' },
      items: [{ path: 'src/main.ts', representation: 'full-ast' }]
    }

    const result = validateDashRequest(payload)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toBe('invalid_representation')
      expect(result.error).toMatch(/invalid representation/)
    }
  })

  it('deve rejeitar path com path traversal ("..")', () => {
    const payloads = [
      {
        protocol: 'code-dash/v1',
        output: { format: 'xml' },
        items: [{ path: '../secret.env', representation: 'source' }]
      },
      {
        protocol: 'code-dash/v1',
        output: { format: 'xml' },
        items: [{ path: 'src/../../etc/passwd', representation: 'compression' }]
      }
    ]

    for (const payload of payloads) {
      const result = validateDashRequest(payload)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.reason).toBe('path_traversal')
        expect(result.error).toMatch(/path traversal/)
      }
    }
  })

  it('deve rejeitar path absoluto', () => {
    const absolutePaths = [
      '/etc/hosts',
      '\\Windows\\System32',
      'C:/Users/test/file.ts',
      'C:\\Users\\test\\file.ts',
      'd:secret.txt'
    ]

    for (const absPath of absolutePaths) {
      const payload = {
        protocol: 'code-dash/v1',
        output: { format: 'xml' },
        items: [{ path: absPath, representation: 'source' }]
      }

      const result = validateDashRequest(payload)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.reason).toBe('absolute_path')
        expect(result.error).toMatch(/absolute path/)
      }
    }
  })

  it('deve rejeitar campo desconhecido no top-level', () => {
    const payload = {
      protocol: 'code-dash/v1',
      output: { format: 'xml' },
      items: [{ path: 'src/main.ts', representation: 'source' }],
      extraField: 'not-allowed'
    }

    const result = validateDashRequest(payload)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toBe('unknown_field')
      expect(result.error).toMatch(/Unknown field in request root/)
    }
  })

  it('deve rejeitar campo desconhecido em output', () => {
    const payload = {
      protocol: 'code-dash/v1',
      output: { format: 'xml', unknownOutputProp: true },
      items: [{ path: 'src/main.ts', representation: 'source' }]
    }

    const result = validateDashRequest(payload)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toBe('unknown_field')
      expect(result.error).toMatch(/Unknown field in "output"/)
    }
  })

  it('deve rejeitar campo desconhecido em item', () => {
    const payload = {
      protocol: 'code-dash/v1',
      output: { format: 'xml' },
      items: [
        {
          path: 'src/main.ts',
          representation: 'source',
          extraOption: true
        }
      ]
    }

    const result = validateDashRequest(payload)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toBe('unknown_field')
      expect(result.error).toMatch(/Unknown field in item at index 0/)
    }
  })

  it('deve rejeitar duplicata de path + representation', () => {
    const payload = {
      protocol: 'code-dash/v1',
      output: { format: 'xml' },
      items: [
        { path: 'src/main.ts', representation: 'source' },
        { path: 'src/main.ts', representation: 'source' }
      ]
    }

    const result = validateDashRequest(payload)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toBe('duplicate_item')
      expect(result.error).toMatch(/Duplicate item found at index 1/)
    }
  })

  it('deve permitir o mesmo path com representações distintas', () => {
    const payload = {
      protocol: 'code-dash/v1',
      output: { format: 'xml' },
      items: [
        { path: 'src/main.ts', representation: 'source' },
        { path: 'src/main.ts', representation: 'compression' }
      ]
    }

    const result = validateDashRequest(payload)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.request.items).toHaveLength(2)
    }
  })

  it('deve rejeitar entradas não-objeto ou nulas', () => {
    expect(validateDashRequest(null).success).toBe(false)
    expect(validateDashRequest(undefined).success).toBe(false)
    expect(validateDashRequest('string').success).toBe(false)
    expect(validateDashRequest([]).success).toBe(false)
  })

  it('deve rejeitar path vazio ou em branco', () => {
    const payload = {
      protocol: 'code-dash/v1',
      output: { format: 'xml' },
      items: [{ path: '   ', representation: 'source' }]
    }

    const result = validateDashRequest(payload)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toBe('invalid_path')
      expect(result.error).toMatch(/non-empty "path"/)
    }
  })
})
