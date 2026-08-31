/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar o OneClickXmlService contra o Repomix real em cenários de aceitação end-to-end.
2. Provar o passthrough fiel (PA-00) comparando byte a byte o XML do serviço com a chamada direta ao RepomixAdapter.
3. Provar as três flags de limpeza (removeComments, removeEmptyLines, truncateBase64) sobre conteúdo real.
4. Provar as políticas de ignore (Git Ignore e Code Awareness Ignore) e sua composição.
5. Documentar por teste o comportamento real de untracked files e arquivos binários no Repomix 1.15.0.

Mapa de Relacionamentos do Script

1. one-click-xml-service.ts
   - Tipo: Dependência Direta
   - Relação: Sujeito dos testes de aceitação (gera o One-Click XML real).
   - Criticidade: Alta

2. ignore-policy.ts
   - Tipo: Dependência Direta
   - Relação: Instanciado com GitService real e SettingsReader fake para resolver a allowlist.
   - Criticidade: Alta

3. repomix-adapter.ts
   - Tipo: Dependência Direta
   - Relação: Porta real de Direct Output usada tanto no passthrough (PA-00) quanto nos demais cenários.
   - Criticidade: Alta

4. git-test-helpers.ts
   - Tipo: Dependência Direta
   - Relação: Cria repositórios Git temporários reais e limpa após cada teste.
   - Criticidade: Alta

Invariantes do Script

1. Nenhum mock substitui o Repomix — todos os cenários executam a CLI real (npx repomix).
2. O teste não enfraquece assertions para acomodar comportamento defeituoso; comportamento observado do Repomix é documentado via console.log.
3. Comportamento documentado do Repomix 1.15.0 (sondagem prévia): arquivos binários explicitamente incluídos são silenciosamente excluídos de <files> sem falhar; arquivos untracked são incluídos; arquivos git-ignored são excluídos mesmo com include explícito.
4. Cada teste cria e limpa seu próprio repositório temporário (isolamento total).

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { writeFileSync } from 'fs'
import { afterEach, describe, expect, it } from 'vitest'
import { IgnorePolicy, type SettingsReader } from './ignore-policy'
import { OneClickXmlService } from './one-click-xml-service'
import { RepomixAdapter } from './repomix-adapter'
import { buildRepomixRequest } from './repomix-arguments-builder'
import { resolveEffectiveProfile } from './effective-profile'
import { DEFAULT_PROFILE } from './compression-profile'
import {
  cleanupTempRepo,
  commit,
  createTempGitRepo,
  stageAll,
  writeFile
} from './git-test-helpers'

const TEST_TIMEOUT = 120_000

/** Repositórios criados no teste, limpos no afterEach. */
const repos: string[] = []

afterEach(async () => {
  for (const repo of repos) {
    await cleanupTempRepo(repo)
  }
  repos.length = 0
})

async function createRepo(): Promise<string> {
  const repo = await createTempGitRepo()
  repos.push(repo)
  return repo
}

/**
 * Cria o serviço One-Click com dependências REAIS (GitService + Repomix CLI),
 * injetando apenas um SettingsReader fake para os ignores do Code Awareness.
 */
function createService(
  repoPath: string,
  ignoredDiffFiles: string[] = []
): OneClickXmlService {
  const settingsReader: SettingsReader = {
    loadSettings: () => ({
      ignoredDiffFiles: ignoredDiffFiles.length
        ? { [repoPath]: ignoredDiffFiles }
        : {}
    })
  }
  const ignorePolicy = new IgnorePolicy(undefined, settingsReader)
  const adapter = new RepomixAdapter()
  return new OneClickXmlService(ignorePolicy, adapter)
}

