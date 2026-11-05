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
import {
  UnitFlowService,
  UnitFlowInvalidPlanError,
  UnitFlowPlanConflictError,
  UnitFlowActivePlanAlreadyExistsError
} from '../../unitflow'
import {
  BUILDX_SMC_TOOLS,
  BUILDX_SMC_READ_TOOLS,
  BUILDX_SMC_MUTATION_TOOLS,
  LIST_BUILDX_SESSIONS_TOOL,
  LIST_BUILDX_SESSION_ENTRIES_TOOL,
  GET_BUILDX_SESSION_ENTRY_TOOL,
  CREATE_BUILDX_SESSION_TOOL,
  APPEND_BUILDX_SESSION_ENTRY_TOOL,
  executeBuildxSmcTool
} from './session-memory-central-mcp'
import { ChannelMcpAdapter } from '../../mcp/channel-mcp-adapter'
import { bindProjectNavigation } from '../../core/context/project-context-navigation'
import type { ContextNavigationPort } from '../../core/context/context-navigation-port'
import { textContent } from '../../mcp/mcp-test-content'


const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('Session Memory Central (SMC) — SMC-01, SMC-02, SMC-03 & SMC-04 Provas Mínimas', () => {
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

      // Garante que o schema_version foi migrado (pelo menos versão 2, atualmente 3)
      const versionDb = new Database(dbPath)
      const row = versionDb.prepare('SELECT value FROM smc_meta WHERE key = ?').get('schema_version') as { value: string }
      expect(['2', '3']).toContain(row.value)
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

  describe('SMC-03 — Descoberta e leitura MCP da memória de sessão', () => {
    function createAdapter(service: SessionMemoryCentralService, projectId: string, assertActiveProject?: () => void) {
      const stubNavigation: ContextNavigationPort = {
        discoverRepository: async () => ({ directories: [] }),
        getRelationships: async () => ({ files: [] }),
        inspectFiles: async () => ({ files: [] }),
        readCode: async () => [],
        getReferences: async () => ({ targets: [] }),
        getSymbolDependencies: async () => ({ sources: [] }),
        getSymbolHierarchy: async () => ({ targets: [] })
      }
      return new ChannelMcpAdapter({
        projectId,
        repoRoot: join(tempBaseDir, projectId),
        navigation: bindProjectNavigation(stubNavigation, join(tempBaseDir, projectId)),
        sessionMemoryCentral: service,
        assertActiveProject
      })
    }

    describe('SMC-03 — Prova 1: Catálogo, anotações e roteamento no Channel MCP', () => {
      it('expõe exatamente as ferramentas de leitura BuildX com readOnlyHint=true e sem ferramentas de escrita', () => {
        const service = new SessionMemoryCentralService(tempBaseDir)
        const adapter = createAdapter(service, 'repo-cat')
        const tools = adapter.listTools()

        const buildxTools = tools.filter(t => BUILDX_SMC_READ_TOOLS.some(bt => bt.name === t.name))
        expect(buildxTools.map(t => t.name).sort()).toEqual([
          'get_buildx_session_entry',
          'list_buildx_session_entries',
          'list_buildx_sessions'
        ])

        for (const t of buildxTools) {
          expect(t.annotations?.readOnlyHint).toBe(true)
          expect(t.inputSchema.properties).not.toHaveProperty('repositoryId')
        }

        const anyWriteBuildX = tools.some(t => BUILDX_SMC_READ_TOOLS.some(rt => rt.name === t.name) && (t.name.includes('create') || t.name.includes('append') || t.name.includes('write')))
        expect(anyWriteBuildX).toBe(false)

        service.close()
      })

      it('não expõe as ferramentas BuildX quando sessionMemoryCentral não for fornecido', () => {
        const stubNav: ContextNavigationPort = {
          discoverRepository: async () => ({ directories: [] }),
          getRelationships: async () => ({ files: [] }),
          inspectFiles: async () => ({ files: [] }),
          readCode: async () => [],
          getReferences: async () => ({ targets: [] }),
          getSymbolDependencies: async () => ({ sources: [] }),
          getSymbolHierarchy: async () => ({ targets: [] })
        }
        const adapter = new ChannelMcpAdapter({
          projectId: 'repo-no-smc',
          repoRoot: join(tempBaseDir, 'repo-no-smc'),
          navigation: bindProjectNavigation(stubNav, join(tempBaseDir, 'repo-no-smc'))
        })

        const tools = adapter.listTools()
        expect(tools.some(t => BUILDX_SMC_TOOLS.some(bt => bt.name === t.name))).toBe(false)
      })
    })

    describe('SMC-03 — Prova 2: Autocontextualização progressiva (list_buildx_sessions -> list_buildx_session_entries -> get_buildx_session_entry)', () => {
      it('executa a jornada completa de autocontextualização sem vazar corpos na listagem e permitindo leitura seletiva', async () => {
        const repoId = 'repo-flow-1'
        const service = new SessionMemoryCentralService(tempBaseDir)
        const adapter = createAdapter(service, repoId)

        const session = service.createSession(repoId)
        const entry1 = service.appendEntry(repoId, session.sessionId, {
          kind: 'DECISION',
          title: 'Decisão de persistência',
          body: 'Corpo confidencial de decisão arquitetural SQLite WAL.',
          provenance: { role: 'HUMAN' }
        })
        const entry2 = service.appendEntry(repoId, session.sessionId, {
          kind: 'EVIDENCE',
          title: 'Evidência de benchmark',
          body: 'Corpo longo de evidência com tempos de execução.',
          provenance: { role: 'AGENT' }
        })
        const entry3 = service.appendEntry(repoId, session.sessionId, {
          kind: 'RESULT',
          title: 'Resultado de validação',
          body: 'Corpo longo com sumário de aprovação de 13 testes.',
          provenance: { role: 'AGENT' }
        })

        // Passo 1: list_buildx_sessions
        const sessionsResult = await adapter.callTool('list_buildx_sessions', {})
        expect(sessionsResult.isError).toBeFalsy()
        const sessionsPayload = JSON.parse(textContent(sessionsResult.content[0]))
        expect(sessionsPayload.sessions).toBeDefined()
        const foundSession = sessionsPayload.sessions.find((s: any) => s.sessionId === session.sessionId)
        expect(foundSession).toBeDefined()
        expect(foundSession.sessionId).toBe(session.sessionId)
        expect(foundSession.status).toBe('OPEN')
        expect(foundSession.revision).toBe(1)
        expect(foundSession).not.toHaveProperty('body')
        expect(foundSession).not.toHaveProperty('entries')

        // Passo 2: list_buildx_session_entries
        const entriesResult = await adapter.callTool('list_buildx_session_entries', { sessionId: session.sessionId })
        expect(entriesResult.isError).toBeFalsy()
        const entriesPayload = JSON.parse(textContent(entriesResult.content[0]))
        expect(entriesPayload.entries).toHaveLength(3)
        for (const item of entriesPayload.entries) {
          expect(item.sessionId).toBe(session.sessionId)
          expect(item.entryId).toBeDefined()
          expect(item.kind).toBeDefined()
          expect(item.title).toBeDefined()
          expect(item).not.toHaveProperty('body')
        }

        // Filtro por kind
        const filteredResult = await adapter.callTool('list_buildx_session_entries', { sessionId: session.sessionId, kind: 'DECISION' })
        const filteredPayload = JSON.parse(textContent(filteredResult.content[0]))
        expect(filteredPayload.entries).toHaveLength(1)
        expect(filteredPayload.entries[0].entryId).toBe(entry1.entryId)
        expect(filteredPayload.entries[0].kind).toBe('DECISION')

        // Paginação por cursor
        const p1 = await adapter.callTool('list_buildx_session_entries', { sessionId: session.sessionId, limit: 2 })
        const p1Payload = JSON.parse(textContent(p1.content[0]))
        expect(p1Payload.entries).toHaveLength(2)
        expect(p1Payload.nextCursor).toBeTruthy()

        const p2 = await adapter.callTool('list_buildx_session_entries', { sessionId: session.sessionId, limit: 2, cursor: p1Payload.nextCursor })
        const p2Payload = JSON.parse(textContent(p2.content[0]))
        expect(p2Payload.entries).toHaveLength(1)
        expect(p2Payload.entries[0].entryId).toBe(entry3.entryId)

        // Passo 3: get_buildx_session_entry
        const singleResult = await adapter.callTool('get_buildx_session_entry', { sessionId: session.sessionId, entryId: entry1.entryId })
        expect(singleResult.isError).toBeFalsy()
        const singlePayload = JSON.parse(textContent(singleResult.content[0]))
        expect(singlePayload.entryId).toBe(entry1.entryId)
        expect(singlePayload.sessionId).toBe(session.sessionId)
        expect(singlePayload.kind).toBe('DECISION')
        expect(singlePayload.title).toBe('Decisão de persistência')
        expect(singlePayload.body).toBe('Corpo confidencial de decisão arquitetural SQLite WAL.')
        expect(singlePayload.provenance.role).toBe('HUMAN')

        service.close()
      })
    })

    describe('SMC-03 — Prova 3: Fronteiras, isolamento entre repositórios e fail-closed', () => {
      it('isola estritamente repositório A de repositório B', async () => {
        const service = new SessionMemoryCentralService(tempBaseDir)
        const adapterA = createAdapter(service, 'repo-a')
        const adapterB = createAdapter(service, 'repo-b')

        const sessionA = service.createSession('repo-a')
        const entryA = service.appendEntry('repo-a', sessionA.sessionId, {
          kind: 'RESULT',
          title: 'Resultado A',
          body: 'Dado específico do repo A',
          provenance: { role: 'AGENT' }
        })

        const sessionB = service.createSession('repo-b')

        const listA = await adapterA.callTool('list_buildx_sessions', {})
        const payloadListA = JSON.parse(textContent(listA.content[0]))
        expect(payloadListA.sessions.map((s: any) => s.sessionId)).toContain(sessionA.sessionId)
        expect(payloadListA.sessions.map((s: any) => s.sessionId)).not.toContain(sessionB.sessionId)

        const crossList = await adapterA.callTool('list_buildx_session_entries', { sessionId: sessionB.sessionId })
        expect(crossList.isError).toBe(true)
        expect(JSON.parse(textContent(crossList.content[0])).code).toBe('SESSION_NOT_FOUND')

        const crossGet = await adapterA.callTool('get_buildx_session_entry', { sessionId: sessionB.sessionId, entryId: entryA.entryId })
        expect(crossGet.isError).toBe(true)
        expect(JSON.parse(textContent(crossGet.content[0])).code).toBe('SESSION_NOT_FOUND')

        service.close()
      })

      it('rejeita com PROJECT_CONTEXT_CHANGED quando o contexto do projeto for invalidado ou trocado', async () => {
        const repoId = 'repo-context-invalidation'
        const service = new SessionMemoryCentralService(tempBaseDir)
        let active = true

        const adapter = createAdapter(service, repoId, () => {
          if (!active) throw new Error('PROJECT_CONTEXT_CHANGED')
        })

        const session = service.createSession(repoId)
        const okRes = await adapter.callTool('list_buildx_sessions', {})
        expect(okRes.isError).toBeFalsy()

        active = false
        const invalidatedRes = await adapter.callTool('list_buildx_sessions', {})
        expect(invalidatedRes.isError).toBe(true)
        expect(JSON.parse(textContent(invalidatedRes.content[0])).code).toBe('PROJECT_CONTEXT_CHANGED')

        service.close()
      })

      it('rejeita identificadores inválidos e argumentos malformados com INVALID_ARGUMENT', async () => {
        const repoId = 'repo-arg-val'
        const service = new SessionMemoryCentralService(tempBaseDir)
        const adapter = createAdapter(service, repoId)

        const invalidSession = await adapter.callTool('list_buildx_session_entries', { sessionId: 'not-a-uuid' })
        expect(invalidSession.isError).toBe(true)
        expect(JSON.parse(textContent(invalidSession.content[0])).code).toBe('INVALID_ARGUMENT')

        const validSession = service.createSession(repoId)
        const invalidEntry = await adapter.callTool('get_buildx_session_entry', { sessionId: validSession.sessionId, entryId: '12345' })
        expect(invalidEntry.isError).toBe(true)
        expect(JSON.parse(textContent(invalidEntry.content[0])).code).toBe('INVALID_ARGUMENT')

        const invalidKind = await adapter.callTool('list_buildx_session_entries', { sessionId: validSession.sessionId, kind: 'NON_EXISTENT_KIND' })
        expect(invalidKind.isError).toBe(true)
        expect(JSON.parse(textContent(invalidKind.content[0])).code).toBe('INVALID_ARGUMENT')

        const invalidLimit = await adapter.callTool('list_buildx_sessions', { limit: -5 })
        expect(invalidLimit.isError).toBe(true)
        expect(JSON.parse(textContent(invalidLimit.content[0])).code).toBe('INVALID_ARGUMENT')

        service.close()
      })
    })

    describe('SMC-03 — Prova 4: Pureza de leitura, ausência de vazamento e limite de resposta', () => {
      it('as consultas de leitura não causam qualquer mutação no SQLite nem alteram contagens ou revisões', async () => {
        const repoId = 'repo-purity'
        const service = new SessionMemoryCentralService(tempBaseDir)
        const adapter = createAdapter(service, repoId)

        const session = service.createSession(repoId)
        const entry = service.appendEntry(repoId, session.sessionId, {
          kind: 'RESULT',
          title: 'Purity test',
          body: 'Corpo de teste para validação de pureza.',
          provenance: { role: 'AGENT' }
        })

        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const dbInspection = new Database(dbPath, { readonly: true })
        const initialSessionsCount = dbInspection.prepare('SELECT COUNT(*) as count FROM smc_sessions').get() as { count: number }
        const initialEntriesCount = dbInspection.prepare('SELECT COUNT(*) as count FROM smc_entries').get() as { count: number }
        const initialSessionRow = dbInspection.prepare('SELECT * FROM smc_sessions WHERE session_id = ?').get(session.sessionId) as any
        dbInspection.close()

        for (let i = 0; i < 5; i++) {
          await adapter.callTool('list_buildx_sessions', {})
          await adapter.callTool('list_buildx_session_entries', { sessionId: session.sessionId })
          await adapter.callTool('get_buildx_session_entry', { sessionId: session.sessionId, entryId: entry.entryId })
        }

        const dbAfter = new Database(dbPath, { readonly: true })
        const afterSessionsCount = dbAfter.prepare('SELECT COUNT(*) as count FROM smc_sessions').get() as { count: number }
        const afterEntriesCount = dbAfter.prepare('SELECT COUNT(*) as count FROM smc_entries').get() as { count: number }
        const afterSessionRow = dbAfter.prepare('SELECT * FROM smc_sessions WHERE session_id = ?').get(session.sessionId) as any
        dbAfter.close()

        expect(afterSessionsCount.count).toBe(initialSessionsCount.count)
        expect(afterEntriesCount.count).toBe(initialEntriesCount.count)
        expect(afterSessionRow.revision).toBe(initialSessionRow.revision)
        expect(afterSessionRow.updated_at).toBe(initialSessionRow.updated_at)

        service.close()
      })

      it('não vaza caminhos privados do sistema de arquivos nas saídas do Channel MCP', async () => {
        const repoId = 'repo-leak-prevention'
        const service = new SessionMemoryCentralService(tempBaseDir)
        const adapter = createAdapter(service, repoId)

        const session = service.createSession(repoId)
        const entry = service.appendEntry(repoId, session.sessionId, {
          kind: 'RESULT',
          title: 'Leak test',
          body: 'Leak check body content',
          provenance: { role: 'AGENT' }
        })

        const res1 = await adapter.callTool('list_buildx_sessions', {})
        const res2 = await adapter.callTool('list_buildx_session_entries', { sessionId: session.sessionId })
        const res3 = await adapter.callTool('get_buildx_session_entry', { sessionId: session.sessionId, entryId: entry.entryId })

        for (const res of [res1, res2, res3]) {
          const rawText = textContent(res.content[0])
          expect(rawText).not.toContain(tempBaseDir)
          expect(rawText).not.toContain('.db')
          expect(rawText).not.toContain('session-memory-central.db')
        }

        service.close()
      })

      it('rejeita com RESPONSE_LIMIT_REACHED quando o registro excede o orçamento de resposta', () => {
        const repoId = 'repo-budget'
        const service = new SessionMemoryCentralService(tempBaseDir)
        const session = service.createSession(repoId)
        const entry = service.appendEntry(repoId, session.sessionId, {
          kind: 'RESULT',
          title: 'Huge payload test',
          body: 'X'.repeat(500),
          provenance: { role: 'AGENT' }
        })

        const overflowResult = executeBuildxSmcTool(
          service,
          repoId,
          'get_buildx_session_entry',
          { sessionId: session.sessionId, entryId: entry.entryId },
          { maxResponseBytes: 200 }
        )

        expect(overflowResult.isError).toBe(true)
        const errPayload = JSON.parse(textContent(overflowResult.content[0]))
        expect(errPayload.code).toBe('RESPONSE_LIMIT_REACHED')

        service.close()
      })
    })
  describe('SMC-04 — Criação e registro autorizado via MCP', () => {
    function createAdapter(service: SessionMemoryCentralService, projectId: string, assertActiveProject?: () => void) {
      const stubNavigation: ContextNavigationPort = {
        discoverRepository: async () => ({ directories: [] }),
        getRelationships: async () => ({ files: [] }),
        inspectFiles: async () => ({ files: [] }),
        readCode: async () => [],
        getReferences: async () => ({ targets: [] }),
        getSymbolDependencies: async () => ({ sources: [] }),
        getSymbolHierarchy: async () => ({ targets: [] })
      }
      return new ChannelMcpAdapter({
        projectId,
        repoRoot: join(tempBaseDir, projectId),
        navigation: bindProjectNavigation(stubNavigation, join(tempBaseDir, projectId)),
        sessionMemoryCentral: service,
        assertActiveProject
      })
    }

    describe('SMC-04 — Prova 1: Catálogo com 5 ferramentas, 3 read-only e 2 mutações na lane BuildX', () => {
      it('expõe exatamente 3 ferramentas read-only e 2 ferramentas de mutação sem readOnlyHint', () => {
        const service = new SessionMemoryCentralService(tempBaseDir)
        const adapter = createAdapter(service, 'repo-smc04-cat')
        const tools = adapter.listTools()

        const buildxTools = tools.filter(t => BUILDX_SMC_TOOLS.some(bt => bt.name === t.name))
        expect(buildxTools.map(t => t.name).sort()).toEqual([
          'append_buildx_session_entry',
          'create_buildx_session',
          'get_buildx_session_entry',
          'list_buildx_session_entries',
          'list_buildx_sessions'
        ])

        const readTools = tools.filter(t => BUILDX_SMC_READ_TOOLS.some(bt => bt.name === t.name))
        for (const t of readTools) {
          expect(t.annotations?.readOnlyHint).toBe(true)
        }

        const mutationTools = tools.filter(t => BUILDX_SMC_MUTATION_TOOLS.some(bt => bt.name === t.name))
        expect(mutationTools.map(t => t.name).sort()).toEqual(['append_buildx_session_entry', 'create_buildx_session'])
        for (const t of mutationTools) {
          expect(t.annotations?.readOnlyHint).toBeUndefined()
        }

        for (const t of buildxTools) {
          expect(t.inputSchema.properties).not.toHaveProperty('repositoryId')
        }

        service.close()
      })
    })

    describe('SMC-04 — Prova 2: Fluxo completo create -> append -> list -> get com persistência', () => {
      it('cria sessão por MCP, adiciona registros por MCP e recupera via consultas de leitura após reabrir DB', async () => {
        const repoId = 'repo-smc04-flow'
        const service = new SessionMemoryCentralService(tempBaseDir)
        const adapter = createAdapter(service, repoId)

        // Passo 1: create_buildx_session
        const sessionId = '11111111-2222-3333-4444-555555555555'
        const createRes = await adapter.callTool('create_buildx_session', { sessionId })
        expect(createRes.isError).toBeFalsy()
        const createPayload = JSON.parse(textContent(createRes.content[0]))
        expect(createPayload.sessionId).toBe(sessionId)
        expect(createPayload.status).toBe('OPEN')
        expect(createPayload.revision).toBe(1)
        expect(createPayload.replayed).toBeUndefined()

        // Passo 2: append_buildx_session_entry
        const entryId1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        const appendRes1 = await adapter.callTool('append_buildx_session_entry', {
          sessionId,
          entryId: entryId1,
          kind: 'DECISION',
          title: 'Usar SQLite WAL para SMC',
          body: 'Decisão de usar WAL mode para melhor performance de leitura concorrente na SMC.',
          emitterId: 'agent-build-x'
        })
        expect(appendRes1.isError).toBeFalsy()
        const appendPayload1 = JSON.parse(textContent(appendRes1.content[0]))
        expect(appendPayload1.entryId).toBe(entryId1)
        expect(appendPayload1.sessionId).toBe(sessionId)
        expect(appendPayload1.kind).toBe('DECISION')
        expect(appendPayload1.title).toBe('Usar SQLite WAL para SMC')
        // Receipt must NOT echo body
        expect(appendPayload1).not.toHaveProperty('body')
        expect(appendPayload1.createdAt).toBeDefined()

        // Passo 3: append second entry with references and supersedes
        const entryId2 = 'ffffffff-1111-2222-3333-444444444444'
        const appendRes2 = await adapter.callTool('append_buildx_session_entry', {
          sessionId,
          entryId: entryId2,
          kind: 'RESULT',
          title: 'Validação de performance SQLite WAL',
          body: 'Latência P99 abaixo de 2ms para leituras concorrentes em SMC com WAL mode.',
          supersedesEntryId: entryId1,
          references: [{ kind: 'PROOF', target: 'artifact-abc-123' }]
        })
        expect(appendRes2.isError).toBeFalsy()
        const appendPayload2 = JSON.parse(textContent(appendRes2.content[0]))
        expect(appendPayload2.entryId).toBe(entryId2)
        expect(appendPayload2).not.toHaveProperty('body')

        // Passo 4: list_buildx_sessions
        const listRes = await adapter.callTool('list_buildx_sessions', {})
        const listPayload = JSON.parse(textContent(listRes.content[0]))
        const found = listPayload.sessions.find((s: any) => s.sessionId === sessionId)
        expect(found).toBeDefined()

        // Passo 5: list entries sem body
        const entriesRes = await adapter.callTool('list_buildx_session_entries', { sessionId })
        const entriesPayload = JSON.parse(textContent(entriesRes.content[0]))
        expect(entriesPayload.entries).toHaveLength(2)
        for (const e of entriesPayload.entries) {
          expect(e).not.toHaveProperty('body')
        }

        // Passo 6: get entry com body exato
        const getRes = await adapter.callTool('get_buildx_session_entry', { sessionId, entryId: entryId1 })
        const getPayload = JSON.parse(textContent(getRes.content[0]))
        expect(getPayload.body).toBe('Decisão de usar WAL mode para melhor performance de leitura concorrente na SMC.')
        expect(getPayload.provenance.role).toBe('AGENT')
        expect(getPayload.provenance.emitterId).toBe('agent-build-x')

        // Passo 7: fechar e reabrir DB — dados persistem
        service.close()
        const service2 = new SessionMemoryCentralService(tempBaseDir)
        const session2 = service2.getSession(repoId, sessionId)
        expect(session2).not.toBeNull()
        expect(session2!.sessionId).toBe(sessionId)
        const entry2 = service2.getEntry(repoId, sessionId, entryId2)
        expect(entry2).not.toBeNull()
        expect(entry2!.supersedesEntryId).toBe(entryId1)
        expect(entry2!.references?.[0].kind).toBe('PROOF')
        service2.close()
      })
    })

    describe('SMC-04 — Prova 3: Idempotência de sessionId e entryId', () => {
      it('repetir mesma criação de sessão retorna replay sem duplicar', async () => {
        const repoId = 'repo-smc04-idem-sess'
        const service = new SessionMemoryCentralService(tempBaseDir)
        const adapter = createAdapter(service, repoId)
        const sessionId = 'cccccccc-dddd-eeee-ffff-000000000001'

        const r1 = await adapter.callTool('create_buildx_session', { sessionId })
        const r2 = await adapter.callTool('create_buildx_session', { sessionId })
        expect(r1.isError).toBeFalsy()
        expect(r2.isError).toBeFalsy()
        const p2 = JSON.parse(textContent(r2.content[0]))
        expect(p2.replayed).toBe(true)
        expect(p2.sessionId).toBe(sessionId)

        // Deve existir exatamente uma sessão
        const sessions = service.listSessions(repoId)
        expect(sessions.filter(s => s.sessionId === sessionId)).toHaveLength(1)
        service.close()
      })

      it('repetir mesmo append com conteúdo idêntico não duplica; conteúdo divergente falha com ENTRY_CONFLICT', async () => {
        const repoId = 'repo-smc04-idem-entry'
        const service = new SessionMemoryCentralService(tempBaseDir)
        const adapter = createAdapter(service, repoId)
        const sessionId = 'cccccccc-dddd-eeee-ffff-000000000002'
        const entryId = 'dddddddd-eeee-ffff-0000-111111111111'

        await adapter.callTool('create_buildx_session', { sessionId })

        const payload = { sessionId, entryId, kind: 'EVIDENCE', title: 'Prova de desempenho', body: 'Latência P99 < 2ms' }
        const r1 = await adapter.callTool('append_buildx_session_entry', payload)
        const r2 = await adapter.callTool('append_buildx_session_entry', payload) // idêntico
        expect(r1.isError).toBeFalsy()
        expect(r2.isError).toBeFalsy() // replay idêntico aprovado

        // Conteúdo divergente com mesmo entryId
        const r3 = await adapter.callTool('append_buildx_session_entry', { ...payload, body: 'Conteúdo diferente' })
        expect(r3.isError).toBe(true)
        expect(JSON.parse(textContent(r3.content[0])).code).toBe('ENTRY_CONFLICT')

        // Exatamente 1 entrada no store
        const list = service.listEntries(repoId, sessionId)
        expect(list.entries).toHaveLength(1)
        service.close()
      })
    })

    describe('SMC-04 — Prova 4: Isolamento, fronteiras e fail-closed', () => {
      it('isola operações de escrita entre repositórios distintos', async () => {
        const service = new SessionMemoryCentralService(tempBaseDir)
        const adapterA = createAdapter(service, 'repo-smc04-iso-a')
        const adapterB = createAdapter(service, 'repo-smc04-iso-b')

        const sessionId = 'eeeeeeee-ffff-0000-1111-222222222222'
        const entryId = 'ffffffff-0000-1111-2222-333333333333'

        await adapterA.callTool('create_buildx_session', { sessionId })
        await adapterA.callTool('append_buildx_session_entry', {
          sessionId, entryId, kind: 'RESULT', title: 'Resultado A', body: 'Corpo A'
        })

        // repo B não pode acessar sessão do repo A
        const crossList = await adapterB.callTool('list_buildx_session_entries', { sessionId })
        expect(crossList.isError).toBe(true)
        expect(JSON.parse(textContent(crossList.content[0])).code).toBe('SESSION_NOT_FOUND')

        // append em sessão de outro repositório falha
        const crossAppend = await adapterB.callTool('append_buildx_session_entry', {
          sessionId, entryId: 'aaaaaaaa-0000-1111-2222-333333333333', kind: 'EVIDENCE', title: 'Cruzado', body: 'Cross-repo'
        })
        expect(crossAppend.isError).toBe(true)

        service.close()
      })

      it('rejeita PROJECT_CONTEXT_CHANGED nas mutações quando contexto trocado', async () => {
        const repoId = 'repo-smc04-ctx-guard'
        const service = new SessionMemoryCentralService(tempBaseDir)
        let active = true
        const adapter = createAdapter(service, repoId, () => {
          if (!active) throw new Error('PROJECT_CONTEXT_CHANGED')
        })

        const sessionId = '11111111-aaaa-bbbb-cccc-dddddddddddd'
        const r1 = await adapter.callTool('create_buildx_session', { sessionId })
        expect(r1.isError).toBeFalsy()

        active = false
        const r2 = await adapter.callTool('create_buildx_session', { sessionId })
        expect(r2.isError).toBe(true)
        expect(JSON.parse(textContent(r2.content[0])).code).toBe('PROJECT_CONTEXT_CHANGED')

        const r3 = await adapter.callTool('append_buildx_session_entry', {
          sessionId, entryId: '22222222-bbbb-cccc-dddd-eeeeeeeeeeee', kind: 'PENDING', title: 'T', body: 'B'
        })
        expect(r3.isError).toBe(true)
        expect(JSON.parse(textContent(r3.content[0])).code).toBe('PROJECT_CONTEXT_CHANGED')

        service.close()
      })

      it('rejeita sessão inexistente, sessão CLOSED e IDs inválidos', async () => {
        const repoId = 'repo-smc04-fail-closed'
        const service = new SessionMemoryCentralService(tempBaseDir)
        const adapter = createAdapter(service, repoId)

        // sessionId inválido em create
        const r1 = await adapter.callTool('create_buildx_session', { sessionId: 'nao-um-uuid' })
        expect(r1.isError).toBe(true)
        expect(JSON.parse(textContent(r1.content[0])).code).toBe('INVALID_ARGUMENT')

        // append em sessão inexistente
        const r2 = await adapter.callTool('append_buildx_session_entry', {
          sessionId: '33333333-cccc-dddd-eeee-ffffffffffff',
          entryId: '44444444-dddd-eeee-ffff-000000000000',
          kind: 'RESULT', title: 'T', body: 'B'
        })
        expect(r2.isError).toBe(true)
        expect(JSON.parse(textContent(r2.content[0])).code).toBe('SESSION_NOT_FOUND')

        // entryId inválido
        const sessId = '55555555-eeee-ffff-0000-111111111111'
        await adapter.callTool('create_buildx_session', { sessionId: sessId })
        const r3 = await adapter.callTool('append_buildx_session_entry', {
          sessionId: sessId, entryId: 'nao-uuid', kind: 'RESULT', title: 'T', body: 'B'
        })
        expect(r3.isError).toBe(true)
        expect(JSON.parse(textContent(r3.content[0])).code).toBe('INVALID_ARGUMENT')

        // kind inválido
        const r4 = await adapter.callTool('append_buildx_session_entry', {
          sessionId: sessId, entryId: '66666666-ffff-0000-1111-222222222222', kind: 'FAKE_KIND', title: 'T', body: 'B'
        })
        expect(r4.isError).toBe(true)
        expect(JSON.parse(textContent(r4.content[0])).code).toBe('INVALID_ARGUMENT')

        service.close()
      })

      it('proveniência é sempre AGENT via MCP, independente de emitterId declarado', async () => {
        const repoId = 'repo-smc04-provenance'
        const service = new SessionMemoryCentralService(tempBaseDir)
        const adapter = createAdapter(service, repoId)

        const sessionId = '77777777-0000-1111-2222-333333333333'
        const entryId = '88888888-1111-2222-3333-444444444444'
        await adapter.callTool('create_buildx_session', { sessionId })
        await adapter.callTool('append_buildx_session_entry', {
          sessionId, entryId, kind: 'DECISION', title: 'Decisão', body: 'Corpo', emitterId: 'agent-ficticio'
        })

        const record = service.getEntry(repoId, sessionId, entryId)
        expect(record).not.toBeNull()
        expect(record!.provenance.role).toBe('AGENT')
        expect(record!.provenance.emitterId).toBe('agent-ficticio')

        service.close()
      })
    })

    describe('SMC-04 — Prova 5: Pureza — recibo sem body, sem mutação de outros domínios', () => {
      it('o recibo de append não ecoa body, título não revela secrets, store é o único efeito colateral', async () => {
        const repoId = 'repo-smc04-purity'
        const service = new SessionMemoryCentralService(tempBaseDir)
        const adapter = createAdapter(service, repoId)

        const sessionId = '99999999-2222-3333-4444-555555555555'
        const entryId = 'aaaaaaaa-3333-4444-5555-666666666666'
        const secretBody = 'CONTEUDO_SECRETO_QUE_NAO_DEVE_APARECER_NO_RECIBO_12345'

        await adapter.callTool('create_buildx_session', { sessionId })
        const appendRes = await adapter.callTool('append_buildx_session_entry', {
          sessionId, entryId, kind: 'EVIDENCE', title: 'Prova de pureza', body: secretBody
        })
        expect(appendRes.isError).toBeFalsy()
        const receipt = textContent(appendRes.content[0])

        // Recibo não pode conter o body
        expect(receipt).not.toContain(secretBody)
        expect(receipt).not.toContain('SECRETO')
        // Recibo não revela paths internos
        expect(receipt).not.toContain(tempBaseDir)
        expect(receipt).not.toContain('.db')

        // Store tem a entrada com body intacto
        const stored = service.getEntry(repoId, sessionId, entryId)
        expect(stored!.body).toBe(secretBody)

        service.close()
      })
    })
  })

  describe('BuildX UnitFlow-01 — Provas Mínimas', () => {
    describe('UnitFlow-01 — Prova 1: Migração de banco real SMC v2 com sessão e histórico para v3', () => {
      it('migra banco v2 atomicamente, preserva sessões e entradas anteriores, registra plano, sobrevive a restart', () => {
        const repoId = 'repo-v2-migration'
        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        mkdirSync(dirname(dbPath), { recursive: true })

        // 1. Cria manualmente banco v2 com sessão e entradas históricas
        const dbRaw = new Database(dbPath)
        dbRaw.exec(`
          CREATE TABLE smc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO smc_meta (key, value) VALUES ('repository_id', '${repoId}');
          INSERT INTO smc_meta (key, value) VALUES ('schema_version', '2');

          CREATE TABLE smc_sessions (
            session_id TEXT PRIMARY KEY,
            repository_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('OPEN', 'CLOSED')),
            revision INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE smc_entries (
            order_seq INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id TEXT UNIQUE NOT NULL,
            session_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            emitter_role TEXT NOT NULL,
            emitter_id TEXT,
            references_json TEXT,
            supersedes_entry_id TEXT,
            created_at TEXT NOT NULL
          );
        `)

        const legacySessionId = '11111111-2222-3333-4444-555555555555'
        const legacyEntryId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        const now = new Date().toISOString()

        dbRaw.prepare(`
          INSERT INTO smc_sessions (session_id, repository_id, status, revision, created_at, updated_at)
          VALUES (?, ?, 'OPEN', 1, ?, ?)
        `).run(legacySessionId, repoId, now, now)

        dbRaw.prepare(`
          INSERT INTO smc_entries (entry_id, session_id, kind, title, body, emitter_role, emitter_id, references_json, supersedes_entry_id, created_at)
          VALUES (?, ?, 'DECISION', 'Decisão histórica v2', 'Corpo detalhado de decisão v2', 'AGENT', 'arquiteto-v2', null, null, ?)
        `).run(legacyEntryId, legacySessionId, now)

        dbRaw.close()

        // 2. Abre com o novo UnitFlowService / SessionMemoryCentralStore
        const smc = new SessionMemoryCentralService(tempBaseDir)
        const unitFlow = new UnitFlowService(smc)

        // Força abertura e migração do Store para o repositório
        const store = smc.getStore(repoId)
        expect(store.isOpen()).toBe(true)

        // Verifica que schema foi promovido a v3
        const checkDb = new Database(dbPath)
        const versionRow = checkDb.prepare('SELECT value FROM smc_meta WHERE key = ?').get('schema_version') as { value: string }
        expect(versionRow.value).toBe('3')
        checkDb.close()

        // 3. Registra plano ativo
        const planId = '99999999-8888-7777-6666-555555555555'
        const plan = unitFlow.registerPlan(repoId, legacySessionId, {
          planId,
          title: 'Plano migrado v3',
          sourceArtifactId: 'artifact-plan-v3'
        })

        expect(plan.planId).toBe(planId)
        expect(plan.sessionId).toBe(legacySessionId)
        expect(plan.repositoryId).toBe(repoId)
        expect(plan.title).toBe('Plano migrado v3')
        expect(plan.sourceArtifactId).toBe('artifact-plan-v3')
        expect(plan.status).toBe('ACTIVE')
        expect(plan.revision).toBe(1)

        // 4. Fecha e reabre store
        smc.close()

        const reopenedSmc = new SessionMemoryCentralService(tempBaseDir)
        const reopenedUnitFlow = new UnitFlowService(reopenedSmc)

        // Recupera o mesmo plano
        const activePlan = reopenedUnitFlow.getActivePlan(repoId, legacySessionId)
        expect(activePlan).not.toBeNull()
        expect(activePlan!.planId).toBe(planId)
        expect(activePlan!.title).toBe('Plano migrado v3')
        expect(activePlan!.sourceArtifactId).toBe('artifact-plan-v3')
        expect(activePlan!.status).toBe('ACTIVE')
        expect(activePlan!.revision).toBe(1)

        // Memória anterior SMC v2 está intacta
        const historicEntry = reopenedSmc.getEntry(repoId, legacySessionId, legacyEntryId)
        expect(historicEntry).not.toBeNull()
        expect(historicEntry!.title).toBe('Decisão histórica v2')
        expect(historicEntry!.body).toBe('Corpo detalhado de decisão v2')
        expect(historicEntry!.kind).toBe('DECISION')

        const session = reopenedSmc.getSession(repoId, legacySessionId)
        expect(session).not.toBeNull()
        expect(session!.status).toBe('OPEN')

        reopenedUnitFlow.close()
        reopenedSmc.close()
      })
    })

    describe('UnitFlow-01 — Prova 2: Replay, divergência, segundo plano ativo e concorrência entre instâncias', () => {
      it('replays idênticos retornam o plano sem duplicar ou alterar revisão', () => {
        const repoId = 'repo-replay'
        const smc = new SessionMemoryCentralService(tempBaseDir)
        const unitFlow = new UnitFlowService(smc)
        const session = smc.createSession(repoId)

        const planId = '11111111-1111-4111-8111-111111111111'
        const first = unitFlow.registerPlan(repoId, session.sessionId, {
          planId,
          title: 'Meu Plano Inicial',
          sourceArtifactId: 'artifact-001'
        })
        expect(first.status).toBe('ACTIVE')
        expect(first.revision).toBe(1)

        // Replay exato
        const second = unitFlow.registerPlan(repoId, session.sessionId, {
          planId,
          title: 'Meu Plano Inicial',
          sourceArtifactId: 'artifact-001'
        })
        expect(second.planId).toBe(first.planId)
        expect(second.revision).toBe(1)
        expect(second.createdAt).toBe(first.createdAt)
        expect(second.updatedAt).toBe(first.updatedAt)

        // Confirma no banco que só existe 1 registro
        const db = new Database(smcDatabasePath(tempBaseDir, repoId))
        const countRow = db.prepare('SELECT count(*) as total FROM smc_plans WHERE session_id = ?').get(session.sessionId) as { total: number }
        expect(countRow.total).toBe(1)
        db.close()

        smc.close()
      })

      it('rejeita com conflito quando mesmo planId diverge em título ou sourceArtifactId', () => {
        const repoId = 'repo-divergence'
        const smc = new SessionMemoryCentralService(tempBaseDir)
        const unitFlow = new UnitFlowService(smc)
        const session = smc.createSession(repoId)

        const planId = '22222222-2222-4222-8222-222222222222'
        unitFlow.registerPlan(repoId, session.sessionId, {
          planId,
          title: 'Título Original',
          sourceArtifactId: 'artifact-abc'
        })

        // Divergência de título
        expect(() => {
          unitFlow.registerPlan(repoId, session.sessionId, {
            planId,
            title: 'Título Alterado',
            sourceArtifactId: 'artifact-abc'
          })
        }).toThrow(UnitFlowPlanConflictError)

        // Divergência de sourceArtifactId
        expect(() => {
          unitFlow.registerPlan(repoId, session.sessionId, {
            planId,
            title: 'Título Original',
            sourceArtifactId: 'artifact-outro'
          })
        }).toThrow(UnitFlowPlanConflictError)

        // Verifica que o plano no banco permaneceu inalterado
        const current = unitFlow.getActivePlan(repoId, session.sessionId)
        expect(current!.title).toBe('Título Original')
        expect(current!.sourceArtifactId).toBe('artifact-abc')

        smc.close()
      })

      it('rejeita tentativa de segundo plano ativo enquanto o atual estiver ACTIVE', () => {
        const repoId = 'repo-second-active'
        const smc = new SessionMemoryCentralService(tempBaseDir)
        const unitFlow = new UnitFlowService(smc)
        const session = smc.createSession(repoId)

        const plan1Id = '33333333-3333-4333-8333-333333333333'
        const plan2Id = '44444444-4444-4444-8444-444444444444'

        unitFlow.registerPlan(repoId, session.sessionId, {
          planId: plan1Id,
          title: 'Primeiro Plano'
        })

        // Tenta registrar segundo plano ativo na mesma sessão
        expect(() => {
          unitFlow.registerPlan(repoId, session.sessionId, {
            planId: plan2Id,
            title: 'Segundo Plano'
          })
        }).toThrow(UnitFlowActivePlanAlreadyExistsError)

        // Confirma que apenas o primeiro permanece
        const active = unitFlow.getActivePlan(repoId, session.sessionId)
        expect(active!.planId).toBe(plan1Id)

        smc.close()
      })

      it('impõe atomicamente "um ativo por sessão" entre duas instâncias concorrentes do Store', () => {
        const repoId = 'repo-store-concurrency'
        const dbPath = smcDatabasePath(tempBaseDir, repoId)

        // Inicializa store 1 e cria sessão
        const store1 = new SessionMemoryCentralStore(dbPath, repoId)
        const session = store1.createSession()

        // Abre store 2 apontando para o mesmo banco
        const store2 = new SessionMemoryCentralStore(dbPath, repoId)

        const planA = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
        const planB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

        // Store 1 registra Plano A
        const regA = store1.registerPlan(session.sessionId, {
          planId: planA,
          title: 'Plano da Instância 1'
        })
        expect(regA.status).toBe('ACTIVE')

        // Store 2 tenta registrar Plano B na mesma sessão
        expect(() => {
          store2.registerPlan(session.sessionId, {
            planId: planB,
            title: 'Plano da Instância 2'
          })
        }).toThrow(UnitFlowActivePlanAlreadyExistsError)

        // Verifica que o plano ativo no banco é exclusivamente o Plano A
        const active1 = store1.getActivePlan(session.sessionId)
        const active2 = store2.getActivePlan(session.sessionId)
        expect(active1!.planId).toBe(planA)
        expect(active2!.planId).toBe(planA)

        store1.close()
        store2.close()
      })
    })

    describe('UnitFlow-01 — Prova 3: Sessão CLOSED, inexistente, IDs inválidos, isolamento A/B e fail-closed', () => {
      it('rejeita registro em sessão CLOSED ou inexistente', () => {
        const repoId = 'repo-closed-and-missing'
        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const store = new SessionMemoryCentralStore(dbPath, repoId)

        const session = store.createSession()

        // Fecha a sessão diretamente no banco
        const db = new Database(dbPath)
        db.prepare("UPDATE smc_sessions SET status = 'CLOSED' WHERE session_id = ?").run(session.sessionId)
        db.close()

        const planId = '55555555-5555-4555-8555-555555555555'

        // Registro em sessão CLOSED falha
        expect(() => {
          store.registerPlan(session.sessionId, {
            planId,
            title: 'Plano em Sessão Fechada'
          })
        }).toThrow(SmcSessionClosedError)

        // Registro em sessão inexistente falha
        const missingSessionId = '00000000-0000-4000-8000-000000000000'
        expect(() => {
          store.registerPlan(missingSessionId, {
            planId,
            title: 'Plano em Sessão Inexistente'
          })
        }).toThrow(SmcSessionNotFoundError)

        store.close()
      })

      it('valida formatos de planId, title, sourceArtifactId e sessionId', () => {
        const repoId = 'repo-validation-rules'
        const smc = new SessionMemoryCentralService(tempBaseDir)
        const unitFlow = new UnitFlowService(smc)
        const session = smc.createSession(repoId)

        const validPlanId = '66666666-6666-4666-8666-666666666666'

        // planId inválido
        expect(() => {
          unitFlow.registerPlan(repoId, session.sessionId, {
            planId: 'not-a-uuid',
            title: 'Válido'
          })
        }).toThrow(UnitFlowInvalidPlanError)

        // title vazio
        expect(() => {
          unitFlow.registerPlan(repoId, session.sessionId, {
            planId: validPlanId,
            title: '   '
          })
        }).toThrow(UnitFlowInvalidPlanError)

        // title excede tamanho máximo
        expect(() => {
          unitFlow.registerPlan(repoId, session.sessionId, {
            planId: validPlanId,
            title: 'a'.repeat(301)
          })
        }).toThrow(UnitFlowInvalidPlanError)

        // sourceArtifactId vazio quando fornecido
        expect(() => {
          unitFlow.registerPlan(repoId, session.sessionId, {
            planId: validPlanId,
            title: 'Válido',
            sourceArtifactId: '   '
          })
        }).toThrow(UnitFlowInvalidPlanError)

        // sessionId inválido
        expect(() => {
          unitFlow.registerPlan(repoId, 'invalid-session-id', {
            planId: validPlanId,
            title: 'Válido'
          })
        }).toThrow(SmcInvalidSessionIdError)

        smc.close()
      })

      it('isola estritamente repositórios A e B e permite sessões independentes simultâneas', () => {
        const smc = new SessionMemoryCentralService(tempBaseDir)
        const unitFlow = new UnitFlowService(smc)

        const repoA = 'repo-isolation-a'
        const repoB = 'repo-isolation-b'

        const sessionA1 = smc.createSession(repoA)
        const sessionA2 = smc.createSession(repoA)
        const sessionB = smc.createSession(repoB)

        const planA1Id = '77777777-7777-4777-8777-777777777771'
        const planA2Id = '77777777-7777-4777-8777-777777777772'
        const planBId = '77777777-7777-4777-8777-777777777773'

        // Duas sessões independentes no Repo A podem ter planos ativos próprios
        const planA1 = unitFlow.registerPlan(repoA, sessionA1.sessionId, { planId: planA1Id, title: 'Plano A1' })
        const planA2 = unitFlow.registerPlan(repoA, sessionA2.sessionId, { planId: planA2Id, title: 'Plano A2' })

        expect(planA1.status).toBe('ACTIVE')
        expect(planA2.status).toBe('ACTIVE')
        expect(unitFlow.getActivePlan(repoA, sessionA1.sessionId)?.planId).toBe(planA1Id)
        expect(unitFlow.getActivePlan(repoA, sessionA2.sessionId)?.planId).toBe(planA2Id)

        // Sessão do Repo B
        unitFlow.registerPlan(repoB, sessionB.sessionId, { planId: planBId, title: 'Plano B' })
        expect(unitFlow.getActivePlan(repoB, sessionB.sessionId)?.planId).toBe(planBId)

        // Repo B não enxerga plano de Repo A
        expect(unitFlow.getActivePlan(repoB, sessionA1.sessionId)).toBeNull()

        // Tentativa de registrar em Repo B com session de Repo A falha
        expect(() => {
          unitFlow.registerPlan(repoB, sessionA1.sessionId, {
            planId: '88888888-8888-4888-8888-888888888888',
            title: 'Plano Cruzado'
          })
        }).toThrow(SmcSessionNotFoundError)

        smc.close()
      })

      it('falha fechado para repositoryId inválido sem fallback ao host', () => {
        const unitFlow = new UnitFlowService(tempBaseDir)
        expect(() => {
          unitFlow.registerPlan('../bad-path', '11111111-1111-4111-8111-111111111111', {
            planId: '22222222-2222-4222-8222-222222222222',
            title: 'Test'
          })
        }).toThrow()

        expect(() => {
          unitFlow.getActivePlan('', '11111111-1111-4111-8111-111111111111')
        }).toThrow()

        unitFlow.close()
      })
    })

    describe('UnitFlow-01 — Prova 4: Consulta compacta, schema futuro e migração repetida', () => {
      it('getActivePlan retorna apenas metadados compactos sem carregar transcrições, Continuum ou corpo de entradas', () => {
        const repoId = 'repo-compact-query'
        const smc = new SessionMemoryCentralService(tempBaseDir)
        const unitFlow = new UnitFlowService(smc)
        const session = smc.createSession(repoId)

        // Adiciona entradas pesadas no SMC
        smc.appendEntry(repoId, session.sessionId, {
          kind: 'DECISION',
          title: 'Decisão volumosa',
          body: 'x'.repeat(50000),
          provenance: { role: 'AGENT' }
        })

        const planId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
        unitFlow.registerPlan(repoId, session.sessionId, {
          planId,
          title: 'Plano Compacto',
          sourceArtifactId: 'artifact-ref-only'
        })

        const plan = unitFlow.getActivePlan(repoId, session.sessionId)
        expect(plan).not.toBeNull()

        // Contrato compacto
        const keys = Object.keys(plan!).sort()
        expect(keys).toEqual([
          'createdAt',
          'planId',
          'repositoryId',
          'revision',
          'sessionId',
          'sourceArtifactId',
          'status',
          'title',
          'updatedAt'
        ].sort())

        // Não contém body ou dados da SMC
        expect((plan as any).body).toBeUndefined()
        expect((plan as any).entries).toBeUndefined()

        smc.close()
      })

      it('retorna null quando sessão não possui plano ativo', () => {
        const repoId = 'repo-no-active'
        const smc = new SessionMemoryCentralService(tempBaseDir)
        const unitFlow = new UnitFlowService(smc)
        const session = smc.createSession(repoId)

        expect(unitFlow.getActivePlan(repoId, session.sessionId)).toBeNull()
        expect(unitFlow.getActivePlan(repoId, '00000000-0000-4000-8000-000000000000')).toBeNull()

        smc.close()
      })

      it('recusa schema futuro (> 3) com SmcUnsupportedSchemaError sem corromper dados', () => {
        const repoId = 'repo-future-schema'
        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        mkdirSync(dirname(dbPath), { recursive: true })

        const dbRaw = new Database(dbPath)
        dbRaw.exec(`
          CREATE TABLE smc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO smc_meta (key, value) VALUES ('repository_id', '${repoId}');
          INSERT INTO smc_meta (key, value) VALUES ('schema_version', '4');
        `)
        dbRaw.close()

        expect(() => {
          new SessionMemoryCentralStore(dbPath, repoId)
        }).toThrow(SmcUnsupportedSchemaError)

        // Verifica que o schema_version não foi alterado
        const checkDb = new Database(dbPath)
        const row = checkDb.prepare('SELECT value FROM smc_meta WHERE key = ?').get('schema_version') as { value: string }
        expect(row.value).toBe('4')
        checkDb.close()
      })

      it('migração repetida é idempotente e preserva dados', () => {
        const repoId = 'repo-repeat-migration'
        const unitFlow1 = new UnitFlowService(tempBaseDir)
        const smc1 = new SessionMemoryCentralService(tempBaseDir)
        const session = smc1.createSession(repoId)
        const planId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

        unitFlow1.registerPlan(repoId, session.sessionId, {
          planId,
          title: 'Plano Repetido'
        })
        unitFlow1.close()
        smc1.close()

        // Abre novamente
        const unitFlow2 = new UnitFlowService(tempBaseDir)
        const recovered = unitFlow2.getActivePlan(repoId, session.sessionId)
        expect(recovered?.planId).toBe(planId)
        unitFlow2.close()
      })
    })
  })
})
})

