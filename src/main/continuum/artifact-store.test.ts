import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactStore, computeContentHash } from './artifact-store'
import type { AppendArtifactInput } from './continuum-types'

const openStores: Array<{ store: ArtifactStore; dir: string }> = []

function createTempStore(): { store: ArtifactStore; dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'continuum-test-'))
  const dbPath = join(dir, 'continuum.db')
  const store = new ArtifactStore(dbPath)
  openStores.push({ store, dir })
  return { store, dbPath, dir }
}

function baseArtifactInput(overrides: Partial<AppendArtifactInput> = {}): AppendArtifactInput {
  const now = new Date().toISOString()
  return {
    artifactId: 'handoff-uuid-001',
    type: 'IMPLEMENTATION_HANDOFF',
    schemaVersion: 1,
    title: 'Initial Implementation Handoff',
    producerRole: 'IMPLEMENTER',
    repositoryKey: 'repo-code-awareness',
    createdAt: now,
    rawMarkdown: '# Handoff\n\nContent for handoff.',
    ...overrides
  }
}

describe('Continuum Artifact Store — Foundation Harness', () => {
  afterEach(() => {
    for (const item of openStores) {
      item.store.close()
      try {
        rmSync(item.dir, { recursive: true, force: true })
      } catch {}
    }
    openStores.length = 0
  })

  // ── 1. Persistência ─────────────────────────────────────────────────────────

  it('1. Artifact persistido pode ser recuperado integralmente com todos os metadados', () => {
    const { store } = createTempStore()
    const input = baseArtifactInput({
      artifactId: 'art-persist-01',
      sourceFingerprint: 'fp-src-9988',
      gitHead: 'commit-sha-abcdef',
      rawMarkdown: '# Architecture Decision\n\nAll details preserved.'
    })

    const appended = store.append(input)

    expect(appended.artifactId).toBe('art-persist-01')
    expect(appended.type).toBe('IMPLEMENTATION_HANDOFF')
    expect(appended.schemaVersion).toBe(1)
    expect(appended.title).toBe(input.title)
    expect(appended.producerRole).toBe('IMPLEMENTER')
    expect(appended.repositoryKey).toBe('repo-code-awareness')
    expect(appended.createdAt).toBe(input.createdAt)
    expect(appended.ingestedAt).toBeTruthy()
    expect(appended.sourceFingerprint).toBe('fp-src-9988')
    expect(appended.gitHead).toBe('commit-sha-abcdef')
    expect(appended.contentHash).toBe(computeContentHash(input.rawMarkdown))
    expect(appended.rawMarkdown).toBe(input.rawMarkdown)

    const retrieved = store.get('art-persist-01')
    expect(retrieved).not.toBeNull()
    expect(retrieved).toEqual(appended)
  })

  it('2. Retorna null para artifactId inexistente', () => {
    const { store } = createTempStore()
    expect(store.get('non-existent-id')).toBeNull()
  })

  // ── 2. Restart ─────────────────────────────────────────────────────────────

  it('3. Restart preserva integridade exata: persistir -> fechar -> reabrir -> recuperar', () => {
    const { dir, dbPath, store: firstStore } = createTempStore()
    const complexMarkdown = '# Title\n\n- item 1\n- item 2\n\n```ts\nconst val = 42;\n```'
    const input = baseArtifactInput({
      artifactId: 'art-restart-01',
      rawMarkdown: complexMarkdown
    })

    const original = firstStore.append(input)
    firstStore.close()

    const reopenedStore = new ArtifactStore(dbPath)
    openStores.push({ store: reopenedStore, dir })

    const fetchedAfterRestart = reopenedStore.get('art-restart-01')
    expect(fetchedAfterRestart).not.toBeNull()
    expect(fetchedAfterRestart).toEqual(original)
    expect(fetchedAfterRestart!.rawMarkdown).toBe(complexMarkdown)
    expect(fetchedAfterRestart!.contentHash).toBe(computeContentHash(complexMarkdown))
  })

  // ── 3. Markdown Fidelity ───────────────────────────────────────────────────

  it('4. Preserva integralmente Markdown complexo sem normalizações ou alterações', () => {
    const { store } = createTempStore()
    const complexMarkdown = [
      '# Heading 1: Architectural Foundation',
      '## Heading 2: Continuum Invariants',
      '### Heading 3: Sub-level detail',
      '',
      'Paragraph with unicode characters: 🔥 ç ã õ ñ 日本語 text and symbols: ∑ ∫ ≈ ≠ ≤ ≥.',
      '',
      '| Column A | Column B | Column C |',
      '| :--- | :---: | ---: |',
      '| Value 1 | Value 2 | 100.50 |',
      '| Multi-word | Special: `code` | 200.00 |',
      '',
      'Code block with formatting and indentation:',
      '```typescript',
      'export function executeHandoff(): boolean {',
      '  const status = "VALIDADO";',
      '  return status.length > 0;',
      '}',
      '```',
      '',
      'Trailing blank lines and line-ending tests:',
      'Line with spaces at end:     ',
      '',
      'End of document.'
    ].join('\n')

    const input = baseArtifactInput({
      artifactId: 'art-fidelity-01',
      rawMarkdown: complexMarkdown
    })

    store.append(input)
    const fetched = store.get('art-fidelity-01')

    expect(fetched).not.toBeNull()
    expect(fetched!.rawMarkdown).toBe(complexMarkdown)
    expect(Buffer.from(fetched!.rawMarkdown, 'utf8')).toEqual(
      Buffer.from(complexMarkdown, 'utf8')
    )
  })

  // ── 4. Imutabilidade e Conflito de Identidade ──────────────────────────────

  it('5. Rejeita reutilização conflitante do mesmo artifactId com conteúdo diferente', () => {
    const { store } = createTempStore()
    const input = baseArtifactInput({
      artifactId: 'art-conflict-01',
      rawMarkdown: 'Original content.'
    })
    store.append(input)

    const conflictingInput = baseArtifactInput({
      artifactId: 'art-conflict-01',
      rawMarkdown: 'Different conflicting content.'
    })

    expect(() => store.append(conflictingInput)).toThrow(/CONFLICT/)

    const original = store.get('art-conflict-01')
    expect(original!.rawMarkdown).toBe('Original content.')
  })

  // ── 5. Idempotência ────────────────────────────────────────────────────────

  it('6. Retry idempotente com mesmo artifactId e mesmo conteúdo não duplica nem falha', () => {
    const { store } = createTempStore()
    const input = baseArtifactInput({
      artifactId: 'art-idempotent-01',
      rawMarkdown: 'Stable idempotent content.'
    })

    const first = store.append(input)
    const second = store.append(input)

    expect(second).toEqual(first)
    expect(store.list()).toHaveLength(1)
  })

  // ── 6. Content Integrity ───────────────────────────────────────────────────

  it('7. Calcula contentHash automaticamente e confere com SHA-256 do rawMarkdown', () => {
    const { store } = createTempStore()
    const markdown = 'Deterministic content hash test.'
    const expectedHash = computeContentHash(markdown)

    const artifact = store.append(
      baseArtifactInput({
        artifactId: 'art-integrity-01',
        rawMarkdown: markdown
      })
    )

    expect(artifact.contentHash).toBe(expectedHash)
  })

  it('8. Rejeita append quando contentHash explícito fornecido diverge do rawMarkdown', () => {
    const { store } = createTempStore()
    expect(() =>
      store.append(
        baseArtifactInput({
          artifactId: 'art-integrity-fail-01',
          rawMarkdown: 'True content.',
          contentHash: 'tampered-hash-00000000000000000000000000000000'
        })
      )
    ).toThrow(/INTEGRITY_ERROR/)
  })

  it('9. Aceita append quando contentHash explícito fornecido é válido e correspondente', () => {
    const { store } = createTempStore()
    const markdown = 'Valid content match.'
    const matchingHash = computeContentHash(markdown)

    const artifact = store.append(
      baseArtifactInput({
        artifactId: 'art-integrity-match-01',
        rawMarkdown: markdown,
        contentHash: matchingHash
      })
    )

    expect(artifact.contentHash).toBe(matchingHash)
  })

  // ── 7. Listagem e Filtros ──────────────────────────────────────────────────

  it('10. Lista artefatos ordenados por createdAt decrescente por padrão', () => {
    const { store } = createTempStore()
    store.append(
      baseArtifactInput({
        artifactId: 'art-order-1',
        createdAt: '2026-09-21T10:00:00.000Z'
      })
    )
    store.append(
      baseArtifactInput({
        artifactId: 'art-order-2',
        createdAt: '2026-09-21T12:00:00.000Z'
      })
    )
    store.append(
      baseArtifactInput({
        artifactId: 'art-order-3',
        createdAt: '2026-09-21T11:00:00.000Z'
      })
    )

    const list = store.list()
    expect(list.map((a) => a.artifactId)).toEqual([
      'art-order-2',
      'art-order-3',
      'art-order-1'
    ])
  })

  it('11. Listagem não carrega rawMarkdown (descoberta barata)', () => {
    const { store } = createTempStore()
    store.append(
      baseArtifactInput({
        artifactId: 'art-cheap-01',
        rawMarkdown: 'Large markdown text not needed in listing.'
      })
    )

    const list = store.list()
    expect(list).toHaveLength(1)
    expect((list[0] as any).rawMarkdown).toBeUndefined()
    expect(list[0].title).toBe('Initial Implementation Handoff')
    expect(list[0].contentHash).toBeTruthy()
  })

  it('12. Filtra listagem por repositoryKey, type e producerRole', () => {
    const { store } = createTempStore()
    store.append(
      baseArtifactInput({
        artifactId: 'art-repo-a',
        repositoryKey: 'repo-alpha'
      })
    )
    store.append(
      baseArtifactInput({
        artifactId: 'art-repo-b',
        repositoryKey: 'repo-beta'
      })
    )

    const alphaResults = store.list({ repositoryKey: 'repo-alpha' })
    expect(alphaResults).toHaveLength(1)
    expect(alphaResults[0].artifactId).toBe('art-repo-a')

    const betaResults = store.list({ repositoryKey: 'repo-beta' })
    expect(betaResults).toHaveLength(1)
    expect(betaResults[0].artifactId).toBe('art-repo-b')

    const filteredByType = store.list({ type: 'IMPLEMENTATION_HANDOFF' })
    expect(filteredByType).toHaveLength(2)

    const filteredByRole = store.list({ producerRole: 'IMPLEMENTER' })
    expect(filteredByRole).toHaveLength(2)
  })

  it('13. Limita quantidade de resultados na listagem', () => {
    const { store } = createTempStore()
    store.append(baseArtifactInput({ artifactId: 'art-limit-1', createdAt: '2026-09-21T01:00:00.000Z' }))
    store.append(baseArtifactInput({ artifactId: 'art-limit-2', createdAt: '2026-09-21T02:00:00.000Z' }))
    store.append(baseArtifactInput({ artifactId: 'art-limit-3', createdAt: '2026-09-21T03:00:00.000Z' }))

    const limited = store.list({ limit: 2 })
    expect(limited).toHaveLength(2)
    expect(limited.map((a) => a.artifactId)).toEqual(['art-limit-3', 'art-limit-2'])
  })

  // ── 8. Invariantes de Entrada ──────────────────────────────────────────────

  it('14. Valida invariantes obrigatórios de entrada', () => {
    const { store } = createTempStore()

    expect(() => store.append(baseArtifactInput({ artifactId: '' }))).toThrow(/artifactId/)
    expect(() => store.append(baseArtifactInput({ schemaVersion: 0 }))).toThrow(/schemaVersion/)
    expect(() => store.append(baseArtifactInput({ title: '   ' }))).toThrow(/title/)
    expect(() => store.append(baseArtifactInput({ repositoryKey: '' }))).toThrow(/repositoryKey/)
    expect(() => store.append(baseArtifactInput({ createdAt: '' }))).toThrow(/createdAt/)
    expect(() => store.append(baseArtifactInput({ type: 'UNKNOWN_TYPE' as any }))).toThrow(/Unsupported artifact type/)
    expect(() => store.append(baseArtifactInput({ producerRole: 'UNKNOWN_ROLE' as any }))).toThrow(/Unsupported producer role/)
  })

  // ── 9. Fluxo Principal da Meta (Critério de Conclusão dos 7 Passos) ────────

  it('15. Prova de Aceitação Principal do Plano (Passos 1 a 7)', () => {
    const { dir, dbPath, store: store1 } = createTempStore()
    const handoffMarkdown = [
      '# Relato de Implementação',
      '',
      '## Resultado',
      '`VALIDADO`',
      '',
      '## Implementado',
      '- Criação da fundação do Continuum',
      '- Persistência imutável em SQLite dedicado',
      '',
      '## Provas',
      '1. Persistência integral',
      '2. Restart e reabertura de store',
      '3. Fidelidade de Markdown complexo'
    ].join('\n')

    // 1. Criar um IMPLEMENTATION_HANDOFF
    // 2. Persistir seu Markdown integralmente
    const created = store1.append({
      artifactId: 'handoff-acceptance-001',
      type: 'IMPLEMENTATION_HANDOFF',
      schemaVersion: 1,
      title: 'Continuum Foundation Handoff',
      producerRole: 'IMPLEMENTER',
      repositoryKey: 'code_awareness',
      createdAt: '2026-09-21T22:30:00.000Z',
      rawMarkdown: handoffMarkdown,
      sourceFingerprint: 'src-fp-12345',
      gitHead: 'git-head-abcdef123'
    })

    expect(created.artifactId).toBe('handoff-acceptance-001')

    // 3. Encerrar o store
    store1.close()

    // 4. Reabrir
    const store2 = new ArtifactStore(dbPath)
    openStores.push({ store: store2, dir })

    // 5. Listar o artefato
    const listed = store2.list({ repositoryKey: 'code_awareness' })
    expect(listed).toHaveLength(1)
    expect(listed[0].artifactId).toBe('handoff-acceptance-001')
    expect(listed[0].title).toBe('Continuum Foundation Handoff')
    expect(listed[0].type).toBe('IMPLEMENTATION_HANDOFF')

    // 6. Recuperá-lo pelo ID
    const retrieved = store2.get('handoff-acceptance-001')
    expect(retrieved).not.toBeNull()

    // 7. Comprovar que nenhum conteúdo foi alterado
    expect(retrieved!.rawMarkdown).toBe(handoffMarkdown)
    expect(retrieved!.contentHash).toBe(computeContentHash(handoffMarkdown))
    expect(retrieved!.sourceFingerprint).toBe('src-fp-12345')
    expect(retrieved!.gitHead).toBe('git-head-abcdef123')
    expect(retrieved!.schemaVersion).toBe(1)
    expect(retrieved!.producerRole).toBe('IMPLEMENTER')
  })
})
