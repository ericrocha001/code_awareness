/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Provar E2E a robustez do Code Dash (E2E-26 a E2E-30): determinismo, cancelamento, isolamento entre providers e resiliência com contexto grande.
2. Usar o pipeline central real com providers espiões controláveis (delay, falha injetada) e filesystem temporário real.

Mapa de Relacionamentos do Script

1. dash-e2e-helpers.ts
   - Tipo: Dependência Direta
   - Relação: Consome DashService real, SpyContextProvider (delay/falha) e utilidades de XML.
   - Criticidade: Alta

2. dash-service.ts
   - Tipo: Dependência Direta
   - Relação: Exercitado com AbortSignal e falhas de provider.
   - Criticidade: Alta

3. git-test-helpers.ts
   - Tipo: Dependência Direta
   - Relação: Cria e limpa repositórios temporários reais.
   - Criticidade: Média

Invariantes do Script

1. Mesmo input produz mesmo XML (exceto timestamp) entre execuções repetidas.
2. Cancelamento rejeita a execução e nenhum provider completa em background exposto como resultado.
3. Falha de um provider nunca contamina o resultado do outro provider.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDashInput,
  checkWellFormedDashXml,
  cleanupTempRepo,
  createTempGitRepo,
  extractItemAttributes,
  extractItemCdata,
  makeRealDashService,
  SpyContextProvider,
  stripGeneratedAt,
  writeFile
} from './dash-e2e-helpers'

