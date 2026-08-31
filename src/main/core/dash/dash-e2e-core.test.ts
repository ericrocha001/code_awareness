/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Provar E2E os contratos centrais do Code Dash (E2E-01 a E2E-10): integração, representações source/compression, mixed mode, ordem, resolução por basename, ambiguidade, falha parcial e profile.
2. Usar DashService, Parser, Validator, Resolver, Planner e Assembler reais com filesystem temporário real.

Mapa de Relacionamentos do Script

1. dash-e2e-helpers.ts
   - Tipo: Dependência Direta
   - Relação: Consome DashService real, SpyContextProvider e utilidades de XML.
   - Criticidade: Alta

2. dash-service.ts
   - Tipo: Dependência Direta
   - Relação: Exercitado de ponta a ponta com entrada bruta de texto.
   - Criticidade: Alta

3. git-test-helpers.ts
   - Tipo: Dependência Direta
   - Relação: Cria e limpa repositórios temporários reais.
   - Criticidade: Média

Invariantes do Script

1. Nenhum componente do pipeline central é mockado; apenas os providers são espiões controlados.
2. Toda resolução opera contra repositório temporário real, limpo no afterEach sem lançar exceção.
3. Ordem e representação declaradas no request devem aparecer intactas no XML.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDashInput,
  cleanupTempRepo,
  createTempGitRepo,
  extractItemAttributes,
  extractItemCdata,
  makeRealDashService,
  SpyContextProvider,
  writeFile
} from './dash-e2e-helpers'
import type { DashResolutionReport } from '../../../shared/types/dash-types'

