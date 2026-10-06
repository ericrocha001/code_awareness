import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ENVELOPE_PROTOCOL,
  serializeEnvelope,
  deserializeEnvelope,
  computeContentHash,
  containsNonTextualControlChars,
  type ArtifactEnvelope
} from './artifact-envelope'
import { ArtifactInbox } from './artifact-inbox'
import { ArtifactStore } from './artifact-store'
import { ContinuumService } from './continuum-service'
import { ArtifactIngestor } from './artifact-ingestor'
import { deriveRepositoryKey } from './repository-key'

const tmpDirs: string[] = []

function tempDir(prefix = 'continuum-fidelity-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
  tmpDirs.length = 0
})

/**
 * Fixture de Markdown particularmente hostil a shells (especialmente PowerShell e Bash).
 * Contém sequências literais propensas a interpolação ou corrupção quando mal manipuladas.
 */
const HOSTILE_SHELL_MARKDOWN = [
  '# Relatório de Auditoria & Validação — 100% Literal 🚀',
  '',
  '> **Atenção**: Este documento testa preservação de caracteres especiais sem interpolação.',
  '',
  '## 1. Variáveis e Interpolações de Shell',
  'Aqui temos variáveis não-resolvidas: $variable e ${variable} e $(command) e `ls -la`.',
  'Mais variáveis: $HOME, $PATH, ${env:USERPROFILE}, $1, $#.',
  '',
  '## 2. Sequências de Escape de Shell (Backtick Sequences)',
  'Sequências comuns do PowerShell: `a (alert/bell), `b (backspace), `f (formfeed), `n (newline), `r (carriage return), `t (tab), `0 (null).',
  'Exemplo em código inline: `echo `a` e `` `r `` e `` `t `` e `` `n ``.',
  '',
  '## 3. Aspas, Barras e Paths Windows',
  'Aspas simples: \'single-quoted text\' e "double-quoted with $var".',
  'Barras invertidas: C:\\Users\\developer\\Projects\\code-awareness\\src\\main.',
  'Caminhos UNC e relativos: \\\\server\\share\\path e .\\scripts\\test.ps1 e ../../dist/.',
  '',
  '## 4. Blocos de Código e Fences',
  '```powershell',
  '# Código de script PowerShell',
  '$var = "Valor com `a e `t"',
  'Write-Host "$var - testando $env:TEMP e $(Get-Date)"',
  '```',
  '',
  '```json',
  '{',
  '  "key": "value with \\"quotes\\" and \\n newlines",',
  '  "nested": { "array": [1, 2, 3] }',
  '}',
  '```',
  '',
  '## 5. Caracteres Markdown, Tabelas e HTML Entities',
  '| Coluna A | Coluna B | Coluna C |',
  '| :--- | :---: | ---: |',
  '| `item_1` | <tag> & "ampersand" | 100% #1 |',
  '| `item_2` | #heading & >quote | 200% #2 |',
  '',
  '## 6. Unicode, Acentuação em Português e Emojis',
  'Texto em português com acentuação rica: á, é, í, ó, ú, â, ê, î, ô, û, ã, õ, ç, à.',
  'Emojis e símbolos matemáticos: 🛡️ 🔒 ⚡ 🧪 🎯 ∑ ∫ π ≠ ≤ ≥ ∞.',
  '',
  'Fim do documento.'
].join('\r\n') // Contém CRLF deliberadamente