describe('OneClickXmlService — Bateria de Aceitação Real (Repomix nativo)', () => {
  it(
    'PA-00: passthrough real — XML do serviço é idêntico byte a byte à chamada direta ao Repomix',
    async () => {
      const repo = await createRepo()
      writeFile(repo, 'a.ts', 'export const a = 1\n')
      writeFile(repo, 'b.ts', 'export const b = 2\n')
      writeFile(repo, 'c.md', '# doc\n')
      await stageAll(repo)
      await commit(repo, 'init')

      const service = createService(repo)

      // Chamada direta ao Repomix com os MESMOS parâmetros derivados do serviço
      const directAdapter = new RepomixAdapter()
      const policy = new IgnorePolicy()
      const allowlist = await policy.resolveAllowlist(repo)
      expect(allowlist.length).toBeGreaterThan(0)
      const profile = resolveEffectiveProfile({ ...DEFAULT_PROFILE }, 'xml')
      const request = buildRepomixRequest(repo, allowlist, profile, 'xml')
      const directResult = await directAdapter.generateDirectOutput(request)

      const oneClickResult = await service.generateOneClickXml(repo)

      expect(directResult.failed).toBe(false)
      expect(oneClickResult.success).toBe(true)
      expect(oneClickResult.xml).toBe(directResult.content)
    },
    TEST_TIMEOUT
  )

  it(
    'PA-01: output é XML nativo, sem envelope do Code Dash',
    async () => {
      const repo = await createRepo()
      writeFile(repo, 'index.ts', 'export const i = 1\n')
      await stageAll(repo)
      await commit(repo, 'init')

      const result = await createService(repo).generateOneClickXml(repo)

      expect(result.success).toBe(true)
      const xml = result.xml!
      expect(xml).not.toContain('<code-dash-context')
      expect(xml).not.toContain('<item index=')
      expect(xml).not.toContain('<![CDATA[')
      // Estrutura nativa do Repomix presente
      expect(xml).toContain('<file path="index.ts"')
      expect(xml).toContain('<files')
    },
    TEST_TIMEOUT
  )

  it(
    'PA-02: removeComments remove comentários de linha, bloco e JSDoc do conteúdo',
    async () => {
      const repo = await createRepo()
      writeFile(
        repo,
        'comments.ts',
        [
          '// Comentário de linha',
          '/* Comentário de bloco */',
          '/**',
          ' * JSDoc',
          ' */',
          'const x = 1 // Comentário inline',
          'export function util() { return 7 }',
          ''
        ].join('\n')
      )
      await stageAll(repo)
      await commit(repo, 'init')

      const result = await createService(repo).generateOneClickXml(repo, {
        removeComments: true
      })

      expect(result.success).toBe(true)
      const blocks = extractFileBlocks(result.xml!)
      const content = blocks.get('comments.ts') ?? ''
      expect(content).not.toContain('Comentário de linha')
      expect(content).not.toContain('Comentário de bloco')
      expect(content).not.toContain('JSDoc')
      expect(content).not.toContain('Comentário inline')
      // Nota: sob --compress (sempre emitido), apenas o corpo de topo é preservado
      expect(content).toContain('const x = 1')
    },
    TEST_TIMEOUT
  )

/** Extrai os blocos <file path="...">conteúdo</file> do XML nativo do Repomix. */
function extractFileBlocks(xml: string): Map<string, string> {
  const blocks = new Map<string, string>()
  const pattern = /<file path="([^"]+)">([\s\S]*?)<\/file>/g
  for (const match of xml.matchAll(pattern)) {
    const unescaped = match[2]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
    blocks.set(match[1], unescaped)
  }
  return blocks
}

  it(
    'PA-03: removeEmptyLines elimina linhas vazias consecutivas do conteúdo',
    async () => {
      const repo = await createRepo()
      writeFile(
        repo,
        'empty-lines.ts',
        ['const a = 1', '', '', 'const b = 2', '', '', '', 'const c = 3', ''].join('\n')
      )
      await stageAll(repo)
      await commit(repo, 'init')

      const result = await createService(repo).generateOneClickXml(repo, {
        removeEmptyLines: true
      })

      expect(result.success).toBe(true)
      const blocks = extractFileBlocks(result.xml!)
      const content = blocks.get('empty-lines.ts') ?? ''
      // Nenhuma sequência de 2+ linhas vazias consecutivas
      expect(content).not.toMatch(/\n[ \t]*\n[ \t]*\n/)
      expect(content).toContain('const a = 1')
      expect(content).toContain('const c = 3')
    },
    TEST_TIMEOUT
  )

  it(
    'PA-04: truncateBase64 trunca data URIs longas no output',
    async () => {
      const repo = await createRepo()
      const fullBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
      writeFile(repo, 'base64.ts', `const icon = 'data:image/png;base64,${fullBase64}'\n`)
      await stageAll(repo)
      await commit(repo, 'init')

      const withTruncation = await createService(repo).generateOneClickXml(repo, {
        truncateBase64: true
      })
      expect(withTruncation.success).toBe(true)
      const xmlTruncated = withTruncation.xml!
      expect(xmlTruncated).toContain('data:image/png;base64')
      expect(xmlTruncated).not.toContain(fullBase64)
      // Documenta o formato do truncamento observado
      console.log(
        '[PA-04] Data URI truncada:',
        xmlTruncated.match(/data:image\/png;base64[^\n'<]*/)?.[0]
      )
    },
    TEST_TIMEOUT
  )

  it(
    'PA-05: arquivos do Git Ignore (.gitignore) não aparecem no XML',
    async () => {
      const repo = await createRepo()
      writeFile(repo, '.gitignore', '*.secret.ts\nsecret.ts\n')
      writeFile(repo, 'secret.ts', 'const s = 1\n')
      writeFile(repo, 'other.secret.ts', 'const o = 1\n')
      writeFile(repo, 'normal.ts', 'export const n = 1\n')
      await stageAll(repo)
      await commit(repo, 'init')

      const result = await createService(repo).generateOneClickXml(repo)

      expect(result.success).toBe(true)
      const xml = result.xml!
      expect(xml).not.toContain('secret.ts')
      expect(xml).toContain('normal.ts')
    },
    TEST_TIMEOUT
  )

  it(
    'PA-06: arquivos do Code Awareness Ignore (settings) não aparecem no XML',
    async () => {
      const repo = await createRepo()
      writeFile(repo, '.hidden.ts', 'const h = 1\n')
      writeFile(repo, 'docs/internal/a.md', '# a\n')
      writeFile(repo, 'docs/internal/b.md', '# b\n')
      writeFile(repo, 'normal.ts', 'export const n = 1\n')
      await stageAll(repo)
      await commit(repo, 'init')

      const result = await createService(repo, [
        '.hidden.ts',
        'docs/internal/a.md'
      ]).generateOneClickXml(repo)

      expect(result.success).toBe(true)
      const xml = result.xml!
      expect(xml).not.toContain('.hidden.ts')
      expect(xml).not.toContain('docs/internal/a.md')
      expect(xml).toContain('docs/internal/b.md')
      expect(xml).toContain('normal.ts')
    },
    TEST_TIMEOUT
  )

  it(
    'PA-07: arquivo permitido aparece no XML com seu conteúdo',
    async () => {
      const repo = await createRepo()
      writeFile(repo, 'normal.ts', 'export const ANSWER = 42\n')
      await stageAll(repo)
      await commit(repo, 'init')

      const result = await createService(repo).generateOneClickXml(repo)

      expect(result.success).toBe(true)
      expect(result.xml).toContain('normal.ts')
      const blocks = extractFileBlocks(result.xml!)
      const content = blocks.get('normal.ts') ?? ''
      expect(content).toContain('ANSWER')
    },
    TEST_TIMEOUT
  )

  it(
    'PA-08: todos os arquivos não ignorados aparecem no XML',
    async () => {
      const repo = await createRepo()
      const names = ['alpha.ts', 'beta.ts', 'gamma.md', 'delta.ts']
      for (const [i, name] of names.entries()) {
        writeFile(repo, name, `export const v${i} = ${i}\n`)
      }
      await stageAll(repo)
      await commit(repo, 'init')

      const result = await createService(repo).generateOneClickXml(repo)

      expect(result.success).toBe(true)
      const blocks = extractFileBlocks(result.xml!)
      for (const name of names) {
        expect(blocks.has(name), `arquivo ${name} deve aparecer no XML`).toBe(true)
      }
    },
    TEST_TIMEOUT
  )

  it(
    'PA-09: untracked files são incluídos no XML (decisão de produto)',
    async () => {
      const repo = await createRepo()
      writeFile(repo, 'tracked.ts', 'export const t = 1\n')
      await stageAll(repo)
      await commit(repo, 'init')
      // Untracked: nem commitado nem staged
      writeFile(repo, 'untracked.ts', 'export const u = 9\n')

      const result = await createService(repo).generateOneClickXml(repo)

      expect(result.success).toBe(true)
      expect(result.xml).toContain('tracked.ts')
      expect(result.xml).toContain('untracked.ts')
      const blocks = extractFileBlocks(result.xml!)
      expect(blocks.has('untracked.ts')).toBe(true)
    },
    TEST_TIMEOUT
  )

  it(
    'PA-10: binários seguem o comportamento do Repomix (delegação documentada)',
    async () => {
      const repo = await createRepo()
      writeFile(repo, 'code.ts', 'export const c = 1\n')
      // PNG mínimo real (assinatura + IHDR + IEND)
      writeFileSync(
        `${repo}/image.png`,
        Buffer.from(
          '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
            '1f15c4890000000a49444154789c63000100000500010d0a2db4000000' +
            '0049454e44ae426082',
          'hex'
        )
      )
      writeFileSync(`${repo}/document.pdf`, Buffer.from('%PDF-1.4\n', 'utf-8'))
      await stageAll(repo)
      await commit(repo, 'init')

      const result = await createService(repo).generateOneClickXml(repo)

      // O Repomix NÃO falha na presença de binários
      expect(result.success).toBe(true)
      expect(result.xml).toContain('code.ts')

      // Comportamento documentado (sondagem Repomix 1.15.0): binários explicitamente
      // incluídos são silenciosamente excluídos da seção <files>, sem erro.
      const blocks = extractFileBlocks(result.xml!)
      console.log('[PA-10] Blocos de arquivo no XML:', Array.from(blocks.keys()).join(', '))
      expect(blocks.has('image.png')).toBe(false)
      expect(blocks.has('document.pdf')).toBe(false)
      expect(blocks.has('code.ts')).toBe(true)
    },
    TEST_TIMEOUT
  )

  it(
    'PA-11: composição de políticas — ignore Git + ignore Code Awareness + untracked + limpeza',
    async () => {
      const repo = await createRepo()
      writeFile(repo, '.gitignore', 'git-ignored.ts\n')
      writeFile(repo, 'kept.ts', '// Comentário\nconst a = 1\n\n\nconst b = 2\n')
      writeFile(repo, 'git-ignored.ts', '// Comentário\nconst c = 3\n')
      writeFile(repo, 'code-awareness-ignored.ts', '// Comentário\nconst d = 4\n')
      writeFile(repo, 'untracked.ts', '// Comentário\nconst e = 5\n')
      await stageAll(repo)
      await commit(repo, 'init')

      const result = await createService(repo, [
        'code-awareness-ignored.ts'
      ]).generateOneClickXml(repo, { removeComments: true, removeEmptyLines: true })

      expect(result.success).toBe(true)
      const xml = result.xml!
      expect(xml).toContain('kept.ts')
      expect(xml).not.toContain('git-ignored.ts')
      expect(xml).not.toContain('code-awareness-ignored.ts')
      expect(xml).toContain('untracked.ts')

      const blocks = extractFileBlocks(xml)
      const keptContent = blocks.get('kept.ts') ?? ''
      expect(keptContent).not.toContain('Comentário')
      expect(keptContent).not.toMatch(/\n[ \t]*\n[ \t]*\n/)
      const untrackedContent = blocks.get('untracked.ts') ?? ''
      expect(untrackedContent).not.toContain('Comentário')
    },
    TEST_TIMEOUT
  )

  it(
    'PA-12: diretórios aninhados respeitam .gitignore de subpasta',
    async () => {
      const repo = await createRepo()
      writeFile(repo, '.gitignore', 'docs/internal/\n')
      writeFile(repo, 'src/a.ts', 'export const a = 1\n')
      writeFile(repo, 'src/internal/b.ts', 'export const b = 2\n')
      writeFile(repo, 'docs/internal/c.md', '# c\n')
      await stageAll(repo)
      await commit(repo, 'init')

      const result = await createService(repo).generateOneClickXml(repo)

      expect(result.success).toBe(true)
      const xml = result.xml!
      expect(xml).toContain('src/a.ts')
      expect(xml).toContain('src/internal/b.ts')
      expect(xml).not.toContain('docs/internal/c.md')
    },
    TEST_TIMEOUT
  )

  it(
    'PA-13: múltiplos arquivos de tipos diferentes aparecem e mantêm estrutura nativa',
    async () => {
      const repo = await createRepo()
      const allowed = [
        'src/app.ts',
        'src/utils/math.ts',
        'src/components/Button.tsx',
        'README.md',
        'package.json'
      ]
      for (const [i, name] of allowed.entries()) {
        writeFile(repo, name, `// file ${i}\nexport const item${i} = ${i}\n`)
      }
      writeFile(repo, 'blocked.log', 'noise')
      writeFile(repo, '.gitignore', '*.log\n')
      await stageAll(repo)
      await commit(repo, 'init')

      const result = await createService(repo).generateOneClickXml(repo)

      expect(result.success).toBe(true)
      const xml = result.xml!
      expect(xml).not.toContain('blocked.log')
      const blocks = extractFileBlocks(xml)
      for (const name of allowed) {
        expect(blocks.has(name), `${name} deve aparecer`).toBe(true)
      }
      // Estrutura nativa intacta
      expect(xml).toContain('<files')
      expect(xml).toContain('</files>')
    },
    TEST_TIMEOUT
  )

  it(
    'PA-14: nomes/paths com caracteres especiais não quebram a geração',
    async () => {
      const repo = await createRepo()
      writeFile(repo, 'normal file.ts', 'export const a = 1\n')
      writeFile(repo, 'weird & file.ts', 'export const b = 2\n')
      writeFile(repo, 'arquivo with spaces.ts', 'export const c = 3\n')
      await stageAll(repo)
      await commit(repo, 'init')

      const result = await createService(repo).generateOneClickXml(repo)

      expect(result.success).toBe(true)
      const blocks = extractFileBlocks(result.xml!)
      // Os paths são escapados no XML (& -> &amp;), então validamos presença
      // sanitizada dos nomes e o conteúdo dos blocos
      const paths = Array.from(blocks.keys())
      console.log('[PA-14] Paths extraídos:', paths.join(' | '))
      expect(paths.some((p) => p.includes('normal file.ts'))).toBe(true)
      expect(paths.some((p) => p.includes('weird') && p.includes('file.ts'))).toBe(true)
      expect(paths.some((p) => p.includes('arquivo with spaces.ts'))).toBe(true)
      expect(Array.from(blocks.values()).join('\n')).toContain('export const c = 3')
    },
    TEST_TIMEOUT
  )

  it(
    'PA-16: allowlist vazia falha de forma estruturada sem invocar o Repomix',
    async () => {
      const repo = await createRepo()
      writeFile(repo, '.gitignore', '*\n')
      writeFile(repo, 'only.ts', 'export const o = 1\n')
      await stageAll(repo)
      await commit(repo, 'init')

      const result = await createService(repo).generateOneClickXml(repo)

      // Com tudo ignorado pelo .gitignore, o serviço encerra com erro estruturado
      expect(result.success).toBe(false)
      expect(result.error).toContain('Nenhum arquivo elegível')
      expect(result.xml).toBeUndefined()
    },
    TEST_TIMEOUT
  )

  it(
    'PA-17: repositório Git sem nenhum commit ainda gera XML válido (apenas untracked)',
    async () => {
      const repo = await createRepo()
      // Nenhum commit: git rev-parse HEAD falha, todos os arquivos são untracked
      writeFile(repo, 'fresh.ts', 'export const f = 1\n')

      const result = await createService(repo).generateOneClickXml(repo)

      expect(result.success).toBe(true)
      expect(result.xml).toContain('fresh.ts')
      expect(extractFileBlocks(result.xml!).has('fresh.ts')).toBe(true)
    },
    TEST_TIMEOUT
  )
})
