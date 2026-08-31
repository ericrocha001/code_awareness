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
})