describe('Continuum — End-to-End Cryptographic Content Fidelity', () => {
  const publisherScript = join(__dirname, '..', '..', '..', 'scripts', 'continuum', 'publish-artifact.cjs')
  it('generic CLI publishes frontmatter as transport and preserves open metadata and literal bytes through ingestion/restart', () => {
    const repo = tempDir('generic-cli-')
    writeFileSync(join(repo, 'package.json'), '{}', 'utf8')
    const rawMarkdown = '---\r\nname: Generic context\r\ndescription: Open this for literal preservation\r\nkind: FUTURE_KIND\r\nexecutionId: canonical-execution\r\n---\r\n' + HOSTILE_SHELL_MARKDOWN
    const mdFile = join(repo, 'generic.md'); writeFileSync(mdFile, rawMarkdown, 'utf8')
    const receipt = JSON.parse(execFileSync(process.execPath, [publisherScript, 'publish', mdFile], { cwd: repo, encoding: 'utf8' }))
    expect(receipt.status).toBe('QUEUED')
    const envelope = deserializeEnvelope(readFileSync(receipt.inboxPath, 'utf8'))
    expect(envelope.protocol).toBe('continuum-artifact/v2'); expect(envelope).not.toHaveProperty('type'); expect(envelope).not.toHaveProperty('producerRole')
    const dbPath = join(tempDir('generic-storage-'), 'continuum.db'); const store = new ArtifactStore(dbPath, 'catalog-A')
    try {
      const service = new ContinuumService(store)
      expect(new ArtifactIngestor(new ArtifactInbox(repo), service, deriveRepositoryKey(repo)).ingestPending().ingested).toBe(1)
    } finally { store.close() }
    const reopened = new ArtifactStore(dbPath, 'catalog-A')
    try {
      const artifact = reopened.get(receipt.artifactId)!
      expect(Buffer.from(artifact.rawMarkdown)).toEqual(Buffer.from(rawMarkdown))
      expect(artifact.metadata.kind).toBe('FUTURE_KIND'); expect(artifact.revision).toBe(1)
      expect(reopened.list({ metadata: { executionId: 'canonical-execution' } }).artifacts).toHaveLength(1)
    } finally { reopened.close() }
  })

  // ── Teste 1 — Publisher Fidelity ─────────────────────────────────────────

  it('Teste 1 — Publisher Fidelity: lê arquivo via filesystem, preserva exatamente o Markdown e grava contentHash', () => {
    const repo = tempDir('repo-t1-')
    // Simular repo com package.json
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'test-repo' }), 'utf8')

    const mdFile = join(repo, 'hostile.md')
    writeFileSync(mdFile, HOSTILE_SHELL_MARKDOWN, 'utf8')

    // Executar publisher diretamente sem shell intermediário
    const result = execFileSync(
      process.execPath,
      [publisherScript, 'implementation-handoff', mdFile, '--title', 'Hostile Test 1'],
      { cwd: repo, encoding: 'utf8' }
    )

    const receipt = JSON.parse(result)
    expect(receipt.status).toBe('QUEUED')
    expect(existsSync(receipt.inboxPath)).toBe(true)

    const rawEnvelope = readFileSync(receipt.inboxPath, 'utf8')
    const envelope = deserializeEnvelope(rawEnvelope)

    // Prova de fidelidade exata do publisher
    expect(envelope.rawMarkdown).toBe(HOSTILE_SHELL_MARKDOWN)
    const expectedHash = createHash('sha256').update(HOSTILE_SHELL_MARKDOWN, 'utf8').digest('hex')
    expect(envelope.contentHash).toBe(expectedHash)
  })

  // ── Teste 2 — Serialization Round-trip ───────────────────────────────────

  it('Teste 2 — Serialization Round-trip: serialize -> deserialize preserva rawMarkdown e contentHash byte a byte', () => {
    const expectedHash = computeContentHash(HOSTILE_SHELL_MARKDOWN)
    const envelope: ArtifactEnvelope = {
      protocol: ENVELOPE_PROTOCOL,
      artifactId: 'art-roundtrip-' + randomUUID(),
      type: 'IMPLEMENTATION_HANDOFF',
      schemaVersion: 1,
      title: 'Roundtrip Test',
      producerRole: 'IMPLEMENTER',
      repositoryKey: 'repo-abc',
      createdAt: new Date().toISOString(),
      sourceFingerprint: null,
      gitHead: null,
      contentHash: expectedHash,
      rawMarkdown: HOSTILE_SHELL_MARKDOWN
    }

    const serialized = serializeEnvelope(envelope)
    const deserialized = deserializeEnvelope(serialized)

    expect(deserialized.rawMarkdown).toBe(HOSTILE_SHELL_MARKDOWN)
    expect(deserialized.contentHash).toBe(expectedHash)
    expect(deserialized.artifactId).toBe(envelope.artifactId)
  })

  // ── Teste 3 — Inbox Fidelity ─────────────────────────────────────────────

  it('Teste 3 — Inbox Fidelity: publisher escreve atomicamente na inbox sem nenhuma alteração de caracteres', () => {
    const repo = tempDir('repo-t3-')
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'test-repo' }), 'utf8')

    const mdFile = join(repo, 'handoff-inbox.md')
    writeFileSync(mdFile, HOSTILE_SHELL_MARKDOWN, 'utf8')

    execFileSync(
      process.execPath,
      [publisherScript, 'implementation-handoff', mdFile, '--title', 'Inbox Fidelity Test'],
      { cwd: repo, encoding: 'utf8' }
    )

    const inbox = new ArtifactInbox(repo)
    const pending = inbox.listPending()
    expect(pending).toHaveLength(1)

    const rawRead = inbox.read(pending[0])
    const envelope = deserializeEnvelope(rawRead)

    expect(envelope.rawMarkdown).toBe(HOSTILE_SHELL_MARKDOWN)
    expect(envelope.contentHash).toBe(computeContentHash(HOSTILE_SHELL_MARKDOWN))
  })

  // ── Teste 4 — End-to-End Fidelity ────────────────────────────────────────

  it('Teste 4 — End-to-End Fidelity: Markdown -> Inbox -> Ingestor -> ArtifactStore -> close -> reopen -> get Artifact', () => {
    const repo = tempDir('repo-t4-')
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'test-repo' }), 'utf8')

    const mdFile = join(repo, 'handoff-e2e.md')
    writeFileSync(mdFile, HOSTILE_SHELL_MARKDOWN, 'utf8')

    // 1. Publisher publica na inbox
    const pubOutput = execFileSync(
      process.execPath,
      [publisherScript, 'implementation-handoff', mdFile, '--title', 'E2E Fidelity'],
      { cwd: repo, encoding: 'utf8' }
    )
    const receipt = JSON.parse(pubOutput)
    const artifactId = receipt.artifactId

    // 2. Ingestor ingere no store
    const dbPath = join(tempDir('storage-t4-'), 'continuum.db')
    const store = new ArtifactStore(dbPath, 'catalog-A')
    const inbox = new ArtifactInbox(repo)
    const ingestor = new ArtifactIngestor(inbox, new ContinuumService(store), deriveRepositoryKey(repo))

    const report = ingestor.ingestPending()
    expect(report.ingested).toBe(1)
    expect(report.rejected).toBe(0)
    expect(inbox.listPending()).toHaveLength(0)

    // 3. Encerrar o store
    store.close()

    // 4. Reabrir e recuperar o artifact
    const storeReopened = new ArtifactStore(dbPath, 'catalog-A')
    const retrieved = storeReopened.get(artifactId)

    expect(retrieved).not.toBeNull()
    // Prova máxima de integridade criptográfica
    expect(retrieved!.rawMarkdown).toBe(HOSTILE_SHELL_MARKDOWN)
    expect(retrieved!.contentHash).toBe(computeContentHash(HOSTILE_SHELL_MARKDOWN))

    storeReopened.close()
  })

  // ── Teste 5 — Tampered Envelope ──────────────────────────────────────────

  it('Teste 5 — Tampered Envelope: alteração no rawMarkdown na inbox é detectada e o envelope é rejeitado', () => {
    const repo = tempDir('repo-t5-')
    const inbox = new ArtifactInbox(repo)

    const originalText = '# Original Valid Markdown\n\nAll good.'
    const originalHash = computeContentHash(originalText)

    const envelope: ArtifactEnvelope = {
      protocol: ENVELOPE_PROTOCOL,
      artifactId: 'art-tampered-md-' + randomUUID(),
      type: 'IMPLEMENTATION_HANDOFF',
      schemaVersion: 1,
      title: 'Tampered Markdown',
      producerRole: 'IMPLEMENTER',
      repositoryKey: deriveRepositoryKey(repo),
      createdAt: new Date().toISOString(),
      sourceFingerprint: null,
      gitHead: null,
      contentHash: originalHash,
      rawMarkdown: originalText
    }
    const receipt = inbox.write(envelope)

    // Adulterar o rawMarkdown no arquivo da inbox sem atualizar contentHash
    const parsed = JSON.parse(readFileSync(receipt.filePath, 'utf8'))
    parsed.rawMarkdown = '# Tampered / Corrupted Content\n\nAttacker modified this!'
    writeFileSync(receipt.filePath, JSON.stringify(parsed, null, 2), 'utf8')

    // Executar ingestão
    const dbPath = join(tempDir('storage-t5-'), 'continuum.db')
    const store = new ArtifactStore(dbPath, 'catalog-A')
    const ingestor = new ArtifactIngestor(inbox, new ContinuumService(store), deriveRepositoryKey(repo))

    const report = ingestor.ingestPending()

    // Deve ser rejeitado pelo ingestor
    expect(report.ingested).toBe(0)
    expect(report.rejected).toBe(1)
    expect(report.failures[0].outcome).toBe('REJECTED')
    expect(report.failures[0].reason).toContain('contentHash does not match')

    // Store permanece limpo
    expect(store.list().artifacts).toHaveLength(0)
    expect(store.get(envelope.artifactId)).toBeNull()

    // Arquivo foi movido para rejected
    expect(inbox.listPending()).toHaveLength(0)

    store.close()
  })

  // ── Teste 6 — Tampered Hash ──────────────────────────────────────────────

  it('Teste 6 — Tampered Hash: alteração somente no contentHash é rejeitada', () => {
    const repo = tempDir('repo-t6-')
    const inbox = new ArtifactInbox(repo)

    const originalText = '# Another Valid Markdown\n\nClean text.'
    const fakeHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

    const envelope: ArtifactEnvelope = {
      protocol: ENVELOPE_PROTOCOL,
      artifactId: 'art-tampered-hash-' + randomUUID(),
      type: 'IMPLEMENTATION_HANDOFF',
      schemaVersion: 1,
      title: 'Tampered Hash',
      producerRole: 'IMPLEMENTER',
      repositoryKey: deriveRepositoryKey(repo),
      createdAt: new Date().toISOString(),
      sourceFingerprint: null,
      gitHead: null,
      contentHash: fakeHash, // Hash adulterado
      rawMarkdown: originalText
    }
    inbox.write(envelope)

    const dbPath = join(tempDir('storage-t6-'), 'continuum.db')
    const store = new ArtifactStore(dbPath, 'catalog-A')
    const ingestor = new ArtifactIngestor(inbox, new ContinuumService(store), deriveRepositoryKey(repo))

    const report = ingestor.ingestPending()
    expect(report.ingested).toBe(0)
    expect(report.rejected).toBe(1)
    expect(report.failures[0].outcome).toBe('REJECTED')
    expect(report.failures[0].reason).toContain('contentHash does not match')

    expect(store.get(envelope.artifactId)).toBeNull()
    store.close()
  })

  // ── Teste 7 — Suspicious Control Characters ──────────────────────────────

  it('Teste 7 — Suspicious Control Character: publisher recusa publicação com BEL ou NUL', () => {
    const repo = tempDir('repo-t7-')
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'test-repo' }), 'utf8')

    // Criar arquivo com caractere de controle BEL (\x07)
    const mdWithBel = join(repo, 'corrupted-bel.md')
    writeFileSync(mdWithBel, '# Corrupted Report\n\nHere is a bell: \x07 sound.', 'utf8')

    expect(() => {
      execFileSync(
        process.execPath,
        [publisherScript, 'implementation-handoff', mdWithBel, '--title', 'BEL Test'],
        { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      )
    }).toThrow()

    // Inbox deve permanecer vazia
    const inbox = new ArtifactInbox(repo)
    expect(inbox.listPending()).toHaveLength(0)

    // Criar arquivo com NUL (\x00)
    const mdWithNul = join(repo, 'corrupted-nul.md')
    writeFileSync(mdWithNul, '# Corrupted Report\n\nHere is a null: \x00 byte.', 'utf8')

    expect(() => {
      execFileSync(
        process.execPath,
        [publisherScript, 'implementation-handoff', mdWithNul, '--title', 'NUL Test'],
        { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      )
    }).toThrow()

    expect(inbox.listPending()).toHaveLength(0)
  })

  // ── Teste 8 — Legitimate Markdown Whitespace ─────────────────────────────

  it('Teste 8 — Legitimate Markdown Whitespace: tabs, CRLF e LF legítimos são aceitos e preservados', () => {
    const repo = tempDir('repo-t8-')
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'test-repo' }), 'utf8')

    const legitimateText = [
      '# Tab and Whitespace Document',
      '',
      'Indent with tab:',
      '\tconst x = 1;',
      '\t\tconst y = 2;',
      '',
      'Line with CRLF follows.',
      'Line with LF follows.'
    ].join('\r\n')

    expect(containsNonTextualControlChars(legitimateText)).toBe(false)

    const mdFile = join(repo, 'legit-whitespace.md')
    writeFileSync(mdFile, legitimateText, 'utf8')

    const result = execFileSync(
      process.execPath,
      [publisherScript, 'implementation-handoff', mdFile, '--title', 'Whitespace Test'],
      { cwd: repo, encoding: 'utf8' }
    )

    const receipt = JSON.parse(result)
    expect(receipt.status).toBe('QUEUED')

    const inbox = new ArtifactInbox(repo)
    const pending = inbox.listPending()
    expect(pending).toHaveLength(1)

    const envelope = deserializeEnvelope(inbox.read(pending[0]))
    expect(envelope.rawMarkdown).toBe(legitimateText)
    expect(envelope.rawMarkdown).toContain('\t')
    expect(envelope.rawMarkdown).toContain('\r\n')
  })
})
