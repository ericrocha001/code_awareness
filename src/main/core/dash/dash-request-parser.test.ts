/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar unitariamente o comportamento do parser tolerante de requisições Code Dash.
2. Garantir a correta extração e deserialização de JSONs puros, em blocos markdown e tratamento de erros sintáticos.

Mapa de Relacionamentos do Script

1. src/main/core/dash/dash-request-parser.ts
   - Tipo: Dependência Direta
   - Relação: Executa e testa a função parseDashRequest sob diversos cenários de entrada.
   - Criticidade: Alta

Invariantes do Script

1. Executar testes puramente em memória sem criar arquivos nem realizar chamadas de I/O.
2. Cobrir todos os cenários obrigatórios de parsing previstos na especificação da Sprint 1.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect } from 'vitest'
import { parseDashRequest } from './dash-request-parser'

describe('dash-request-parser', () => {
  it('deve parsear JSON puro válido', () => {
    const input = '{"protocol":"code-dash/v1","output":{"format":"xml"},"items":[]}'
    const result = parseDashRequest(input)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.request).toEqual({
        protocol: 'code-dash/v1',
        output: { format: 'xml' },
        items: []
      })
    }
  })

  it('deve extrair e parsear JSON dentro de fence com "json"', () => {
    const input = `
Aqui está a requisição:
\`\`\`json
{
  "protocol": "code-dash/v1",
  "output": { "format": "xml" },
  "items": [
    { "path": "src/main.ts", "representation": "source" }
  ]
}
\`\`\`
Favor processar.
`
    const result = parseDashRequest(input)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.request).toEqual({
        protocol: 'code-dash/v1',
        output: { format: 'xml' },
        items: [{ path: 'src/main.ts', representation: 'source' }]
      })
    }
  })

  it('deve extrair e parsear JSON dentro de fence sem identificador de linguagem', () => {
    const input = `
\`\`\`
{
  "protocol": "code-dash/v1",
  "output": { "format": "xml" },
  "items": []
}
\`\`\`
`
    const result = parseDashRequest(input)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.request).toEqual({
        protocol: 'code-dash/v1',
        output: { format: 'xml' },
        items: []
      })
    }
  })

  it('deve usar o primeiro bloco com JSON válido quando houver múltiplos fences', () => {
    const input = `
Primeiro bloco de código (código TypeScript, não é JSON):
\`\`\`typescript
const greeting = "hello world";
console.log(greeting);
\`\`\`

Segundo bloco de código (JSON válido):
\`\`\`json
{
  "protocol": "code-dash/v1",
  "output": { "format": "xml" },
  "items": [
    { "path": "first-valid.ts", "representation": "source" }
  ]
}
\`\`\`

Terceiro bloco de código (também JSON, mas deve ignorar):
\`\`\`json
{
  "protocol": "code-dash/v1",
  "output": { "format": "xml" },
  "items": [
    { "path": "second-valid.ts", "representation": "source" }
  ]
}
\`\`\`
`
    const result = parseDashRequest(input)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.request).toEqual({
        protocol: 'code-dash/v1',
        output: { format: 'xml' },
        items: [{ path: 'first-valid.ts', representation: 'source' }]
      })
    }
  })

  it('deve retornar erro para texto sem JSON e sem fences', () => {
    const input = 'Apenas um texto simples sem nenhum JSON nem bloco de código markdown.'
    const result = parseDashRequest(input)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeDefined()
    }
  })

  it('deve retornar erro para JSON malformado puro', () => {
    const input = '{"protocol": "code-dash/v1", items: [}'
    const result = parseDashRequest(input)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeDefined()
    }
  })

  it('deve retornar erro para JSON malformado dentro de fences', () => {
    const input = `
\`\`\`json
{
  "protocol": "code-dash/v1",
  invalid_json: true,
}
\`\`\`
`
    const result = parseDashRequest(input)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toMatch(/Failed to parse JSON inside code fences/)
    }
  })

  it('deve retornar erro para entrada não string ou vazia', () => {
    expect(parseDashRequest(null).success).toBe(false)
    expect(parseDashRequest(undefined).success).toBe(false)
    expect(parseDashRequest(123).success).toBe(false)
    expect(parseDashRequest('   ').success).toBe(false)
  })
})