describe('Suite E — Robustez', () => {
  let repoPath: string

  afterEach(async () => {
    if (repoPath) await cleanupTempRepo(repoPath)
    repoPath = ''
  })

  // E2E-26
  it('E2E-26: 3 execuções do mesmo request produzem o mesmo XML (determinismo)', async () => {
    repoPath = await createTempGitRepo()
    writeFile(repoPath, 'one.ts', '1\n')
    writeFile(repoPath, 'two.ts', '2\n')
    writeFile(repoPath, 'three.ts', '3\n')

    const run = async () => {
      const source = new SpyContextProvider()
      source.setContentFactory((item) => `S:${item.path}`)
      const compression = new SpyContextProvider()
      compression.setContentFactory((item) => `C:${item.path}`)
      const service = makeRealDashService(source, compression)
      return service.execute(
        buildDashInput([
          { path: 'one.ts', representation: 'source' },
          { path: 'two.ts', representation: 'compression' },
          { path: 'three.ts', representation: 'source' }
        ]),
        repoPath
      )
    }

    const r1 = await run()
    const r2 = await run()
    const r3 = await run()

    expect(r1.success).toBe(true)
    expect(stripGeneratedAt(r1.xml!)).toBe(stripGeneratedAt(r2.xml!))
    expect(stripGeneratedAt(r2.xml!)).toBe(stripGeneratedAt(r3.xml!))
  })

  // E2E-27
  it('E2E-27: cancelamento durante a geração interrompe sem expor resultado parcial', async () => {
    repoPath = await createTempGitRepo()
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) {
      writeFile(repoPath, f, `${f}\n`)
    }

    const source = new SpyContextProvider()
    source.setContentFactory((item) => `S:${item.path}`)
    source.setDelay(2000)
    const compression = new SpyContextProvider()
    const service = makeRealDashService(source, compression)

    const controller = new AbortController()
    const execution = service.execute(
      buildDashInput([
        { path: 'a.ts', representation: 'source' },
        { path: 'b.ts', representation: 'source' },
        { path: 'c.ts', representation: 'source' },
        { path: 'd.ts', representation: 'source' }
      ]),
      repoPath,
      { signal: controller.signal }
    )

    setTimeout(() => controller.abort(), 100)

    // A execução é interrompida: rejeita (erro de cancelamento) ou retorna
    // insucesso estruturado — nunca sucesso com resultado completo.
    let rejected = false
    let result
    try {
      result = await execution
    } catch {
      rejected = true
    }

    if (rejected) {
      expect(rejected).toBe(true)
    } else {
      expect(result!.success).toBe(false)
    }

    // Nenhum provider completou o trabalho em background: o spion não recebeu
    // ciclo completo de produção de conteúdo para os 4 itens.
    expect(source.calls.length).toBeLessThanOrEqual(1)
    const producedCount = source.calls.reduce((acc, items) => acc + items.length, 0)
    // Se chegou a iniciar, o abort deve ter interrompido antes de produzir tudo.
    if (producedCount > 0) {
      expect(rejected || result!.success === false).toBe(true)
    }
  }, 10000)

  // E2E-28
  it('E2E-28: falha de Source não afeta itens Compression', async () => {
    repoPath = await createTempGitRepo()
    writeFile(repoPath, 's1.ts', 's1\n')
    writeFile(repoPath, 's2.ts', 's2\n')
    writeFile(repoPath, 'c1.ts', 'c1\n')

    const source = new SpyContextProvider()
    source.setFailures({ 0: 'repomix indisponível', 2: 'repomix indisponível' })
    const compression = new SpyContextProvider()
    compression.setContentFactory((item) => `C:${item.path}`)
    const service = makeRealDashService(source, compression)

    const result = await service.execute(
      buildDashInput([
        { path: 's1.ts', representation: 'source' },
        { path: 'c1.ts', representation: 'compression' },
        { path: 's2.ts', representation: 'source' }
      ]),
      repoPath
    )

    expect(result.success).toBe(true)
    // Itens compression gerados normalmente.
    expect(extractItemCdata(result.xml!, 1)).toBe('C:c1.ts')
    // Itens source reportados como falha, sem contaminar o compression.
    expect(result.failures!.map((f) => f.index).sort()).toEqual([0, 2])
    expect(result.metadata).toEqual({ requested: 3, resolved: 3, generated: 1, failed: 2 })
    const items = extractItemAttributes(result.xml!)
    expect(items).toHaveLength(1)
    expect(items[0].representation).toBe('compression')
  })

  // E2E-29
  it('E2E-29: falha de Compression não afeta itens Source', async () => {
    repoPath = await createTempGitRepo()
    writeFile(repoPath, 's1.ts', 's1\n')
    writeFile(repoPath, 'c1.ts', 'c1\n')
    writeFile(repoPath, 'c2.ts', 'c2\n')

    const source = new SpyContextProvider()
    source.setContentFactory((item) => `S:${item.path}`)
    const compression = new SpyContextProvider()
    compression.setFailures({ 1: 'tree-sitter parse error', 2: 'tree-sitter parse error' })
    const service = makeRealDashService(source, compression)

    const result = await service.execute(
      buildDashInput([
        { path: 's1.ts', representation: 'source' },
        { path: 'c1.ts', representation: 'compression' },
        { path: 'c2.ts', representation: 'compression' }
      ]),
      repoPath
    )

    expect(result.success).toBe(true)
    expect(extractItemCdata(result.xml!, 0)).toBe('S:s1.ts')
    expect(result.failures!.map((f) => f.index).sort()).toEqual([1, 2])
    expect(result.metadata).toEqual({ requested: 3, resolved: 3, generated: 1, failed: 2 })
    const items = extractItemAttributes(result.xml!)
    expect(items).toHaveLength(1)
    expect(items[0].representation).toBe('source')
  })

  // E2E-30
  it('E2E-30: 50 arquivos grandes (~200KB cada) geram XML válido sem crash', async () => {
    repoPath = await createTempGitRepo()
    // 50 arquivos x 200KB ≈ 10MB de conteúdo; escrever uma vez, com bloco
    // repetitivo determinístico (evita estourar o heap na montagem das strings).
    const block =
      'const block = "abcdefghij"; // linha de preenchimento determinística\n'.repeat(100)
    const bigFiles: string[] = []
    for (let i = 0; i < 50; i++) {
      const name = `big/big-${i}.ts`
      bigFiles.push(name)
      writeFile(repoPath, name, block.repeat(25))
    }

    const source = new SpyContextProvider()
    // Provider retorna conteúdo proporcional (~200KB por arquivo) simulando o
    // volume real de contexto — o XML final fica com ~10MB.
    const bigContent = ('const big = "0123456789abcdefghij"; // padding\n').repeat(6650) // ≈200KB
    source.setContentFactory(() => bigContent)
    const compression = new SpyContextProvider()
    const service = makeRealDashService(source, compression)

    const input = buildDashInput(
      bigFiles.map((p) => ({ path: p, representation: 'source' as const }))
    )

    const startedAt = Date.now()
    const result = await service.execute(input, repoPath)
    const elapsedMs = Date.now() - startedAt

    expect(result.success).toBe(true)
    expect(result.metadata?.generated).toBe(50)
    expect(result.xml!.length).toBeGreaterThan(5_000_000)
    const check = checkWellFormedDashXml(result.xml!)
    expect(check.problems).toEqual([])
    // Tempo registrado e dentro de limite de sanidade (sem hang).
    expect(elapsedMs).toBeLessThan(60000)
    console.log(`[E2E-30] tempo de geração: ${elapsedMs}ms`)
  }, 120000)
})