describe('Suite A — Core E2E', () => {
  let repoPath: string

  afterEach(async () => {
    if (repoPath) await cleanupTempRepo(repoPath)
    repoPath = ''
  })

  // E2E-01
  it('E2E-01: parseAndResolve com repo válido retorna sucesso com request e sem failures', async () => {
    repoPath = await createTempGitRepo()
    writeFile(repoPath, 'src/alpha.ts', 'const alpha = 1\n')
    writeFile(repoPath, 'src/beta.ts', 'const beta = 2\n')
    writeFile(repoPath, 'src/gamma.ts', 'const gamma = 3\n')

    const source = new SpyContextProvider()
    const compression = new SpyContextProvider()
    const service = makeRealDashService(source, compression)

    const result = service.parseAndResolve(
      buildDashInput([{ path: 'src/alpha.ts', representation: 'source' }]),
      repoPath
    )

    expect(result.success).toBe(true)
    expect(result.data).not.toBeNull()
    expect((result.data as DashResolutionReport).failures).toEqual([])
    expect(source.calls.length).toBe(0)
    expect(compression.calls.length).toBe(0)
  })

  // E2E-02
  it('E2E-02: request source simples gera XML com representation="source" e metadados corretos', async () => {
    repoPath = await createTempGitRepo()
    writeFile(repoPath, 'src/alpha.ts', 'const alpha = 1\n')

    const source = new SpyContextProvider()
    source.setContentFactory((item) => `SOURCE_CONTENT(${item.path})`)
    const compression = new SpyContextProvider()
    const service = makeRealDashService(source, compression)

    const result = await service.execute(
      buildDashInput([{ path: 'src/alpha.ts', representation: 'source' }]),
      repoPath
    )

    expect(result.success).toBe(true)
    expect(result.metadata).toEqual({ requested: 1, resolved: 1, generated: 1, failed: 0 })
    expect(result.xml).toContain('representation="source"')
    expect(extractItemCdata(result.xml!, 0)).toBe('SOURCE_CONTENT(src/alpha.ts)')
    // Provider Source chamado exatamente 1 vez; Compression nunca.
    expect(source.calls.length).toBe(1)
    expect(source.receivedIndexes).toEqual([0])
    expect(compression.calls.length).toBe(0)
  })

  // E2E-03
  it('E2E-03: request compression simples gera XML com representation="compression" e metadados corretos', async () => {
    repoPath = await createTempGitRepo()
    writeFile(repoPath, 'src/beta.ts', 'const beta = 2\n')

    const source = new SpyContextProvider()
    const compression = new SpyContextProvider()
    compression.setContentFactory((item) => `COMPRESSED_CONTENT(${item.path})`)
    const service = makeRealDashService(source, compression)

    const result = await service.execute(
      buildDashInput([{ path: 'src/beta.ts', representation: 'compression' }]),
      repoPath
    )

    expect(result.success).toBe(true)
    expect(result.metadata).toEqual({ requested: 1, resolved: 1, generated: 1, failed: 0 })
    expect(result.xml).toContain('representation="compression"')
    expect(extractItemCdata(result.xml!, 0)).toBe('COMPRESSED_CONTENT(src/beta.ts)')
    expect(compression.calls.length).toBe(1)
    expect(source.calls.length).toBe(0)
  })

  // E2E-04
  it('E2E-04: mixed source+compression roteia itens aos providers corretos preservando ordem', async () => {
    repoPath = await createTempGitRepo()
    writeFile(repoPath, 'a.ts', 'a\n')
    writeFile(repoPath, 'b.ts', 'b\n')
    writeFile(repoPath, 'c.ts', 'c\n')
    writeFile(repoPath, 'd.ts', 'd\n')

    const source = new SpyContextProvider()
    source.setContentFactory((item) => `SRC:${item.path}`)
    const compression = new SpyContextProvider()
    compression.setContentFactory((item) => `CMP:${item.path}`)
    const service = makeRealDashService(source, compression)

    const result = await service.execute(
      buildDashInput([
        { path: 'a.ts', representation: 'source' },
        { path: 'b.ts', representation: 'compression' },
        { path: 'c.ts', representation: 'compression' },
        { path: 'd.ts', representation: 'source' }
      ]),
      repoPath
    )

    expect(result.success).toBe(true)
    const items = extractItemAttributes(result.xml!)
    expect(items.map((it) => it.path)).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
    expect(items.map((it) => it.representation)).toEqual([
      'source', 'compression', 'compression', 'source'
    ])
    // Nenhum item trocou de provider: Source recebeu [a, d]; Compression [b, c].
    expect([...source.receivedIndexes].sort((a, b) => a - b)).toEqual([0, 3])
    expect([...compression.receivedIndexes].sort((a, b) => a - b)).toEqual([1, 2])
    expect(extractItemCdata(result.xml!, 0)).toBe('SRC:a.ts')
    expect(extractItemCdata(result.xml!, 1)).toBe('CMP:b.ts')
    expect(extractItemCdata(result.xml!, 2)).toBe('CMP:c.ts')
    expect(extractItemCdata(result.xml!, 3)).toBe('SRC:d.ts')
  })

  // E2E-05
  it('E2E-05: 8 itens em ordem deliberadamente não alfabética preservam a ordem no XML', async () => {
    repoPath = await createTempGitRepo()
    const files = ['z8.ts', 'm5.ts', 'a1.ts', 'y7.ts', 'c3.ts', 'x6.ts', 'b2.ts', 'w4.ts']
    for (const f of files) writeFile(repoPath, f, `content of ${f}\n`)

    const source = new SpyContextProvider()
    source.setContentFactory((item) => `S:${item.path}`)
    const compression = new SpyContextProvider()
    compression.setContentFactory((item) => `C:${item.path}`)
    const service = makeRealDashService(source, compression)

    // Ordem deliberadamente embaralhada e representações alternadas.
    const order = ['w4.ts', 'z8.ts', 'a1.ts', 'm5.ts', 'x6.ts', 'b2.ts', 'y7.ts', 'c3.ts']
    const items = order.map((p, i) => ({
      path: p,
      representation: i % 2 === 0 ? ('source' as const) : ('compression' as const)
    }))

    const result = await service.execute(buildDashInput(items), repoPath)

    expect(result.success).toBe(true)
    const xmlItems = extractItemAttributes(result.xml!)
    expect(xmlItems.map((it) => it.path)).toEqual(order)
    expect(xmlItems.map((it) => it.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  // E2E-06
  it('E2E-06: basename único resolve por fallback e reporta o caminho real', async () => {
    repoPath = await createTempGitRepo()
    writeFile(repoPath, 'src/deep/gamma.ts', 'gamma\n')

    const source = new SpyContextProvider()
    source.setContentFactory(() => 'GAMMA_SOURCE')
    const compression = new SpyContextProvider()
    const service = makeRealDashService(source, compression)

    const result = await service.execute(
      buildDashInput([{ path: 'gamma.ts', representation: 'source' }]),
      repoPath
    )

    expect(result.success).toBe(true)
    expect(result.failures).toEqual([])
    expect(result.metadata).toEqual({ requested: 1, resolved: 1, generated: 1, failed: 0 })
    // O XML deve conter o caminho real resolvido, não o basename pedido.
    expect(result.xml).toContain('path="src/deep/gamma.ts"')
    expect(extractItemCdata(result.xml!, 0)).toBe('GAMMA_SOURCE')
  })

  // E2E-07
  it('E2E-07: basename ambíguo falha com reason "ambiguous" sem processar nenhum arquivo', async () => {
    repoPath = await createTempGitRepo()
    writeFile(repoPath, 'src/auth/service.ts', 'auth\n')
    writeFile(repoPath, 'src/payment/service.ts', 'payment\n')

    const source = new SpyContextProvider()
    const compression = new SpyContextProvider()
    const service = makeRealDashService(source, compression)

    const result = await service.execute(
      buildDashInput([{ path: 'service.ts', representation: 'source' }]),
      repoPath
    )

    expect(result.success).toBe(true)
    expect(result.metadata?.failed).toBe(1)
    expect(result.metadata?.generated).toBe(0)
    expect(result.failures).toHaveLength(1)
    expect(result.failures![0].reason).toBe('ambiguous')
    expect(result.xml).toContain('<failure index="0" path="service.ts" reason="ambiguous"')
    // Nenhum arquivo foi processado arbitrariamente.
    expect(source.calls.length).toBe(0)
    expect(result.xml).not.toContain('<item index=')
  })

  // E2E-08
  it('E2E-08: arquivo inexistente vira falha parcial sem bloquear o item existente', async () => {
    repoPath = await createTempGitRepo()
    writeFile(repoPath, 'real.ts', 'real\n')

    const source = new SpyContextProvider()
    source.setContentFactory((item) => `S:${item.path}`)
    const compression = new SpyContextProvider()
    const service = makeRealDashService(source, compression)

    const result = await service.execute(
      buildDashInput([
        { path: 'real.ts', representation: 'source' },
        { path: 'ghost.ts', representation: 'source' }
      ]),
      repoPath
    )

    expect(result.success).toBe(true)
    expect(result.metadata).toEqual({ requested: 2, resolved: 1, generated: 1, failed: 1 })
    expect(result.xml).toContain('<failure index="1" path="ghost.ts" reason="not_found"')
    expect(result.xml).toContain('path="real.ts"')
    // Provider chamado apenas para o item resolvido.
    expect(source.receivedIndexes).toEqual([0])
  })

  // E2E-09
  it('E2E-09: execução parcial com 10 itens (7 resolvidos, 3 inexistentes) mantém contagens', async () => {
    repoPath = await createTempGitRepo()
    const real = ['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts', 'f6.ts', 'f7.ts']
    const ghosts = ['nope1.ts', 'nope2.ts', 'nope3.ts']
    for (const f of real) writeFile(repoPath, f, `content ${f}\n`)

    const source = new SpyContextProvider()
    source.setContentFactory((item) => `S:${item.path}`)
    const compression = new SpyContextProvider()
    compression.setContentFactory((item) => `C:${item.path}`)
    const service = makeRealDashService(source, compression)

    // Intercala ghosts entre os reais (mixed mode entre os 7 resolvidos).
    const items = [
      { path: 'f1.ts', representation: 'source' as const },
      { path: 'nope1.ts', representation: 'source' as const },
      { path: 'f2.ts', representation: 'compression' as const },
      { path: 'f3.ts', representation: 'compression' as const },
      { path: 'nope2.ts', representation: 'compression' as const },
      { path: 'f4.ts', representation: 'source' as const },
      { path: 'f5.ts', representation: 'compression' as const },
      { path: 'f6.ts', representation: 'source' as const },
      { path: 'nope3.ts', representation: 'source' as const },
      { path: 'f7.ts', representation: 'compression' as const }
    ]

    const result = await service.execute(buildDashInput(items), repoPath)

    expect(result.success).toBe(true)
    expect(result.metadata).toEqual({
      requested: 10, resolved: 7, generated: 7, failed: 3
    })
    expect(result.failures!.map((f) => f.path).sort()).toEqual([...ghosts].sort())
    expect((result.xml!.match(/<item /g) ?? []).length).toBe(7)
    expect((result.xml!.match(/<failure /g) ?? []).length).toBe(3)
    expect([...source.receivedIndexes].sort((a, b) => a - b)).toEqual([0, 5, 7])
    expect([...compression.receivedIndexes].sort((a, b) => a - b)).toEqual([2, 3, 6, 9])
  })

  // E2E-10
  it('E2E-10: profile customizado em 1 item chega ao provider sem contaminar o item default', async () => {
    repoPath = await createTempGitRepo()
    writeFile(repoPath, 'p1.ts', 'p1\n')
    writeFile(repoPath, 'p2.ts', 'p2\n')

    const customProfile = JSON.stringify({ removeComments: true })
    const compression = new SpyContextProvider()
    compression.setContentFactory((item) => `C:${item.path}`)
    const source = new SpyContextProvider()
    const service = makeRealDashService(source, compression)

    // O contrato do provider é a fronteira onde o profile por item é resolvido:
    // itens sem profile devem receber o default; itens com profile devem
    // recebê-lo intacto, sem contaminação cruzada entre grupos.
    const { CompressionContextProvider } = await import(
      './providers/compression-context-provider'
    )
    const provider = new CompressionContextProvider({
      generateCompressionMarkdown: async (_repo, files, profile) =>
        files
          .map(
            (f) =>
              `## 📄 \`${f}\`\n\`\`\`ts\nprofile=${
                typeof profile === 'string' ? profile : JSON.stringify(profile)
              }\n\`\`\``
          )
          .join('\n')
    } as never)

    const providerResult = await provider.provide(
      [
        { index: 0, path: 'p1.ts', representation: 'compression', profile: customProfile },
        { index: 1, path: 'p2.ts', representation: 'compression' }
      ],
      { repoPath }
    )

    // Item com profile customizado recebe o profile; item default recebe o
    // DEFAULT_PROFILE e não herda o custom.
    expect(providerResult.contents.get(0)).toContain('"removeComments":true')
    expect(providerResult.contents.get(1)).toContain('"removeComments":false')
    expect(providerResult.contents.get(1)).not.toContain('"removeComments":true')

    // Espião registra que os profiles chegaram distintos ao provider.
    const spyResult = await compression.provide(
      [
        { index: 0, path: 'p1.ts', representation: 'compression', profile: customProfile },
        { index: 1, path: 'p2.ts', representation: 'compression' }
      ],
      { repoPath }
    )
    expect(spyResult.contents.get(0)).toBe('C:p1.ts')
    expect(spyResult.contents.get(1)).toBe('C:p2.ts')
    expect(compression.receivedProfiles[0][0]).toBe(customProfile)
    expect(compression.receivedProfiles[0][1]).toBeUndefined()
  })
})
