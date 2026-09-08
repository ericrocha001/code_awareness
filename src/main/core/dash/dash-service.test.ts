/*
-T ---
*/

import { describe, expect, it, vi } from 'vitest'
import type { DashResolutionReport } from '../../../shared/types/dash-types'
import type { DashFileResolver } from './dash-file-resolver'
import { DashService } from './dash-service'
import type { ContextProvider } from './providers/context-provider'

describe('DashService', () => {
  const repoPath = '/test/repo'

  it('deve orquestrar request válido com 2 source + 3 compression gerando XML com 5 itens na ordem preservada', async () => {
    const mockResolver = {
      resolve: vi.fn().mockReturnValue({
        valid: true,
        request: {
          protocol: 'code-dash/v1',
          output: { format: 'xml' },
          items: [
            { path: 'src/s1.ts', representation: 'source' },
            { path: 'src/c1.ts', representation: 'compression' },
            { path: 'src/s2.ts', representation: 'source' },
            { path: 'src/c2.ts', representation: 'compression' },
            { path: 'src/c3.ts', representation: 'compression' }
          ]
        },
        failures: []
      } as DashResolutionReport)
    } as unknown as DashFileResolver

    const mockSourceProvider: ContextProvider = {
      provide: vi.fn().mockResolvedValue({
        contents: new Map([
          [0, 'source s1 content'],
          [2, 'source s2 content']
        ]),
        failures: []
      })
    }

    const mockCompressionProvider: ContextProvider = {
      provide: vi.fn().mockResolvedValue({
        contents: new Map([
          [1, 'compression c1 content'],
          [3, 'compression c2 content'],
          [4, 'compression c3 content']
        ]),
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
    { "path": "src/c1.ts", "representation": "compression" },
    { "path": "src/s2.ts", "representation": "source" },
    { "path": "src/c2.ts", "representation": "compression" },
    { "path": "src/c3.ts", "representation": "compression" }
  ]
}
\`\`\`
`

    const result = await service.execute(rawInput, repoPath)

    expect(result.success).toBe(true)
    expect(result.xml).toBeDefined()
    expect(result.metadata).toEqual({
      requested: 5,
      resolved: 5,
      generated: 5,
      failed: 0
    })

    // Ordem estrita no XML
    const xml = result.xml!
    const idx0 = xml.indexOf('index="0"')
    const idx1 = xml.indexOf('index="1"')
    const idx2 = xml.indexOf('index="2"')
    const idx3 = xml.indexOf('index="3"')
    const idx4 = xml.indexOf('index="4"')

    expect(idx0).toBeLessThan(idx1)
    expect(idx1).toBeLessThan(idx2)
    expect(idx2).toBeLessThan(idx3)
    expect(idx3).toBeLessThan(idx4)
  })

  it('deve gerar XML parcial quando houver 1 item não resolvido', async () => {
    const mockResolver = {
      resolve: vi.fn().mockReturnValue({
        valid: false,
        request: {
          protocol: 'code-dash/v1',
          output: { format: 'xml' },
          items: [
            { path: 'src/s1.ts', representation: 'source' },
            { path: 'src/c1.ts', representation: 'compression' }
          ]
        },
        failures: [
          { index: 1, path: 'missing.ts', reason: 'not_found' }
        ]
      } as DashResolutionReport)
    } as unknown as DashFileResolver

    const mockSourceProvider: ContextProvider = {
      provide: vi.fn().mockResolvedValue({
        contents: new Map([[0, 'source s1']]),
        failures: []
      })
    }

    const mockCompressionProvider: ContextProvider = {
      provide: vi.fn().mockResolvedValue({
        contents: new Map([[2, 'compression c1']]),
        failures: []
      })
    }

    const service = new DashService(
      mockResolver,
      mockSourceProvider,
      mockCompressionProvider
    )

    const rawInput = JSON.stringify({
      protocol: 'code-dash/v1',
      output: { format: 'xml' },
      items: [
        { path: 'src/s1.ts', representation: 'source' },
        { path: 'missing.ts', representation: 'source' },
        { path: 'src/c1.ts', representation: 'compression' }
      ]
    })

    const result = await service.execute(rawInput, repoPath)

    expect(result.success).toBe(true)
    expect(result.xml).toContain('<failure index="1" path="missing.ts" reason="not_found" />')
    expect(result.failures).toHaveLength(1)
    expect(result.metadata?.failed).toBe(1)
    expect(result.metadata?.generated).toBe(2)
  })

  it('deve retornar erro imediato em caso de falha de parsing', async () => {
    const service = new DashService(
      {} as any,
      {} as any,
      {} as any
    )

    const result = await service.execute('texto sem nenhum json', repoPath)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Falha no parsing/)
    expect(result.xml).toBeUndefined()
  })

  it('deve retornar erro imediato em caso de falha de validação', async () => {
    const service = new DashService(
      {} as any,
      {} as any,
      {} as any
    )

    const invalidPayload = JSON.stringify({
      protocol: 'invalid/v1',
      output: { format: 'xml' },
      items: []
    })

    const result = await service.execute(invalidPayload, repoPath)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Falha na validação/)
    expect(result.xml).toBeUndefined()
  })

  it('deve reportar falha quando o provider source falhar em 1 item e continuar os outros', async () => {
    const mockResolver = {
      resolve: vi.fn().mockReturnValue({
        valid: true,
        request: {
          protocol: 'code-dash/v1',
          output: { format: 'xml' },
          items: [
            { path: 'src/s1.ts', representation: 'source' },
            { path: 'src/s2.ts', representation: 'source' }
          ]
        },
        failures: []
      } as DashResolutionReport)
    } as unknown as DashFileResolver

    const mockSourceProvider: ContextProvider = {
      provide: vi.fn().mockResolvedValue({
        contents: new Map([[0, 'source s1 content']]),
        failures: [{ index: 1, reason: 'Arquivo muito grande para Repomix' }]
      })
    }

    const mockCompressionProvider: ContextProvider = {
      provide: vi.fn().mockResolvedValue({
        contents: new Map(),
        failures: []
      })
    }

    const service = new DashService(
      mockResolver,
      mockSourceProvider,
      mockCompressionProvider
    )

    const rawInput = JSON.stringify({
      protocol: 'code-dash/v1',
      output: { format: 'xml' },
      items: [
        { path: 'src/s1.ts', representation: 'source' },
        { path: 'src/s2.ts', representation: 'source' }
      ]
    })

    const result = await service.execute(rawInput, repoPath)

    expect(result.success).toBe(true)
    expect(result.failures).toHaveLength(1)
    expect(result.failures![0]).toEqual({
      index: 1,
      path: 'src/s2.ts',
      reason: 'Arquivo muito grande para Repomix'
    })
    expect(result.xml).toContain('item index="0"')
    expect(result.xml).not.toContain('item index="1"')
    expect(result.xml).toContain('<failure index="1" path="src/s2.ts"')
  })

  it('deve reportar falhas quando o provider compression falhar completamente', async () => {
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
        contents: new Map(),
        failures: [{ index: 1, reason: 'Tree-sitter parse error' }]
      })
    }

    const service = new DashService(
      mockResolver,
      mockSourceProvider,
      mockCompressionProvider
    )

    const rawInput = JSON.stringify({
      protocol: 'code-dash/v1',
      output: { format: 'xml' },
      items: [
        { path: 'src/s1.ts', representation: 'source' },
        { path: 'src/c1.ts', representation: 'compression' }
      ]
    })

    const result = await service.execute(rawInput, repoPath)

    expect(result.failures).toEqual([
      { index: 1, path: 'src/c1.ts', reason: 'Tree-sitter parse error' }
    ])
  })

  it('deve repassar settings para os providers e retornar tokenCount numérico proporcional ao XML gerado', async () => {
    const mockResolver = {
      resolve: vi.fn().mockReturnValue({
        valid: true,
        request: {
          protocol: 'code-dash/v1',
          output: { format: 'xml' },
          items: [{ path: 'src/main.ts', representation: 'source' }]
        },
        failures: []
      } as DashResolutionReport)
    } as unknown as DashFileResolver

    const mockSourceProvider: ContextProvider = {
      provide: vi.fn().mockResolvedValue({
        contents: new Map([[0, 'const greeting = "hello world";']]),
        failures: []
      })
    }

    const mockCompressionProvider: ContextProvider = {
      provide: vi.fn().mockResolvedValue({
        contents: new Map(),
        failures: []
      })
    }

    const service = new DashService(
      mockResolver,
      mockSourceProvider,
      mockCompressionProvider
    )

    const rawInput = JSON.stringify({
      protocol: 'code-dash/v1',
      output: { format: 'xml' },
      items: [{ path: 'src/main.ts', representation: 'source' }]
    })

    const settings = {
      removeComments: true,
      removeEmptyLines: true,
      truncateBase64: true
    }

    const result = await service.execute(rawInput, repoPath, { repoPath, settings })

    expect(result.success).toBe(true)
    expect(result.xml).toBeDefined()
    expect(typeof result.tokenCount).toBe('number')
    expect(result.tokenCount).toBeGreaterThan(0)
    expect(result.tokenCount).toBe(Math.ceil(result.xml!.length / 4))

    // Verifica se options.settings foi repassado ao provider
    expect(mockSourceProvider.provide).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ settings })
    )
  })
})
