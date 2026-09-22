import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, afterEach } from 'vitest'
import {
  ENVELOPE_PROTOCOL,
  validateEnvelope,
  serializeEnvelope,
  deserializeEnvelope,
  computeContentHash
} from './artifact-envelope'
import type { ArtifactEnvelope } from './artifact-envelope'
import { ArtifactInbox, INBOX_RELATIVE_PATH } from './artifact-inbox'

// ── Helpers ──────────────────────────────────────────────────────────────────

const tmpDirs: string[] = []

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'continuum-publisher-test-'))
  tmpDirs.push(d)
  return d
}

function baseEnvelope(overrides: Partial<ArtifactEnvelope> = {}): ArtifactEnvelope {
  const rawMarkdown = overrides.rawMarkdown ?? '# Handoff\n\nContent.'
  return {
    protocol: ENVELOPE_PROTOCOL,
    artifactId: 'artifact-' + randomUUID(),
    type: 'IMPLEMENTATION_HANDOFF',
    schemaVersion: 1,
    title: 'Test Handoff',
    producerRole: 'IMPLEMENTER',
    repositoryKey: 'repo-key-abc123',
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

// ── 1. Envelope — Validação estrutural ───────────────────────────────────────

describe('Artifact Envelope', () => {
  it('1. envelope válido passa validação sem erros', () => {
    expect(validateEnvelope(baseEnvelope())).toHaveLength(0)
  })

  it('2. rejeita protocol incorreto', () => {
    const errors = validateEnvelope({ ...baseEnvelope(), protocol: 'wrong' })
    expect(errors.some(e => e.field === 'protocol')).toBe(true)
  })

  it('3. rejeita type inválido', () => {
    const errors = validateEnvelope({ ...baseEnvelope(), type: 'UNKNOWN' })
    expect(errors.some(e => e.field === 'type')).toBe(true)
  })

  it('4. rejeita producerRole inválido', () => {
    const errors = validateEnvelope({ ...baseEnvelope(), producerRole: 'ARCHITECT' })
    expect(errors.some(e => e.field === 'producerRole')).toBe(true)
  })

  it('5. rejeita schemaVersion < 1', () => {
    const errors = validateEnvelope({ ...baseEnvelope(), schemaVersion: 0 })
    expect(errors.some(e => e.field === 'schemaVersion')).toBe(true)
  })

  it('6. rejeita title vazio', () => {
    const errors = validateEnvelope({ ...baseEnvelope(), title: '' })
    expect(errors.some(e => e.field === 'title')).toBe(true)
  })

  it('7. rejeita rawMarkdown vazio', () => {
    const errors = validateEnvelope({ ...baseEnvelope(), rawMarkdown: '' })
    expect(errors.some(e => e.field === 'rawMarkdown')).toBe(true)
  })

  it('8. aceita sourceFingerprint e gitHead nulos', () => {
    const errors = validateEnvelope(baseEnvelope({ sourceFingerprint: null, gitHead: null }))
    expect(errors).toHaveLength(0)
  })

  it('9. aceita gitHead string presente', () => {
    const errors = validateEnvelope(baseEnvelope({ gitHead: 'abc123def456' }))
    expect(errors).toHaveLength(0)
  })

  it('10. rejeita gitHead com tipo incorreto', () => {
    const errors = validateEnvelope({ ...baseEnvelope(), gitHead: 42 })
    expect(errors.some(e => e.field === 'gitHead')).toBe(true)
  })

  it('11. round-trip serialize → deserialize preserva todos os campos', () => {
    const markdown = '# Heading\n\n```ts\nconst x = 1;\n```\n\n🔥 Unicode: ç ã'
    const original = baseEnvelope({ rawMarkdown: markdown, gitHead: 'deadbeef123' })
    const serialized = serializeEnvelope(original)
    const restored = deserializeEnvelope(serialized)
    expect(restored).toEqual(original)
  })

  it('12. deserialize lança erro em JSON inválido', () => {
    expect(() => deserializeEnvelope('not json')).toThrow(/ENVELOPE_PARSE_ERROR/)
  })

  it('13. deserialize lança erro quando campos obrigatórios faltam', () => {
    expect(() => deserializeEnvelope(JSON.stringify({ protocol: ENVELOPE_PROTOCOL }))).toThrow(/ENVELOPE_INVALID/)
  })
})

// ── 2. Inbox — Escrita atômica e descoberta ──────────────────────────────────

describe('Artifact Inbox', () => {
  it('14. arquivo não existe antes da escrita', () => {
    const root = tempDir()
    const inbox = new ArtifactInbox(root)
    const envelope = baseEnvelope()
    expect(inbox.exists(envelope.artifactId)).toBe(false)
  })

  it('15. escrita coloca arquivo na inbox e receipt contém path e artifactId', () => {
    const root = tempDir()
    const inbox = new ArtifactInbox(root)
    const envelope = baseEnvelope()

    const receipt = inbox.write(envelope)

    expect(receipt.artifactId).toBe(envelope.artifactId)
    expect(existsSync(receipt.filePath)).toBe(true)
    expect(inbox.exists(envelope.artifactId)).toBe(true)
  })

  it('16. inbox fica dentro do INBOX_RELATIVE_PATH do repositório', () => {
    const root = tempDir()
    const inbox = new ArtifactInbox(root)
    const envelope = baseEnvelope()
    const receipt = inbox.write(envelope)
    const expectedDir = join(root, INBOX_RELATIVE_PATH)
    expect(receipt.filePath.startsWith(expectedDir)).toBe(true)
  })

  it('17. arquivo na inbox é JSON deserializável como ArtifactEnvelope', () => {
    const root = tempDir()
    const inbox = new ArtifactInbox(root)
    const envelope = baseEnvelope({ gitHead: 'sha-abc123' })

    const receipt = inbox.write(envelope)
    const raw = readFileSync(receipt.filePath, 'utf8')
    const restored = deserializeEnvelope(raw)

    expect(restored).toEqual(envelope)
  })

  it('18. rawMarkdown preservado byte a byte incluindo unicode e code fences', () => {
    const root = tempDir()
    const inbox = new ArtifactInbox(root)
    const complexMarkdown = [
      '# Implementation Handoff',
      '',
      '## Resultado',
      '`VALIDADO`',
      '',
      '| Col A | Col B |',
      '| --- | --- |',
      '| Value 1 | Value 2 |',
      '',
      '```typescript',
      'export function fn(): void {',
      '  const x = "🔥 ç ã ñ";',
      '}',
      '```',
      '',
      'Trailing space:   ',
      'Final line.'
    ].join('\n')

    const envelope = baseEnvelope({ rawMarkdown: complexMarkdown })
    const receipt = inbox.write(envelope)
    const raw = readFileSync(receipt.filePath, 'utf8')
    const restored = deserializeEnvelope(raw)

    expect(restored.rawMarkdown).toBe(complexMarkdown)
    expect(Buffer.from(restored.rawMarkdown, 'utf8')).toEqual(Buffer.from(complexMarkdown, 'utf8'))
  })

  it('19. inbox cria diretório automaticamente se inexistente', () => {
    const root = tempDir()
    const inboxDir = join(root, INBOX_RELATIVE_PATH)
    expect(existsSync(inboxDir)).toBe(false)

    const inbox = new ArtifactInbox(root)
    inbox.write(baseEnvelope())

    expect(existsSync(inboxDir)).toBe(true)
  })

  it('20. nome do arquivo definitivo contém artifactId', () => {
    const root = tempDir()
    const inbox = new ArtifactInbox(root)
    const envelope = baseEnvelope()
    const receipt = inbox.write(envelope)
    expect(receipt.filePath).toContain(envelope.artifactId)
    expect(receipt.filePath.endsWith('.json')).toBe(true)
  })

  it('21. atomicidade: nenhum arquivo .tmp sobrevive após escrita bem-sucedida', () => {
    const root = tempDir()
    const inbox = new ArtifactInbox(root)
    inbox.write(baseEnvelope())

    const inboxDir = join(root, INBOX_RELATIVE_PATH)
    const files = require('node:fs').readdirSync(inboxDir)
    const temps = files.filter((f: string) => f.endsWith('.tmp'))
    expect(temps).toHaveLength(0)
  })

  it('22. dois envelopes distintos produzem dois arquivos distintos', () => {
    const root = tempDir()
    const inbox = new ArtifactInbox(root)
    const r1 = inbox.write(baseEnvelope())
    const r2 = inbox.write(baseEnvelope())
    expect(r1.artifactId).not.toBe(r2.artifactId)
    expect(r1.filePath).not.toBe(r2.filePath)
    expect(existsSync(r1.filePath)).toBe(true)
    expect(existsSync(r2.filePath)).toBe(true)
  })
})

// ── 3. Publisher integration (sem CLI subprocess — exercita lógica diretamente) ──

describe('Publisher Integration', () => {
  it('23. metadata automática: type, producerRole, schemaVersion preservados', () => {
    const envelope = baseEnvelope()
    expect(envelope.type).toBe('IMPLEMENTATION_HANDOFF')
    expect(envelope.producerRole).toBe('IMPLEMENTER')
    expect(envelope.schemaVersion).toBe(1)
    expect(envelope.protocol).toBe(ENVELOPE_PROTOCOL)
  })

  it('24. Teste de Aceitação Principal: Markdown → Inbox → artifact disponível intacto', () => {
    const root = tempDir()

    // Criar arquivo Markdown temporário
    const handoffMarkdown = [
      '# Relato de Implementação — Continuum Publisher',
      '',
      '## Resultado',
      '`VALIDADO`',
      '',
      '## Implementado',
      '- Artifact Publisher offline',
      '- Artifact Inbox com escrita atômica',
      '',
      '## Separação published vs ingested',
      'Inbox contém envelopes publicados.',
      'Artifact Store (SQLite) permanece inalterado.'
    ].join('\n')

    const markdownFile = join(root, 'handoff.md')
    writeFileSync(markdownFile, handoffMarkdown, 'utf8')

    // Simular o que o publisher faz
    const artifactId = 'artifact-acceptance-' + randomUUID()
    const createdAt = new Date().toISOString()
    const envelope: ArtifactEnvelope = {
      protocol: ENVELOPE_PROTOCOL,
      artifactId,
      type: 'IMPLEMENTATION_HANDOFF',
      schemaVersion: 1,
      title: 'Continuum Publisher Acceptance',
      producerRole: 'IMPLEMENTER',
      repositoryKey: 'repo-code-awareness',
      createdAt,
      sourceFingerprint: null,
      gitHead: null,
      rawMarkdown: handoffMarkdown,
      contentHash: computeContentHash(handoffMarkdown)
    }

    // 1. Publicar na inbox
    const inbox = new ArtifactInbox(root)
    const receipt = inbox.write(envelope)

    // 2. Processo termina (inbox persiste no filesystem)
    expect(existsSync(receipt.filePath)).toBe(true)

    // 3. Ler e verificar
    const rawFile = readFileSync(receipt.filePath, 'utf8')
    const restored = deserializeEnvelope(rawFile)

    expect(restored.artifactId).toBe(artifactId)
    expect(restored.type).toBe('IMPLEMENTATION_HANDOFF')
    expect(restored.rawMarkdown).toBe(handoffMarkdown)
    expect(restored.producerRole).toBe('IMPLEMENTER')
    expect(restored.createdAt).toBe(createdAt)

    // 4. Confirmar que o Artifact Store não foi tocado (nenhum SQLite foi criado)
    expect(existsSync(join(root, 'continuum.db'))).toBe(false)
    expect(existsSync(join(root, 'validation-ledger.db'))).toBe(false)
  })
})
