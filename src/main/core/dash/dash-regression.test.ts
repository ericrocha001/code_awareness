/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Garantir que o pipeline contextual do Code Dash (DashService) não regrediu com a introdução do One-Click XML.
2. Validar que o XML contextual preserva o envelope canônico code-dash-context com itens indexados.

Mapa de Relacionamentos do Script

1. dash-service.ts
   - Tipo: Dependência Direta
   - Relação: Sujeito do teste de regressão (orquestração via mocks de provedores).
   - Criticidade: Alta

2. providers/context-provider.ts
   - Tipo: Contrato / Interface
   - Relação: Provedores mockados para gerar conteúdo sem I/O real.
   - Criticidade: Alta

Invariantes do Script

1. O XML do Code Dash contextual SEMPRE contém <code-dash-context> e <item index=.
2. O teste não invoca o OneClickXmlService — valida exclusivamente o DashService.
3. Nenhum I/O real (filesystem/Repomix): resolução e provedores são mockados.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, expect, it, vi } from 'vitest'
import type { DashResolutionReport } from '../../../shared/types/dash-types'
import type { DashFileResolver } from './dash-file-resolver'
import { DashService } from './dash-service'
import type { ContextProvider } from './providers/context-provider'

describe('Code Dash contextual — regressão pós One-Click XML (PA-15)', () => {
  it('PA-15: DashService.execute preserva o envelope code-dash-context com itens indexados', async () => {
    const repoPath = '/test/repo'

    const mockResolver = {
      resolve: vi.fn().mockReturnValue({
        valid: true,
        request: {
          protocol: 'code-dash/v1',
          output: { format: 'xml' },
          items: [
            { path: 'src/s1.ts', representation: 'source' },
            { path: 'src/c1.ts', representation: 'compression' }
          ]
        },
        failures: []
      } as DashResolutionReport)
    } as unknown as DashFileResolver

    const mockSourceProvider: ContextProvider = {
      provide: vi.fn().mockResolvedValue({
        contents: new Map([[0, 'source s1 content']]),
        failures: []
      })
    }

    const mockCompressionProvider: ContextProvider = {
      provide: vi.fn().mockResolvedValue({
        contents: new Map([[1, 'compression c1 content']]),
        failures: []
      })
    }

    const service = new DashService(
      mockResolver,
      mockSourceProvider,
      mockCompressionProvider
    )

    const rawInput = `
\`\`\`json
{
  "protocol": "code-dash/v1",
  "output": { "format": "xml" },
  "items": [
    { "path": "src/s1.ts", "representation": "source" },
    { "path": "src/c1.ts", "representation": "compression" }
  ]
}
\`\`\`
`

    const result = await service.execute(rawInput, repoPath)

    expect(result.success).toBe(true)
    expect(result.xml).toContain('<code-dash-context')
    expect(result.xml).toContain('<item index=')
    // Ordem preservada
    const xml = result.xml!
    expect(xml.indexOf('index="0"')).toBeLessThan(xml.indexOf('index="1"'))
  })
})
