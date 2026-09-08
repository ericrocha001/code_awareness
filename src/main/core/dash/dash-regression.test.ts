/*
-T ---
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
