import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactStore, computeContentHash } from './artifact-store'
import { ArtifactInbox, INBOX_RELATIVE_PATH, REJECTED_RELATIVE_PATH } from './artifact-inbox'
import { ArtifactIngestor } from './artifact-ingestor'
import { ENVELOPE_PROTOCOL, serializeEnvelope } from './artifact-envelope'
import type { ArtifactEnvelope } from './artifact-envelope'

// ── Helpers ──────────────────────────────────────────────────────────────────

const tmpDirs: string[] = []

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'continuum-ingestor-test-'))
  tmpDirs.push(d)
  return d
}

function setup(): { repoRoot: string; dbPath: string; inbox: ArtifactInbox; store: ArtifactStore; ingestor: ArtifactIngestor } {
  const repoRoot = tempDir()
  const dbPath = join(repoRoot, 'continuum.db')
  const store = new ArtifactStore(dbPath)
  const inbox = new ArtifactInbox(repoRoot)
  const ingestor = new ArtifactIngestor(inbox, store)
  return { repoRoot, dbPath, inbox, store, ingestor }
}

function baseEnvelope(overrides: Partial<ArtifactEnvelope> = {}): ArtifactEnvelope {
  const rawMarkdown = overrides.rawMarkdown ?? '# Test\n\nContent.'
  return {
    protocol: ENVELOPE_PROTOCOL,
    artifactId: 'artifact-' + randomUUID(),
    type: 'IMPLEMENTATION_HANDOFF',
    schemaVersion: 1,
    title: 'Test Handoff',
    producerRole: 'IMPLEMENTER',
    repositoryKey: 'repo-code-awareness',
    createdAt: new Date().toISOString(),
    sourceFingerprint: null,
    gitHead: null,
    rawMarkdown,
    contentHash: computeContentHash(rawMarkdown),
    ...overrides
  }
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
  tmpDirs.length = 0
})

// ── 1. Happy path ─────────────────────────────────────────────────────────────

