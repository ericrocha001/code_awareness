/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Proteger a fronteira arquitetural do OneClickXmlService contra dependência do pipeline contextual do Code Dash.
2. Validar estaticamente o código-fonte do serviço contra imports e símbolos proibidos.

Mapa de Relacionamentos do Script

1. one-click-xml-service.ts
   - Tipo: Dependência Direta
   - Relação: Código-fonte analisado estaticamente pelo teste de fronteira.
   - Criticidade: Alta

Invariantes do Script

1. OneClickXmlService não pode importar dash-service, compression-context-provider, structured-compression-port, dash-context-assembler ou dash-types.
2. OneClickXmlService não pode referenciar DashContextPlan, DashPlannedItem nem assembleContext.
3. O teste é estático (leitura de source) e não executa o serviço.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const servicePath = join(__dirname, 'one-click-xml-service.ts')
const sourceCode = readFileSync(servicePath, 'utf-8')

describe('OneClickXmlService — Fronteira Arquitetural', () => {
  it('B-01: não deve importar componentes do pipeline contextual do Code Dash', () => {
    const forbiddenImports = [
      'dash-service',
      'compression-context-provider',
      'structured-compression-port',
      'dash-context-assembler',
      'dash-types'
    ]

    for (const forbidden of forbiddenImports) {
      const importPattern = new RegExp(
        `import.*from.*['"].*${forbidden}.*['"]`,
        'i'
      )
      expect(
        importPattern.test(sourceCode),
        `OneClickXmlService não deve importar de '${forbidden}' (violação da fronteira arquitetural)`
      ).toBe(false)
    }
  })

  it('B-02: não deve referenciar DashContextPlan ou tipos do pipeline contextual', () => {
    expect(sourceCode).not.toContain('DashContextPlan')
    expect(sourceCode).not.toContain('DashPlannedItem')
    expect(sourceCode).not.toContain('assembleContext')
  })
})
