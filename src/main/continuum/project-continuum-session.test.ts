import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectContinuumSession } from './project-continuum-session'
import { ArtifactInbox } from './artifact-inbox'
import { ENVELOPE_PROTOCOL, computeContentHash } from './artifact-envelope'
import type { ArtifactEnvelope } from './artifact-envelope'
import { deriveRepositoryKey } from './repository-key'

const tmpDirs: string[] = []

function tempDir(prefix = 'continuum-session-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

function baseEnvelope(repoRoot: string, overrides: Partial<ArtifactEnvelope> = {}): ArtifactEnvelope {
  const rawMarkdown = overrides.rawMarkdown ?? '# Handoff\n\nProject content.'
  return {
    protocol: ENVELOPE_PROTOCOL,
    artifactId: 'artifact-' + randomUUID(),
    type: 'IMPLEMENTATION_HANDOFF',
    schemaVersion: 1,
    title: 'Handoff Artifact',
    producerRole: 'IMPLEMENTER',
    repositoryKey: deriveRepositoryKey(repoRoot),
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
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
  tmpDirs.length = 0
})

describe('ProjectContinuumSession — Per-Project Isolation Harness', () => {
  it('1. Store por projeto: ativar A cria Store A; ativar B fecha A e cria Store B diferente', () => {
    const storageBase = tempDir('storage-')
    const repoA = tempDir('repo-a-')
    const repoB = tempDir('repo-b-')

    const session = new ProjectContinuumSession(storageBase)

    // Ativar A
    session.activate(repoA)
    const storeA = session.getActiveStore()
    expect(storeA).not.toBeNull()
    const sessionA = session.getActiveSession()
    expect(sessionA?.projectKey).toBe(deriveRepositoryKey(repoA))
    expect(existsSync(join(storageBase, sessionA!.projectKey, 'continuum.db'))).toBe(true)

    // Ativar B
    session.activate(repoB)
    const storeB = session.getActiveStore()
    expect(storeB).not.toBeNull()
    expect(storeB).not.toBe(storeA)
    const sessionB = session.getActiveSession()
    expect(sessionB?.projectKey).toBe(deriveRepositoryKey(repoB))
    expect(existsSync(join(storageBase, sessionB!.projectKey, 'continuum.db'))).toBe(true)

    session.dispose()
  })

  it('2. Isolamento real: Store A contém apenas Artifact A; Store B contém apenas Artifact B (sem filtros SQL)', () => {
    const storageBase = tempDir('storage-')
    const repoA = tempDir('repo-a-')
    const repoB = tempDir('repo-b-')

    const session = new ProjectContinuumSession(storageBase)

    // Publicar na Inbox A
    const inboxA = new ArtifactInbox(repoA)
    const envA = baseEnvelope(repoA, {
      artifactId: 'art-project-a',
      title: 'Artifact from Project A',
      rawMarkdown: '# Content Project A'
    })
    inboxA.write(envA)

    // Publicar na Inbox B
    const inboxB = new ArtifactInbox(repoB)
    const envB = baseEnvelope(repoB, {
      artifactId: 'art-project-b',
      title: 'Artifact from Project B',
      rawMarkdown: '# Content Project B'
    })
    inboxB.write(envB)

    // Ativar A: ingere Inbox A
    session.activate(repoA)
    const storeA = session.getActiveStore()!
    const listA = storeA.list() // Chamada SEM filtro repositoryKey
    expect(listA).toHaveLength(1)
    expect(listA[0].artifactId).toBe('art-project-a')
    expect(storeA.get('art-project-b')).toBeNull()

    // Ativar B: fecha A, abre B, ingere Inbox B
    session.activate(repoB)
    const storeB = session.getActiveStore()!
    const listB = storeB.list() // Chamada SEM filtro repositoryKey
    expect(listB).toHaveLength(1)
    expect(listB[0].artifactId).toBe('art-project-b')
    expect(storeB.get('art-project-a')).toBeNull()

    // Reabrir A: fecha B, reabre A
    session.activate(repoA)
    const storeAReopened = session.getActiveStore()!
    const listAReopened = storeAReopened.list()
    expect(listAReopened).toHaveLength(1)
    expect(listAReopened[0].artifactId).toBe('art-project-a')
    expect(storeAReopened.get('art-project-b')).toBeNull()

    session.dispose()
  })

  it('3. Persistência entre trocas de projeto: A -> B -> A preserva o conteúdo exato', () => {
    const storageBase = tempDir('storage-')
    const repoA = tempDir('repo-a-')
    const repoB = tempDir('repo-b-')

    const session = new ProjectContinuumSession(storageBase)

    const inboxA = new ArtifactInbox(repoA)
    const envA = baseEnvelope(repoA, {
      artifactId: 'art-persist-a',
      rawMarkdown: '# Persistent Content A\n\nPreserved.'
    })
    inboxA.write(envA)

    session.activate(repoA)
    session.activate(repoB)
    session.activate(repoA)

    const storeA = session.getActiveStore()!
    const recovered = storeA.get('art-persist-a')
    expect(recovered).not.toBeNull()
    expect(recovered!.rawMarkdown).toBe(envA.rawMarkdown)

    session.dispose()
  })

  it('4. Idempotência: ativar o mesmo projeto duas vezes não recria o Store', () => {
    const storageBase = tempDir('storage-')
    const repoA = tempDir('repo-a-')

    const session = new ProjectContinuumSession(storageBase)

    session.activate(repoA)
    const store1 = session.getActiveStore()

    session.activate(repoA)
    const store2 = session.getActiveStore()

    expect(store2).toBe(store1)

    session.dispose()
  })

  it('5. Desativação: fechar projeto limpa Store e sessão', () => {
    const storageBase = tempDir('storage-')
    const repoA = tempDir('repo-a-')

    const session = new ProjectContinuumSession(storageBase)
    session.activate(repoA)
    expect(session.getActiveStore()).not.toBeNull()

    session.deactivate()
    expect(session.getActiveStore()).toBeNull()
    expect(session.getActiveSession()).toBeNull()

    session.dispose()
  })

  it('6. Shutdown: dispose fecha a conexão do Store ativo', () => {
    const storageBase = tempDir('storage-')
    const repoA = tempDir('repo-a-')

    const session = new ProjectContinuumSession(storageBase)
    session.activate(repoA)

    session.dispose()
    expect(session.getActiveStore()).toBeNull()
  })

  it('7. Inbox correta: ativar A ingere apenas Inbox A; Inbox B permanece intacta', () => {
    const storageBase = tempDir('storage-')
    const repoA = tempDir('repo-a-')
    const repoB = tempDir('repo-b-')

    const session = new ProjectContinuumSession(storageBase)

    const inboxA = new ArtifactInbox(repoA)
    const inboxB = new ArtifactInbox(repoB)

    inboxA.write(baseEnvelope(repoA, { artifactId: 'art-inbox-a' }))
    inboxB.write(baseEnvelope(repoB, { artifactId: 'art-inbox-b' }))

    // Ativar apenas A
    session.activate(repoA)

    // Inbox A deve ter sido consumida
    expect(inboxA.listPending()).toHaveLength(0)

    // Inbox B ainda deve conter seu item pendente
    expect(inboxB.listPending()).toHaveLength(1)
    expect(inboxB.listPending()[0].filename).toBe('art-inbox-b.json')

    // Agora ativar B -> consome Inbox B
    session.activate(repoB)
    expect(inboxB.listPending()).toHaveLength(0)

    session.dispose()
  })

  it('8. Failure isolation: falha interna no Continuum não propaga exceção destrutiva', () => {
    const storageBase = tempDir('storage-')
    const session = new ProjectContinuumSession(storageBase)

    // Ativação com caminho inválido / vazio retorna null sem lançar exceção
    const result = session.activate('')
    expect(result).toBeNull()
    expect(session.getActiveStore()).toBeNull()

    session.dispose()
  })
})

describe('ProjectContinuumSession — Live Reader (read-through por consulta)', () => {
  it('9. Publicação pós-ativação: artifact criado depois de activate() aparece em list() sem reativação', () => {
    const storageBase = tempDir('storage-')
    const repo = tempDir('repo-live-')

    const session = new ProjectContinuumSession(storageBase)
    session.activate(repo)
    const reader = session.getActiveReader()!
    expect(reader.list()).toHaveLength(0)

    const inbox = new ArtifactInbox(repo)
    inbox.write(baseEnvelope(repo, { artifactId: 'art-live-list' }))

    const listed = reader.list()
    expect(listed.map((a) => a.artifactId)).toContain('art-live-list')
    expect(inbox.listPending()).toHaveLength(0)

    session.dispose()
  })

  it('10. Get direto: artifact publicado pós-ativação é recuperável por get() sem list() prévio', () => {
    const storageBase = tempDir('storage-')
    const repo = tempDir('repo-live-')

    const session = new ProjectContinuumSession(storageBase)
    session.activate(repo)
    const reader = session.getActiveReader()!

    const rawMarkdown = '# Direct Get Content'
    const inbox = new ArtifactInbox(repo)
    inbox.write(
      baseEnvelope(repo, {
        artifactId: 'art-live-get',
        rawMarkdown,
        contentHash: computeContentHash(rawMarkdown)
      })
    )

    const recovered = reader.get('art-live-get')
    expect(recovered).not.toBeNull()
    expect(recovered!.rawMarkdown).toBe(rawMarkdown)

    session.dispose()
  })

  it('11. Reader estável: mesma instância antes e depois da ingestão recupera o novo artifact', () => {
    const storageBase = tempDir('storage-')
    const repo = tempDir('repo-live-')

    const session = new ProjectContinuumSession(storageBase)
    session.activate(repo)
    const before = session.getActiveReader()!

    new ArtifactInbox(repo).write(baseEnvelope(repo, { artifactId: 'art-live-stable' }))

    const listed = before.list()
    expect(listed.map((a) => a.artifactId)).toContain('art-live-stable')

    const after = session.getActiveReader()!
    expect(after).toBe(before)

    session.dispose()
  })

  it('12. Idempotência: consultas repetidas não duplicam artifacts', () => {
    const storageBase = tempDir('storage-')
    const repo = tempDir('repo-live-')

    const session = new ProjectContinuumSession(storageBase)
    session.activate(repo)
    const reader = session.getActiveReader()!

    new ArtifactInbox(repo).write(baseEnvelope(repo, { artifactId: 'art-live-idem' }))

    expect(reader.list()).toHaveLength(1)
    expect(reader.list()).toHaveLength(1)
    expect(reader.get('art-live-idem')).not.toBeNull()
    expect(reader.list()).toHaveLength(1)
    expect(session.getActiveStore()!.list()).toHaveLength(1)

    session.dispose()
  })

  it('13. Isolamento: artifact da inbox do projeto A nunca aparece no reader do projeto B', () => {
    const storageBase = tempDir('storage-')
    const repoA = tempDir('repo-a-')
    const repoB = tempDir('repo-b-')

    const sessionA = new ProjectContinuumSession(storageBase)
    const sessionB = new ProjectContinuumSession(storageBase)
    sessionA.activate(repoA)
    sessionB.activate(repoB)
    const readerA = sessionA.getActiveReader()!
    const readerB = sessionB.getActiveReader()!

    new ArtifactInbox(repoA).write(baseEnvelope(repoA, { artifactId: 'art-isolated-a' }))

    expect(readerA.list().map((a) => a.artifactId)).toContain('art-isolated-a')
    expect(readerB.list().map((a) => a.artifactId)).not.toContain('art-isolated-a')
    expect(readerB.get('art-isolated-a')).toBeNull()

    sessionA.dispose()
    sessionB.dispose()
  })

  it('14. Falha isolada: entrada inválida não impede leitura de artifacts válidos já armazenados', () => {
    const storageBase = tempDir('storage-')
    const repo = tempDir('repo-live-')

    const session = new ProjectContinuumSession(storageBase)
    const inbox = new ArtifactInbox(repo)
    const rawMarkdown = '# Valid Content Preserved'
    inbox.write(
      baseEnvelope(repo, {
        artifactId: 'art-live-valid',
        rawMarkdown,
        contentHash: computeContentHash(rawMarkdown)
      })
    )
    session.activate(repo)
    const reader = session.getActiveReader()!
    expect(reader.get('art-live-valid')).not.toBeNull()

    writeFileSync(join(inbox.getInboxDir(), 'broken.json'), '{ not-json', 'utf8')

    const listed = reader.list()
    expect(listed.map((a) => a.artifactId)).toContain('art-live-valid')
    expect(reader.get('art-live-valid')!.rawMarkdown).toBe(rawMarkdown)

    session.dispose()
  })
})