describe('Artifact Ingestor — Foundation Harness', () => {
  it('1. happy path: envelope válido na inbox → ingerido → inbox fica vazia', () => {
    const { inbox, store, ingestor } = setup()
    const envelope = baseEnvelope()
    inbox.write(envelope)

    const report = ingestor.ingestPending()

    expect(report.discovered).toBe(1)
    expect(report.ingested).toBe(1)
    expect(report.rejected).toBe(0)
    expect(report.retryableFailures).toBe(0)
    expect(inbox.listPending()).toHaveLength(0)
    expect(store.get(envelope.artifactId)).not.toBeNull()
    store.close()
  })

  // ── 2. Markdown fidelity ────────────────────────────────────────────────────

  it('2. rawMarkdown recuperado do Store é byte-equivalent ao envelope publicado', () => {
    const { inbox, store, ingestor } = setup()
    const complexMarkdown = [
      '# Handoff',
      '',
      '```typescript',
      'const x = 42;',
      '```',
      '',
      'Unicode: 🔥 ç ã ñ',
      'Trailing space:   ',
      'End.'
    ].join('\n')

    inbox.write(baseEnvelope({ artifactId: 'art-fidelity', rawMarkdown: complexMarkdown }))
    ingestor.ingestPending()

    const artifact = store.get('art-fidelity')
    expect(artifact).not.toBeNull()
    expect(Buffer.from(artifact!.rawMarkdown, 'utf8')).toEqual(Buffer.from(complexMarkdown, 'utf8'))
    store.close()
  })

  // ── 3. Metadata fidelity ────────────────────────────────────────────────────

  it('3. todos os campos de metadata são preservados na ingestão', () => {
    const { inbox, store, ingestor } = setup()
    const envelope = baseEnvelope({
      artifactId: 'art-meta-fidelity',
      type: 'IMPLEMENTATION_HANDOFF',
      schemaVersion: 1,
      title: 'Metadata Fidelity Proof',
      producerRole: 'IMPLEMENTER',
      repositoryKey: 'repo-test-key',
      createdAt: '2026-09-21T22:00:00.000Z',
      sourceFingerprint: 'fp-src-99aa',
      gitHead: 'git-sha-deadbeef123',
      rawMarkdown: '# Test\n\nMetadata check.'
    })

    inbox.write(envelope)
    ingestor.ingestPending()

    const artifact = store.get('art-meta-fidelity')
    expect(artifact).not.toBeNull()
    expect(artifact!.artifactId).toBe('art-meta-fidelity')
    expect(artifact!.type).toBe('IMPLEMENTATION_HANDOFF')
    expect(artifact!.schemaVersion).toBe(1)
    expect(artifact!.title).toBe('Metadata Fidelity Proof')
    expect(artifact!.producerRole).toBe('IMPLEMENTER')
    expect(artifact!.repositoryKey).toBe('repo-test-key')
    expect(artifact!.createdAt).toBe('2026-09-21T22:00:00.000Z')
    expect(artifact!.sourceFingerprint).toBe('fp-src-99aa')
    expect(artifact!.gitHead).toBe('git-sha-deadbeef123')
    store.close()
  })

  // ── 4. Ingestion timestamp ─────────────────────────────────────────────────

  it('4. ingestedAt é definido na ingestão e pode diferir de createdAt', async () => {
    const { inbox, store, ingestor } = setup()
    const createdAt = '2026-09-01T10:00:00.000Z'
    inbox.write(baseEnvelope({ artifactId: 'art-timestamp', createdAt }))

    // Small delay to ensure ingestedAt > createdAt in a real scenario;
    // here we just confirm both fields exist and createdAt is preserved.
    ingestor.ingestPending()

    const artifact = store.get('art-timestamp')
    expect(artifact).not.toBeNull()
    expect(artifact!.createdAt).toBe(createdAt)
    expect(typeof artifact!.ingestedAt).toBe('string')
    expect(artifact!.ingestedAt.length).toBeGreaterThan(0)
    // They are allowed to differ (this is the point).
    // In practice ingestedAt will be later, but we don't freeze time in tests.
    store.close()
  })

  // ── 5. Idempotent recovery ──────────────────────────────────────────────────

  it('5. artifact já no Store + envelope ainda na inbox → idempotência, envelope removido', () => {
    const { inbox, store, ingestor } = setup()
    const envelope = baseEnvelope({ artifactId: 'art-idempotent' })

    // First ingestion: normal path
    inbox.write(envelope)
    ingestor.ingestPending()
    expect(inbox.listPending()).toHaveLength(0)

    // Simulate crash recovery: re-publish same envelope (same content)
    inbox.write(envelope)
    expect(inbox.listPending()).toHaveLength(1)

    const report = ingestor.ingestPending()
    expect(report.ingested).toBe(1)
    expect(report.rejected).toBe(0)
    expect(inbox.listPending()).toHaveLength(0)
    expect(store.list()).toHaveLength(1)
    store.close()
  })

  // ── 6. Invalid envelope ─────────────────────────────────────────────────────

  it('6. envelope malformado → rejected → nenhum artifact criado', () => {
    const { repoRoot, inbox, store, ingestor } = setup()

    // Write an invalid JSON file directly into inbox dir
    const inboxDir = join(repoRoot, INBOX_RELATIVE_PATH)
    const { mkdirSync: md, writeFileSync: wf } = require('node:fs')
    md(inboxDir, { recursive: true })
    wf(join(inboxDir, 'artifact-bad-json.json'), 'NOT JSON AT ALL', 'utf8')

    const report = ingestor.ingestPending()

    expect(report.discovered).toBe(1)
    expect(report.rejected).toBe(1)
    expect(report.ingested).toBe(0)
    expect(inbox.listPending()).toHaveLength(0)
    expect(store.list()).toHaveLength(0)

    // File moved to rejected dir
    const rejectedDir = join(repoRoot, REJECTED_RELATIVE_PATH)
    expect(existsSync(join(rejectedDir, 'artifact-bad-json.json'))).toBe(true)
    store.close()
  })

  it('7. envelope com campo obrigatório ausente → rejected', () => {
    const { repoRoot, inbox, store, ingestor } = setup()
    const inboxDir = join(repoRoot, INBOX_RELATIVE_PATH)
    const { mkdirSync: md, writeFileSync: wf } = require('node:fs')
    md(inboxDir, { recursive: true })
    const partial = JSON.stringify({ protocol: ENVELOPE_PROTOCOL, artifactId: 'art-partial' })
    wf(join(inboxDir, 'artifact-partial.json'), partial, 'utf8')

    const report = ingestor.ingestPending()
    expect(report.rejected).toBe(1)
    expect(store.list()).toHaveLength(0)
    store.close()
  })

  // ── 7. Identity conflict ────────────────────────────────────────────────────

  it('8. mesmo artifactId com conteúdo diferente → rejected → artifact original intacto', () => {
    const { inbox, store, ingestor } = setup()
    const originalMarkdown = 'Original content.'
    const envelope = baseEnvelope({ artifactId: 'art-conflict', rawMarkdown: originalMarkdown })

    // First ingestion — stores original
    inbox.write(envelope)
    ingestor.ingestPending()

    // Second ingestion — same ID, different content
    const conflicting = { ...envelope, rawMarkdown: 'Tampered different content.' }
    inbox.write(conflicting)

    const report = ingestor.ingestPending()
    expect(report.rejected).toBe(1)
    expect(report.ingested).toBe(0)

    const artifact = store.get('art-conflict')
    expect(artifact!.rawMarkdown).toBe(originalMarkdown)
    store.close()
  })

  // ── 8. Queue isolation ──────────────────────────────────────────────────────

  it('9. fila com válido A, inválido B e válido C → A e C ingeridos, B rejected', () => {
    const { repoRoot, inbox, store, ingestor } = setup()
    const inboxDir = join(repoRoot, INBOX_RELATIVE_PATH)
    const { mkdirSync: md, writeFileSync: wf } = require('node:fs')
    md(inboxDir, { recursive: true })

    const envA = baseEnvelope({ artifactId: 'art-queue-a', rawMarkdown: 'Content A.' })
    const envC = baseEnvelope({ artifactId: 'art-queue-c', rawMarkdown: 'Content C.' })

    // Write directly so filenames sort correctly: A < B < C
    wf(join(inboxDir, `${envA.artifactId}.json`), serializeEnvelope(envA), 'utf8')
    wf(join(inboxDir, 'art-queue-b-invalid.json'), 'BROKEN JSON', 'utf8')
    wf(join(inboxDir, `${envC.artifactId}.json`), serializeEnvelope(envC), 'utf8')

    const report = ingestor.ingestPending()
    expect(report.discovered).toBe(3)
    expect(report.ingested).toBe(2)
    expect(report.rejected).toBe(1)
    expect(report.retryableFailures).toBe(0)

    expect(store.get('art-queue-a')).not.toBeNull()
    expect(store.get('art-queue-c')).not.toBeNull()
    expect(inbox.listPending()).toHaveLength(0)
    store.close()
  })

  // ── 9. Retryable failure ────────────────────────────────────────────────────

  it('10. falha transitória do store → envelope permanece pending', () => {
    const { inbox, ingestor } = setup()

    // Use a store that always throws a non-conflict error
    const brokenStore: typeof import('./continuum-types').IArtifactStore = {
      append: () => { throw new Error('DATABASE_LOCKED') },
      get: () => null,
      list: () => [],
      close: () => {}
    } as any

    const brokenIngestor = new ArtifactIngestor(inbox, brokenStore)
    inbox.write(baseEnvelope({ artifactId: 'art-retry' }))

    const report = brokenIngestor.ingestPending()
    expect(report.retryableFailures).toBe(1)
    expect(report.ingested).toBe(0)
    expect(report.rejected).toBe(0)
    expect(inbox.listPending()).toHaveLength(1)
  })

  // ── 10. Temporary files not included ──────────────────────────────────────

  it('11. arquivos .tmp não entram na lista pendente', () => {
    const { repoRoot, inbox } = setup()
    const inboxDir = join(repoRoot, INBOX_RELATIVE_PATH)
    const { mkdirSync: md, writeFileSync: wf } = require('node:fs')
    md(inboxDir, { recursive: true })
    wf(join(inboxDir, `${randomUUID()}.tmp`), 'partial write', 'utf8')
    wf(join(inboxDir, `${randomUUID()}.tmp`), 'another partial', 'utf8')

    expect(inbox.listPending()).toHaveLength(0)
  })

  // ── 11. Restart ────────────────────────────────────────────────────────────

  it('12. ingerir → fechar Store → reabrir → artifact ainda recuperável', () => {
    const { repoRoot, dbPath, inbox, store: store1, ingestor } = setup()
    const envelope = baseEnvelope({ artifactId: 'art-restart-ingest' })
    inbox.write(envelope)
    ingestor.ingestPending()
    store1.close()

    const store2 = new ArtifactStore(dbPath)
    const artifact = store2.get('art-restart-ingest')
    expect(artifact).not.toBeNull()
    expect(artifact!.rawMarkdown).toBe(envelope.rawMarkdown)
    store2.close()
  })

  // ── 12. contentHash computado pelo store ───────────────────────────────────

  it('13. contentHash persistido no store corresponde ao SHA-256 do rawMarkdown', () => {
    const { inbox, store, ingestor } = setup()
    const markdown = 'Deterministic hash test content.'
    inbox.write(baseEnvelope({ artifactId: 'art-hash', rawMarkdown: markdown }))
    ingestor.ingestPending()

    const artifact = store.get('art-hash')
    expect(artifact!.contentHash).toBe(computeContentHash(markdown))
    store.close()
  })

  // ── 13. Prova de Aceitação do Plano ──────────────────────────────────────

  it('14. Prova de Aceitação: Publisher → Inbox → Ingestor → Store → Restart', () => {
    const { repoRoot, dbPath, inbox, store: store1, ingestor } = setup()

    const handoffMarkdown = [
      '# Relato de Implementação',
      '',
      '## Resultado',
      '`VALIDADO`',
      '',
      '## Implementado',
      '- Artifact Ingestor',
      '- Pipeline completo: Inbox → Store'
    ].join('\n')

    const createdAt = '2026-09-21T20:00:00.000Z'
    const envelope: ArtifactEnvelope = {
      protocol: ENVELOPE_PROTOCOL,
      artifactId: 'art-acceptance-pipeline',
      type: 'IMPLEMENTATION_HANDOFF',
      schemaVersion: 1,
      title: 'Pipeline Acceptance Proof',
      producerRole: 'IMPLEMENTER',
      repositoryKey: 'code_awareness',
      createdAt,
      sourceFingerprint: 'fp-acc-001',
      gitHead: 'sha-acc-abcdef',
      contentHash: computeContentHash(handoffMarkdown),
      rawMarkdown: handoffMarkdown
    }

    // 1. Publicar na inbox (representa o publisher offline)
    inbox.write(envelope)
    expect(inbox.listPending()).toHaveLength(1)

    // 2. Ingerir
    const report = ingestor.ingestPending()
    expect(report.ingested).toBe(1)
    expect(report.rejected).toBe(0)

    // 3. Inbox fica vazia após ingestão
    expect(inbox.listPending()).toHaveLength(0)

    // 4. Artifact disponível no store
    const artifact = store1.get('art-acceptance-pipeline')
    expect(artifact).not.toBeNull()
    expect(artifact!.rawMarkdown).toBe(handoffMarkdown)
    expect(artifact!.createdAt).toBe(createdAt)
    expect(artifact!.ingestedAt).toBeTruthy()

    // 5. createdAt ≠ ingestedAt (timestamps de momentos distintos)
    // (May be equal in fast tests, but both fields are present and independent)
    expect(typeof artifact!.createdAt).toBe('string')
    expect(typeof artifact!.ingestedAt).toBe('string')

    // 6. Fechar → Reabrir → Artifact ainda disponível
    store1.close()
    const store2 = new ArtifactStore(dbPath)
    const recovered = store2.get('art-acceptance-pipeline')
    expect(recovered).not.toBeNull()
    expect(recovered!.rawMarkdown).toBe(handoffMarkdown)
    expect(recovered!.artifactId).toBe('art-acceptance-pipeline')
    store2.close()
  })
})
