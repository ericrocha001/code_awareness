import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import Database from 'better-sqlite3'
import {
  SessionMemoryCentralStore,
  SessionMemoryCentralService,
  smcDatabasePath,
  SmcRepositoryScopeMismatchError,
  SmcInvalidSessionIdError,
  SmcSessionAlreadyExistsError,
  SmcSessionNotFoundError,
  SmcSessionClosedError,
  SmcInvalidEntryError,
  SmcEntryConflictError,
  SmcInvalidSupersedesError,
  SmcUnsupportedSchemaError
} from './index'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('Session Memory Central (SMC) — SMC-01 & SMC-02 Provas Mínimas', () => {
  let tempBaseDir: string

  beforeEach(() => {
    tempBaseDir = mkdtempSync(join(tmpdir(), 'smc-test-'))
  })

  afterEach(() => {
    if (existsSync(tempBaseDir)) {
      rmSync(tempBaseDir, { recursive: true, force: true })
    }
  })

  describe('SMC-01 — Prova 1: Criar sessão, fechar/reabrir Store e recuperar a mesma identidade e metadata', () => {
    it('persiste a identidade estável e metadata entre ciclos de vida da Store', () => {
      const repositoryId = 'repo-alpha-123'
      const dbPath = smcDatabasePath(tempBaseDir, repositoryId)

      const store1 = new SessionMemoryCentralStore(dbPath, repositoryId)
      expect(store1.isOpen()).toBe(true)

      const created = store1.createSession()
      expect(created.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      expect(created.repositoryId).toBe(repositoryId)
      expect(created.status).toBe('OPEN')
      expect(created.revision).toBe(1)
      expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt)
      expect(created.updatedAt).toBe(created.createdAt)

      store1.close()
      expect(store1.isOpen()).toBe(false)

      const store2 = new SessionMemoryCentralStore(dbPath, repositoryId)
      expect(store2.isOpen()).toBe(true)

      const recovered = store2.getSession(created.sessionId)
      expect(recovered).not.toBeNull()
      expect(recovered).toEqual(created)

      store2.close()
    })
  })

  describe('SMC-01 — Prova 2: Criar duas sessões no mesmo repositório: registros distintos e listagem bounded/determinística', () => {
    it('mantém sessões distintas do mesmo projeto coexistindo sem compartilhamento de estado', async () => {
      const repositoryId = 'repo-beta-456'
      const dbPath = smcDatabasePath(tempBaseDir, repositoryId)
      const store = new SessionMemoryCentralStore(dbPath, repositoryId)

      try {
        const s1 = store.createSession()
        await new Promise((r) => setTimeout(r, 10))
        const s2 = store.createSession()

        expect(s1.sessionId).not.toBe(s2.sessionId)
        expect(s1.repositoryId).toBe(repositoryId)
        expect(s2.repositoryId).toBe(repositoryId)

        expect(store.getSession(s1.sessionId)).toEqual(s1)
        expect(store.getSession(s2.sessionId)).toEqual(s2)

        const allSessions = store.listSessions()
        expect(allSessions).toHaveLength(2)
        expect(allSessions[0].sessionId).toBe(s2.sessionId)
        expect(allSessions[1].sessionId).toBe(s1.sessionId)

        const limited = store.listSessions({ limit: 1 })
        expect(limited).toHaveLength(1)
        expect(limited[0].sessionId).toBe(s2.sessionId)

        for (let i = 0; i < 5; i++) {
          store.createSession()
        }
        expect(store.listSessions({ limit: 3 })).toHaveLength(3)
        expect(store.listSessions({ limit: 100 })).toHaveLength(7)
      } finally {
        store.close()
      }
    })
  })

  describe('SMC-01 — Prova 3: Isolamento estrito entre repositories e fail-closed sem fallback', () => {
    it('impede consulta cruzada de sessões entre repositórios distintos', () => {
      const service = new SessionMemoryCentralService(tempBaseDir)

      const repoA = 'repo-customer-portal'
      const repoB = 'repo-payment-gateway'

      const sessionA = service.createSession(repoA)
      const sessionB = service.createSession(repoB)

      expect(service.getSession(repoA, sessionA.sessionId)).toEqual(sessionA)
      expect(service.getSession(repoB, sessionA.sessionId)).toBeNull()

      expect(service.getSession(repoB, sessionB.sessionId)).toEqual(sessionB)
      expect(service.getSession(repoA, sessionB.sessionId)).toBeNull()

      const listA = service.listSessions(repoA)
      expect(listA.map((s) => s.sessionId)).toContain(sessionA.sessionId)
      expect(listA.map((s) => s.sessionId)).not.toContain(sessionB.sessionId)

      const listB = service.listSessions(repoB)
      expect(listB.map((s) => s.sessionId)).toContain(sessionB.sessionId)
      expect(listB.map((s) => s.sessionId)).not.toContain(sessionA.sessionId)

      service.close()
    })

    it('rejeita tentativa de abrir banco de dados de outro repositório (REPOSITORY_SCOPE_MISMATCH)', () => {
      const repoOriginal = 'repo-auth'
      const dbPath = smcDatabasePath(tempBaseDir, repoOriginal)

      const store = new SessionMemoryCentralStore(dbPath, repoOriginal)
      store.createSession()
      store.close()

      expect(() => {
        new SessionMemoryCentralStore(dbPath, 'repo-imposter')
      }).toThrow(SmcRepositoryScopeMismatchError)
    })

    it('falha fechado na ausência de contexto de repositório válido, sem fallback ao checkout do host', () => {
      const service = new SessionMemoryCentralService(tempBaseDir)

      expect(() => service.getStore('')).toThrow(/REPOSITORY_ID_REQUIRED/)
      expect(() => service.getStore('   ')).toThrow(/REPOSITORY_ID_REQUIRED/)
      expect(() => service.getStore(undefined as any)).toThrow(/REPOSITORY_ID_REQUIRED/)
      expect(() => service.getStore(null as any)).toThrow(/REPOSITORY_ID_REQUIRED/)

      expect(() => service.createSession('')).toThrow(/REPOSITORY_ID_REQUIRED/)
      expect(() => service.getSession('', 'any-id')).toThrow(/REPOSITORY_ID_REQUIRED/)
      expect(() => service.listSessions('')).toThrow(/REPOSITORY_ID_REQUIRED/)

      expect(() => new SessionMemoryCentralStore(join(tempBaseDir, 'test.db'), '')).toThrow(/REPOSITORY_ID_REQUIRED/)
      expect(() => new SessionMemoryCentralStore(join(tempBaseDir, 'test.db'), '  ')).toThrow(/REPOSITORY_ID_REQUIRED/)

      service.close()
    })
  })

  describe('SMC-01 — Prova 4: Reabertura repetida e garantia de não-contaminação de outros domínios', () => {
    it('suporta reaberturas repetidas sem corromper ou duplicar registros', () => {
      const repoId = 'repo-persistent'
      const dbPath = smcDatabasePath(tempBaseDir, repoId)

      const storeInitial = new SessionMemoryCentralStore(dbPath, repoId)
      const session1 = storeInitial.createSession()
      const session2 = storeInitial.createSession()
      storeInitial.close()

      for (let i = 0; i < 5; i++) {
        const store = new SessionMemoryCentralStore(dbPath, repoId)
        expect(store.listSessions()).toHaveLength(2)
        expect(store.getSession(session1.sessionId)).toEqual(session1)
        expect(store.getSession(session2.sessionId)).toEqual(session2)
        store.close()
      }
    })

    it('isola o armazenamento fora da árvore do repositório/worktree, sem escritas no Continuum ou Session Context', () => {
      const repoId = 'repo-isolation-check'
      const service = new SessionMemoryCentralService(tempBaseDir)
      service.createSession(repoId)

      const dbPath = smcDatabasePath(tempBaseDir, repoId)
      expect(existsSync(dbPath)).toBe(true)
      expect(dbPath.startsWith(tempBaseDir)).toBe(true)

      expect(existsSync(join(tempBaseDir, 'continuum.db'))).toBe(false)
      expect(existsSync(join(tempBaseDir, 'session-context.sqlite'))).toBe(false)

      service.close()
    })
  })

  describe('SMC-02 — Prova 1: Migração de banco real SMC-01 v1 com sessão anterior', () => {
    it('migra banco v1 atomicamente, preserva sessões existentes, permite append e recupera body literal após restart', () => {
      const repoId = 'repo-migration-v1'
      const dbPath = smcDatabasePath(tempBaseDir, repoId)

      // 1. Simula exatamente um banco legado SMC-01 (schema v1)
      mkdirSync(dirname(dbPath), { recursive: true })
      const dbRaw = new Database(dbPath)
      dbRaw.exec(`
        CREATE TABLE smc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO smc_meta (key, value) VALUES ('repository_id', '${repoId}');
        INSERT INTO smc_meta (key, value) VALUES ('schema_version', '1');

        CREATE TABLE smc_sessions (
          session_id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL,
          status TEXT NOT NULL,
          revision INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO smc_sessions VALUES (
          '88888888-4444-4444-4444-121212121212',
          '${repoId}',
          'OPEN',
          1,
          '2026-11-04T12:00:00.000Z',
          '2026-11-04T12:00:00.000Z'
        );
      `)
      dbRaw.close()

      // 2. Abre com SessionMemoryCentralStore (deve migrar aditivamente v1 -> v2)
      const store = new SessionMemoryCentralStore(dbPath, repoId)

      // Sessão legada continua intacta
      const legacySession = store.getSession('88888888-4444-4444-4444-121212121212')
      expect(legacySession).not.toBeNull()
      expect(legacySession?.sessionId).toBe('88888888-4444-4444-4444-121212121212')
      expect(legacySession?.revision).toBe(1)

      // Acrescenta novo registro cumulativo na sessão legada
      const entryInput = {
        kind: 'DECISION' as const,
        title: 'Arquitetura SQLite isolada por repositório',
        body: 'Decisão formal de particionar arquivos por repositoryId em conformidade com o perfil canônico.',
        provenance: {
          role: 'AGENT' as const,
          emitterId: 'antigravity-worker'
        },
        references: [
          { kind: 'ARTIFACT' as const, target: 'artifact-4cd3bd4e-897a-48bf-8f22-8419c5ec0bd2' }
        ]
      }
      const appended = store.appendEntry(legacySession!.sessionId, entryInput)
      expect(appended.entryId).toMatch(UUID_REGEX)
      expect(appended.title).toBe(entryInput.title)
      expect(appended.body).toBe(entryInput.body)
      expect(appended.provenance.role).toBe('AGENT')
      expect(appended.provenance.emitterId).toBe('antigravity-worker')
      expect(appended.references).toHaveLength(1)

      store.close()

      // 3. Reabre a Store e recupera o registro com exatidão literal
      const reopened = new SessionMemoryCentralStore(dbPath, repoId)
      const recoveredEntry = reopened.getEntry(legacySession!.sessionId, appended.entryId)
      expect(recoveredEntry).not.toBeNull()
      expect(recoveredEntry?.body).toBe(entryInput.body)
      expect(recoveredEntry?.title).toBe(entryInput.title)
      expect(recoveredEntry?.provenance).toEqual(entryInput.provenance)
      expect(recoveredEntry?.references).toEqual(entryInput.references)

      // Garante que o schema_version está em 2
      const versionDb = new Database(dbPath)
      const row = versionDb.prepare('SELECT value FROM smc_meta WHERE key = ?').get('schema_version') as { value: string }
      expect(row.value).toBe('2')
      versionDb.close()

      reopened.close()
    })
  })

  describe('SMC-02 — Prova 2: Isolamento entre sessões/repositórios e fail-closed de sessão inexistente/CLOSED', () => {
    it('garante que registros não cruzam escopo entre sessões ou repositórios e rejeita sessão inexistente ou CLOSED', () => {
      const service = new SessionMemoryCentralService(tempBaseDir)

      const repoA = 'repo-service-alpha'
      const repoB = 'repo-service-beta'

      const sessionA1 = service.createSession(repoA)
      const sessionA2 = service.createSession(repoA)
      const sessionB = service.createSession(repoB)

      // Adiciona entrada na sessão A1
      const entryA1 = service.appendEntry(repoA, sessionA1.sessionId, {
        kind: 'DECISION',
        title: 'Decisão em A1',
        body: 'Corpo literal A1',
        provenance: { role: 'HUMAN', emitterId: 'lead-dev' }
      })

      // Consulta de A1 através de A2 retorna null
      expect(service.getEntry(repoA, sessionA2.sessionId, entryA1.entryId)).toBeNull()
      // Consulta de A1 através do repo B retorna null
      expect(service.getEntry(repoB, sessionB.sessionId, entryA1.entryId)).toBeNull()

      // Listagem de A2 não contém a entrada de A1
      const listA2 = service.listEntries(repoA, sessionA2.sessionId)
      expect(listA2.entries).toHaveLength(0)

      // Rejeita apontar supersedesEntryId de outra sessão
      expect(() => {
        service.appendEntry(repoA, sessionA2.sessionId, {
          kind: 'DECISION',
          title: 'Tentativa inválida de supersede',
          body: 'Corpo',
          provenance: { role: 'SYSTEM' },
          supersedesEntryId: entryA1.entryId
        })
      }).toThrow(SmcInvalidSupersedesError)

      // Rejeita append em sessão inexistente
      expect(() => {
        service.appendEntry(repoA, '00000000-0000-0000-0000-000000000000', {
          kind: 'RESULT',
          title: 'Teste',
          body: 'Corpo',
          provenance: { role: 'AGENT' }
        })
      }).toThrow(SmcSessionNotFoundError)

      // Simula uma sessão fechada
      const dbPathA = smcDatabasePath(tempBaseDir, repoA)
      const db = new Database(dbPathA)
      db.prepare('UPDATE smc_sessions SET status = ? WHERE session_id = ?').run('CLOSED', sessionA1.sessionId)
      db.close()

      // Rejeita append em sessão CLOSED
      expect(() => {
        service.appendEntry(repoA, sessionA1.sessionId, {
          kind: 'EVIDENCE',
          title: 'Tentativa pós-fechamento',
          body: 'Corpo',
          provenance: { role: 'AGENT' }
        })
      }).toThrow(SmcSessionClosedError)

      service.close()
    })
  })

  describe('SMC-02 — Prova 3: Vários kinds, paginação determinística e listagem metadata-only', () => {
    it('projeta listagem sem body, suporta todos os kinds e pagina deterministicamente com cursor', async () => {
      const repoId = 'repo-pagination-test'
      const service = new SessionMemoryCentralService(tempBaseDir)
      const session = service.createSession(repoId)

      const kinds = ['DECISION', 'EVIDENCE', 'RESULT', 'PENDING', 'INTERVENTION'] as const

      for (let i = 0; i < kinds.length; i++) {
        service.appendEntry(repoId, session.sessionId, {
          kind: kinds[i],
          title: `Título para kind ${kinds[i]}`,
          body: `Corpo detalhado e extenso do kind ${kinds[i]} com conteúdo literal de engenharia.`,
          provenance: { role: 'AGENT', emitterId: `agent-${i}` },
          references: [{ kind: 'COMMIT', target: `abc${i}` }]
        })
      }

      // 1. Listagem metadata-only: nenhum elemento possui body materializado
      const fullList = service.listEntries(repoId, session.sessionId, { limit: 10 })
      expect(fullList.entries).toHaveLength(5)
      for (const entry of fullList.entries) {
        expect((entry as any).body).toBeUndefined()
        expect(entry.title).toBeTruthy()
        expect(entry.provenance).toBeDefined()
        expect(entry.references).toBeDefined()
      }

      // 2. Filtro por kind
      const decisionsOnly = service.listEntries(repoId, session.sessionId, { kind: 'DECISION' })
      expect(decisionsOnly.entries).toHaveLength(1)
      expect(decisionsOnly.entries[0].kind).toBe('DECISION')

      // 3. Paginação determinística com cursor
      const page1 = service.listEntries(repoId, session.sessionId, { limit: 2 })
      expect(page1.entries).toHaveLength(2)
      expect(page1.nextCursor).toBeDefined()

      const page2 = service.listEntries(repoId, session.sessionId, { limit: 2, cursor: page1.nextCursor })
      expect(page2.entries).toHaveLength(2)
      expect(page2.nextCursor).toBeDefined()

      // Os registros das duas páginas são estritamente disjuntos
      const idsPage1 = page1.entries.map((e) => e.entryId)
      const idsPage2 = page2.entries.map((e) => e.entryId)
      expect(idsPage1.some((id) => idsPage2.includes(id))).toBe(false)

      const page3 = service.listEntries(repoId, session.sessionId, { limit: 2, cursor: page2.nextCursor })
      expect(page3.entries).toHaveLength(1)
      expect(page3.nextCursor).toBeUndefined()

      // 4. Seleciona um ID da lista e lê o conteúdo exato
      const selectedId = page1.entries[0].entryId
      const exactRecord = service.getEntry(repoId, session.sessionId, selectedId)
      expect(exactRecord).not.toBeNull()
      expect(exactRecord?.entryId).toBe(selectedId)
      expect(exactRecord?.body).toContain('Corpo detalhado e extenso')

      service.close()
    })
  })

  describe('SMC-02 — Prova 4: Replay idêntico, conflito em divergência, integridade e schema futuro', () => {
    it('garante idempotência em replay idêntico e falha explicitamente diante de divergência com mesmo ID', () => {
      const repoId = 'repo-idempotency'
      const service = new SessionMemoryCentralService(tempBaseDir)
      const session = service.createSession(repoId)

      const fixedEntryId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      const input = {
        entryId: fixedEntryId,
        kind: 'DECISION' as const,
        title: 'Decisão Imutável',
        body: 'Corpo literal fixo',
        provenance: { role: 'HUMAN' as const, emitterId: 'lead' },
        references: [{ kind: 'COMMIT' as const, target: 'sha-123456' }]
      }

      // Primeiro append com sucesso
      const firstAppend = service.appendEntry(repoId, session.sessionId, input)
      expect(firstAppend.entryId).toBe(fixedEntryId)

      // Replay idêntico: retorna mesmo registro sem duplicação
      const replay = service.appendEntry(repoId, session.sessionId, input)
      expect(replay).toEqual(firstAppend)

      const list = service.listEntries(repoId, session.sessionId)
      expect(list.entries).toHaveLength(1)

      // Replay divergente (mesmo entryId com outro body): lança SmcEntryConflictError
      expect(() => {
        service.appendEntry(repoId, session.sessionId, {
          ...input,
          body: 'Corpo modificado divergente'
        })
      }).toThrow(SmcEntryConflictError)

      // Replay divergente com outro title
      expect(() => {
        service.appendEntry(repoId, session.sessionId, {
          ...input,
          title: 'Título modificado'
        })
      }).toThrow(SmcEntryConflictError)

      service.close()
    })

    it('rejeita schema futuro sem gravações parciais ou corrupção', () => {
      const repoId = 'repo-future-schema'
      const dbPath = smcDatabasePath(tempBaseDir, repoId)

      mkdirSync(dirname(dbPath), { recursive: true })
      const dbRaw = new Database(dbPath)
      dbRaw.exec(`
        CREATE TABLE smc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO smc_meta (key, value) VALUES ('repository_id', '${repoId}');
        INSERT INTO smc_meta (key, value) VALUES ('schema_version', '99');
      `)
      dbRaw.close()

      expect(() => {
        new SessionMemoryCentralStore(dbPath, repoId)
      }).toThrow(SmcUnsupportedSchemaError)
    })

    it('suporta superação declarada de registro anterior (supersedesEntryId) na mesma sessão', () => {
      const repoId = 'repo-supersedes'
      const service = new SessionMemoryCentralService(tempBaseDir)
      const session = service.createSession(repoId)

      const initial = service.appendEntry(repoId, session.sessionId, {
        kind: 'PENDING',
        title: 'Investigação inicial pendente',
        body: 'Precisamos verificar a latência do SQLite no perfil.',
        provenance: { role: 'AGENT' }
      })

      const superseding = service.appendEntry(repoId, session.sessionId, {
        kind: 'RESULT',
        title: 'Investigação concluída',
        body: 'A latência medida está abaixo de 1ms para operações WAL.',
        provenance: { role: 'AGENT' },
        supersedesEntryId: initial.entryId
      })

      expect(superseding.supersedesEntryId).toBe(initial.entryId)

      // O histórico de ambos permanece preservado (append-only)
      const list = service.listEntries(repoId, session.sessionId)
      expect(list.entries).toHaveLength(2)
      expect(list.entries.map((e) => e.entryId)).toContain(initial.entryId)
      expect(list.entries.map((e) => e.entryId)).toContain(superseding.entryId)

      service.close()
    })
  })
})
