/*
-T ---
*/

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDashInput,
  cleanupTempRepo,
  createTempGitRepo,
  extractItemCdata,
  checkWellFormedDashXml,
  makeRealDashService,
  SpyContextProvider,
  writeFile
} from './dash-e2e-helpers'

describe('Suite B — Segurança e Erros', () => {
  let repoPath: string
  let extraDirs: string[] = []

  afterEach(async () => {
    if (repoPath) await cleanupTempRepo(repoPath)
    repoPath = ''
    for (const dir of extraDirs) {
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      } catch {
        /* cleanup silencioso */
      }
    }
    extraDirs = []
  })

  // E2E-11
  it('E2E-11: todas as variantes de request inválido são rejeitadas sem chamar providers', async () => {
    repoPath = await createTempGitRepo()
    writeFile(repoPath, 'x.ts', 'x\n')

    const invalidInputs: Array<[string, string]> = [
      ['JSON truncado', '{"protocol": "code-dash/v1", "items": ['],
      ['array em vez de objeto', '[{"path": "x.ts"}]'],
      ['protocol ausente', JSON.stringify({ output: { format: 'xml' }, items: [{ path: 'x.ts', representation: 'source' }] })],
      ['protocol errado', JSON.stringify({ protocol: 'other/v9', output: { format: 'xml' }, items: [{ path: 'x.ts', representation: 'source' }] })],
      ['items vazio', JSON.stringify({ protocol: 'code-dash/v1', output: { format: 'xml' }, items: [] })],
      ['representation inválida', JSON.stringify({ protocol: 'code-dash/v1', output: { format: 'xml' }, items: [{ path: 'x.ts', representation: 'yaml' }] })],
      ['campo desconhecido no top-level', JSON.stringify({ protocol: 'code-dash/v1', output: { format: 'xml' }, items: [{ path: 'x.ts', representation: 'source' }], extra: true })],
      ['campo desconhecido em item', JSON.stringify({ protocol: 'code-dash/v1', output: { format: 'xml' }, items: [{ path: 'x.ts', representation: 'source', hack: 1 }] })]
    ]

    const source = new SpyContextProvider()
    const compression = new SpyContextProvider()
    const service = makeRealDashService(source, compression)

    for (const [label, input] of invalidInputs) {
      const result = await service.execute(input, repoPath)
      expect(result.success, `variante "${label}" deveria falhar`).toBe(false)
      expect(result.error, `variante "${label}" deveria ter erro descritivo`).toBeTruthy()
      expect(result.xml, `variante "${label}" não deveria gerar XML`).toBeUndefined()
    }

    // Nenhum provider foi chamado em nenhuma variante.
    expect(source.calls.length).toBe(0)
    expect(compression.calls.length).toBe(0)
  })

  // E2E-12
  it('E2E-12: nenhuma variante de path traversal atravessa validator e resolver', async () => {
    repoPath = await createTempGitRepo()
    writeFile(repoPath, 'src/legit.ts', 'legit\n')

    // Secret FORA do repo (diretório irmão).
    const outsideDir = mkdtempSync(join(tmpdir(), 'dash_secret_'))
    extraDirs.push(outsideDir)
    const secretPath = join(outsideDir, 'secret.txt')
    writeFileSync(secretPath, 'TOP SECRET', 'utf-8')
    const outsideName = outsideDir.split(/[\\/]/).pop()!

    const traversalVariants = [
      '../secret.txt',
      '../../secret.txt',
      `/absolute/path.txt`,
      `C:\\absolute\\path.txt`,
      `C:/absolute/path.txt`,
      `\\\\server\\share\\file.txt`,
      `../${outsideName}/secret.txt`
    ]

    const source = new SpyContextProvider()
    source.setContentFactory((item) => {
      // Violação gravíssima: se o provider fosse chamado com path fora, falha.
      if (item.path.includes('secret')) throw new Error('CONTENT LEAK: ' + item.path)
      return `S:${item.path}`
    })
    const compression = new SpyContextProvider()
    const service = makeRealDashService(source, compression)

    for (const badPath of traversalVariants) {
      const result = await service.execute(
        buildDashInput([{ path: badPath, representation: 'source' }]),
        repoPath
      )
      expect(result.success, `variante "${badPath}" deveria ser bloqueada`).toBe(false)
      // Nenhum conteúdo fora do repo pode ter sido exposto.
      if (result.xml) {
        expect(result.xml).not.toContain('TOP SECRET')
      }
    }

    // Defesa em profundidade: com item válido junto, o traversal vira failure
    // estruturada no XML (resolver) ou rejeita a requisição inteira (validator).
    const mixed = await service.execute(
      buildDashInput([
        { path: 'src/legit.ts', representation: 'source' },
        { path: `../${outsideName}/secret.txt`, representation: 'source' }
      ]),
      repoPath
    )
    if (mixed.success) {
      expect(mixed.xml).not.toContain('TOP SECRET')
      expect(mixed.xml).not.toContain('secret.txt" representation')
    }

    expect(source.receivedIndexes.every((i) => i >= 0)).toBe(true)
    expect(mixed.xml ?? '').not.toContain('TOP SECRET')
  })

  // E2E-13
  it('E2E-13: One-Click XML não inclui arquivos ignorados pelo .gitignore', async () => {
    repoPath = await createTempGitRepo()
    writeFile(repoPath, '.gitignore', 'node_modules/\ndist/\n')
    writeFile(repoPath, 'root-a.ts', 'a\n')
    writeFile(repoPath, 'src/root-b.ts', 'b\n')
    writeFile(repoPath, 'src/root-c.ts', 'c\n')
    writeFile(repoPath, 'node_modules/dep.js', 'ignored\n')
    writeFile(repoPath, 'dist/bundle.js', 'ignored\n')

    const { service } = await makeOneClickService(repoPath)
    const result = await service.generateOneClickXml(repoPath)

    expect(result.success).toBe(true)
    expect(result.xml).not.toContain('node_modules/dep.js')
    expect(result.xml).not.toContain('dist/bundle.js')
    for (const kept of ['root-a.ts', 'src/root-b.ts', 'src/root-c.ts']) {
      expect(result.xml).toContain(kept)
    }
  })

  // E2E-14
  it('E2E-14: XML com falha parcial é estruturalmente válido e completo', async () => {
    repoPath = await createTempGitRepo()
    writeFile(repoPath, 'a.ts', 'a\n')
    writeFile(repoPath, 'b.ts', 'b\n')
    writeFile(repoPath, 'c.ts', 'c\n')

    const source = new SpyContextProvider()
    source.setContentFactory((item) => `S:${item.path}`)
    const compression = new SpyContextProvider()
    compression.setContentFactory((item) => `C:${item.path}`)
    const service = makeRealDashService(source, compression)

    const result = await service.execute(
      buildDashInput([
        { path: 'a.ts', representation: 'source' },
        { path: 'b.ts', representation: 'compression' },
        { path: 'missing.ts', representation: 'source' },
        { path: 'c.ts', representation: 'compression' }
      ]),
      repoPath
    )

    expect(result.success).toBe(true)
    const check = checkWellFormedDashXml(result.xml!)
    expect(check.problems).toEqual([])
    expect(result.xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(result.xml).toContain('<code-dash-context ')
    expect(result.xml).toContain('<metadata>')
    expect(result.xml).toContain('<failure index="2"')
    expect(result.xml).toContain('<items>')
  })

  // E2E-15
  it('E2E-15: conteúdo source no CDATA é idêntico ao produzido pelo provider', async () => {
    repoPath = await createTempGitRepo()
    const big = Array.from({ length: 50 }, (_, i) => `line ${i} // comentário <tag> & "quotes"`).join('\n')
    writeFile(repoPath, 'big.ts', big)

    const exactOutput = '<<<exato>>> & ]]>';
    const source = new SpyContextProvider()
    source.setContentFactory(() => exactOutput)
    const compression = new SpyContextProvider()
    const service = makeRealDashService(source, compression)

    const result = await service.execute(
      buildDashInput([{ path: 'big.ts', representation: 'source' }]),
      repoPath
    )

    expect(result.success).toBe(true)
    const cdata = extractItemCdata(result.xml!, 0)
    expect(cdata).not.toBeNull()
    // Fidelidade byte a byte — inclusive com caracteres CDATA-hostis (']]>').
    expect(cdata).toBe(exactOutput.replace(/]]>/g, ']]]]><![CDATA[>'))
    expect(cdata!.length).toBe(exactOutput.replace(/]]>/g, ']]]]><![CDATA[>').length)
  })

  // E2E-16
  it('E2E-16: conteúdo compression no CDATA é idêntico ao produzido pelo provider', async () => {
    repoPath = await createTempGitRepo()
    writeFile(repoPath, 'comp.ts', 'const x = 1\n')

    const exactOutput = 'compressed <<content>> with "quotes" & symbols ]]> trailing'
    const compression = new SpyContextProvider()
    compression.setContentFactory(() => exactOutput)
    const source = new SpyContextProvider()
    const service = makeRealDashService(source, compression)

    const result = await service.execute(
      buildDashInput([{ path: 'comp.ts', representation: 'compression' }]),
      repoPath
    )

    expect(result.success).toBe(true)
    const cdata = extractItemCdata(result.xml!, 0)
    expect(cdata).toBe(exactOutput.replace(/]]>/g, ']]]]><![CDATA[>'))
  })

  /**
   * Monta um OneClickXmlService com IgnorePolicy e mock de Direct Output
   * para os cenários que dependem de listagem e filtros reais de arquivos.
   */
  async function makeOneClickService(_repo: string) {
    const { IgnorePolicy } = await import('../ignore-policy')
    const { OneClickXmlService } = await import('../one-click-xml-service')

    class OneClickMockAdapter {
      async generateDirectOutput(request: { selectedFiles: string[] }) {
        const filesXml = request.selectedFiles
          .map((p) => `<file path="${p}">content of ${p}</file>`)
          .join('\n')
        return {
          content: `<?xml version="1.0"?><repomix>${filesXml}</repomix>`,
          failed: false
        }
      }
    }

    const adapter = new OneClickMockAdapter()
    const ignorePolicy = new IgnorePolicy()
    const service = new OneClickXmlService(ignorePolicy, adapter)
    return { service, adapter }
  }

})
