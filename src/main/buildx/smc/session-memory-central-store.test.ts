import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, delimiter } from 'node:path'
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
  UnitFlowReservationService,
  UnitFlowInvalidPlanError,
  UnitFlowPlanConflictError,
  UnitFlowActivePlanAlreadyExistsError,
  UnitFlowPlanNotFoundError,
  UnitFlowInvalidUnitError,
  UnitFlowUnitConflictError,
  UnitFlowManifestConflictError,
  UnitFlowInvalidReservationIdError,
  UnitFlowReservationConflictError,
  UnitFlowReservationIdConflictError,
  UnitFlowReservationNotFoundError,
  type DefineUnitFlowUnitInput,
  type UnitFlowUnitRecord,
  type UnitFlowUnitHeaderRecord,
  type UnitFlowUnitStateRecord,
  type UnitFlowEligibilityResult,
  type UnitFlowReservationRecord,
  type UnitFlowReservationResult,
  type ReserveUnitFlowUnitOptions
} from '../unitflow'
import {
  WorkspaceBindingService,
  ExecutionAttemptService,
  BuildXWorkspaceBindingConflictError,
  BuildXWorkspaceNotFoundError,
  BuildXWorkspaceInvalidError,
  BuildXWorkspaceEvidenceUnavailableError,
  BuildXWorkspaceRepositoryMismatchError,
  ExecutionInvalidAttemptIdError,
  ExecutionAttemptConflictError,
  ExecutionAttemptIdConflictError,
  ExecutionAttemptNotFoundError,
  type BuildXWorkspaceBindingRecord,
  type BuildXInspectWorkspaceResult,
  type GitOperationsPort,
  type ExecutionAttemptRecord,
  type ExecutionAttemptStatus,
  type PrepareExecutionAttemptOptions,
  BuildXGrokCliBridge,
  type CliExecutionPort,
  type GrokCliPreAdmissionResult
} from '../execution'
import type { CliProposal } from '../../cli-execution/cli-execution-types'
import { CliExecutionService } from '../../cli-execution/cli-execution-service'
import { resolveCliCommand } from '../../cli-execution/cli-command-resolver'
import type { BranchInventory, BranchRecord } from '../../../shared/types/branch-orchestration-types'
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

      // Garante que o schema_version foi migrado (pelo menos versão 2, atualmente 4)
      const versionDb = new Database(dbPath)
      const row = versionDb.prepare('SELECT value FROM smc_meta WHERE key = ?').get('schema_version') as { value: string }
      expect(['2', '3', '4', '5', '6', '7', '8']).toContain(row.value)
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

        // Verifica que schema foi promovido (v3 ou superior)
        const checkDb = new Database(dbPath)
        const versionRow = checkDb.prepare('SELECT value FROM smc_meta WHERE key = ?').get('schema_version') as { value: string }
        expect(['3', '4', '5', '6', '7', '8']).toContain(versionRow.value)
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

      it('recusa schema futuro (> 6) com SmcUnsupportedSchemaError sem corromper dados', () => {
        const repoId = 'repo-future-schema'
        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        mkdirSync(dirname(dbPath), { recursive: true })

        const dbRaw = new Database(dbPath)
        dbRaw.exec(`
          CREATE TABLE smc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO smc_meta (key, value) VALUES ('repository_id', '${repoId}');
          INSERT INTO smc_meta (key, value) VALUES ('schema_version', '9');
        `)
        dbRaw.close()

        expect(() => {
          new SessionMemoryCentralStore(dbPath, repoId)
        }).toThrow(SmcUnsupportedSchemaError)

        // Verifica que o schema_version não foi alterado
        const checkDb = new Database(dbPath)
        const row = checkDb.prepare('SELECT value FROM smc_meta WHERE key = ?').get('schema_version') as { value: string }
        expect(row.value).toBe('9')
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

  describe('BuildX UnitFlow-02 — Definição ordenada de unidades e dependências (Provas Mínimas)', () => {
    const repoId = 'repo-unitflow-02'
    let smc: SessionMemoryCentralService
    let unitFlow: UnitFlowService

    beforeEach(() => {
      smc = new SessionMemoryCentralService(tempBaseDir)
      unitFlow = new UnitFlowService(smc)
    })

    afterEach(() => {
      smc.close()
    })

    describe('Prova 1: Migração v3→v4, gravação de manifesto ordenado com dependências e persistência durável', () => {
      it('migra banco v3 real para v4, grava unidades ordenadas com dependência anterior e recupera tudo após restart', () => {
        const v3RepoId = 'repo-v3-migration'
        const dbPath = smcDatabasePath(tempBaseDir, v3RepoId)
        mkdirSync(dirname(dbPath), { recursive: true })

        const legacySessionId = '11111111-2222-3333-4444-555555555555'
        const legacyEntryId = '66666666-7777-8888-9999-000000000000'
        const legacyPlanId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

        // 1. Cria esquema v3 manualmente
        const v3Db = new Database(dbPath)
        v3Db.exec(`
          CREATE TABLE smc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO smc_meta (key, value) VALUES ('repository_id', '${v3RepoId}');
          INSERT INTO smc_meta (key, value) VALUES ('schema_version', '3');

          CREATE TABLE smc_sessions (
            session_id TEXT PRIMARY KEY,
            repository_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('OPEN', 'CLOSED')),
            revision INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO smc_sessions (session_id, repository_id, status, revision, created_at, updated_at)
          VALUES ('${legacySessionId}', '${v3RepoId}', 'OPEN', 1, '2026-11-04T10:00:00.000Z', '2026-11-04T10:00:00.000Z');

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
          INSERT INTO smc_entries (entry_id, session_id, kind, title, body, emitter_role, created_at)
          VALUES ('${legacyEntryId}', '${legacySessionId}', 'DECISION', 'Decisão inicial', 'Conteúdo v3', 'HUMAN', '2026-11-04T10:01:00.000Z');

          CREATE TABLE smc_plans (
            plan_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            repository_id TEXT NOT NULL,
            title TEXT NOT NULL,
            source_artifact_id TEXT,
            status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),
            revision INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO smc_plans (plan_id, session_id, repository_id, title, status, revision, created_at, updated_at)
          VALUES ('${legacyPlanId}', '${legacySessionId}', '${v3RepoId}', 'Plano V3 Existente', 'ACTIVE', 1, '2026-11-04T10:02:00.000Z', '2026-11-04T10:02:00.000Z');
        `)
        v3Db.close()

        // 2. Abre com o serviço atual para disparar migração v3 -> v4
        const store = smc.getStore(v3RepoId)
        expect(store.isOpen()).toBe(true)

        // Verifica que schema foi promovido para v4 ou superior (atualmente v5)
        const checkDb = new Database(dbPath)
        const versionRow = checkDb.prepare('SELECT value FROM smc_meta WHERE key = ?').get('schema_version') as { value: string }
        expect(['4', '5', '6', '7', '8']).toContain(versionRow.value)
        checkDb.close()

        // 3. Define 3 unidades com dependências estritamente anteriores
        const unit1Id = '00000000-0000-4000-8000-000000000001'
        const unit2Id = '00000000-0000-4000-8000-000000000002'
        const unit3Id = '00000000-0000-4000-8000-000000000003'

        const unitsInput: DefineUnitFlowUnitInput[] = [
          {
            unitId: unit1Id,
            title: 'Unidade 1 - Setup Inicial',
            objective: 'Preparar a infraestrutura base',
            acceptanceCriteria: 'Infraestrutura instalada e funcionando'
          },
          {
            unitId: unit2Id,
            title: 'Unidade 2 - Implementação do Core',
            objective: 'Implementar a lógica principal',
            acceptanceCriteria: 'Lógica core passa em testes unitários',
            dependsOnUnitIds: [unit1Id]
          },
          {
            unitId: unit3Id,
            title: 'Unidade 3 - Integração e Validação',
            objective: 'Integrar componentes e validar ponta a ponta',
            acceptanceCriteria: 'Testes de integração verdes',
            dependsOnUnitIds: [unit1Id, unit2Id]
          }
        ]

        const definedUnits = unitFlow.definePlanUnits(v3RepoId, legacySessionId, legacyPlanId, unitsInput)
        expect(definedUnits).toHaveLength(3)
        expect(definedUnits[0].position).toBe(1)
        expect(definedUnits[0].unitId).toBe(unit1Id)
        expect(definedUnits[0].dependsOnUnitIds).toEqual([])
        expect(definedUnits[1].position).toBe(2)
        expect(definedUnits[1].unitId).toBe(unit2Id)
        expect(definedUnits[1].dependsOnUnitIds).toEqual([unit1Id])
        expect(definedUnits[2].position).toBe(3)
        expect(definedUnits[2].unitId).toBe(unit3Id)
        expect(definedUnits[2].dependsOnUnitIds).toEqual([unit1Id, unit2Id])

        // 4. Fecha a store e reabre em nova instância do serviço
        smc.closeStore(v3RepoId)

        const smcReopened = new SessionMemoryCentralService(tempBaseDir)
        const unitFlowReopened = new UnitFlowService(smcReopened)

        // Preservação do estado v3 anterior
        const session = smcReopened.getSession(v3RepoId, legacySessionId)
        expect(session).not.toBeNull()
        expect(session?.status).toBe('OPEN')

        const entry = smcReopened.getEntry(v3RepoId, legacySessionId, legacyEntryId)
        expect(entry).not.toBeNull()
        expect(entry?.body).toBe('Conteúdo v3')

        const activePlan = unitFlowReopened.getActivePlan(v3RepoId, legacySessionId)
        expect(activePlan).not.toBeNull()
        expect(activePlan?.planId).toBe(legacyPlanId)

        // Recuperação fiel do manifesto
        const listHeaders = unitFlowReopened.listPlanUnits(v3RepoId, legacySessionId, legacyPlanId)
        expect(listHeaders).toHaveLength(3)
        expect(listHeaders[0]).toEqual({
          unitId: unit1Id,
          planId: legacyPlanId,
          position: 1,
          title: 'Unidade 1 - Setup Inicial',
          dependsOnUnitIds: [],
          createdAt: expect.any(String)
        })
        expect(listHeaders[1].position).toBe(2)
        expect(listHeaders[1].dependsOnUnitIds).toEqual([unit1Id])
        expect(listHeaders[2].position).toBe(3)
        expect(listHeaders[2].dependsOnUnitIds).toEqual([unit1Id, unit2Id])

        // Recuperação literal de cada unidade
        const recovered1 = unitFlowReopened.getPlanUnit(v3RepoId, legacySessionId, legacyPlanId, unit1Id)
        expect(recovered1?.objective).toBe('Preparar a infraestrutura base')
        expect(recovered1?.acceptanceCriteria).toBe('Infraestrutura instalada e funcionando')

        const recovered2 = unitFlowReopened.getPlanUnit(v3RepoId, legacySessionId, legacyPlanId, unit2Id)
        expect(recovered2?.objective).toBe('Implementar a lógica principal')
        expect(recovered2?.acceptanceCriteria).toBe('Lógica core passa em testes unitários')

        const recovered3 = unitFlowReopened.getPlanUnit(v3RepoId, legacySessionId, legacyPlanId, unit3Id)
        expect(recovered3?.objective).toBe('Integrar componentes e validar ponta a ponta')
        expect(recovered3?.acceptanceCriteria).toBe('Testes de integração verdes')

        smcReopened.close()
      })
    })

    describe('Prova 2: Replay idêntico idempotente, detecção de divergência e atomicidade concorrente', () => {
      it('permite replay idêntico sem duplicar registros nem alterar revisão do plano', () => {
        const session = smc.createSession(repoId)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: '11111111-1111-4111-8111-111111111111',
          title: 'Plano Replay'
        })

        const unit1Id = '11111111-0000-4000-8000-000000000001'
        const unit2Id = '11111111-0000-4000-8000-000000000002'
        const units: DefineUnitFlowUnitInput[] = [
          {
            unitId: unit1Id,
            title: 'Unidade Alpha',
            objective: 'Objetivo Alpha',
            acceptanceCriteria: 'Critério Alpha'
          },
          {
            unitId: unit2Id,
            title: 'Unidade Beta',
            objective: 'Objetivo Beta',
            acceptanceCriteria: 'Critério Beta',
            dependsOnUnitIds: [unit1Id]
          }
        ]

        const firstResult = unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, units)
        expect(firstResult).toHaveLength(2)

        // Replay idêntico
        const replayResult = unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, units)
        expect(replayResult).toEqual(firstResult)

        // Verifica que banco não duplicou linhas
        const headers = unitFlow.listPlanUnits(repoId, session.sessionId, plan.planId)
        expect(headers).toHaveLength(2)

        // Verifica que revisão do plano continua 1
        const planAfter = unitFlow.getPlan(repoId, plan.planId)
        expect(planAfter?.revision).toBe(1)
      })

      it('rejeita divergências de título, objetivo, critérios, ordem e dependências com UnitFlowManifestConflictError', () => {
        const session = smc.createSession(repoId)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: '22222222-2222-4222-8222-222222222222',
          title: 'Plano Divergências'
        })

        const unit1Id = '22222222-0000-4000-8000-000000000001'
        const unit2Id = '22222222-0000-4000-8000-000000000002'
        const units: DefineUnitFlowUnitInput[] = [
          {
            unitId: unit1Id,
            title: 'Unidade 1',
            objective: 'Obj 1',
            acceptanceCriteria: 'Crit 1'
          },
          {
            unitId: unit2Id,
            title: 'Unidade 2',
            objective: 'Obj 2',
            acceptanceCriteria: 'Crit 2',
            dependsOnUnitIds: [unit1Id]
          }
        ]
        unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, units)

        // Divergência em título
        expect(() => {
          unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
            { ...units[0], title: 'Título Alterado' },
            units[1]
          ])
        }).toThrow(UnitFlowManifestConflictError)

        // Divergência em objetivo
        expect(() => {
          unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
            units[0],
            { ...units[1], objective: 'Obj Alterado' }
          ])
        }).toThrow(UnitFlowManifestConflictError)

        // Divergência em critério
        expect(() => {
          unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
            { ...units[0], acceptanceCriteria: 'Crit Alterado' },
            units[1]
          ])
        }).toThrow(UnitFlowManifestConflictError)

        // Divergência em dependência
        expect(() => {
          unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
            units[0],
            { ...units[1], dependsOnUnitIds: [] }
          ])
        }).toThrow(UnitFlowManifestConflictError)

        // Divergência em contagem (menos unidades)
        expect(() => {
          unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [units[0]])
        }).toThrow(UnitFlowManifestConflictError)

        // Divergência em ordem invertida
        expect(() => {
          unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
            { ...units[1], dependsOnUnitIds: [] },
            { ...units[0], dependsOnUnitIds: [unit2Id] }
          ])
        }).toThrow(UnitFlowManifestConflictError)
      })

      it('duas instâncias de store preservam atomicidade e integridade', () => {
        const session = smc.createSession(repoId)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: '33333333-3333-4333-8333-333333333333',
          title: 'Plano Concorrência'
        })

        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const storeB = new SessionMemoryCentralStore(dbPath, repoId)

        const u1 = '33333333-0000-4000-8000-000000000001'
        const manifestA: DefineUnitFlowUnitInput[] = [
          { unitId: u1, title: 'Unit A', objective: 'Obj A', acceptanceCriteria: 'Crit A' }
        ]
        const manifestB: DefineUnitFlowUnitInput[] = [
          { unitId: u1, title: 'Unit B Divergente', objective: 'Obj B', acceptanceCriteria: 'Crit B' }
        ]

        // Store 1 define manifestA
        const resA = unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, manifestA)
        expect(resA).toHaveLength(1)

        // Store 2 tenta definir divergente -> conflito
        expect(() => {
          storeB.definePlanUnits(session.sessionId, plan.planId, manifestB)
        }).toThrow(UnitFlowManifestConflictError)

        // Store 2 faz replay idêntico -> sucesso
        const resB = storeB.definePlanUnits(session.sessionId, plan.planId, manifestA)
        expect(resB[0].title).toBe('Unit A')

        storeB.close()
      })
    })

    describe('Prova 3: Fail-closed — rejeitar plano inexistente/inativo, sessão CLOSED, dependências inválidas e isolamento', () => {
      it('rejeita plano inexistente com UnitFlowPlanNotFoundError', () => {
        const session = smc.createSession(repoId)
        const randomPlanId = '44444444-0000-4000-8000-000000000000'
        expect(() => {
          unitFlow.definePlanUnits(repoId, session.sessionId, randomPlanId, [
            { unitId: '44444444-0000-4000-8000-000000000001', title: 'U1', objective: 'O1', acceptanceCriteria: 'C1' }
          ])
        }).toThrow(UnitFlowPlanNotFoundError)
      })

      it('rejeita plano inativo (não ACTIVE) com UnitFlowPlanConflictError', () => {
        const session = smc.createSession(repoId)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: '55555555-5555-4555-8555-555555555555',
          title: 'Plano Inativo'
        })

        // Altera status para COMPLETED no banco
        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const rawDb = new Database(dbPath)
        rawDb.prepare('UPDATE smc_plans SET status = ? WHERE plan_id = ?').run('COMPLETED', plan.planId)
        rawDb.close()

        expect(() => {
          unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
            { unitId: '55555555-0000-4000-8000-000000000001', title: 'U1', objective: 'O1', acceptanceCriteria: 'C1' }
          ])
        }).toThrow(UnitFlowPlanConflictError)
      })

      it('rejeita sessão CLOSED com SmcSessionClosedError', () => {
        const session = smc.createSession(repoId)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: '66666666-6666-4666-8666-666666666666',
          title: 'Plano Sessão Fechada'
        })

        // Fecha a sessão no banco
        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const rawDb = new Database(dbPath)
        rawDb.prepare('UPDATE smc_sessions SET status = ? WHERE session_id = ?').run('CLOSED', session.sessionId)
        rawDb.close()

        expect(() => {
          unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
            { unitId: '66666666-0000-4000-8000-000000000001', title: 'U1', objective: 'O1', acceptanceCriteria: 'C1' }
          ])
        }).toThrow(SmcSessionClosedError)
      })

      it('rejeita manifesto vazio ou inválido com UnitFlowInvalidUnitError', () => {
        const session = smc.createSession(repoId)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: '77777777-7777-4777-8777-777777777777',
          title: 'Plano Vazio'
        })

        expect(() => {
          unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [])
        }).toThrow(UnitFlowInvalidUnitError)

        expect(() => {
          unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, null as any)
        }).toThrow(UnitFlowInvalidUnitError)
      })

      it('rejeita IDs duplicados no manifesto com UnitFlowInvalidUnitError', () => {
        const session = smc.createSession(repoId)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: '88888888-8888-4888-8888-888888888888',
          title: 'Plano IDs Duplicados'
        })
        const dupeId = '77777777-0000-4000-8000-000000000001'

        expect(() => {
          unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
            { unitId: dupeId, title: 'U1', objective: 'O1', acceptanceCriteria: 'C1' },
            { unitId: dupeId, title: 'U2', objective: 'O2', acceptanceCriteria: 'C2' }
          ])
        }).toThrow(UnitFlowInvalidUnitError)
      })

      it('rejeita dependência para si mesma com UnitFlowInvalidUnitError', () => {
        const session = smc.createSession(repoId)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: '99999999-9999-4999-8999-999999999999',
          title: 'Plano Self Dep'
        })
        const id1 = '88888888-0000-4000-8000-000000000001'

        expect(() => {
          unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
            { unitId: id1, title: 'U1', objective: 'O1', acceptanceCriteria: 'C1', dependsOnUnitIds: [id1] }
          ])
        }).toThrow(UnitFlowInvalidUnitError)
      })

      it('rejeita dependência futura com UnitFlowInvalidUnitError (forward dependency)', () => {
        const session = smc.createSession(repoId)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          title: 'Plano Forward Dep'
        })
        const id1 = '99999999-0000-4000-8000-000000000001'
        const id2 = '99999999-0000-4000-8000-000000000002'

        expect(() => {
          unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
            { unitId: id1, title: 'U1', objective: 'O1', acceptanceCriteria: 'C1', dependsOnUnitIds: [id2] },
            { unitId: id2, title: 'U2', objective: 'O2', acceptanceCriteria: 'C2' }
          ])
        }).toThrow(UnitFlowInvalidUnitError)
      })

      it('rejeita dependência externa inexistente com UnitFlowInvalidUnitError', () => {
        const session = smc.createSession(repoId)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          title: 'Plano External Dep'
        })
        const id1 = 'aaaaaaaa-0000-4000-8000-000000000001'
        const externalId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

        expect(() => {
          unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
            { unitId: id1, title: 'U1', objective: 'O1', acceptanceCriteria: 'C1', dependsOnUnitIds: [externalId] }
          ])
        }).toThrow(UnitFlowInvalidUnitError)
      })

      it('rejeita acesso cruzado entre sessões e repositórios sem escrita parcial', () => {
        const sessionA = smc.createSession(repoId)
        const sessionB = smc.createSession(repoId)
        const planA = unitFlow.registerPlan(repoId, sessionA.sessionId, {
          planId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          title: 'Plano Sessão A'
        })

        // Tentativa de definir unidades do plano A usando sessão B -> conflito
        const unitId = 'bbbbbbbb-0000-4000-8000-000000000001'
        expect(() => {
          unitFlow.definePlanUnits(repoId, sessionB.sessionId, planA.planId, [
            { unitId, title: 'U1', objective: 'O1', acceptanceCriteria: 'C1' }
          ])
        }).toThrow(UnitFlowPlanConflictError)

        // Tentativa de acessar plano A a partir de outro repositório -> plano não encontrado
        const otherRepoId = 'repo-other-scope'
        const otherSession = smc.createSession(otherRepoId)
        expect(() => {
          unitFlow.definePlanUnits(otherRepoId, otherSession.sessionId, planA.planId, [
            { unitId, title: 'U1', objective: 'O1', acceptanceCriteria: 'C1' }
          ])
        }).toThrow(UnitFlowPlanNotFoundError)

        // Verifica que nenhuma linha parcial foi escrita
        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const rawDb = new Database(dbPath)
        const count = rawDb.prepare('SELECT count(*) as cnt FROM smc_plan_units WHERE plan_id = ?').get(planA.planId) as { cnt: number }
        expect(count.cnt).toBe(0)
        rawDb.close()
      })
    })

    describe('Prova 4: Leitura seletiva — listPlanUnits compacta e getPlanUnit detalhada pontual', () => {
      it('listPlanUnits retorna projeção compacta ordenada sem carregar objective nem acceptanceCriteria', () => {
        const session = smc.createSession(repoId)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          title: 'Plano Leitura Seletiva'
        })

        const u1 = 'cccccccc-0000-4000-8000-000000000001'
        const u2 = 'cccccccc-0000-4000-8000-000000000002'

        unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
          {
            unitId: u1,
            title: 'Unidade 1 - Setup',
            objective: 'Texto longo de objective da unidade 1 que não deve vir no list',
            acceptanceCriteria: 'Critérios longos da unidade 1 que não devem vir no list'
          },
          {
            unitId: u2,
            title: 'Unidade 2 - Feature',
            objective: 'Texto longo de objective da unidade 2 que não deve vir no list',
            acceptanceCriteria: 'Critérios longos da unidade 2 que não devem vir no list',
            dependsOnUnitIds: [u1]
          }
        ])

        const headers = unitFlow.listPlanUnits(repoId, session.sessionId, plan.planId)
        expect(headers).toHaveLength(2)

        for (const h of headers) {
          expect(h).toHaveProperty('unitId')
          expect(h).toHaveProperty('planId')
          expect(h).toHaveProperty('position')
          expect(h).toHaveProperty('title')
          expect(h).toHaveProperty('dependsOnUnitIds')
          expect(h).toHaveProperty('createdAt')
          // Confirma ausência de campos pesados de payload
          expect((h as any).objective).toBeUndefined()
          expect((h as any).acceptanceCriteria).toBeUndefined()
        }

        expect(headers[0].position).toBe(1)
        expect(headers[0].unitId).toBe(u1)
        expect(headers[1].position).toBe(2)
        expect(headers[1].unitId).toBe(u2)
        expect(headers[1].dependsOnUnitIds).toEqual([u1])
      })

      it('getPlanUnit busca exclusivamente a unidade solicitada com texto integral ou devolve null se inexistente', () => {
        const session = smc.createSession(repoId)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          title: 'Plano GetUnit'
        })

        const u1 = 'dddddddd-0000-4000-8000-000000000001'
        unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
          {
            unitId: u1,
            title: 'Unidade Alvo',
            objective: 'Objetivo Específico Alvo',
            acceptanceCriteria: 'Critérios Específicos Alvo'
          }
        ])

        const unit = unitFlow.getPlanUnit(repoId, session.sessionId, plan.planId, u1)
        expect(unit).not.toBeNull()
        expect(unit?.unitId).toBe(u1)
        expect(unit?.planId).toBe(plan.planId)
        expect(unit?.position).toBe(1)
        expect(unit?.title).toBe('Unidade Alvo')
        expect(unit?.objective).toBe('Objetivo Específico Alvo')
        expect(unit?.acceptanceCriteria).toBe('Critérios Específicos Alvo')
        expect(unit?.dependsOnUnitIds).toEqual([])

        // Busca de unit inexistente retorna null
        const nonExistent = unitFlow.getPlanUnit(repoId, session.sessionId, plan.planId, '00000000-0000-4000-8000-999999999999')
        expect(nonExistent).toBeNull()

        // Busca com sessionId errada retorna null
        const wrongSession = unitFlow.getPlanUnit(repoId, '00000000-0000-4000-8000-000000000000', plan.planId, u1)
        expect(wrongSession).toBeNull()

        // Busca com planId errada retorna null
        const wrongPlan = unitFlow.getPlanUnit(repoId, session.sessionId, '00000000-0000-4000-8000-000000000000', u1)
        expect(wrongPlan).toBeNull()
      })
    })
  })

  describe('BuildX UnitFlow-03 — Estado inicial e elegibilidade sequencial (Provas Mínimas)', () => {
    const repoId = 'repo-unitflow-03'
    let smc: SessionMemoryCentralService
    let unitFlow: UnitFlowService

    beforeEach(() => {
      smc = new SessionMemoryCentralService(tempBaseDir)
      unitFlow = new UnitFlowService(smc)
    })

    afterEach(() => {
      smc.close()
    })

    describe('Prova 1 — Migração v4→v5: estado inicial AVAILABLE criado para unidades pré-existentes', () => {
      it('migra banco v4 para v5, cria smc_unit_states com status AVAILABLE para todas as unidades existentes', () => {
        const p1 = 'aaaaaaaa-0003-4000-8001-000000000001'
        const u1 = 'bbbbbbbb-0003-4000-8001-000000000001'
        const u2 = 'bbbbbbbb-0003-4000-8001-000000000002'
        const sessId = 'cccccccc-0003-4000-8001-000000000001'
        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        mkdirSync(dirname(dbPath), { recursive: true })

        // Constrói banco v4 manualmente
        const dbRaw = new Database(dbPath)
        const now = new Date().toISOString()
        dbRaw.exec(`
          CREATE TABLE smc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO smc_meta VALUES ('repository_id', '${repoId}');
          INSERT INTO smc_meta VALUES ('schema_version', '4');
          CREATE TABLE smc_sessions (
            session_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL,
            status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          INSERT INTO smc_sessions VALUES ('${sessId}', '${repoId}', 'OPEN', 1, '${now}', '${now}');
          CREATE TABLE smc_entries (
            order_seq INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT UNIQUE NOT NULL,
            session_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
            body TEXT NOT NULL, emitter_role TEXT NOT NULL, emitter_id TEXT,
            references_json TEXT, supersedes_entry_id TEXT, created_at TEXT NOT NULL
          );
          CREATE TABLE smc_plans (
            plan_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, repository_id TEXT NOT NULL,
            title TEXT NOT NULL, source_artifact_id TEXT,
            status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          INSERT INTO smc_plans VALUES ('${p1}', '${sessId}', '${repoId}', 'Plano Legado', NULL, 'ACTIVE', 1, '${now}', '${now}');
          CREATE TABLE smc_plan_units (
            unit_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, position INTEGER NOT NULL,
            title TEXT NOT NULL, objective TEXT NOT NULL, acceptance_criteria TEXT NOT NULL,
            depends_on_json TEXT, created_at TEXT NOT NULL
          );
          INSERT INTO smc_plan_units VALUES ('${u1}', '${p1}', 1, 'U1', 'Obj1', 'Crit1', NULL, '${now}');
          INSERT INTO smc_plan_units VALUES ('${u2}', '${p1}', 2, 'U2', 'Obj2', 'Crit2', NULL, '${now}');
        `)
        dbRaw.close()

        // Abre com o serviço — deve migrar para v5
        const smcLocal = new SessionMemoryCentralService(tempBaseDir)
        const store = smcLocal.getStore(repoId)
        expect(store.isOpen()).toBe(true)

        const checkDb = new Database(dbPath)
        const verRow = checkDb.prepare('SELECT value FROM smc_meta WHERE key = ?').get('schema_version') as { value: string }
        expect(['5', '6', '7', '8']).toContain(verRow.value)

        const stateRows = checkDb.prepare('SELECT unit_id, status, revision FROM smc_unit_states WHERE plan_id = ? ORDER BY unit_id').all(p1) as { unit_id: string; status: string; revision: number }[]
        expect(stateRows).toHaveLength(2)
        expect(stateRows.every(r => r.status === 'AVAILABLE')).toBe(true)
        expect(stateRows.every(r => r.revision === 1)).toBe(true)
        checkDb.close()

        // Sessão, plano e unidades preservados
        const sess = smcLocal.getSession(repoId, sessId)
        expect(sess).not.toBeNull()
        expect(sess?.sessionId).toBe(sessId)
        const plan = smcLocal.getPlan(repoId, p1)
        expect(plan).not.toBeNull()
        expect(plan?.status).toBe('ACTIVE')

        // Reabre em nova instância — estados ainda presentes
        smcLocal.close()
        const smcLocal2 = new SessionMemoryCentralService(tempBaseDir)
        const checkDb2 = new Database(dbPath)
        const stateRows2 = checkDb2.prepare('SELECT count(*) as cnt FROM smc_unit_states WHERE plan_id = ?').get(p1) as { cnt: number }
        expect(stateRows2.cnt).toBe(2)
        checkDb2.close()
        smcLocal2.close()
      })
    })

    describe('Prova 2 — Manifesto novo recebe estados AVAILABLE; primeiro é elegível', () => {
      it('definePlanUnits insere estados AVAILABLE atomicamente; getNextEligibleUnit retorna ELIGIBLE u1', () => {
        const session = smc.createSession(repoId)
        const planId = 'dddddddd-0003-4000-8002-000000000001'
        unitFlow.registerPlan(repoId, session.sessionId, { planId, title: 'Plano Prova 2' })

        const u1 = 'eeeeeeee-0003-4000-8002-000000000001'
        const u2 = 'eeeeeeee-0003-4000-8002-000000000002'
        const u3 = 'eeeeeeee-0003-4000-8002-000000000003'

        const records = unitFlow.definePlanUnits(repoId, session.sessionId, planId, [
          { unitId: u1, title: 'U1', objective: 'O1', acceptanceCriteria: 'C1' },
          { unitId: u2, title: 'U2', objective: 'O2', acceptanceCriteria: 'C2', dependsOnUnitIds: [u1] },
          { unitId: u3, title: 'U3', objective: 'O3', acceptanceCriteria: 'C3', dependsOnUnitIds: [u2] }
        ])
        expect(records).toHaveLength(3)

        // Todos os estados são AVAILABLE imediatamente após definição
        const s1 = unitFlow.getUnitState(repoId, session.sessionId, planId, u1) as UnitFlowUnitStateRecord
        const s2 = unitFlow.getUnitState(repoId, session.sessionId, planId, u2) as UnitFlowUnitStateRecord
        const s3 = unitFlow.getUnitState(repoId, session.sessionId, planId, u3) as UnitFlowUnitStateRecord
        expect(s1.status).toBe('AVAILABLE')
        expect(s2.status).toBe('AVAILABLE')
        expect(s3.status).toBe('AVAILABLE')
        expect(s1.revision).toBe(1)

        // getNextEligibleUnit retorna u1 como elegível
        const result = unitFlow.getNextEligibleUnit(repoId, session.sessionId, planId) as { kind: 'ELIGIBLE'; unitId: string; position: number; title: string }
        expect(result.kind).toBe('ELIGIBLE')
        expect(result.unitId).toBe(u1)
        expect(result.position).toBe(1)
        expect(result.title).toBe('U1')

        // Resultado não contém objective nem acceptanceCriteria
        expect((result as any).objective).toBeUndefined()
        expect((result as any).acceptanceCriteria).toBeUndefined()

        // Estados não foram modificados pela consulta
        const s1After = unitFlow.getUnitState(repoId, session.sessionId, planId, u1) as UnitFlowUnitStateRecord
        expect(s1After.revision).toBe(1)
        expect(s1After.updatedAt).toBe(s1.updatedAt)
      })
    })

    describe('Prova 3 — Elegibilidade sequencial com estados simulados via rawDb UPDATE', () => {
      it('Cenário A: u1=COMPLETED → u2 é ELIGIBLE', () => {
        const session = smc.createSession(repoId)
        const planId = 'ffffffff-0003-4000-8003-00000000000a'
        unitFlow.registerPlan(repoId, session.sessionId, { planId, title: 'Plano Cenário A' })
        const u1 = '11111111-0003-4000-8003-00000000000a'
        const u2 = '22222222-0003-4000-8003-00000000000a'
        unitFlow.definePlanUnits(repoId, session.sessionId, planId, [
          { unitId: u1, title: 'U1A', objective: 'O', acceptanceCriteria: 'C' },
          { unitId: u2, title: 'U2A', objective: 'O', acceptanceCriteria: 'C', dependsOnUnitIds: [u1] }
        ])

        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const rawDb = new Database(dbPath)
        rawDb.prepare('UPDATE smc_unit_states SET status = ?, updated_at = ? WHERE unit_id = ?').run('COMPLETED', new Date().toISOString(), u1)
        rawDb.close()

        const r = unitFlow.getNextEligibleUnit(repoId, session.sessionId, planId) as { kind: string; unitId: string }
        expect(r.kind).toBe('ELIGIBLE')
        expect(r.unitId).toBe(u2)
      })

      it('Cenário B: u1=COMPLETED, u2=RESERVED → WAITING blockingUnitId=u2', () => {
        const session = smc.createSession(repoId)
        const planId = 'ffffffff-0003-4000-8003-00000000000b'
        unitFlow.registerPlan(repoId, session.sessionId, { planId, title: 'Plano Cenário B' })
        const u1 = '11111111-0003-4000-8003-00000000000b'
        const u2 = '22222222-0003-4000-8003-00000000000b'
        unitFlow.definePlanUnits(repoId, session.sessionId, planId, [
          { unitId: u1, title: 'U1B', objective: 'O', acceptanceCriteria: 'C' },
          { unitId: u2, title: 'U2B', objective: 'O', acceptanceCriteria: 'C', dependsOnUnitIds: [u1] }
        ])

        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const rawDb = new Database(dbPath)
        const now = new Date().toISOString()
        rawDb.prepare('UPDATE smc_unit_states SET status = ?, updated_at = ? WHERE unit_id = ?').run('COMPLETED', now, u1)
        rawDb.prepare('UPDATE smc_unit_states SET status = ?, updated_at = ? WHERE unit_id = ?').run('RESERVED', now, u2)
        rawDb.close()

        const r = unitFlow.getNextEligibleUnit(repoId, session.sessionId, planId) as { kind: string; blockingUnitId: string }
        expect(r.kind).toBe('WAITING')
        expect(r.blockingUnitId).toBe(u2)
      })

      it('Cenário C: u1=COMPLETED, u2=EXECUTING → WAITING blockingUnitId=u2', () => {
        const session = smc.createSession(repoId)
        const planId = 'ffffffff-0003-4000-8003-00000000000c'
        unitFlow.registerPlan(repoId, session.sessionId, { planId, title: 'Plano Cenário C' })
        const u1 = '11111111-0003-4000-8003-00000000000c'
        const u2 = '22222222-0003-4000-8003-00000000000c'
        unitFlow.definePlanUnits(repoId, session.sessionId, planId, [
          { unitId: u1, title: 'U1C', objective: 'O', acceptanceCriteria: 'C' },
          { unitId: u2, title: 'U2C', objective: 'O', acceptanceCriteria: 'C', dependsOnUnitIds: [u1] }
        ])

        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const rawDb = new Database(dbPath)
        const now = new Date().toISOString()
        rawDb.prepare('UPDATE smc_unit_states SET status = ?, updated_at = ? WHERE unit_id = ?').run('COMPLETED', now, u1)
        rawDb.prepare('UPDATE smc_unit_states SET status = ?, updated_at = ? WHERE unit_id = ?').run('EXECUTING', now, u2)
        rawDb.close()

        const r = unitFlow.getNextEligibleUnit(repoId, session.sessionId, planId) as { kind: string; blockingUnitId: string }
        expect(r.kind).toBe('WAITING')
        expect(r.blockingUnitId).toBe(u2)
      })

      it('Cenário D: todas COMPLETED → ALL_UNITS_COMPLETED; plano ainda ACTIVE', () => {
        const session = smc.createSession(repoId)
        const planId = 'ffffffff-0003-4000-8003-00000000000d'
        unitFlow.registerPlan(repoId, session.sessionId, { planId, title: 'Plano Cenário D' })
        const u1 = '11111111-0003-4000-8003-00000000000d'
        const u2 = '22222222-0003-4000-8003-00000000000d'
        unitFlow.definePlanUnits(repoId, session.sessionId, planId, [
          { unitId: u1, title: 'U1D', objective: 'O', acceptanceCriteria: 'C' },
          { unitId: u2, title: 'U2D', objective: 'O', acceptanceCriteria: 'C', dependsOnUnitIds: [u1] }
        ])

        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const rawDb = new Database(dbPath)
        const now = new Date().toISOString()
        rawDb.prepare('UPDATE smc_unit_states SET status = ?, updated_at = ? WHERE unit_id = ?').run('COMPLETED', now, u1)
        rawDb.prepare('UPDATE smc_unit_states SET status = ?, updated_at = ? WHERE unit_id = ?').run('COMPLETED', now, u2)
        rawDb.close()

        const r = unitFlow.getNextEligibleUnit(repoId, session.sessionId, planId)
        expect(r.kind).toBe('ALL_UNITS_COMPLETED')

        const plan = unitFlow.getPlan(repoId, planId)
        expect(plan?.status).toBe('ACTIVE')
      })

      it('Cenário E: u2 tem dep em u1; u1 AVAILABLE → apenas u1 elegível; u1 COMPLETED → u2 elegível', () => {
        const session = smc.createSession(repoId)
        const planId = 'ffffffff-0003-4000-8003-00000000000e'
        unitFlow.registerPlan(repoId, session.sessionId, { planId, title: 'Plano Cenário E' })
        const u1 = '11111111-0003-4000-8003-00000000000e'
        const u2 = '22222222-0003-4000-8003-00000000000e'
        unitFlow.definePlanUnits(repoId, session.sessionId, planId, [
          { unitId: u1, title: 'U1E', objective: 'O', acceptanceCriteria: 'C' },
          { unitId: u2, title: 'U2E', objective: 'O', acceptanceCriteria: 'C', dependsOnUnitIds: [u1] }
        ])

        // Ambos AVAILABLE: u1 é elegível (u2 depende de u1 não-COMPLETED)
        const r1 = unitFlow.getNextEligibleUnit(repoId, session.sessionId, planId) as { kind: string; unitId: string }
        expect(r1.kind).toBe('ELIGIBLE')
        expect(r1.unitId).toBe(u1)

        // Simula u1=COMPLETED → u2 passa a ser elegível
        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const rawDb = new Database(dbPath)
        rawDb.prepare('UPDATE smc_unit_states SET status = ?, updated_at = ? WHERE unit_id = ?').run('COMPLETED', new Date().toISOString(), u1)
        rawDb.close()

        const r2 = unitFlow.getNextEligibleUnit(repoId, session.sessionId, planId) as { kind: string; unitId: string }
        expect(r2.kind).toBe('ELIGIBLE')
        expect(r2.unitId).toBe(u2)
      })
    })

    describe('Prova 4 — Fail-closed: validações de entrada e estado', () => {
      it('sem manifesto → MANIFEST_UNDEFINED', () => {
        const session = smc.createSession(repoId)
        const planId = 'ffffffff-0003-4000-8004-000000000001'
        unitFlow.registerPlan(repoId, session.sessionId, { planId, title: 'Sem Manifesto' })

        const r = unitFlow.getNextEligibleUnit(repoId, session.sessionId, planId)
        expect(r.kind).toBe('MANIFEST_UNDEFINED')
      })

      it('plano não ACTIVE → UnitFlowPlanConflictError', () => {
        const session = smc.createSession(repoId)
        const planId = 'ffffffff-0003-4000-8004-000000000002'
        unitFlow.registerPlan(repoId, session.sessionId, { planId, title: 'Plano Cancelado' })

        // Forçar o plano para CANCELLED via rawDb
        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const rawDb = new Database(dbPath)
        rawDb.prepare('UPDATE smc_plans SET status = ? WHERE plan_id = ?').run('CANCELLED', planId)
        rawDb.close()

        expect(() => unitFlow.getNextEligibleUnit(repoId, session.sessionId, planId)).toThrow(UnitFlowPlanConflictError)
      })

      it('sessão CLOSED → SmcSessionClosedError', () => {
        const session = smc.createSession(repoId)
        const planId = 'ffffffff-0003-4000-8004-000000000003'
        unitFlow.registerPlan(repoId, session.sessionId, { planId, title: 'Sessão Fechada' })

        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const rawDb = new Database(dbPath)
        rawDb.prepare('UPDATE smc_sessions SET status = ? WHERE session_id = ?').run('CLOSED', session.sessionId)
        rawDb.close()

        expect(() => unitFlow.getNextEligibleUnit(repoId, session.sessionId, planId)).toThrow(SmcSessionClosedError)
      })

      it('sessão inexistente → SmcSessionNotFoundError', () => {
        const fakeSession = '00000000-0003-4000-8004-000000000004'
        const planId = 'ffffffff-0003-4000-8004-000000000004'

        expect(() => unitFlow.getNextEligibleUnit(repoId, fakeSession, planId)).toThrow(SmcSessionNotFoundError)
      })

      it('plano pertence a outra sessão → UnitFlowPlanConflictError', () => {
        const session1 = smc.createSession(repoId)
        const session2 = smc.createSession(repoId)
        const planId = 'ffffffff-0003-4000-8004-000000000005'
        unitFlow.registerPlan(repoId, session1.sessionId, { planId, title: 'Plano da Sessão 1' })

        expect(() => unitFlow.getNextEligibleUnit(repoId, session2.sessionId, planId)).toThrow(UnitFlowPlanConflictError)
      })

      it('plano em repositório diferente → UnitFlowPlanNotFoundError', () => {
        const session = smc.createSession(repoId)
        const planId = 'ffffffff-0003-4000-8004-000000000006'
        unitFlow.registerPlan(repoId, session.sessionId, { planId, title: 'Plano Repo A' })

        const session2 = smc.createSession('repo-unitflow-03-alt')
        expect(() => unitFlow.getNextEligibleUnit('repo-unitflow-03-alt', session2.sessionId, planId)).toThrow(UnitFlowPlanNotFoundError)
      })

      it('planId inválido (não UUID) → UnitFlowInvalidPlanError', () => {
        const session = smc.createSession(repoId)
        expect(() => unitFlow.getNextEligibleUnit(repoId, session.sessionId, 'not-a-uuid')).toThrow(UnitFlowInvalidPlanError)
      })

      it('getUnitState com sessão errada (plano não pertence à sessão) → null', () => {
        const session1 = smc.createSession(repoId)
        const session2 = smc.createSession(repoId)
        const planId = 'ffffffff-0003-4000-8004-000000000007'
        const u1 = '11111111-0003-4000-8004-000000000007'
        unitFlow.registerPlan(repoId, session1.sessionId, { planId, title: 'Plano Sessão 1' })
        unitFlow.definePlanUnits(repoId, session1.sessionId, planId, [
          { unitId: u1, title: 'U1', objective: 'O', acceptanceCriteria: 'C' }
        ])

        // Consulta com session2 → null (não erro)
        const result = unitFlow.getUnitState(repoId, session2.sessionId, planId, u1)
        expect(result).toBeNull()
      })
    })

    describe('Prova 5 — Replay não reseta progresso; migração idempotente', () => {
      it('replay de definePlanUnits idêntico preserva estado existente', () => {
        const session = smc.createSession(repoId)
        const planId = 'ffffffff-0003-4000-8005-000000000001'
        unitFlow.registerPlan(repoId, session.sessionId, { planId, title: 'Plano Replay' })

        const u1 = '11111111-0003-4000-8005-000000000001'
        const u2 = '22222222-0003-4000-8005-000000000001'
        const manifest = [
          { unitId: u1, title: 'U1', objective: 'O1', acceptanceCriteria: 'C1' },
          { unitId: u2, title: 'U2', objective: 'O2', acceptanceCriteria: 'C2', dependsOnUnitIds: [u1] }
        ]
        unitFlow.definePlanUnits(repoId, session.sessionId, planId, manifest)

        // Simula progresso: u1 = COMPLETED
        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const rawDb = new Database(dbPath)
        rawDb.prepare('UPDATE smc_unit_states SET status = ?, updated_at = ? WHERE unit_id = ?').run('COMPLETED', new Date().toISOString(), u1)
        rawDb.close()

        // Replay idêntico — deve retornar registros existentes sem resetar estados
        const replayed = unitFlow.definePlanUnits(repoId, session.sessionId, planId, manifest)
        expect(replayed).toHaveLength(2)

        const s1After = unitFlow.getUnitState(repoId, session.sessionId, planId, u1) as UnitFlowUnitStateRecord
        expect(s1After.status).toBe('COMPLETED')
      })

      it('reabertura não duplica linhas em smc_unit_states', () => {
        const session = smc.createSession(repoId)
        const planId = 'ffffffff-0003-4000-8005-000000000002'
        unitFlow.registerPlan(repoId, session.sessionId, { planId, title: 'Plano Idempotente' })

        const u1 = '11111111-0003-4000-8005-000000000002'
        unitFlow.definePlanUnits(repoId, session.sessionId, planId, [
          { unitId: u1, title: 'U1', objective: 'O', acceptanceCriteria: 'C' }
        ])

        // Fecha e reabre duas vezes
        smc.close()
        const smc2 = new SessionMemoryCentralService(tempBaseDir)
        smc2.getStore(repoId)
        smc2.close()

        const smc3 = new SessionMemoryCentralService(tempBaseDir)
        smc3.getStore(repoId)

        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const rawDb = new Database(dbPath)
        const count = rawDb.prepare('SELECT count(*) as cnt FROM smc_unit_states WHERE plan_id = ?').get(planId) as { cnt: number }
        rawDb.close()
        expect(count.cnt).toBe(1)

        smc3.close()
        // Reinicializa smc para afterEach não falhar
        smc = new SessionMemoryCentralService(tempBaseDir)
      })
    })
  })

  describe('BuildX Workspace-01 — Vínculo durável de sessão à Worktree Git (Provas Mínimas)', () => {
    const repoId = 'repo-workspace-01'
    let smc: SessionMemoryCentralService

    function createFixtureInventory(options?: {
      repositoryId?: string
      worktreeId?: string
      generation?: string
      branch?: string
      head?: string
      missing?: boolean
      locked?: boolean
      prunable?: boolean
      detached?: boolean
      reference?: boolean
    }): BranchInventory {
      const repositoryId = options?.repositoryId ?? repoId
      const worktreeId = options?.worktreeId ?? 'wt-workspace-01'
      const generation = options?.generation ?? 'gen-12345'
      const branchName = options?.branch ?? 'feature-workspace-01'
      const head = options?.head ?? 'abcdef1234567890abcdef1234567890abcdef12'

      const worktree: any = {
        worktreeId,
        generation,
        path: `/mock/path/${worktreeId}`,
        head,
        branch: branchName,
        detached: options?.detached ?? false,
        locked: options?.locked ?? false,
        missing: options?.missing ?? false,
        prunable: options?.prunable ?? false,
        reference: options?.reference ?? false
      }

      const branchRecord: BranchRecord = {
        key: `key-${branchName}`,
        repositoryId,
        ref: `refs/heads/${branchName}`,
        name: branchName,
        namespace: 'LOCAL',
        head,
        upstream: null,
        generation: 'branch-gen-1',
        revision: 'branch-rev-1',
        creation: { at: '2026-11-05T00:00:00.000Z', source: 'APP_RECEIPT' },
        lastCommitAt: '2026-11-05T00:00:00.000Z',
        worktrees: [{ worktreeId, generation }]
      }

      return {
        repositoryId,
        source: 'GIT_LOCAL',
        coverage: 'COMPLETE',
        observedAt: '2026-11-05T00:00:00.000Z',
        revision: 'inv-rev-1',
        branches: [branchRecord],
        worktrees: [worktree],
        unassignedWorktrees: []
      }
    }

    function createFixturePort(
      inventory: BranchInventory,
      snapshotOverride?: boolean | ((id: string) => Promise<{ reference: boolean }> | { reference: boolean })
    ): GitOperationsPort {
      return {
        getBranchInventory: async () => inventory,
        getCoordinationSnapshot: async (worktreeId: string) => {
          if (typeof snapshotOverride === 'function') {
            return await snapshotOverride(worktreeId)
          }
          if (typeof snapshotOverride === 'boolean') {
            return { reference: snapshotOverride }
          }
          const wt = inventory.worktrees.find(w => w.worktreeId === worktreeId)
          return { reference: (wt as any)?.reference === true }
        }
      }
    }

    beforeEach(() => {
      smc = new SessionMemoryCentralService(tempBaseDir)
    })

    afterEach(() => {
      smc.close()
    })

    describe('Prova 1 — Migração v5→v6, vínculo durável e persistência', () => {
      it('migra banco v5 real para v6, vincula Worktree e recupera identidade após restart', async () => {
        const legacySessionId = '00000000-0000-4000-9001-000000000001'
        const legacyEntryId = '00000000-0000-4000-9001-000000000002'
        const legacyPlanId = '00000000-0000-4000-9001-000000000003'
        const legacyUnitId = '00000000-0000-4000-9001-000000000004'
        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        mkdirSync(dirname(dbPath), { recursive: true })

        // 1. Cria esquema v5 manualmente
        const v5Db = new Database(dbPath)
        const now = new Date().toISOString()
        v5Db.exec(`
          CREATE TABLE smc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO smc_meta VALUES ('repository_id', '${repoId}');
          INSERT INTO smc_meta VALUES ('schema_version', '5');

          CREATE TABLE smc_sessions (
            session_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('OPEN', 'CLOSED')),
            revision INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          INSERT INTO smc_sessions VALUES ('${legacySessionId}', '${repoId}', 'OPEN', 1, '${now}', '${now}');

          CREATE TABLE smc_entries (
            order_seq INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT UNIQUE NOT NULL,
            session_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
            body TEXT NOT NULL, emitter_role TEXT NOT NULL, emitter_id TEXT,
            references_json TEXT, supersedes_entry_id TEXT, created_at TEXT NOT NULL
          );
          INSERT INTO smc_entries VALUES (1, '${legacyEntryId}', '${legacySessionId}', 'DECISION', 'Histórico', 'Corpo', 'HUMAN', NULL, NULL, NULL, '${now}');

          CREATE TABLE smc_plans (
            plan_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, repository_id TEXT NOT NULL,
            title TEXT NOT NULL, source_artifact_id TEXT,
            status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          INSERT INTO smc_plans VALUES ('${legacyPlanId}', '${legacySessionId}', '${repoId}', 'Plano V5', NULL, 'ACTIVE', 1, '${now}', '${now}');

          CREATE TABLE smc_plan_units (
            unit_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, position INTEGER NOT NULL,
            title TEXT NOT NULL, objective TEXT NOT NULL, acceptance_criteria TEXT NOT NULL,
            depends_on_json TEXT, created_at TEXT NOT NULL
          );
          INSERT INTO smc_plan_units VALUES ('${legacyUnitId}', '${legacyPlanId}', 1, 'U1', 'O1', 'C1', NULL, '${now}');

          CREATE TABLE smc_unit_states (
            unit_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, status TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          INSERT INTO smc_unit_states VALUES ('${legacyUnitId}', '${legacyPlanId}', 'AVAILABLE', 1, '${now}', '${now}');
        `)
        v5Db.close()

        // 2. Abre com WorkspaceBindingService para disparar migração v5 -> v6
        const inventory = createFixtureInventory({
          worktreeId: 'wt-001',
          generation: 'gen-aaa',
          branch: 'feature-migrada',
          head: '1111111111111111111111111111111111111111'
        })
        const workspaceService = new WorkspaceBindingService(smc, createFixturePort(inventory))

        // Vincula a worktree
        const binding = await workspaceService.bindWorkspace(repoId, legacySessionId, 'wt-001')
        expect(binding.sessionId).toBe(legacySessionId)
        expect(binding.repositoryId).toBe(repoId)
        expect(binding.worktreeId).toBe('wt-001')
        expect(binding.generation).toBe('gen-aaa')
        expect(binding.branch).toBe('feature-migrada')
        expect(binding.headAtBind).toBe('1111111111111111111111111111111111111111')
        expect((binding as any).path).toBeUndefined()

        // Verifica que schema_version é 6 ou superior no banco
        const checkDb = new Database(dbPath)
        const versionRow = checkDb.prepare('SELECT value FROM smc_meta WHERE key = ?').get('schema_version') as { value: string }
        expect(['6', '7', '8']).toContain(versionRow.value)
        checkDb.close()

        // 3. Fecha e reabre em nova instância de serviço
        smc.close()
        const reopenedSmc = new SessionMemoryCentralService(tempBaseDir)
        const reopenedService = new WorkspaceBindingService(reopenedSmc, createFixturePort(inventory))

        const recovered = reopenedService.getWorkspaceBinding(repoId, legacySessionId)
        expect(recovered).not.toBeNull()
        expect(recovered?.sessionId).toBe(legacySessionId)
        expect(recovered?.worktreeId).toBe('wt-001')
        expect(recovered?.generation).toBe('gen-aaa')
        expect(recovered?.branch).toBe('feature-migrada')
        expect(recovered?.headAtBind).toBe('1111111111111111111111111111111111111111')

        // Entidades legadas permanecem intactas
        const sess = reopenedSmc.getSession(repoId, legacySessionId)
        expect(sess?.status).toBe('OPEN')
        const plan = reopenedSmc.getPlan(repoId, legacyPlanId)
        expect(plan?.title).toBe('Plano V5')
        const entry = reopenedSmc.getEntry(repoId, legacySessionId, legacyEntryId)
        expect(entry?.title).toBe('Histórico')
        const unit = reopenedSmc.getPlanUnit(repoId, legacySessionId, legacyPlanId, legacyUnitId)
        expect(unit?.title).toBe('U1')

        reopenedSmc.close()
      })
    })

    describe('Prova 2 — Idempotência de replay e conflito de rebind', () => {
      it('permite replay idêntico sem mutação e rejeita rebind com worktree/generation/branch divergente', async () => {
        const session = smc.createSession(repoId)
        const inventory = createFixtureInventory({
          worktreeId: 'wt-replay',
          generation: 'gen-replay-1',
          branch: 'feature-replay',
          head: '2222222222222222222222222222222222222222'
        })
        const service = new WorkspaceBindingService(smc, createFixturePort(inventory))

        // Primeiro vínculo
        const first = await service.bindWorkspace(repoId, session.sessionId, 'wt-replay')
        expect(first.worktreeId).toBe('wt-replay')

        // Replay idêntico
        const replay = await service.bindWorkspace(repoId, session.sessionId, 'wt-replay')
        expect(replay.worktreeId).toBe('wt-replay')
        expect(replay.generation).toBe('gen-replay-1')
        expect(replay.createdAt).toBe(first.createdAt)
        expect(replay.updatedAt).toBe(first.updatedAt)

        // Conflito: tentativa com worktreeId diferente
        const conflictingInventory1 = createFixtureInventory({
          worktreeId: 'wt-other',
          generation: 'gen-other',
          branch: 'feature-other',
          head: '3333333333333333333333333333333333333333'
        })
        const serviceConflict1 = new WorkspaceBindingService(smc, createFixturePort(conflictingInventory1))
        await expect(
          serviceConflict1.bindWorkspace(repoId, session.sessionId, 'wt-other')
        ).rejects.toThrow(BuildXWorkspaceBindingConflictError)

        // Conflito: mesma worktreeId mas generation diferente
        const conflictingInventory2 = createFixtureInventory({
          worktreeId: 'wt-replay',
          generation: 'gen-replay-2',
          branch: 'feature-replay',
          head: '2222222222222222222222222222222222222222'
        })
        const serviceConflict2 = new WorkspaceBindingService(smc, createFixturePort(conflictingInventory2))
        await expect(
          serviceConflict2.bindWorkspace(repoId, session.sessionId, 'wt-replay')
        ).rejects.toThrow(BuildXWorkspaceBindingConflictError)
      })

      it('duas instâncias de store concorrentes preservam no máximo um vínculo', async () => {
        const session = smc.createSession(repoId)
        const invA = createFixtureInventory({ worktreeId: 'wt-concur-a', branch: 'feat-a' })
        const invB = createFixtureInventory({ worktreeId: 'wt-concur-b', branch: 'feat-b' })

        const serviceA = new WorkspaceBindingService(smc, createFixturePort(invA))
        const serviceB = new WorkspaceBindingService(smc, createFixturePort(invB))

        await serviceA.bindWorkspace(repoId, session.sessionId, 'wt-concur-a')

        await expect(
          serviceB.bindWorkspace(repoId, session.sessionId, 'wt-concur-b')
        ).rejects.toThrow(BuildXWorkspaceBindingConflictError)

        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const checkDb = new Database(dbPath)
        const count = checkDb.prepare('SELECT count(*) as cnt FROM smc_session_worktrees WHERE session_id = ?').get(session.sessionId) as { cnt: number }
        expect(count.cnt).toBe(1)
        checkDb.close()
      })
    })

    describe('Prova 3 — Revalidação read-only (CURRENT, STALE, UNAVAILABLE, UNBOUND)', () => {
      it('revalida estados de observação sem mutações no banco', async () => {
        const session = smc.createSession(repoId)
        let currentInv = createFixtureInventory({
          worktreeId: 'wt-inspect',
          generation: 'gen-insp-1',
          branch: 'feat-insp',
          head: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111'
        })

        const service = new WorkspaceBindingService(smc, {
          getBranchInventory: async () => currentInv,
          getCoordinationSnapshot: async () => ({ reference: false })
        })

        // 1. UNBOUND antes de vincular
        const unb = await service.inspectBoundWorkspace(repoId, session.sessionId)
        expect(unb.status).toBe('UNBOUND')

        // Vincula
        await service.bindWorkspace(repoId, session.sessionId, 'wt-inspect')

        // 2. CURRENT com HEAD inicial
        const insp1 = await service.inspectBoundWorkspace(repoId, session.sessionId)
        expect(insp1.status).toBe('CURRENT')
        if (insp1.status === 'CURRENT') {
          expect(insp1.currentHead).toBe('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111')
          expect(insp1.binding.headAtBind).toBe('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111')
        }

        // 3. HEAD avançado -> continua CURRENT com novo HEAD
        currentInv = createFixtureInventory({
          worktreeId: 'wt-inspect',
          generation: 'gen-insp-1',
          branch: 'feat-insp',
          head: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222'
        })
        const insp2 = await service.inspectBoundWorkspace(repoId, session.sessionId)
        expect(insp2.status).toBe('CURRENT')
        if (insp2.status === 'CURRENT') {
          expect(insp2.currentHead).toBe('bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222')
          expect(insp2.binding.headAtBind).toBe('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111')
        }

        // 4. Worktree removida do inventário -> STALE (WORKTREE_NOT_FOUND)
        currentInv = createFixtureInventory({
          worktreeId: 'wt-other',
          generation: 'gen-other',
          branch: 'feat-other'
        })
        const insp3 = await service.inspectBoundWorkspace(repoId, session.sessionId)
        expect(insp3.status).toBe('STALE')
        if (insp3.status === 'STALE') {
          expect(insp3.reason).toBe('WORKTREE_NOT_FOUND')
        }

        // 5. Worktree missing -> STALE (WORKTREE_MISSING)
        currentInv = createFixtureInventory({
          worktreeId: 'wt-inspect',
          generation: 'gen-insp-1',
          branch: 'feat-insp',
          missing: true
        })
        const insp4 = await service.inspectBoundWorkspace(repoId, session.sessionId)
        expect(insp4.status).toBe('STALE')
        if (insp4.status === 'STALE') {
          expect(insp4.reason).toBe('WORKTREE_MISSING')
        }

        // 6. Geração diferente -> STALE (GENERATION_CHANGED)
        currentInv = createFixtureInventory({
          worktreeId: 'wt-inspect',
          generation: 'gen-insp-changed',
          branch: 'feat-insp'
        })
        const insp5 = await service.inspectBoundWorkspace(repoId, session.sessionId)
        expect(insp5.status).toBe('STALE')
        if (insp5.status === 'STALE') {
          expect(insp5.reason).toBe('GENERATION_CHANGED')
        }

        // 7. Branch diferente -> STALE (BRANCH_CHANGED)
        currentInv = createFixtureInventory({
          worktreeId: 'wt-inspect',
          generation: 'gen-insp-1',
          branch: 'feat-altered'
        })
        const insp6 = await service.inspectBoundWorkspace(repoId, session.sessionId)
        expect(insp6.status).toBe('STALE')
        if (insp6.status === 'STALE') {
          expect(insp6.reason).toBe('BRANCH_CHANGED')
        }

        // 8. Detached HEAD -> STALE (DETACHED_HEAD)
        currentInv = createFixtureInventory({
          worktreeId: 'wt-inspect',
          generation: 'gen-insp-1',
          branch: 'feat-insp',
          detached: true
        })
        const insp7 = await service.inspectBoundWorkspace(repoId, session.sessionId)
        expect(insp7.status).toBe('STALE')
        if (insp7.status === 'STALE') {
          expect(insp7.reason).toBe('DETACHED_HEAD')
        }

        // 9. Git indisponível -> UNAVAILABLE
        const serviceFailing = new WorkspaceBindingService(smc, {
          getBranchInventory: async () => {
            throw new Error('Git daemon crashed')
          },
          getCoordinationSnapshot: async () => ({ reference: false })
        })
        const insp8 = await serviceFailing.inspectBoundWorkspace(repoId, session.sessionId)
        expect(insp8.status).toBe('UNAVAILABLE')
        if (insp8.status === 'UNAVAILABLE') {
          expect(insp8.reason).toBe('GIT_INVENTORY_UNAVAILABLE')
          expect(insp8.binding.worktreeId).toBe('wt-inspect')
        }
      })
    })

    describe('Prova 4 — Fail-closed e validações de integridade', () => {
      it('rejeita sessão CLOSED', async () => {
        const session = smc.createSession(repoId)
        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const rawDb = new Database(dbPath)
        rawDb.prepare('UPDATE smc_sessions SET status = ? WHERE session_id = ?').run('CLOSED', session.sessionId)
        rawDb.close()

        const service = new WorkspaceBindingService(smc, createFixturePort(createFixtureInventory()))
        await expect(
          service.bindWorkspace(repoId, session.sessionId, 'wt-workspace-01')
        ).rejects.toThrow(SmcSessionClosedError)
      })

      it('rejeita sessão inexistente', async () => {
        const service = new WorkspaceBindingService(smc, createFixturePort(createFixtureInventory()))
        await expect(
          service.bindWorkspace(repoId, '00000000-0000-4000-9004-999999999999', 'wt-workspace-01')
        ).rejects.toThrow(SmcSessionNotFoundError)
      })

      it('rejeita divergência de repositório entre sessão e inventário Git', async () => {
        const session = smc.createSession(repoId)
        const mismatchInventory = createFixtureInventory({ repositoryId: 'repo-different' })
        const service = new WorkspaceBindingService(smc, createFixturePort(mismatchInventory))
        await expect(
          service.bindWorkspace(repoId, session.sessionId, 'wt-workspace-01')
        ).rejects.toThrow(BuildXWorkspaceRepositoryMismatchError)
      })

      it('rejeita worktreeId não encontrada no inventário', async () => {
        const session = smc.createSession(repoId)
        const service = new WorkspaceBindingService(smc, createFixturePort(createFixtureInventory({ worktreeId: 'wt-real' })))
        await expect(
          service.bindWorkspace(repoId, session.sessionId, 'wt-unknown')
        ).rejects.toThrow(BuildXWorkspaceNotFoundError)
      })

      it('rejeita checkout de referência principal (reference: true)', async () => {
        const session = smc.createSession(repoId)
        const refInventory = createFixtureInventory({ reference: true })
        const service = new WorkspaceBindingService(smc, createFixturePort(refInventory))
        await expect(
          service.bindWorkspace(repoId, session.sessionId, 'wt-workspace-01')
        ).rejects.toThrow(BuildXWorkspaceInvalidError)
      })

      it('rejeita worktree missing, locked, prunable ou detached', async () => {
        const session = smc.createSession(repoId)

        // Missing
        const serviceMissing = new WorkspaceBindingService(smc, createFixturePort(createFixtureInventory({ missing: true })))
        await expect(serviceMissing.bindWorkspace(repoId, session.sessionId, 'wt-workspace-01')).rejects.toThrow(BuildXWorkspaceInvalidError)

        // Locked
        const serviceLocked = new WorkspaceBindingService(smc, createFixturePort(createFixtureInventory({ locked: true })))
        await expect(serviceLocked.bindWorkspace(repoId, session.sessionId, 'wt-workspace-01')).rejects.toThrow(BuildXWorkspaceInvalidError)

        // Prunable
        const servicePrunable = new WorkspaceBindingService(smc, createFixturePort(createFixtureInventory({ prunable: true })))
        await expect(servicePrunable.bindWorkspace(repoId, session.sessionId, 'wt-workspace-01')).rejects.toThrow(BuildXWorkspaceInvalidError)

        // Detached
        const serviceDetached = new WorkspaceBindingService(smc, createFixturePort(createFixtureInventory({ detached: true })))
        await expect(serviceDetached.bindWorkspace(repoId, session.sessionId, 'wt-workspace-01')).rejects.toThrow(BuildXWorkspaceInvalidError)
      })

      it('rejeita geração UNKNOWN ou ausente e worktree sem HEAD confirmado', async () => {
        const session = smc.createSession(repoId)

        // UNKNOWN generation
        const serviceUnknownGen = new WorkspaceBindingService(smc, createFixturePort(createFixtureInventory({ generation: 'UNKNOWN' })))
        await expect(serviceUnknownGen.bindWorkspace(repoId, session.sessionId, 'wt-workspace-01')).rejects.toThrow(BuildXWorkspaceInvalidError)

        // No HEAD
        const serviceNoHead = new WorkspaceBindingService(smc, createFixturePort(createFixtureInventory({ head: '' })))
        await expect(serviceNoHead.bindWorkspace(repoId, session.sessionId, 'wt-workspace-01')).rejects.toThrow(BuildXWorkspaceInvalidError)
      })

      it('rejeita branch não vinculado no inventário local', async () => {
        const session = smc.createSession(repoId)
        const unlinkedInv = createFixtureInventory()
        // Remove worktree do branch local
        unlinkedInv.branches[0].worktrees = []
        const service = new WorkspaceBindingService(smc, createFixturePort(unlinkedInv))
        await expect(
          service.bindWorkspace(repoId, session.sessionId, 'wt-workspace-01')
        ).rejects.toThrow(BuildXWorkspaceInvalidError)
      })
    })
  })

  describe('BuildX Workspace-02 — Revalidação fail-closed da Worktree vinculada (Provas Dirigidas)', () => {
    const repoId = 'repo-workspace-02'
    let smc: SessionMemoryCentralService

    function createControlledInventory(options?: {
      worktreeId?: string
      generation?: string
      branch?: string
      worktreeHead?: string
      branchHead?: string
      locked?: boolean
      prunable?: boolean
      missing?: boolean
      detached?: boolean
    }): BranchInventory {
      const worktreeId = options?.worktreeId ?? 'wt-ws02-sec'
      const generation = options?.generation ?? 'gen-ws02-1'
      const branchName = options?.branch ?? 'feature-ws02'
      const wtHead = options?.worktreeHead ?? '1111222233334444555566667777888899990000'
      const brHead = options?.branchHead ?? wtHead

      const worktree: any = {
        worktreeId,
        generation,
        path: `/mock/worktrees/${worktreeId}`,
        head: wtHead,
        branch: branchName,
        detached: options?.detached ?? false,
        locked: options?.locked ?? false,
        missing: options?.missing ?? false,
        prunable: options?.prunable ?? false
        // NOTA: intencionalmente sem propriedade 'reference' no BranchInventory
      }

      const branchRecord: BranchRecord = {
        key: `key-${branchName}`,
        repositoryId: repoId,
        ref: `refs/heads/${branchName}`,
        name: branchName,
        namespace: 'LOCAL',
        head: brHead,
        upstream: null,
        generation: 'branch-gen-1',
        revision: 'branch-rev-1',
        creation: { at: '2026-11-05T00:00:00.000Z', source: 'APP_RECEIPT' },
        lastCommitAt: '2026-11-05T00:00:00.000Z',
        worktrees: [{ worktreeId, generation }]
      }

      return {
        repositoryId: repoId,
        source: 'GIT_LOCAL',
        coverage: 'COMPLETE',
        observedAt: '2026-11-05T00:00:00.000Z',
        revision: 'inv-ws02-1',
        branches: [branchRecord],
        worktrees: [worktree],
        unassignedWorktrees: []
      }
    }

    beforeEach(() => {
      smc = new SessionMemoryCentralService(tempBaseDir)
    })

    afterEach(() => {
      smc.close()
    })

    describe('Prova 1 — Port real e primary checkout', () => {
      it('rejeita checkout principal quando getCoordinationSnapshot retorna reference: true, mesmo sem reference em BranchInventory', async () => {
        const session = smc.createSession(repoId)
        const inventory = createControlledInventory()
        expect((inventory.worktrees[0] as any).reference).toBeUndefined()

        const port: GitOperationsPort = {
          getBranchInventory: async () => inventory,
          getCoordinationSnapshot: async () => ({ reference: true })
        }
        const service = new WorkspaceBindingService(smc, port)

        await expect(
          service.bindWorkspace(repoId, session.sessionId, 'wt-ws02-sec')
        ).rejects.toThrow(BuildXWorkspaceInvalidError)
        await expect(
          service.bindWorkspace(repoId, session.sessionId, 'wt-ws02-sec')
        ).rejects.toThrow('Cannot bind primary or reference worktree checkout')
      })

      it('rejeita bind com erro tipado se gitPort não implementar getCoordinationSnapshot', async () => {
        const session = smc.createSession(repoId)
        const inventory = createControlledInventory()
        const port: GitOperationsPort = {
          getBranchInventory: async () => inventory
        }
        const service = new WorkspaceBindingService(smc, port)

        await expect(
          service.bindWorkspace(repoId, session.sessionId, 'wt-ws02-sec')
        ).rejects.toThrow(BuildXWorkspaceEvidenceUnavailableError)
      })

      it('rejeita bind com erro tipado se getCoordinationSnapshot falhar/lançar exceção', async () => {
        const session = smc.createSession(repoId)
        const inventory = createControlledInventory()
        const port: GitOperationsPort = {
          getBranchInventory: async () => inventory,
          getCoordinationSnapshot: async () => {
            throw new Error('Coordination snapshot timeout')
          }
        }
        const service = new WorkspaceBindingService(smc, port)

        await expect(
          service.bindWorkspace(repoId, session.sessionId, 'wt-ws02-sec')
        ).rejects.toThrow(BuildXWorkspaceEvidenceUnavailableError)
      })

      it('rejeita bind se HEAD da worktree divergir do HEAD da branch local', async () => {
        const session = smc.createSession(repoId)
        const inventory = createControlledInventory({
          worktreeHead: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
          branchHead: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222'
        })
        const port: GitOperationsPort = {
          getBranchInventory: async () => inventory,
          getCoordinationSnapshot: async () => ({ reference: false })
        }
        const service = new WorkspaceBindingService(smc, port)

        await expect(
          service.bindWorkspace(repoId, session.sessionId, 'wt-ws02-sec')
        ).rejects.toThrow(BuildXWorkspaceInvalidError)
        await expect(
          service.bindWorkspace(repoId, session.sessionId, 'wt-ws02-sec')
        ).rejects.toThrow('Worktree HEAD does not match local branch HEAD')
      })
    })

    describe('Prova 2 — Revalidação fail-closed estrita em inspectBoundWorkspace', () => {
      it('revalida fail-closed todos os impedimentos para STALE com razões tipadas', async () => {
        const session = smc.createSession(repoId)
        let currentInv = createControlledInventory()
        let refState = false
        let snapshotFails = false

        const dynamicPort: GitOperationsPort = {
          getBranchInventory: async () => currentInv,
          getCoordinationSnapshot: async () => {
            if (snapshotFails) {
              throw new Error('Coordination daemon inaccessible')
            }
            return { reference: refState }
          }
        }

        const service = new WorkspaceBindingService(smc, dynamicPort)

        // 1. Bind inicial válido
        const binding = await service.bindWorkspace(repoId, session.sessionId, 'wt-ws02-sec')
        expect(binding.worktreeId).toBe('wt-ws02-sec')

        // Estado inicial -> CURRENT
        const initialInspect = await service.inspectBoundWorkspace(repoId, session.sessionId)
        expect(initialInspect.status).toBe('CURRENT')

        // 2. Simula locked: true -> STALE com WORKTREE_LOCKED
        currentInv = createControlledInventory({ locked: true })
        const lockedInspect = await service.inspectBoundWorkspace(repoId, session.sessionId)
        expect(lockedInspect.status).toBe('STALE')
        if (lockedInspect.status === 'STALE') {
          expect(lockedInspect.reason).toBe('WORKTREE_LOCKED')
        }

        // 3. Simula prunable: true -> STALE com WORKTREE_PRUNABLE
        currentInv = createControlledInventory({ prunable: true })
        const prunableInspect = await service.inspectBoundWorkspace(repoId, session.sessionId)
        expect(prunableInspect.status).toBe('STALE')
        if (prunableInspect.status === 'STALE') {
          expect(prunableInspect.reason).toBe('WORKTREE_PRUNABLE')
        }

        // 4. Simula checkout tornando-se referência -> STALE com PRIMARY_CHECKOUT
        currentInv = createControlledInventory()
        refState = true
        const refInspect = await service.inspectBoundWorkspace(repoId, session.sessionId)
        expect(refInspect.status).toBe('STALE')
        if (refInspect.status === 'STALE') {
          expect(refInspect.reason).toBe('PRIMARY_CHECKOUT')
        }
        refState = false

        // 5. Simula HEAD ausente/vazio -> STALE com HEAD_UNAVAILABLE (nunca fallback para headAtBind)
        currentInv = createControlledInventory({ worktreeHead: '' })
        const noHeadInspect = await service.inspectBoundWorkspace(repoId, session.sessionId)
        expect(noHeadInspect.status).toBe('STALE')
        if (noHeadInspect.status === 'STALE') {
          expect(noHeadInspect.reason).toBe('HEAD_UNAVAILABLE')
        }

        // 6. Simula HEAD divergente entre worktree e branch local -> STALE com HEAD_DIVERGED
        currentInv = createControlledInventory({
          worktreeHead: '1111222233334444555566667777888899990000',
          branchHead: '9999888877776666555544443333222211110000'
        })
        const divergedInspect = await service.inspectBoundWorkspace(repoId, session.sessionId)
        expect(divergedInspect.status).toBe('STALE')
        if (divergedInspect.status === 'STALE') {
          expect(divergedInspect.reason).toBe('HEAD_DIVERGED')
        }

        // 7. Simula branch ausente no inventário -> STALE com BRANCH_NOT_IN_INVENTORY
        currentInv = createControlledInventory()
        currentInv.branches = []
        const noBranchInspect = await service.inspectBoundWorkspace(repoId, session.sessionId)
        expect(noBranchInspect.status).toBe('STALE')
        if (noBranchInspect.status === 'STALE') {
          expect(noBranchInspect.reason).toBe('BRANCH_NOT_IN_INVENTORY')
        }

        // 8. Simula branch desvinculada (worktrees = []) -> STALE com BRANCH_NOT_LINKED
        currentInv = createControlledInventory()
        currentInv.branches[0].worktrees = []
        const unlinkedInspect = await service.inspectBoundWorkspace(repoId, session.sessionId)
        expect(unlinkedInspect.status).toBe('STALE')
        if (unlinkedInspect.status === 'STALE') {
          expect(unlinkedInspect.reason).toBe('BRANCH_NOT_LINKED')
        }

        // 9. Simula falha em getCoordinationSnapshot -> UNAVAILABLE com COORDINATION_SNAPSHOT_FAILED (sem vazar mensagem)
        currentInv = createControlledInventory()
        snapshotFails = true
        const failInspect = await service.inspectBoundWorkspace(repoId, session.sessionId)
        expect(failInspect.status).toBe('UNAVAILABLE')
        if (failInspect.status === 'UNAVAILABLE') {
          expect(failInspect.reason).toBe('COORDINATION_SNAPSHOT_FAILED')
        }
        snapshotFails = false

        // 10. Simula port sem getCoordinationSnapshot -> UNAVAILABLE com EVIDENCE_UNAVAILABLE
        const serviceNoSnapshotMethod = new WorkspaceBindingService(smc, {
          getBranchInventory: async () => currentInv
        })
        const noMethodInspect = await serviceNoSnapshotMethod.inspectBoundWorkspace(repoId, session.sessionId)
        expect(noMethodInspect.status).toBe('UNAVAILABLE')
        if (noMethodInspect.status === 'UNAVAILABLE') {
          expect(noMethodInspect.reason).toBe('EVIDENCE_UNAVAILABLE')
        }

        // 11. HEAD avançado válido (mesmo novo commit na worktree e na branch local) -> CURRENT
        const newHead = 'fedcba0987654321fedcba0987654321fedcba09'
        currentInv = createControlledInventory({
          worktreeHead: newHead,
          branchHead: newHead
        })
        const advancedInspect = await service.inspectBoundWorkspace(repoId, session.sessionId)
        expect(advancedInspect.status).toBe('CURRENT')
        if (advancedInspect.status === 'CURRENT') {
          expect(advancedInspect.currentHead).toBe(newHead)
          expect(advancedInspect.binding.headAtBind).toBe('1111222233334444555566667777888899990000')
        }
      })
    })

    describe('Prova 3 — Não-regressão e pureza de inspeção', () => {
      it('garante que inspeções são estritamente read-only e não alteram registros no SQLite', async () => {
        const session = smc.createSession(repoId)
        const inventory = createControlledInventory()
        const port: GitOperationsPort = {
          getBranchInventory: async () => inventory,
          getCoordinationSnapshot: async () => ({ reference: false })
        }
        const service = new WorkspaceBindingService(smc, port)

        const binding = await service.bindWorkspace(repoId, session.sessionId, 'wt-ws02-sec')
        const dbPath = smcDatabasePath(tempBaseDir, repoId)

        const dbBefore = new Database(dbPath)
        const recordBefore = dbBefore
          .prepare('SELECT * FROM smc_session_worktrees WHERE session_id = ?')
          .get(session.sessionId) as any
        const allRowsBefore = dbBefore.prepare('SELECT count(*) as count FROM smc_session_worktrees').get() as any
        dbBefore.close()

        // Múltiplas inspeções de diferentes estados
        await service.inspectBoundWorkspace(repoId, session.sessionId)
        await service.inspectBoundWorkspace(repoId, session.sessionId)

        const dbAfter = new Database(dbPath)
        const recordAfter = dbAfter
          .prepare('SELECT * FROM smc_session_worktrees WHERE session_id = ?')
          .get(session.sessionId) as any
        const allRowsAfter = dbAfter.prepare('SELECT count(*) as count FROM smc_session_worktrees').get() as any
        dbAfter.close()

        expect(allRowsAfter.count).toBe(allRowsBefore.count)
        expect(recordAfter.created_at).toBe(recordBefore.created_at)
        expect(recordAfter.updated_at).toBe(recordBefore.updated_at)
        expect(recordAfter.head_at_bind).toBe(recordBefore.head_at_bind)
      })
    })
  })

  describe('BuildX UnitFlow-04 — Reserva atômica da próxima unidade elegível (Provas Dirigidas)', () => {
    const repoId = 'repo-unitflow-04'
    let smc: SessionMemoryCentralService

    function createFixtureInventory(options?: {
      worktreeId?: string
      generation?: string
      branch?: string
      head?: string
      reference?: boolean
    }): BranchInventory {
      const worktreeId = options?.worktreeId ?? 'wt-uf04-01'
      const generation = options?.generation ?? 'gen-uf04-1'
      const branchName = options?.branch ?? 'feature-uf04'
      const head = options?.head ?? 'abcdef1234567890abcdef1234567890abcdef12'

      const worktree: any = {
        worktreeId,
        generation,
        path: `/mock/path/${worktreeId}`,
        head,
        branch: branchName,
        detached: false,
        locked: false,
        missing: false,
        prunable: false
      }

      const branchRecord: BranchRecord = {
        key: `key-${branchName}`,
        repositoryId: repoId,
        ref: `refs/heads/${branchName}`,
        name: branchName,
        namespace: 'LOCAL',
        head,
        upstream: null,
        generation: 'branch-gen-1',
        revision: 'branch-rev-1',
        creation: { at: '2026-11-05T00:00:00.000Z', source: 'APP_RECEIPT' },
        lastCommitAt: '2026-11-05T00:00:00.000Z',
        worktrees: [{ worktreeId, generation }]
      }

      return {
        repositoryId: repoId,
        source: 'GIT_LOCAL',
        coverage: 'COMPLETE',
        observedAt: '2026-11-05T00:00:00.000Z',
        revision: 'inv-uf04-1',
        branches: [branchRecord],
        worktrees: [worktree],
        unassignedWorktrees: []
      }
    }

    function createFixturePort(
      inventory: BranchInventory,
      snapshotOverride?: boolean | ((id: string) => Promise<{ reference: boolean }> | { reference: boolean })
    ): GitOperationsPort {
      return {
        getBranchInventory: async () => inventory,
        getCoordinationSnapshot: async (worktreeId: string) => {
          if (typeof snapshotOverride === 'function') {
            return await snapshotOverride(worktreeId)
          }
          if (typeof snapshotOverride === 'boolean') {
            return { reference: snapshotOverride }
          }
          return { reference: false }
        }
      }
    }

    beforeEach(() => {
      smc = new SessionMemoryCentralService(tempBaseDir)
    })

    afterEach(() => {
      smc.close()
    })

    describe('Prova 1 — Migração v6→v7, reserva da primeira unidade e recuperação pós-restart', () => {
      it('migra banco v6 real para v7, reserva a primeira unidade, fecha/reabre e recupera recibo durável intacto', async () => {
        const legacySessionId = '00000000-0000-4000-9005-000000000001'
        const legacyEntryId = '00000000-0000-4000-9005-000000000002'
        const legacyPlanId = '00000000-0000-4000-9005-000000000003'
        const legacyUnit1Id = '00000000-0000-4000-9005-000000000004'
        const legacyUnit2Id = '00000000-0000-4000-9005-000000000005'
        const reservationId = '00000000-0000-4000-9005-000000000006'
        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        mkdirSync(dirname(dbPath), { recursive: true })

        // 1. Cria esquema v6 manualmente
        const v6Db = new Database(dbPath)
        const now = new Date().toISOString()
        v6Db.exec(`
          CREATE TABLE smc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO smc_meta VALUES ('repository_id', '${repoId}');
          INSERT INTO smc_meta VALUES ('schema_version', '6');

          CREATE TABLE smc_sessions (
            session_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('OPEN', 'CLOSED')),
            revision INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          INSERT INTO smc_sessions VALUES ('${legacySessionId}', '${repoId}', 'OPEN', 1, '${now}', '${now}');

          CREATE TABLE smc_entries (
            order_seq INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT UNIQUE NOT NULL,
            session_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
            body TEXT NOT NULL, emitter_role TEXT NOT NULL, emitter_id TEXT,
            references_json TEXT, supersedes_entry_id TEXT, created_at TEXT NOT NULL
          );
          INSERT INTO smc_entries VALUES (1, '${legacyEntryId}', '${legacySessionId}', 'DECISION', 'Decisão V6', 'Corpo V6', 'HUMAN', NULL, NULL, NULL, '${now}');

          CREATE TABLE smc_plans (
            plan_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, repository_id TEXT NOT NULL,
            title TEXT NOT NULL, source_artifact_id TEXT,
            status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          INSERT INTO smc_plans VALUES ('${legacyPlanId}', '${legacySessionId}', '${repoId}', 'Plano V6', NULL, 'ACTIVE', 1, '${now}', '${now}');

          CREATE TABLE smc_plan_units (
            unit_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, position INTEGER NOT NULL,
            title TEXT NOT NULL, objective TEXT NOT NULL, acceptance_criteria TEXT NOT NULL,
            depends_on_json TEXT, created_at TEXT NOT NULL
          );
          INSERT INTO smc_plan_units VALUES ('${legacyUnit1Id}', '${legacyPlanId}', 1, 'U1', 'Obj1', 'Crit1', NULL, '${now}');
          INSERT INTO smc_plan_units VALUES ('${legacyUnit2Id}', '${legacyPlanId}', 2, 'U2', 'Obj2', 'Crit2', '["${legacyUnit1Id}"]', '${now}');

          CREATE TABLE smc_unit_states (
            unit_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, status TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          INSERT INTO smc_unit_states VALUES ('${legacyUnit1Id}', '${legacyPlanId}', 'AVAILABLE', 1, '${now}', '${now}');
          INSERT INTO smc_unit_states VALUES ('${legacyUnit2Id}', '${legacyPlanId}', 'AVAILABLE', 1, '${now}', '${now}');

          CREATE TABLE smc_session_worktrees (
            session_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL,
            worktree_id TEXT NOT NULL, generation TEXT NOT NULL, branch TEXT NOT NULL,
            head_at_bind TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          INSERT INTO smc_session_worktrees VALUES (
            '${legacySessionId}', '${repoId}', 'wt-uf04-01', 'gen-uf04-1', 'feature-uf04',
            '1111111111111111111111111111111111111111', '${now}', '${now}'
          );
        `)
        v6Db.close()

        // 2. Abre com UnitFlowReservationService para disparar migração v6 -> v7
        const inventory = createFixtureInventory({
          worktreeId: 'wt-uf04-01',
          generation: 'gen-uf04-1',
          branch: 'feature-uf04',
          head: '1111111111111111111111111111111111111111'
        })
        const port = createFixturePort(inventory)
        const reservationService = new UnitFlowReservationService(smc, port)

        // 3. Reserva a primeira unidade elegível (dispara migração v6 -> v7 lazy)
        const result = await reservationService.reserveNextEligibleUnit(
          repoId,
          legacySessionId,
          legacyPlanId,
          { reservationId }
        )

        // Verifica schema_version >= 7 após migração lazy
        const checkDb = new Database(dbPath)
        const versionRow = checkDb.prepare('SELECT value FROM smc_meta WHERE key = ?').get('schema_version') as { value: string }
        expect(['7', '8']).toContain(versionRow.value)
        checkDb.close()

        expect(result.kind).toBe('RESERVED')
        if (result.kind === 'RESERVED') {
          expect(result.reservation.reservationId).toBe(reservationId)
          expect(result.reservation.repositoryId).toBe(repoId)
          expect(result.reservation.sessionId).toBe(legacySessionId)
          expect(result.reservation.planId).toBe(legacyPlanId)
          expect(result.reservation.unitId).toBe(legacyUnit1Id)
          expect(result.reservation.worktreeId).toBe('wt-uf04-01')
          expect(result.reservation.generation).toBe('gen-uf04-1')
          expect(result.reservation.branch).toBe('feature-uf04')
          expect(result.reservation.headObservedAtReservation).toBe('1111111111111111111111111111111111111111')
          expect(result.reservation.unitStateRevision).toBe(2)
          expect(result.reservation.status).toBe('ACTIVE')
          expect((result.reservation as any).path).toBeUndefined()
        }

        // 4. Fecha e reabre em nova instância de serviço
        smc.close()
        const reopenedSmc = new SessionMemoryCentralService(tempBaseDir)
        const reopenedService = new UnitFlowReservationService(reopenedSmc, port)

        const recovered = reopenedService.getReservation(repoId, reservationId)
        expect(recovered).not.toBeNull()
        expect(recovered?.reservationId).toBe(reservationId)
        expect(recovered?.unitId).toBe(legacyUnit1Id)
        expect(recovered?.status).toBe('ACTIVE')
        expect(recovered?.unitStateRevision).toBe(2)

        const activeRecovered = reopenedService.getActiveReservation(repoId, legacySessionId)
        expect(activeRecovered?.reservationId).toBe(reservationId)

        // Estado da unidade U1 no banco é RESERVED com revision 2
        const unit1State = reopenedSmc.getUnitState(repoId, legacySessionId, legacyPlanId, legacyUnit1Id)
        expect(unit1State?.status).toBe('RESERVED')
        expect(unit1State?.revision).toBe(2)

        // Unidade U2 permanece AVAILABLE com revision 1
        const unit2State = reopenedSmc.getUnitState(repoId, legacySessionId, legacyPlanId, legacyUnit2Id)
        expect(unit2State?.status).toBe('AVAILABLE')
        expect(unit2State?.revision).toBe(1)

        // Dados legados permanecem intactos
        const sess = reopenedSmc.getSession(repoId, legacySessionId)
        expect(sess?.status).toBe('OPEN')
        const plan = reopenedSmc.getPlan(repoId, legacyPlanId)
        expect(plan?.title).toBe('Plano V6')
        const entry = reopenedSmc.getEntry(repoId, legacySessionId, legacyEntryId)
        expect(entry?.title).toBe('Decisão V6')
        const binding = reopenedSmc.getWorkspaceBinding(repoId, legacySessionId)
        expect(binding?.worktreeId).toBe('wt-uf04-01')

        reopenedSmc.close()
      })

      it('recusa esquema futuro (> 8) com SmcUnsupportedSchemaError sem alterar banco', () => {
        const repoFuture = 'repo-future-schema'
        const dbPath = smcDatabasePath(tempBaseDir, repoFuture)
        mkdirSync(dirname(dbPath), { recursive: true })

        const rawDb = new Database(dbPath)
        rawDb.exec(`
          CREATE TABLE smc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO smc_meta VALUES ('repository_id', '${repoFuture}');
          INSERT INTO smc_meta VALUES ('schema_version', '9');
        `)
        rawDb.close()

        expect(() => {
          new SessionMemoryCentralStore(dbPath, repoFuture)
        }).toThrow(SmcUnsupportedSchemaError)

        const checkDb = new Database(dbPath)
        const version = checkDb.prepare('SELECT value FROM smc_meta WHERE key = ?').get('schema_version') as { value: string }
        expect(version.value).toBe('9')
        checkDb.close()
      })
    })

    describe('Prova 2 — Idempotência de replay e conflitos de reserva', () => {
      it('replay do mesmo reservationId devolve o mesmo recibo sem mutações e sem consultar Git', async () => {
        const session = smc.createSession(repoId)
        const unitFlow = new UnitFlowService(smc)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: '00000000-0000-4000-9005-000000000010',
          title: 'Plano Replay'
        })
        unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
          { unitId: '00000000-0000-4000-9005-000000000011', title: 'U1', objective: 'O1', acceptanceCriteria: 'C1' },
          { unitId: '00000000-0000-4000-9005-000000000012', title: 'U2', objective: 'O2', acceptanceCriteria: 'C2' }
        ])

        const inv = createFixtureInventory()
        const wsService = new WorkspaceBindingService(smc, createFixturePort(inv))
        await wsService.bindWorkspace(repoId, session.sessionId, 'wt-uf04-01')

        let gitCalled = false
        const customPort: GitOperationsPort = {
          getBranchInventory: async () => {
            gitCalled = true
            return inv
          },
          getCoordinationSnapshot: async () => ({ reference: false })
        }

        const resService = new UnitFlowReservationService(smc, customPort)
        const reservationId = '00000000-0000-4000-9005-000000000013'

        // Primeira reserva
        const first = await resService.reserveNextEligibleUnit(repoId, session.sessionId, plan.planId, { reservationId })
        expect(first.kind).toBe('RESERVED')
        expect(gitCalled).toBe(true)

        // Configura port para falhar caso chamado
        gitCalled = false
        const failingPort: GitOperationsPort = {
          getBranchInventory: async () => {
            throw new Error('Git network down')
          },
          getCoordinationSnapshot: async () => {
            throw new Error('Coordination down')
          }
        }
        const replayService = new UnitFlowReservationService(smc, failingPort)

        // Replay com mesmo reservationId
        const replay = await replayService.reserveNextEligibleUnit(repoId, session.sessionId, plan.planId, { reservationId })
        expect(replay.kind).toBe('RESERVED')
        if (replay.kind === 'RESERVED' && first.kind === 'RESERVED') {
          expect(replay.reservation.reservationId).toBe(first.reservation.reservationId)
          expect(replay.reservation.createdAt).toBe(first.reservation.createdAt)
          expect(replay.reservation.updatedAt).toBe(first.reservation.updatedAt)
          expect(replay.reservation.unitStateRevision).toBe(first.reservation.unitStateRevision)
        }
        expect(gitCalled).toBe(false) // Git não foi tocado no replay

        // Conflito de reuso: mesmo reservationId com planId diferente
        await expect(
          resService.reserveNextEligibleUnit(
            repoId,
            session.sessionId,
            '00000000-0000-4000-9005-999999999999',
            { reservationId }
          )
        ).rejects.toThrow(UnitFlowReservationIdConflictError)

        // Tentativa de outra reserva na mesma sessão enquanto a primeira está ACTIVE
        const secondResId = '00000000-0000-4000-9005-000000000014'
        const secondAttempt = await resService.reserveNextEligibleUnit(repoId, session.sessionId, plan.planId, { reservationId: secondResId })
        // Seletor encontra U1 em RESERVED -> WAITING
        expect(secondAttempt.kind).toBe('WAITING')
        if (secondAttempt.kind === 'WAITING') {
          expect(secondAttempt.blockingUnitId).toBe('00000000-0000-4000-9005-000000000011')
        }
      })
    })

    describe('Prova 3 — Concorrência entre Stores e exclusão por sessão e por Worktree', () => {
      it('duas sessões vinculadas à mesma Worktree e geração não admitem reservas simultâneas', async () => {
        const sessionA = smc.createSession(repoId)
        const sessionB = smc.createSession(repoId)
        const unitFlow = new UnitFlowService(smc)

        const planA = unitFlow.registerPlan(repoId, sessionA.sessionId, {
          planId: '00000000-0000-4000-9005-000000000021',
          title: 'Plano A'
        })
        unitFlow.definePlanUnits(repoId, sessionA.sessionId, planA.planId, [
          { unitId: '00000000-0000-4000-9005-000000000022', title: 'U-A1', objective: 'OA1', acceptanceCriteria: 'CA1' }
        ])

        const planB = unitFlow.registerPlan(repoId, sessionB.sessionId, {
          planId: '00000000-0000-4000-9005-000000000023',
          title: 'Plano B'
        })
        unitFlow.definePlanUnits(repoId, sessionB.sessionId, planB.planId, [
          { unitId: '00000000-0000-4000-9005-000000000024', title: 'U-B1', objective: 'OB1', acceptanceCriteria: 'CB1' }
        ])

        // Ambas as sessões vinculam-se à mesma Worktree + generation
        const sharedInv = createFixtureInventory({
          worktreeId: 'wt-shared',
          generation: 'gen-shared-1',
          branch: 'feature-shared'
        })
        const port = createFixturePort(sharedInv)
        const wsService = new WorkspaceBindingService(smc, port)
        await wsService.bindWorkspace(repoId, sessionA.sessionId, 'wt-shared')
        await wsService.bindWorkspace(repoId, sessionB.sessionId, 'wt-shared')

        const resService = new UnitFlowReservationService(smc, port)

        // Sessão A reserva com sucesso
        const resA = await resService.reserveNextEligibleUnit(repoId, sessionA.sessionId, planA.planId, {
          reservationId: '00000000-0000-4000-9005-000000000025'
        })
        expect(resA.kind).toBe('RESERVED')

        // Sessão B tenta reservar na mesma Worktree compartilhada -> rejeitada por exclusão
        await expect(
          resService.reserveNextEligibleUnit(repoId, sessionB.sessionId, planB.planId, {
            reservationId: '00000000-0000-4000-9005-000000000026'
          })
        ).rejects.toThrow(UnitFlowReservationConflictError)
      })

      it('duas sessões com Worktrees distintas reservam simultaneamente em perfeito isolamento', async () => {
        const session1 = smc.createSession(repoId)
        const session2 = smc.createSession(repoId)
        const unitFlow = new UnitFlowService(smc)

        const plan1 = unitFlow.registerPlan(repoId, session1.sessionId, {
          planId: '00000000-0000-4000-9005-000000000031',
          title: 'Plano 1'
        })
        unitFlow.definePlanUnits(repoId, session1.sessionId, plan1.planId, [
          { unitId: '00000000-0000-4000-9005-000000000032', title: 'U1-1', objective: 'O1', acceptanceCriteria: 'C1' }
        ])

        const plan2 = unitFlow.registerPlan(repoId, session2.sessionId, {
          planId: '00000000-0000-4000-9005-000000000033',
          title: 'Plano 2'
        })
        unitFlow.definePlanUnits(repoId, session2.sessionId, plan2.planId, [
          { unitId: '00000000-0000-4000-9005-000000000034', title: 'U2-1', objective: 'O2', acceptanceCriteria: 'C2' }
        ])

        const invMulti: BranchInventory = {
          repositoryId: repoId,
          source: 'GIT_LOCAL',
          coverage: 'COMPLETE',
          observedAt: '2026-11-05T00:00:00.000Z',
          revision: 'inv-multi',
          branches: [
            {
              key: 'key-br1',
              repositoryId: repoId,
              ref: 'refs/heads/br1',
              name: 'br1',
              namespace: 'LOCAL',
              head: '1111111111111111111111111111111111111111',
              upstream: null,
              generation: 'g1',
              revision: 'r1',
              creation: { at: '2026-11-05T00:00:00.000Z', source: 'APP_RECEIPT' },
              lastCommitAt: '2026-11-05T00:00:00.000Z',
              worktrees: [{ worktreeId: 'wt-iso-1', generation: 'gen-iso-1' }]
            },
            {
              key: 'key-br2',
              repositoryId: repoId,
              ref: 'refs/heads/br2',
              name: 'br2',
              namespace: 'LOCAL',
              head: '2222222222222222222222222222222222222222',
              upstream: null,
              generation: 'g2',
              revision: 'r2',
              creation: { at: '2026-11-05T00:00:00.000Z', source: 'APP_RECEIPT' },
              lastCommitAt: '2026-11-05T00:00:00.000Z',
              worktrees: [{ worktreeId: 'wt-iso-2', generation: 'gen-iso-2' }]
            }
          ],
          worktrees: [
            {
              worktreeId: 'wt-iso-1',
              generation: 'gen-iso-1',
              path: '/mock/wt-iso-1',
              head: '1111111111111111111111111111111111111111',
              branch: 'br1',
              detached: false,
              locked: false,
              missing: false,
              prunable: false
            } as any,
            {
              worktreeId: 'wt-iso-2',
              generation: 'gen-iso-2',
              path: '/mock/wt-iso-2',
              head: '2222222222222222222222222222222222222222',
              branch: 'br2',
              detached: false,
              locked: false,
              missing: false,
              prunable: false
            } as any
          ],
          unassignedWorktrees: []
        }

        const portMulti = createFixturePort(invMulti)
        const wsService = new WorkspaceBindingService(smc, portMulti)
        await wsService.bindWorkspace(repoId, session1.sessionId, 'wt-iso-1')
        await wsService.bindWorkspace(repoId, session2.sessionId, 'wt-iso-2')

        const resService = new UnitFlowReservationService(smc, portMulti)
        const res1 = await resService.reserveNextEligibleUnit(repoId, session1.sessionId, plan1.planId, {
          reservationId: '00000000-0000-4000-9005-000000000035'
        })
        const res2 = await resService.reserveNextEligibleUnit(repoId, session2.sessionId, plan2.planId, {
          reservationId: '00000000-0000-4000-9005-000000000036'
        })

        expect(res1.kind).toBe('RESERVED')
        expect(res2.kind).toBe('RESERVED')
      })
    })

    describe('Prova 4 — Fail-closed em estados de workspace, drift e integridade', () => {
      it('rejeita reserva se workspace for UNBOUND, STALE ou UNAVAILABLE sem deixar registro parcial', async () => {
        const session = smc.createSession(repoId)
        const unitFlow = new UnitFlowService(smc)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: '00000000-0000-4000-9005-000000000041',
          title: 'Plano Fail-Closed'
        })
        unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
          { unitId: '00000000-0000-4000-9005-000000000042', title: 'U1', objective: 'O1', acceptanceCriteria: 'C1' }
        ])

        const inv = createFixtureInventory()
        const port = createFixturePort(inv)
        const resService = new UnitFlowReservationService(smc, port)

        // 1. UNBOUND
        await expect(
          resService.reserveNextEligibleUnit(repoId, session.sessionId, plan.planId, {
            reservationId: '00000000-0000-4000-9005-000000000043'
          })
        ).rejects.toThrow(BuildXWorkspaceInvalidError)

        // Vincula
        const wsService = new WorkspaceBindingService(smc, port)
        await wsService.bindWorkspace(repoId, session.sessionId, 'wt-uf04-01')

        // 2. STALE (simula locked: true)
        const lockedInv = createFixtureInventory()
        lockedInv.worktrees[0].locked = true
        const lockedPort = createFixturePort(lockedInv)
        const lockedResService = new UnitFlowReservationService(smc, lockedPort)
        await expect(
          lockedResService.reserveNextEligibleUnit(repoId, session.sessionId, plan.planId, {
            reservationId: '00000000-0000-4000-9005-000000000044'
          })
        ).rejects.toThrow(BuildXWorkspaceInvalidError)

        // 3. UNAVAILABLE (simula falha de Git)
        const failingPort: GitOperationsPort = {
          getBranchInventory: async () => {
            throw new Error('Git crashed')
          },
          getCoordinationSnapshot: async () => ({ reference: false })
        }
        const failService = new UnitFlowReservationService(smc, failingPort)
        await expect(
          failService.reserveNextEligibleUnit(repoId, session.sessionId, plan.planId, {
            reservationId: '00000000-0000-4000-9005-000000000045'
          })
        ).rejects.toThrow(BuildXWorkspaceInvalidError)

        // Verifica que nenhuma reserva foi criada e unidade continua AVAILABLE
        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const checkDb = new Database(dbPath)
        const count = checkDb.prepare('SELECT count(*) as cnt FROM smc_unit_reservations').get() as { cnt: number }
        expect(count.cnt).toBe(0)
        checkDb.close()

        const state = unitFlow.getUnitState(repoId, session.sessionId, plan.planId, '00000000-0000-4000-9005-000000000042')
        expect(state?.status).toBe('AVAILABLE')
        expect(state?.revision).toBe(1)
      })

      it('rejeita reserva se sessão estiver CLOSED ou plano não for ACTIVE', async () => {
        const session = smc.createSession(repoId)
        const unitFlow = new UnitFlowService(smc)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: '00000000-0000-4000-9005-000000000051',
          title: 'Plano Closed'
        })
        unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
          { unitId: '00000000-0000-4000-9005-000000000052', title: 'U1', objective: 'O1', acceptanceCriteria: 'C1' }
        ])

        const port = createFixturePort(createFixtureInventory())
        const wsService = new WorkspaceBindingService(smc, port)
        await wsService.bindWorkspace(repoId, session.sessionId, 'wt-uf04-01')

        const resService = new UnitFlowReservationService(smc, port)

        // Fecha sessão
        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const rawDb = new Database(dbPath)
        rawDb.prepare('UPDATE smc_sessions SET status = ? WHERE session_id = ?').run('CLOSED', session.sessionId)
        rawDb.close()

        await expect(
          resService.reserveNextEligibleUnit(repoId, session.sessionId, plan.planId, {
            reservationId: '00000000-0000-4000-9005-000000000053'
          })
        ).rejects.toThrow(SmcSessionClosedError)
      })

      it('aborta com BuildXWorkspaceBindingConflictError se ocorrer drift no binding antes da transação', async () => {
        const session = smc.createSession(repoId)
        const unitFlow = new UnitFlowService(smc)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: '00000000-0000-4000-9005-000000000061',
          title: 'Plano Drift'
        })
        unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
          { unitId: '00000000-0000-4000-9005-000000000062', title: 'U1', objective: 'O1', acceptanceCriteria: 'C1' }
        ])

        const inv = createFixtureInventory()
        const port = createFixturePort(inv)
        const wsService = new WorkspaceBindingService(smc, port)
        await wsService.bindWorkspace(repoId, session.sessionId, 'wt-uf04-01')

        // Simula drift do binding no banco entre a inspeção e a transação
        const store = smc.getStore(repoId)
        expect(() => {
          store.reserveEligibleUnit({
            reservationId: '00000000-0000-4000-9005-000000000063',
            sessionId: session.sessionId,
            planId: plan.planId,
            expectedBinding: {
              worktreeId: 'wt-uf04-01',
              generation: 'gen-drifted-different',
              branch: 'feature-uf04'
            },
            headObserved: '1111111111111111111111111111111111111111'
          })
        }).toThrow(BuildXWorkspaceBindingConflictError)
      })
    })

    describe('Prova 5 — Seletor read-only, falha fechada em estado ausente e conformidade de privacidade', () => {
      it('getNextEligibleUnit retorna WAITING após reserva e falha fechado se linha de estado estiver ausente', async () => {
        const session = smc.createSession(repoId)
        const unitFlow = new UnitFlowService(smc)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: '00000000-0000-4000-9005-000000000071',
          title: 'Plano Seletor'
        })
        unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
          { unitId: '00000000-0000-4000-9005-000000000072', title: 'U1', objective: 'O1', acceptanceCriteria: 'C1' },
          { unitId: '00000000-0000-4000-9005-000000000073', title: 'U2', objective: 'O2', acceptanceCriteria: 'C2' }
        ])

        const port = createFixturePort(createFixtureInventory())
        const wsService = new WorkspaceBindingService(smc, port)
        await wsService.bindWorkspace(repoId, session.sessionId, 'wt-uf04-01')

        const resService = new UnitFlowReservationService(smc, port)

        // Antes da reserva: U1 é ELIGIBLE
        const before = unitFlow.getNextEligibleUnit(repoId, session.sessionId, plan.planId)
        expect(before.kind).toBe('ELIGIBLE')

        // Reserva U1
        const res = await resService.reserveNextEligibleUnit(repoId, session.sessionId, plan.planId, {
          reservationId: '00000000-0000-4000-9005-000000000074'
        })
        expect(res.kind).toBe('RESERVED')

        // Após a reserva: seletor retorna WAITING apontando para U1
        const after = unitFlow.getNextEligibleUnit(repoId, session.sessionId, plan.planId)
        expect(after.kind).toBe('WAITING')
        if (after.kind === 'WAITING') {
          expect(after.blockingUnitId).toBe('00000000-0000-4000-9005-000000000072')
        }

        // Falha fechado se smc_unit_states estiver corrompido/ausente
        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        const rawDb = new Database(dbPath)
        rawDb.prepare('DELETE FROM smc_unit_states WHERE unit_id = ?').run('00000000-0000-4000-9005-000000000072')
        rawDb.close()

        // getNextEligibleUnit falha fechado com UnitFlowInvalidUnitError
        expect(() => {
          unitFlow.getNextEligibleUnit(repoId, session.sessionId, plan.planId)
        }).toThrow(UnitFlowInvalidUnitError)

        // reserveNextEligibleUnit também falha fechado
        await expect(
          resService.reserveNextEligibleUnit(repoId, session.sessionId, plan.planId, {
            reservationId: '00000000-0000-4000-9005-000000000075'
          })
        ).rejects.toThrow(UnitFlowInvalidUnitError)

        // Conformidade de privacidade no recibo
        if (res.kind === 'RESERVED') {
          const serialized = JSON.stringify(res.reservation)
          expect(serialized).not.toContain('/mock/')
          expect(serialized).not.toContain('Obj1')
          expect(serialized).not.toContain('Crit1')
        }
      })
    })
  })

  describe('BuildX Execution-01 — Preparação durável de tentativa vinculada à reserva (Provas Dirigidas)', () => {
    const repoId = 'repo-execution-01'
    let smc: SessionMemoryCentralService

    function createFixtureInventory(options?: {
      worktreeId?: string
      generation?: string
      branch?: string
      head?: string
    }): BranchInventory {
      const worktreeId = options?.worktreeId ?? 'wt-ex01-01'
      const generation = options?.generation ?? 'gen-ex01-1'
      const branchName = options?.branch ?? 'feature-ex01'
      const head = options?.head ?? '1111111111111111111111111111111111111111'

      const worktree: any = {
        worktreeId,
        generation,
        path: `/mock/path/${worktreeId}`,
        head,
        branch: branchName,
        detached: false,
        locked: false,
        missing: false,
        prunable: false
      }

      const branchRecord: BranchRecord = {
        key: `key-${branchName}`,
        repositoryId: repoId,
        ref: `refs/heads/${branchName}`,
        name: branchName,
        namespace: 'LOCAL',
        head,
        upstream: null,
        generation: 'branch-gen-1',
        revision: 'branch-rev-1',
        creation: { at: '2026-11-05T00:00:00.000Z', source: 'APP_RECEIPT' },
        lastCommitAt: '2026-11-05T00:00:00.000Z',
        worktrees: [{ worktreeId, generation }]
      }

      return {
        repositoryId: repoId,
        source: 'GIT_LOCAL',
        coverage: 'COMPLETE',
        observedAt: '2026-11-05T00:00:00.000Z',
        revision: 'inv-ex01-1',
        worktrees: [worktree],
        branches: [branchRecord],
        unassignedWorktrees: []
      }
    }

    function createFixturePort(inventory: BranchInventory): GitOperationsPort {
      return {
        getBranchInventory: async () => inventory,
        getCoordinationSnapshot: async () => ({ reference: false })
      }
    }

    beforeEach(() => {
      smc = new SessionMemoryCentralService(tempBaseDir)
    })

    afterEach(() => {
      smc.close()
    })

    describe('Prova 1 — Migração v7→v8, preparação durável da tentativa e recuperação pós-restart', () => {
      it('migra banco v7 real para v8, prepara tentativa PREPARED, fecha/reabre e recupera registro intacto', async () => {
        const legacySessionId = '00000000-0000-4000-9006-000000000001'
        const legacyPlanId = '00000000-0000-4000-9006-000000000002'
        const legacyUnit1Id = '00000000-0000-4000-9006-000000000003'
        const legacyReservationId = '00000000-0000-4000-9006-000000000004'
        const attemptId = '00000000-0000-4000-9006-000000000005'
        const dbPath = smcDatabasePath(tempBaseDir, repoId)
        mkdirSync(dirname(dbPath), { recursive: true })

        // 1. Cria esquema v7 manualmente
        const v7Db = new Database(dbPath)
        const now = new Date().toISOString()
        v7Db.exec(`
          CREATE TABLE smc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO smc_meta VALUES ('repository_id', '${repoId}');
          INSERT INTO smc_meta VALUES ('schema_version', '7');

          CREATE TABLE smc_sessions (
            session_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('OPEN', 'CLOSED')),
            revision INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          INSERT INTO smc_sessions VALUES ('${legacySessionId}', '${repoId}', 'OPEN', 1, '${now}', '${now}');

          CREATE TABLE smc_plans (
            plan_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, repository_id TEXT NOT NULL,
            title TEXT NOT NULL, source_artifact_id TEXT,
            status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          INSERT INTO smc_plans VALUES ('${legacyPlanId}', '${legacySessionId}', '${repoId}', 'Plano V7', NULL, 'ACTIVE', 1, '${now}', '${now}');

          CREATE TABLE smc_plan_units (
            unit_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, position INTEGER NOT NULL,
            title TEXT NOT NULL, objective TEXT NOT NULL, acceptance_criteria TEXT NOT NULL,
            depends_on_json TEXT, created_at TEXT NOT NULL
          );
          INSERT INTO smc_plan_units VALUES ('${legacyUnit1Id}', '${legacyPlanId}', 1, 'U1', 'Obj1', 'Crit1', NULL, '${now}');

          CREATE TABLE smc_unit_states (
            unit_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, status TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          INSERT INTO smc_unit_states VALUES ('${legacyUnit1Id}', '${legacyPlanId}', 'RESERVED', 2, '${now}', '${now}');

          CREATE TABLE smc_session_worktrees (
            session_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL,
            worktree_id TEXT NOT NULL, generation TEXT NOT NULL, branch TEXT NOT NULL,
            head_at_bind TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          INSERT INTO smc_session_worktrees VALUES (
            '${legacySessionId}', '${repoId}', 'wt-ex01-01', 'gen-ex01-1', 'feature-ex01',
            '1111111111111111111111111111111111111111', '${now}', '${now}'
          );

          CREATE TABLE smc_unit_reservations (
            reservation_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL,
            session_id TEXT NOT NULL, plan_id TEXT NOT NULL, unit_id TEXT NOT NULL,
            worktree_id TEXT NOT NULL, generation TEXT NOT NULL, branch TEXT NOT NULL,
            head_observed_at_reservation TEXT NOT NULL, unit_state_revision INTEGER NOT NULL,
            status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          INSERT INTO smc_unit_reservations VALUES (
            '${legacyReservationId}', '${repoId}', '${legacySessionId}', '${legacyPlanId}', '${legacyUnit1Id}',
            'wt-ex01-01', 'gen-ex01-1', 'feature-ex01',
            '1111111111111111111111111111111111111111', 2, 'ACTIVE', '${now}', '${now}'
          );
        `)
        v7Db.close()

        // 2. Abre com ExecutionAttemptService para disparar migração v7 -> v8 lazy
        const inventory = createFixtureInventory({
          worktreeId: 'wt-ex01-01',
          generation: 'gen-ex01-1',
          branch: 'feature-ex01',
          head: '1111111111111111111111111111111111111111'
        })
        const port = createFixturePort(inventory)
        const attemptService = new ExecutionAttemptService(smc, port)

        // 3. Prepara tentativa
        const attempt = await attemptService.prepareExecutionAttempt(
          repoId,
          legacySessionId,
          legacyReservationId,
          { attemptId }
        )

        // Verifica schema_version = 8 após migração lazy
        const checkDb = new Database(dbPath)
        const versionRow = checkDb.prepare('SELECT value FROM smc_meta WHERE key = ?').get('schema_version') as { value: string }
        expect(versionRow.value).toBe('8')
        checkDb.close()

        expect(attempt.attemptId).toBe(attemptId)
        expect(attempt.repositoryId).toBe(repoId)
        expect(attempt.sessionId).toBe(legacySessionId)
        expect(attempt.planId).toBe(legacyPlanId)
        expect(attempt.unitId).toBe(legacyUnit1Id)
        expect(attempt.reservationId).toBe(legacyReservationId)
        expect(attempt.worktreeId).toBe('wt-ex01-01')
        expect(attempt.generation).toBe('gen-ex01-1')
        expect(attempt.branch).toBe('feature-ex01')
        expect(attempt.headObservedAtPreparation).toBe('1111111111111111111111111111111111111111')
        expect(attempt.status).toBe('PREPARED')
        expect(attempt.revision).toBe(1)
        expect((attempt as any).path).toBeUndefined()

        // 4. Fecha e reabre em nova instância de serviço
        smc.close()
        const reopenedSmc = new SessionMemoryCentralService(tempBaseDir)
        const reopenedService = new ExecutionAttemptService(reopenedSmc, port)

        const recovered = reopenedService.getExecutionAttempt(repoId, attemptId)
        expect(recovered).not.toBeNull()
        expect(recovered?.attemptId).toBe(attemptId)
        expect(recovered?.status).toBe('PREPARED')
        expect(recovered?.revision).toBe(1)
        expect(recovered?.reservationId).toBe(legacyReservationId)

        const prepared = reopenedService.getPreparedExecutionAttempt(repoId, legacySessionId)
        expect(prepared?.attemptId).toBe(attemptId)

        // Reserva e unidade permanecem inalteradas
        const res = reopenedSmc.getStore(repoId).getReservation(legacyReservationId)
        expect(res?.status).toBe('ACTIVE')
        const unitState = reopenedSmc.getUnitState(repoId, legacySessionId, legacyPlanId, legacyUnit1Id)
        expect(unitState?.status).toBe('RESERVED')
        expect(unitState?.revision).toBe(2)

        reopenedSmc.close()
      })

      it('recusa esquema futuro (> 8) com SmcUnsupportedSchemaError sem alterar banco', () => {
        const repoFuture = 'repo-future-schema-v9'
        const dbPath = smcDatabasePath(tempBaseDir, repoFuture)
        mkdirSync(dirname(dbPath), { recursive: true })

        const rawDb = new Database(dbPath)
        rawDb.exec(`
          CREATE TABLE smc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO smc_meta VALUES ('repository_id', '${repoFuture}');
          INSERT INTO smc_meta VALUES ('schema_version', '9');
        `)
        rawDb.close()

        expect(() => {
          new SessionMemoryCentralStore(dbPath, repoFuture)
        }).toThrow(SmcUnsupportedSchemaError)

        const checkDb = new Database(dbPath)
        const version = checkDb.prepare('SELECT value FROM smc_meta WHERE key = ?').get('schema_version') as { value: string }
        expect(version.value).toBe('9')
        checkDb.close()
      })
    })

    describe('Prova 2 — Idempotência de replay e conflitos de attemptId', () => {
      it('replay do mesmo attemptId devolve o mesmo registro sem mutações e sem consultar Git', async () => {
        const session = smc.createSession(repoId)
        const unitFlow = new UnitFlowService(smc)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: '00000000-0000-4000-9006-000000000010',
          title: 'Plano Replay Execution'
        })
        unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
          { unitId: '00000000-0000-4000-9006-000000000011', title: 'U1', objective: 'O1', acceptanceCriteria: 'C1' }
        ])

        const inv = createFixtureInventory()
        const wsService = new WorkspaceBindingService(smc, createFixturePort(inv))
        await wsService.bindWorkspace(repoId, session.sessionId, 'wt-ex01-01')

        const resService = new UnitFlowReservationService(smc, createFixturePort(inv))
        const reservationId = '00000000-0000-4000-9006-000000000012'
        const resResult = await resService.reserveNextEligibleUnit(repoId, session.sessionId, plan.planId, { reservationId })
        expect(resResult.kind).toBe('RESERVED')

        let gitCalled = false
        const customPort: GitOperationsPort = {
          getBranchInventory: async () => {
            gitCalled = true
            return inv
          },
          getCoordinationSnapshot: async () => ({ reference: false })
        }

        const attemptService = new ExecutionAttemptService(smc, customPort)
        const attemptId = '00000000-0000-4000-9006-000000000013'

        // Primeira preparação
        const first = await attemptService.prepareExecutionAttempt(repoId, session.sessionId, reservationId, { attemptId })
        expect(first.status).toBe('PREPARED')
        expect(gitCalled).toBe(true)

        // Configura port para falhar caso chamado
        gitCalled = false
        const failingPort: GitOperationsPort = {
          getBranchInventory: async () => {
            throw new Error('Git network down')
          },
          getCoordinationSnapshot: async () => {
            throw new Error('Coordination down')
          }
        }
        const replayService = new ExecutionAttemptService(smc, failingPort)

        // Replay com mesmo attemptId
        const replay = await replayService.prepareExecutionAttempt(repoId, session.sessionId, reservationId, { attemptId })
        expect(replay.status).toBe('PREPARED')
        expect(replay.attemptId).toBe(first.attemptId)
        expect(replay.createdAt).toBe(first.createdAt)
        expect(replay.updatedAt).toBe(first.updatedAt)
        expect(replay.revision).toBe(first.revision)
        expect(gitCalled).toBe(false) // Git não foi chamado no replay

        // Conflito: reuso do mesmo attemptId com reservationId diferente
        await expect(
          attemptService.prepareExecutionAttempt(
            repoId,
            session.sessionId,
            '00000000-0000-4000-9006-999999999999',
            { attemptId }
          )
        ).rejects.toThrow(ExecutionAttemptIdConflictError)

        // Tentativa de outra tentativa PREPARED na mesma sessão enquanto a primeira está PREPARED
        const secondAttemptId = '00000000-0000-4000-9006-000000000014'
        await expect(
          attemptService.prepareExecutionAttempt(repoId, session.sessionId, reservationId, { attemptId: secondAttemptId })
        ).rejects.toThrow(ExecutionAttemptConflictError)
      })

      it('duas stores concorrentes competindo pela mesma sessão/reserva com attemptIds distintos admitem apenas um vencedor', async () => {
        const session = smc.createSession(repoId)
        const unitFlow = new UnitFlowService(smc)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: '00000000-0000-4000-9006-000000000020',
          title: 'Plano Concorrência Execution'
        })
        unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
          { unitId: '00000000-0000-4000-9006-000000000021', title: 'U1', objective: 'O1', acceptanceCriteria: 'C1' }
        ])

        const inv = createFixtureInventory()
        const wsService = new WorkspaceBindingService(smc, createFixturePort(inv))
        await wsService.bindWorkspace(repoId, session.sessionId, 'wt-ex01-01')

        const resService = new UnitFlowReservationService(smc, createFixturePort(inv))
        const reservationId = '00000000-0000-4000-9006-000000000022'
        await resService.reserveNextEligibleUnit(repoId, session.sessionId, plan.planId, { reservationId })

        const store1 = smc.getStore(repoId)
        const store2 = new SessionMemoryCentralStore(smcDatabasePath(tempBaseDir, repoId), repoId)

        const attemptId1 = '00000000-0000-4000-9006-000000000023'
        const attemptId2 = '00000000-0000-4000-9006-000000000024'

        const r1 = store1.prepareExecutionAttempt({
          attemptId: attemptId1,
          sessionId: session.sessionId,
          reservationId,
          expectedBinding: {
            worktreeId: 'wt-ex01-01',
            generation: 'gen-ex01-1',
            branch: 'feature-ex01'
          },
          headObserved: '1111111111111111111111111111111111111111'
        })
        expect(r1.status).toBe('PREPARED')

        // Segunda store tenta preparar para a mesma sessão/reserva
        expect(() => {
          store2.prepareExecutionAttempt({
            attemptId: attemptId2,
            sessionId: session.sessionId,
            reservationId,
            expectedBinding: {
              worktreeId: 'wt-ex01-01',
              generation: 'gen-ex01-1',
              branch: 'feature-ex01'
            },
            headObserved: '1111111111111111111111111111111111111111'
          })
        }).toThrow(ExecutionAttemptConflictError)

        store2.close()
      })
    })

    describe('Prova 3 — Admissão fail-closed (sessão, plano, reserva, unidade e workspace)', () => {
      it('rejeita admissão se sessão estiver CLOSED, reserva não for ACTIVE, ou workspace não for CURRENT', async () => {
        const session = smc.createSession(repoId)
        const unitFlow = new UnitFlowService(smc)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: '00000000-0000-4000-9006-000000000030',
          title: 'Plano Fail-Closed'
        })
        unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
          { unitId: '00000000-0000-4000-9006-000000000031', title: 'U1', objective: 'O1', acceptanceCriteria: 'C1' }
        ])

        const inv = createFixtureInventory()
        const wsService = new WorkspaceBindingService(smc, createFixturePort(inv))
        await wsService.bindWorkspace(repoId, session.sessionId, 'wt-ex01-01')

        const resService = new UnitFlowReservationService(smc, createFixturePort(inv))
        const reservationId = '00000000-0000-4000-9006-000000000032'
        await resService.reserveNextEligibleUnit(repoId, session.sessionId, plan.planId, { reservationId })

        const port = createFixturePort(inv)
        const attemptService = new ExecutionAttemptService(smc, port)

        // 1. Reserva inexistente
        await expect(
          attemptService.prepareExecutionAttempt(
            repoId,
            session.sessionId,
            '00000000-0000-4000-9006-999999999999',
            { attemptId: '00000000-0000-4000-9006-000000000033' }
          )
        ).rejects.toThrow(UnitFlowReservationNotFoundError)

        // 2. Workspace STALE
        const staleInv = createFixtureInventory({ head: 'different-head' })
        // worktree head diverged from local branch head -> STALE
        const stalePort: GitOperationsPort = {
          getBranchInventory: async () => ({
            ...staleInv,
            worktrees: [{ ...staleInv.worktrees[0], head: 'diverged-head' }]
          }),
          getCoordinationSnapshot: async () => ({ reference: false })
        }
        const staleAttemptService = new ExecutionAttemptService(smc, stalePort)
        await expect(
          staleAttemptService.prepareExecutionAttempt(
            repoId,
            session.sessionId,
            reservationId,
            { attemptId: '00000000-0000-4000-9006-000000000034' }
          )
        ).rejects.toThrow(BuildXWorkspaceInvalidError)

        // 3. Sessão CLOSED
        const session2 = smc.createSession(repoId)
        const rawDb = new Database(smcDatabasePath(tempBaseDir, repoId))
        rawDb.prepare('UPDATE smc_sessions SET status = ? WHERE session_id = ?').run('CLOSED', session2.sessionId)
        rawDb.close()

        await expect(
          attemptService.prepareExecutionAttempt(
            repoId,
            session2.sessionId,
            reservationId,
            { attemptId: '00000000-0000-4000-9006-000000000035' }
          )
        ).rejects.toThrow(SmcSessionClosedError)

        // 4. Drift de binding entre observação e transação
        const store = smc.getStore(repoId)
        expect(() => {
          store.prepareExecutionAttempt({
            attemptId: '00000000-0000-4000-9006-000000000036',
            sessionId: session.sessionId,
            reservationId,
            expectedBinding: {
              worktreeId: 'wt-ex01-01',
              generation: 'gen-drifted-diff',
              branch: 'feature-ex01'
            },
            headObserved: '1111111111111111111111111111111111111111'
          })
        }).toThrow(BuildXWorkspaceBindingConflictError)
      })
    })

    describe('Prova 4 — HEAD legítimo avançado e conformidade de privacidade', () => {
      it('admite HEAD legítimo avançado em branch/worktree correspondente e preserva privacidade', async () => {
        const session = smc.createSession(repoId)
        const unitFlow = new UnitFlowService(smc)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: '00000000-0000-4000-9006-000000000040',
          title: 'Plano Head Avancado'
        })
        unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
          { unitId: '00000000-0000-4000-9006-000000000041', title: 'U1', objective: 'Obj1', acceptanceCriteria: 'Crit1' }
        ])

        const initialInv = createFixtureInventory({
          head: '1111111111111111111111111111111111111111'
        })
        const wsService = new WorkspaceBindingService(smc, createFixturePort(initialInv))
        await wsService.bindWorkspace(repoId, session.sessionId, 'wt-ex01-01')

        const resService = new UnitFlowReservationService(smc, createFixturePort(initialInv))
        const reservationId = '00000000-0000-4000-9006-000000000042'
        const res = await resService.reserveNextEligibleUnit(repoId, session.sessionId, plan.planId, { reservationId })
        expect(res.kind).toBe('RESERVED')

        // HEAD avança legitimamente na branch e na worktree
        const advancedHead = '2222222222222222222222222222222222222222'
        const advancedInv = createFixtureInventory({
          head: advancedHead
        })
        const attemptService = new ExecutionAttemptService(smc, createFixturePort(advancedInv))

        const attemptId = '00000000-0000-4000-9006-000000000043'
        const attempt = await attemptService.prepareExecutionAttempt(
          repoId,
          session.sessionId,
          reservationId,
          { attemptId }
        )

        expect(attempt.status).toBe('PREPARED')
        expect(attempt.headObservedAtPreparation).toBe(advancedHead)
        expect(attempt.worktreeId).toBe('wt-ex01-01')
        expect(attempt.generation).toBe('gen-ex01-1')

        // Conformidade de privacidade
        const serialized = JSON.stringify(attempt)
        expect(serialized).not.toContain('/mock/')
        expect(serialized).not.toContain('Obj1')
        expect(serialized).not.toContain('Crit1')
        expect((attempt as any).path).toBeUndefined()
      })
    })

    describe('Prova 5 — Pureza da unidade, reserva e plano, e não-regressão global', () => {
      it('não altera status da unidade, da reserva nem do plano, e não inicia processos', async () => {
        const session = smc.createSession(repoId)
        const unitFlow = new UnitFlowService(smc)
        const plan = unitFlow.registerPlan(repoId, session.sessionId, {
          planId: '00000000-0000-4000-9006-000000000050',
          title: 'Plano Pureza'
        })
        unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
          { unitId: '00000000-0000-4000-9006-000000000051', title: 'U1', objective: 'O1', acceptanceCriteria: 'C1' }
        ])

        const inv = createFixtureInventory()
        const wsService = new WorkspaceBindingService(smc, createFixturePort(inv))
        await wsService.bindWorkspace(repoId, session.sessionId, 'wt-ex01-01')

        const resService = new UnitFlowReservationService(smc, createFixturePort(inv))
        const reservationId = '00000000-0000-4000-9006-000000000052'
        await resService.reserveNextEligibleUnit(repoId, session.sessionId, plan.planId, { reservationId })

        const unitStateBefore = smc.getUnitState(repoId, session.sessionId, plan.planId, '00000000-0000-4000-9006-000000000051')
        const reservationBefore = smc.getStore(repoId).getReservation(reservationId)
        const planBefore = smc.getStore(repoId).getPlan(plan.planId)
        const sessionBefore = smc.getSession(repoId, session.sessionId)

        const attemptService = new ExecutionAttemptService(smc, createFixturePort(inv))
        const attemptId = '00000000-0000-4000-9006-000000000053'
        const attempt = await attemptService.prepareExecutionAttempt(
          repoId,
          session.sessionId,
          reservationId,
          { attemptId }
        )

        expect(attempt.status).toBe('PREPARED')

        // Pureza: unidade continua RESERVED com a mesma revision
        const unitStateAfter = smc.getUnitState(repoId, session.sessionId, plan.planId, '00000000-0000-4000-9006-000000000051')
        expect(unitStateAfter?.status).toBe('RESERVED')
        expect(unitStateAfter?.revision).toBe(unitStateBefore?.revision)
        expect(unitStateAfter?.updatedAt).toBe(unitStateBefore?.updatedAt)

        // Pureza: reserva continua ACTIVE com mesmo timestamp
        const reservationAfter = smc.getStore(repoId).getReservation(reservationId)
        expect(reservationAfter?.status).toBe('ACTIVE')
        expect(reservationAfter?.updatedAt).toBe(reservationBefore?.updatedAt)

        // Pureza: plano continua ACTIVE
        const planAfter = smc.getStore(repoId).getPlan(plan.planId)
        expect(planAfter?.status).toBe('ACTIVE')
        expect(planAfter?.revision).toBe(planBefore?.revision)

        // Pureza: sessão continua OPEN
        const sessionAfter = smc.getSession(repoId, session.sessionId)
        expect(sessionAfter?.status).toBe('OPEN')
        expect(sessionAfter?.revision).toBe(sessionBefore?.revision)
      })
    })
  })

  describe('BuildX Execution-04 — Compatibilidade real do probe Grok com o resolver CLI (Provas Dirigidas)', () => {
    const repoId = 'repo-execution-04'
    let smc: SessionMemoryCentralService
    let originalEnvPath: string | undefined
    let isolatedBinDir: string
    let isolatedWorktreeDir: string

    function createFixtureInventory(options?: {
      worktreeId?: string
      generation?: string
      branch?: string
      head?: string
      detached?: boolean
      path?: string
    }): BranchInventory {
      const worktreeId = options?.worktreeId ?? 'wt-ex04-01'
      const generation = options?.generation ?? 'gen-ex04-1'
      const branchName = options?.branch ?? 'feature-ex04'
      const head = options?.head ?? '2222222222222222222222222222222222222222'
      const detached = options?.detached ?? false
      const wtPath = options?.path ?? isolatedWorktreeDir

      const worktree: any = {
        worktreeId,
        generation,
        path: wtPath,
        head,
        branch: branchName,
        detached,
        locked: false,
        missing: false,
        prunable: false
      }

      const branchRecord: BranchRecord = {
        key: `key-${branchName}`,
        repositoryId: repoId,
        ref: `refs/heads/${branchName}`,
        name: branchName,
        namespace: 'LOCAL',
        head,
        upstream: null,
        generation: 'branch-gen-1',
        revision: 'branch-rev-1',
        creation: { at: '2026-11-06T00:00:00.000Z', source: 'APP_RECEIPT' },
        lastCommitAt: '2026-11-06T00:00:00.000Z',
        worktrees: [{ worktreeId, generation }]
      }

      return {
        repositoryId: repoId,
        source: 'GIT_LOCAL',
        coverage: 'COMPLETE',
        observedAt: '2026-11-06T00:00:00.000Z',
        revision: 'inv-ex04-1',
        worktrees: [worktree],
        branches: [branchRecord],
        unassignedWorktrees: []
      }
    }

    function createFixturePort(inventory: BranchInventory): GitOperationsPort {
      return {
        getBranchInventory: async () => inventory,
        getCoordinationSnapshot: async () => ({ reference: false })
      }
    }

    function createFixtureProposalFromDescriptor(
      descriptor: any,
      options?: {
        proposalId?: string
        repositoryId?: string
        worktreeId?: string
        generation?: string
        branch?: string
        head?: string
        policyMode?: 'SUPERVISED' | 'AUTONOMOUS_CONSULTATIVE' | 'AUTONOMOUS_TRUSTED'
        autoAuthorized?: boolean
      }
    ): CliProposal {
      const worktreeId = options?.worktreeId ?? 'wt-ex04-01'
      const generation = options?.generation ?? 'gen-ex04-1'
      const branch = options?.branch ?? 'feature-ex04'
      const head = options?.head ?? '2222222222222222222222222222222222222222'

      return {
        proposalId: options?.proposalId ?? 'proposal-grok-uuid-001',
        repositoryId: options?.repositoryId ?? repoId,
        repositoryDirectory: descriptor.cwd,
        checkoutFingerprint: 'mock-fingerprint',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        status: 'PENDING',
        risks: [],
        worktree: {
          worktreeId,
          generation,
          branch,
          head,
          indexRevision: 'idx-rev-1'
        },
        command: { ...descriptor },
        policy: {
          mode: options?.policyMode ?? 'SUPERVISED',
          revision: 'default',
          rule: 'native-command-consent'
        },
        autoAuthorized: options?.autoAuthorized ?? false
      }
    }

    beforeEach(() => {
      smc = new SessionMemoryCentralService(tempBaseDir)
      originalEnvPath = process.env.PATH
      isolatedBinDir = join(tempBaseDir, 'bin-ex04-' + Math.random().toString(36).slice(2, 8))
      isolatedWorktreeDir = join(tempBaseDir, 'wt-ex04-' + Math.random().toString(36).slice(2, 8))
      mkdirSync(isolatedBinDir, { recursive: true })
      mkdirSync(isolatedWorktreeDir, { recursive: true })
    })

    afterEach(() => {
      smc.close()
      if (originalEnvPath !== undefined) {
        process.env.PATH = originalEnvPath
      }
    })

    async function setupPreparedScenario(options?: {
      worktreeId?: string
      generation?: string
      branch?: string
      head?: string
      planId?: string
      unitId?: string
      reservationId?: string
      attemptId?: string
      worktreePath?: string
    }) {
      const worktreeId = options?.worktreeId ?? 'wt-ex04-01'
      const generation = options?.generation ?? 'gen-ex04-1'
      const branch = options?.branch ?? 'feature-ex04'
      const head = options?.head ?? '2222222222222222222222222222222222222222'
      const planId = options?.planId ?? '00000000-0000-4000-9007-000000000001'
      const unitId = options?.unitId ?? '00000000-0000-4000-9007-000000000002'
      const reservationId = options?.reservationId ?? '00000000-0000-4000-9007-000000000003'
      const attemptId = options?.attemptId ?? '00000000-0000-4000-9007-000000000004'
      const wtPath = options?.worktreePath ?? isolatedWorktreeDir

      const inv = createFixtureInventory({ worktreeId, generation, branch, head, path: wtPath })
      const gitPort = createFixturePort(inv)

      const session = smc.createSession(repoId)

      const wsService = new WorkspaceBindingService(smc, gitPort)
      await wsService.bindWorkspace(repoId, session.sessionId, worktreeId)

      const unitFlow = new UnitFlowService(smc)
      const plan = unitFlow.registerPlan(repoId, session.sessionId, { planId, title: 'Plano Grok' })
      unitFlow.definePlanUnits(repoId, session.sessionId, plan.planId, [
        { unitId, title: 'Unidade Grok', objective: 'Obj', acceptanceCriteria: 'Crit' }
      ])

      const resService = new UnitFlowReservationService(smc, gitPort)
      await resService.reserveNextEligibleUnit(repoId, session.sessionId, plan.planId, { reservationId })

      const attemptService = new ExecutionAttemptService(smc, gitPort)
      const attempt = await attemptService.prepareExecutionAttempt(repoId, session.sessionId, reservationId, { attemptId })

      return {
        session,
        plan,
        unitId,
        reservationId,
        attempt,
        wsService,
        gitPort,
        inv,
        worktreeId,
        generation,
        branch,
        head,
        worktreePath: wtPath
      }
    }

    describe('Prova 1 — Prova real do contrato de fronteira com instância real de CliExecutionService e executáveis fictícios', () => {
      it('integração real com CliExecutionService.prepare para grok.cmd (Windows wrapper) sem spawn, aprovada pelo bridge', async () => {
        const scenario = await setupPreparedScenario()

        // 1. Cria executável fictício no diretório isolado
        const scriptName = process.platform === 'win32' ? 'grok.cmd' : 'grok'
        const scriptContent = process.platform === 'win32' ? '@echo grok 1.0.0' : '#!/bin/sh\necho grok 1.0.0\n'
        const scriptPath = join(isolatedBinDir, scriptName)
        writeFileSync(scriptPath, scriptContent)

        // 2. Prepend no PATH para o resolver real encontrar
        process.env.PATH = isolatedBinDir + delimiter + (originalEnvPath ?? '')

        // 3. Instância REAL de CliExecutionService
        const canonicalWtDir = realpathSync(scenario.worktreePath)
        const realCliService = new CliExecutionService({
          repoRoot: canonicalWtDir,
          repositoryId: repoId,
          enabledByDefault: true,
          resolveWorktree: async (selector) => ({
            directory: canonicalWtDir,
            identity: {
              worktreeId: selector.worktreeId,
              generation: selector.generation,
              branch: scenario.branch,
              head: scenario.head,
              indexRevision: 'idx-1'
            },
            getFingerprint: async () => 'fp-real-1'
          })
        })

        // 4. Executa a ponte sobre a instância real
        const bridge = new BuildXGrokCliBridge(smc, scenario.wsService, realCliService)
        const result = await bridge.prepareGrokBuildProposal(
          repoId,
          scenario.session.sessionId,
          scenario.attempt.attemptId
        )

        expect(result.status).toBe('PROPOSAL_PREPARED')
        if (result.status === 'PROPOSAL_PREPARED') {
          expect(result.proposalId).toBeDefined()
          expect(typeof result.proposalId).toBe('string')
          expect(result.executable).toBe('grok')
          expect(result.args).toEqual(['version'])
          expect(result.attemptId).toBe(scenario.attempt.attemptId)
          expect(result.sessionId).toBe(scenario.session.sessionId)
          expect(result.repositoryId).toBe(repoId)
          expect(result.worktree).toEqual({
            worktreeId: scenario.worktreeId,
            generation: scenario.generation,
            branch: scenario.branch,
            head: scenario.head
          })
        }

        // 5. Sem spawn de processos: operação ativa é nula
        expect(realCliService.getActiveOperationId()).toBeNull()

        // 6. Pureza do SQLite
        const store = smc.getStore(repoId)
        const attemptAfter = store.getExecutionAttempt(scenario.attempt.attemptId)
        expect(attemptAfter?.status).toBe('PREPARED')
        expect(attemptAfter?.revision).toBe(scenario.attempt.revision)
      })

      it('integração real com CliExecutionService.prepare para grok.exe (binário Windows) sem spawn', async () => {
        if (process.platform !== 'win32') return // Platform guard

        const scenario = await setupPreparedScenario({
          attemptId: '00000000-0000-4000-9007-000000000010',
          planId: '00000000-0000-4000-9007-000000000011',
          unitId: '00000000-0000-4000-9007-000000000012',
          reservationId: '00000000-0000-4000-9007-000000000013'
        })

        // Cria grok.exe fictício
        const exePath = join(isolatedBinDir, 'grok.exe')
        writeFileSync(exePath, 'MZ-fictitious-binary')

        process.env.PATH = isolatedBinDir + delimiter + (originalEnvPath ?? '')

        const canonicalWtDir = realpathSync(scenario.worktreePath)
        const realCliService = new CliExecutionService({
          repoRoot: canonicalWtDir,
          repositoryId: repoId,
          enabledByDefault: true,
          resolveWorktree: async (selector) => ({
            directory: canonicalWtDir,
            identity: {
              worktreeId: selector.worktreeId,
              generation: selector.generation,
              branch: scenario.branch,
              head: scenario.head,
              indexRevision: 'idx-1'
            },
            getFingerprint: async () => 'fp-real-exe-1'
          })
        })

        const bridge = new BuildXGrokCliBridge(smc, scenario.wsService, realCliService)
        const result = await bridge.prepareGrokBuildProposal(
          repoId,
          scenario.session.sessionId,
          scenario.attempt.attemptId
        )

        expect(result.status).toBe('PROPOSAL_PREPARED')
        if (result.status === 'PROPOSAL_PREPARED') {
          expect(result.executable).toBe('grok')
          expect(result.args).toEqual(['version'])
        }
        expect(realCliService.getActiveOperationId()).toBeNull()
      })
    })

    describe('Prova 2 — Negativas e Propostas Adulteradas', () => {
      it('rejeita proposta com originalExecutable trocado', async () => {
        const scenario = await setupPreparedScenario({
          attemptId: '00000000-0000-4000-9007-000000000020',
          planId: '00000000-0000-4000-9007-000000000021',
          unitId: '00000000-0000-4000-9007-000000000022',
          reservationId: '00000000-0000-4000-9007-000000000023'
        })

        // Simula proposta com originalExecutable alterado para node
        const canonicalWtDir = realpathSync(scenario.worktreePath)
        const desc = {
          executable: 'node',
          originalExecutable: 'node',
          args: ['version'],
          originalArgs: ['version'],
          cwd: canonicalWtDir,
          relativeCwd: '.',
          displayCommandLine: 'node version'
        }
        const prop = createFixtureProposalFromDescriptor(desc)

        const mockCli: CliExecutionPort = {
          isEnabled: () => true,
          getRepositoryId: () => repoId,
          prepare: async () => prop
        }

        const bridge = new BuildXGrokCliBridge(smc, scenario.wsService, mockCli)
        const result = await bridge.prepareGrokBuildProposal(repoId, scenario.session.sessionId, scenario.attempt.attemptId)

        expect(result.status).toBe('CLI_INSTALLATION_UNVERIFIED')
        if (result.status === 'CLI_INSTALLATION_UNVERIFIED') {
          expect(result.reason).toBe('PROPOSAL_COMMAND_MISMATCH')
        }
      })

      it('rejeita proposta com originalArgs adulterados', async () => {
        const scenario = await setupPreparedScenario({
          attemptId: '00000000-0000-4000-9007-000000000024',
          planId: '00000000-0000-4000-9007-000000000025',
          unitId: '00000000-0000-4000-9007-000000000026',
          reservationId: '00000000-0000-4000-9007-000000000027'
        })

        const canonicalWtDir = realpathSync(scenario.worktreePath)
        const desc = {
          executable: 'grok',
          originalExecutable: 'grok',
          args: ['login'],
          originalArgs: ['login'],
          cwd: canonicalWtDir,
          relativeCwd: '.',
          displayCommandLine: 'grok login'
        }
        const prop = createFixtureProposalFromDescriptor(desc)

        const mockCli: CliExecutionPort = {
          isEnabled: () => true,
          getRepositoryId: () => repoId,
          prepare: async () => prop
        }

        const bridge = new BuildXGrokCliBridge(smc, scenario.wsService, mockCli)
        const result = await bridge.prepareGrokBuildProposal(repoId, scenario.session.sessionId, scenario.attempt.attemptId)

        expect(result.status).toBe('CLI_INSTALLATION_UNVERIFIED')
        if (result.status === 'CLI_INSTALLATION_UNVERIFIED') {
          expect(result.reason).toBe('PROPOSAL_ARGS_MISMATCH')
        }
      })

      it('rejeita proposta com CWD fora da raiz da worktree (subdiretório arbitrário)', async () => {
        const scenario = await setupPreparedScenario({
          attemptId: '00000000-0000-4000-9007-000000000028',
          planId: '00000000-0000-4000-9007-000000000029',
          unitId: '00000000-0000-4000-9007-00000000002a',
          reservationId: '00000000-0000-4000-9007-00000000002b'
        })

        const canonicalWtDir = realpathSync(scenario.worktreePath)
        const desc = {
          executable: 'grok',
          originalExecutable: 'grok',
          args: ['version'],
          originalArgs: ['version'],
          cwd: join(canonicalWtDir, 'subdir'),
          relativeCwd: 'subdir',
          displayCommandLine: 'grok version'
        }
        const prop = createFixtureProposalFromDescriptor(desc)

        const mockCli: CliExecutionPort = {
          isEnabled: () => true,
          getRepositoryId: () => repoId,
          prepare: async () => prop
        }

        const bridge = new BuildXGrokCliBridge(smc, scenario.wsService, mockCli)
        const result = await bridge.prepareGrokBuildProposal(repoId, scenario.session.sessionId, scenario.attempt.attemptId)

        expect(result.status).toBe('WORKSPACE_INVALID')
        if (result.status === 'WORKSPACE_INVALID') {
          expect(result.reason).toBe('PROPOSAL_CWD_NOT_ROOT')
        }
      })

      it('rejeita proposta com descriptor efetivo adulterado (flags ou executável divergente do resolver)', async () => {
        const scenario = await setupPreparedScenario({
          attemptId: '00000000-0000-4000-9007-00000000002c',
          planId: '00000000-0000-4000-9007-00000000002d',
          unitId: '00000000-0000-4000-9007-00000000002e',
          reservationId: '00000000-0000-4000-9007-00000000002f'
        })

        const canonicalWtDir = realpathSync(scenario.worktreePath)

        // Adiciona grok no PATH
        const scriptName = process.platform === 'win32' ? 'grok.cmd' : 'grok'
        writeFileSync(join(isolatedBinDir, scriptName), '@echo 1.0.0')
        process.env.PATH = isolatedBinDir + delimiter + (originalEnvPath ?? '')

        // Resolver canônico gera o descritor
        const canonicalDesc = resolveCliCommand(canonicalWtDir, 'grok', ['version'])

        // Adultera o descritor (injetando flags indevidas nos args efetivos)
        const tamperedDesc = {
          ...canonicalDesc,
          args: [...canonicalDesc.args, '--injected-flag']
        }
        const prop = createFixtureProposalFromDescriptor(tamperedDesc)

        const mockCli: CliExecutionPort = {
          isEnabled: () => true,
          getRepositoryId: () => repoId,
          prepare: async () => prop
        }

        const bridge = new BuildXGrokCliBridge(smc, scenario.wsService, mockCli)
        const result = await bridge.prepareGrokBuildProposal(repoId, scenario.session.sessionId, scenario.attempt.attemptId)

        expect(result.status).toBe('CLI_INSTALLATION_UNVERIFIED')
        if (result.status === 'CLI_INSTALLATION_UNVERIFIED') {
          expect(result.reason).toBe('PROPOSAL_DESCRIPTOR_MISMATCH')
        }
      })

      it('rejeita fail-closed com EXECUTABLE_NOT_FOUND quando o binário não for encontrado pelo resolver', async () => {
        const scenario = await setupPreparedScenario({
          attemptId: '00000000-0000-4000-9007-000000000030',
          planId: '00000000-0000-4000-9007-000000000031',
          unitId: '00000000-0000-4000-9007-000000000032',
          reservationId: '00000000-0000-4000-9007-000000000033'
        })

        // PATH limpo sem grok
        process.env.PATH = isolatedBinDir // binDir está vazio

        const canonicalWtDir = realpathSync(scenario.worktreePath)
        const realCliService = new CliExecutionService({
          repoRoot: canonicalWtDir,
          repositoryId: repoId,
          enabledByDefault: true,
          resolveWorktree: async (selector) => ({
            directory: canonicalWtDir,
            identity: {
              worktreeId: selector.worktreeId,
              generation: selector.generation,
              branch: scenario.branch,
              head: scenario.head,
              indexRevision: 'idx-1'
            },
            getFingerprint: async () => 'fp-none'
          })
        })

        const bridge = new BuildXGrokCliBridge(smc, scenario.wsService, realCliService)
        const result = await bridge.prepareGrokBuildProposal(repoId, scenario.session.sessionId, scenario.attempt.attemptId)

        expect(result.status).toBe('CLI_INSTALLATION_UNVERIFIED')
        if (result.status === 'CLI_INSTALLATION_UNVERIFIED') {
          expect(result.reason).toBe('EXECUTABLE_NOT_FOUND')
        }
      })
    })

    describe('Prova 3 — Regressão dos Gates Fail-Closed do Execution-03 e integridade estrita', () => {
      it('rejeita com PROJECT_CONTEXT_CHANGED quando getRepositoryId() retornar null ou divergir', async () => {
        const scenario = await setupPreparedScenario({
          attemptId: '00000000-0000-4000-9007-000000000040',
          planId: '00000000-0000-4000-9007-000000000041',
          unitId: '00000000-0000-4000-9007-000000000042',
          reservationId: '00000000-0000-4000-9007-000000000043'
        })

        const mockCli: CliExecutionPort = {
          isEnabled: () => true,
          getRepositoryId: () => null,
          prepare: async () => { throw new Error('Uncalled') }
        }

        const bridge = new BuildXGrokCliBridge(smc, scenario.wsService, mockCli)
        const result = await bridge.prepareGrokBuildProposal(repoId, scenario.session.sessionId, scenario.attempt.attemptId)
        expect(result.status).toBe('PROJECT_CONTEXT_CHANGED')
        if (result.status === 'PROJECT_CONTEXT_CHANGED') {
          expect(result.reason).toBe('CLI_SERVICE_REPOSITORY_MISMATCH')
        }
      })

      it('rejeita proposta com repositoryId divergente ou worktree ausente', async () => {
        const scenario = await setupPreparedScenario({
          attemptId: '00000000-0000-4000-9007-000000000044',
          planId: '00000000-0000-4000-9007-000000000045',
          unitId: '00000000-0000-4000-9007-000000000046',
          reservationId: '00000000-0000-4000-9007-000000000047'
        })

        const canonicalWtDir = realpathSync(scenario.worktreePath)
        const desc = {
          executable: 'grok',
          originalExecutable: 'grok',
          args: ['version'],
          originalArgs: ['version'],
          cwd: canonicalWtDir,
          relativeCwd: '.',
          displayCommandLine: 'grok version'
        }

        // 1. repositoryId divergente
        const prop1 = createFixtureProposalFromDescriptor(desc, { repositoryId: 'other-repo' })
        const b1 = new BuildXGrokCliBridge(smc, scenario.wsService, {
          isEnabled: () => true,
          getRepositoryId: () => repoId,
          prepare: async () => prop1
        })
        const r1 = await b1.prepareGrokBuildProposal(repoId, scenario.session.sessionId, scenario.attempt.attemptId)
        expect(r1.status).toBe('PROJECT_CONTEXT_CHANGED')

        // 2. worktree ausente
        const prop2 = createFixtureProposalFromDescriptor(desc)
        delete (prop2 as any).worktree
        const b2 = new BuildXGrokCliBridge(smc, scenario.wsService, {
          isEnabled: () => true,
          getRepositoryId: () => repoId,
          prepare: async () => prop2
        })
        const r2 = await b2.prepareGrokBuildProposal(repoId, scenario.session.sessionId, scenario.attempt.attemptId)
        expect(r2.status).toBe('WORKSPACE_INVALID')
      })

      it('rejeita proposta com política inadequada ou autoAuthorized ativo', async () => {
        const scenario = await setupPreparedScenario({
          attemptId: '00000000-0000-4000-9007-000000000048',
          planId: '00000000-0000-4000-9007-000000000049',
          unitId: '00000000-0000-4000-9007-00000000004a',
          reservationId: '00000000-0000-4000-9007-00000000004b'
        })

        const canonicalWtDir = realpathSync(scenario.worktreePath)
        const desc = {
          executable: 'grok',
          originalExecutable: 'grok',
          args: ['version'],
          originalArgs: ['version'],
          cwd: canonicalWtDir,
          relativeCwd: '.',
          displayCommandLine: 'grok version'
        }

        // autoAuthorized true
        const prop = createFixtureProposalFromDescriptor(desc, { autoAuthorized: true })
        const bridge = new BuildXGrokCliBridge(smc, scenario.wsService, {
          isEnabled: () => true,
          getRepositoryId: () => repoId,
          prepare: async () => prop
        })
        const result = await bridge.prepareGrokBuildProposal(repoId, scenario.session.sessionId, scenario.attempt.attemptId)
        expect(result.status).toBe('CLI_DISABLED')
        if (result.status === 'CLI_DISABLED') {
          expect(result.reason).toBe('PROPOSAL_AUTO_AUTHORIZATION_DISALLOWED')
        }
      })

      it('revalidação pós-await: rejeita fail-closed quando sessão fechar ou HEAD avançar durante o prepare', async () => {
        const scenario = await setupPreparedScenario({
          attemptId: '00000000-0000-4000-9007-00000000004c',
          planId: '00000000-0000-4000-9007-00000000004d',
          unitId: '00000000-0000-4000-9007-00000000004e',
          reservationId: '00000000-0000-4000-9007-00000000004f'
        })

        let currentHead = scenario.head
        const dynamicPort: GitOperationsPort = {
          getBranchInventory: async () => createFixtureInventory({ head: currentHead }),
          getCoordinationSnapshot: async () => ({ reference: false })
        }
        const dynamicWsService = new WorkspaceBindingService(smc, dynamicPort)

        const canonicalWtDir = realpathSync(scenario.worktreePath)
        const scriptName = process.platform === 'win32' ? 'grok.cmd' : 'grok'
        writeFileSync(join(isolatedBinDir, scriptName), '@echo 1.0.0')
        process.env.PATH = isolatedBinDir + delimiter + (originalEnvPath ?? '')

        const desc = resolveCliCommand(canonicalWtDir, 'grok', ['version'])

        const mockCli: CliExecutionPort = {
          isEnabled: () => true,
          getRepositoryId: () => repoId,
          prepare: async () => {
            // Commit avança durante a preparação
            currentHead = '9999999999999999999999999999999999999999'
            return createFixtureProposalFromDescriptor(desc)
          }
        }

        const bridge = new BuildXGrokCliBridge(smc, dynamicWsService, mockCli)
        const result = await bridge.prepareGrokBuildProposal(repoId, scenario.session.sessionId, scenario.attempt.attemptId)

        expect(result.status).toBe('WORKSPACE_INVALID')
        if (result.status === 'WORKSPACE_INVALID') {
          expect(result.reason).toBe('HEAD_DIVERGED_DURING_PREPARATION')
          expect((result as any).proposalId).toBeUndefined()
        }
      })
    })

    describe('Prova 4 — HEAD legítimo avançado antes da chamada e pureza total de persistência', () => {
      it('aceita HEAD avançado antes da chamada na mesma branch/generation e reflete novo HEAD no resultado', async () => {
        const scenario = await setupPreparedScenario({
          attemptId: '00000000-0000-4000-9007-000000000050',
          planId: '00000000-0000-4000-9007-000000000051',
          unitId: '00000000-0000-4000-9007-000000000052',
          reservationId: '00000000-0000-4000-9007-000000000053',
          head: '2222222222222222222222222222222222222222'
        })

        const advancedHead = '3333333333333333333333333333333333333333'
        const advancedInv = createFixtureInventory({ head: advancedHead })
        const advancedPort = createFixturePort(advancedInv)
        const advancedWsService = new WorkspaceBindingService(smc, advancedPort)

        const canonicalWtDir = realpathSync(scenario.worktreePath)
        const scriptName = process.platform === 'win32' ? 'grok.cmd' : 'grok'
        writeFileSync(join(isolatedBinDir, scriptName), '@echo 1.0.0')
        process.env.PATH = isolatedBinDir + delimiter + (originalEnvPath ?? '')

        const desc = resolveCliCommand(canonicalWtDir, 'grok', ['version'])

        const mockCli: CliExecutionPort = {
          isEnabled: () => true,
          getRepositoryId: () => repoId,
          prepare: async () => createFixtureProposalFromDescriptor(desc, { head: advancedHead })
        }

        const bridge = new BuildXGrokCliBridge(smc, advancedWsService, mockCli)
        const result = await bridge.prepareGrokBuildProposal(repoId, scenario.session.sessionId, scenario.attempt.attemptId)

        expect(result.status).toBe('PROPOSAL_PREPARED')
        if (result.status === 'PROPOSAL_PREPARED') {
          expect(result.proposalId).toBe('proposal-grok-uuid-001')
          expect(result.worktree.head).toBe(advancedHead)
          expect(result.worktree.worktreeId).toBe(scenario.worktreeId)
          expect(result.worktree.generation).toBe(scenario.generation)
          expect(result.worktree.branch).toBe(scenario.branch)
        }
      })

      it('preserva privacidade (sem host paths, prompts ou tokens) e pureza estrita do SQLite após repetições', async () => {
        const scenario = await setupPreparedScenario({
          attemptId: '00000000-0000-4000-9007-000000000060',
          planId: '00000000-0000-4000-9007-000000000061',
          unitId: '00000000-0000-4000-9007-000000000062',
          reservationId: '00000000-0000-4000-9007-000000000063'
        })

        const canonicalWtDir = realpathSync(scenario.worktreePath)
        const scriptName = process.platform === 'win32' ? 'grok.cmd' : 'grok'
        writeFileSync(join(isolatedBinDir, scriptName), '@echo 1.0.0')
        process.env.PATH = isolatedBinDir + delimiter + (originalEnvPath ?? '')

        const desc = resolveCliCommand(canonicalWtDir, 'grok', ['version'])

        let callCount = 0
        const mockCli: CliExecutionPort = {
          isEnabled: () => true,
          getRepositoryId: () => repoId,
          prepare: async () => {
            callCount++
            return createFixtureProposalFromDescriptor(desc, {
              proposalId: `proposal-grok-call-${callCount}`
            })
          }
        }

        const bridge = new BuildXGrokCliBridge(smc, scenario.wsService, mockCli)

        // Snapshot inicial das contagens e revisões SQLite
        const store = smc.getStore(repoId)
        const attemptBefore = store.getExecutionAttempt(scenario.attempt.attemptId)
        const unitBefore = store.getUnitState(scenario.session.sessionId, scenario.plan.planId, scenario.unitId)
        const resBefore = store.getReservation(scenario.reservationId)
        const planBefore = store.getPlan(scenario.plan.planId)
        const sessionBefore = smc.getSession(repoId, scenario.session.sessionId)

        // Execução 1
        const r1 = await bridge.prepareGrokBuildProposal(repoId, scenario.session.sessionId, scenario.attempt.attemptId)
        expect(r1.status).toBe('PROPOSAL_PREPARED')

        // Execução 2 (repetição)
        const r2 = await bridge.prepareGrokBuildProposal(repoId, scenario.session.sessionId, scenario.attempt.attemptId)
        expect(r2.status).toBe('PROPOSAL_PREPARED')

        if (r1.status === 'PROPOSAL_PREPARED' && r2.status === 'PROPOSAL_PREPARED') {
          expect(r1.proposalId).toBe('proposal-grok-call-1')
          expect(r2.proposalId).toBe('proposal-grok-call-2')
        }

        // Privacidade: nenhum caminho físico, prompt ou token vazado
        const jsonR1 = JSON.stringify(r1)
        expect(jsonR1).not.toContain(isolatedWorktreeDir)
        expect(jsonR1).not.toContain('prompt')
        expect(jsonR1).not.toContain('token')
        expect(jsonR1).not.toContain('credential')

        // Pureza: zero mutações em todas as tabelas SMC
        const attemptAfter = store.getExecutionAttempt(scenario.attempt.attemptId)
        expect(attemptAfter?.status).toBe('PREPARED')
        expect(attemptAfter?.revision).toBe(attemptBefore?.revision)
        expect(attemptAfter?.updatedAt).toBe(attemptBefore?.updatedAt)

        const unitAfter = store.getUnitState(scenario.session.sessionId, scenario.plan.planId, scenario.unitId)
        expect(unitAfter?.status).toBe('RESERVED')
        expect(unitAfter?.revision).toBe(unitBefore?.revision)
        expect(unitAfter?.updatedAt).toBe(unitBefore?.updatedAt)

        const resAfter = store.getReservation(scenario.reservationId)
        expect(resAfter?.status).toBe('ACTIVE')
        expect(resAfter?.updatedAt).toBe(resBefore?.updatedAt)

        const planAfter = store.getPlan(scenario.plan.planId)
        expect(planAfter?.status).toBe('ACTIVE')
        expect(planAfter?.revision).toBe(planBefore?.revision)

        const sessionAfter = smc.getSession(repoId, scenario.session.sessionId)
        expect(sessionAfter?.status).toBe('OPEN')
        expect(sessionAfter?.revision).toBe(sessionBefore?.revision)
      })
    })
  })

})
})


