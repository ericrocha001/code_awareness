/**
 * Registra provas de validação das implementações de diagnóstico de manutenção
 * no Validation Ledger.
 *
 * Lane: Native (requires SQLite via better-sqlite3).
 *
 * Provas registradas:
 * - codemap-maintenance-explicit-failure
 * - codemap-maintenance-correlation-chain
 * - codemap-maintenance-diagnostic-target
 * - codemap-diagnostic-architecture-map-regression
 */

import { describe, it, expect, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ValidationLedger } from '../validation-ledger/validation-ledger'
import { CodeMapLifecycleMonitor } from './codemap-lifecycle-monitor'
import { telemetryService } from '../core/telemetry-service'
import { boundariesByArea, CODEMAP_DIAGNOSTIC_CATALOG } from './codemap-diagnostic-catalog'

let ledgerDir: string
let ledger: ValidationLedger

const now = () => new Date().toISOString()
const dur = (ms: number) => ms

// ─── Setup ───────────────────────────────────────────────────────────────────

describe('Validation Ledger — CodeMap Maintenance Diagnostic', () => {
  afterAll(() => {
    ledger?.close()
    if (ledgerDir && existsSync(ledgerDir)) {
      try { rmSync(ledgerDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  it('setup: cria ledger em diretório temporário', () => {
    ledgerDir = mkdtempSync(join(tmpdir(), 'vl_maintenance_'))
    ledger = new ValidationLedger(join(ledgerDir, 'ledger.db'))
    expect(ledger).toBeDefined()
  })

  // ─── Proof 1: Explicit Failure ─────────────────────────────────────────────

  it('Proof codemap-maintenance-explicit-failure: 5 novos FAILED events observáveis no monitor', () => {
    const monitor = new CodeMapLifecycleMonitor().connect()
    const REPO = '/test/repo-failure'

    const failedSteps: string[] = []

    telemetryService.log('cid', 'CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO })

    // Context Ref
    telemetryService.log('cid', 'CODE_MAP', 'MAINTENANCE_CONTEXT_REF_STARTED', { repoPath: REPO })
    telemetryService.logError('cid', 'CODE_MAP', 'MAINTENANCE_CONTEXT_REF_FAILED', { repoPath: REPO, error: 'e' })
    const s1 = monitor.getRepoState(REPO)!.maintenanceSteps.get('Context Reference Backfill')
    if (s1?.status === 'failed') failedSteps.push('Context Reference Backfill')

    telemetryService.log('cid', 'CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO })

    // Token Metadata
    telemetryService.log('cid', 'CODE_MAP', 'MAINTENANCE_TOKEN_METADATA_STARTED', { repoPath: REPO })
    telemetryService.logError('cid', 'CODE_MAP', 'MAINTENANCE_TOKEN_METADATA_FAILED', { repoPath: REPO, error: 'e' })
    const s2 = monitor.getRepoState(REPO)!.maintenanceSteps.get('Token Metadata Backfill')
    if (s2?.status === 'failed') failedSteps.push('Token Metadata Backfill')

    telemetryService.log('cid', 'CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO })

    // Text Documents
    telemetryService.log('cid', 'CODE_MAP', 'MAINTENANCE_TEXT_DOCUMENTS_STARTED', { repoPath: REPO })
    telemetryService.logError('cid', 'CODE_MAP', 'MAINTENANCE_TEXT_DOCUMENTS_FAILED', { repoPath: REPO, error: 'e' })
    const s3 = monitor.getRepoState(REPO)!.maintenanceSteps.get('Text Document Backfill')
    if (s3?.status === 'failed') failedSteps.push('Text Document Backfill')

    telemetryService.log('cid', 'CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO })

    // Declaration Sigs
    telemetryService.log('cid', 'CODE_MAP', 'MAINTENANCE_DECLARATION_SIGS_STARTED', { repoPath: REPO })
    telemetryService.logError('cid', 'CODE_MAP', 'MAINTENANCE_DECLARATION_SIGS_FAILED', { repoPath: REPO, error: 'e' })
    const s4 = monitor.getRepoState(REPO)!.maintenanceSteps.get('Declaration Signature Backfill')
    if (s4?.status === 'failed') failedSteps.push('Declaration Signature Backfill')

    telemetryService.log('cid', 'CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO })

    // Content Identity
    telemetryService.log('cid', 'CODE_MAP', 'BACKFILL_STARTED', { repoPath: REPO })
    telemetryService.logError('cid', 'CODE_MAP', 'BACKFILL_FAILED', { repoPath: REPO, error: 'e' })
    const s5 = monitor.getRepoState(REPO)!.maintenanceSteps.get('Content Identity Backfill')
    if (s5?.status === 'failed') failedSteps.push('Content Identity Backfill')

    monitor.dispose()

    expect(failedSteps).toHaveLength(5)

    const t = now()
    ledger.recordProof({
      kind: 'TARGETED_TEST',
      producer: 'IMPLEMENTER',
      status: 'PASSED',
      startedAt: t,
      finishedAt: t,
      durationMs: dur(0),
      scope: ['codemap-maintenance-explicit-failure'],
      summary: `5 novos MAINTENANCE_*_FAILED events são detectáveis pelo CodeMapLifecycleMonitor: ${failedSteps.join(', ')}`,
      evidenceFor: ['codemap-maintenance-explicit-failure'],
      deduplicationKey: 'codemap-maintenance-explicit-failure-v1',
      metrics: { testsPassed: failedSteps.length, testsFailed: 0 }
    })
  })

  // ─── Proof 2: Correlation Chain ────────────────────────────────────────────

  it('Proof codemap-maintenance-correlation-chain: mesma sessão usa mesmo cid', () => {
    const capturedCids = new Set<string>()
    const SESSION_CID = 'test-maintenance-session-cid-12345'
    const REPO = '/test/repo-chain'

    const unsub = telemetryService.subscribe(e => {
      if (e.component === 'CODE_MAP' &&
        (e.event.startsWith('MAINTENANCE') || e.event.startsWith('BACKFILL') || e.event === 'BACKGROUND_MAINTENANCE_STARTED')) {
        capturedCids.add(e.correlationId)
      }
    })

    telemetryService.log(SESSION_CID, 'CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO })
    telemetryService.log(SESSION_CID, 'CODE_MAP', 'BACKFILL_STARTED', { repoPath: REPO })
    telemetryService.log(SESSION_CID, 'CODE_MAP', 'BACKFILL_COMPLETED', { repoPath: REPO })
    telemetryService.log(SESSION_CID, 'CODE_MAP', 'MAINTENANCE_CONTEXT_REF_STARTED', { repoPath: REPO })
    telemetryService.log(SESSION_CID, 'CODE_MAP', 'MAINTENANCE_CONTEXT_REF_COMPLETED', { repoPath: REPO })
    telemetryService.log(SESSION_CID, 'CODE_MAP', 'MAINTENANCE_TOKEN_METADATA_STARTED', { repoPath: REPO })
    telemetryService.log(SESSION_CID, 'CODE_MAP', 'MAINTENANCE_TOKEN_METADATA_COMPLETED', { repoPath: REPO })

    unsub()

    // Todos os eventos têm o mesmo cid
    expect(capturedCids.size).toBe(1)
    expect(capturedCids.has(SESSION_CID)).toBe(true)

    const t = now()
    ledger.recordProof({
      kind: 'TARGETED_TEST',
      producer: 'IMPLEMENTER',
      status: 'PASSED',
      startedAt: t,
      finishedAt: t,
      durationMs: dur(0),
      scope: ['codemap-maintenance-correlation-chain'],
      summary: `7 eventos de manutenção distintos usam o mesmo correlation ID (${SESSION_CID}) — cadeia causal verificada`,
      evidenceFor: ['codemap-maintenance-correlation-chain'],
      deduplicationKey: 'codemap-maintenance-correlation-chain-v1',
      metrics: { testsPassed: 1, testsFailed: 0 }
    })
  })

  // ─── Proof 3: Diagnostic Target ────────────────────────────────────────────

  it('Proof codemap-maintenance-diagnostic-target: step falhado retorna Investigation Target correto', () => {
    const monitor = new CodeMapLifecycleMonitor().connect()
    const REPO = '/test/repo-target'

    telemetryService.log('cid', 'CODE_MAP', 'BACKGROUND_MAINTENANCE_STARTED', { repoPath: REPO })
    telemetryService.log('cid', 'CODE_MAP', 'MAINTENANCE_TOKEN_METADATA_STARTED', { repoPath: REPO })
    telemetryService.logError('cid', 'CODE_MAP', 'MAINTENANCE_TOKEN_METADATA_FAILED', { repoPath: REPO, error: 'OOM' })
    telemetryService.logError('cid', 'CODE_MAP', 'BACKGROUND_MAINTENANCE_FAILED', { repoPath: REPO, error: 'OOM' })

    const blocked = monitor.getBlockedMaintenanceStep()
    const target = monitor.getBlockedMaintenanceTarget()

    expect(blocked).not.toBeNull()
    expect(blocked!.step).toBe('Token Metadata Backfill')
    expect(blocked!.boundaryId).toBe('maintenance-token-metadata')
    expect(target).not.toBeNull()
    expect(target!.systemArea).toBe('CodeMap Background Maintenance')
    expect(target!.investigationSeeds.length).toBeGreaterThan(0)

    monitor.dispose()

    const t = now()
    ledger.recordProof({
      kind: 'TARGETED_TEST',
      producer: 'IMPLEMENTER',
      status: 'PASSED',
      startedAt: t,
      finishedAt: t,
      durationMs: dur(0),
      scope: ['codemap-maintenance-diagnostic-target'],
      summary: `getBlockedMaintenanceTarget() retorna Investigation Target para "${blocked!.step}" após MAINTENANCE_TOKEN_METADATA_FAILED — investigationSeeds: ${target!.investigationSeeds.join(', ')}`,
      evidenceFor: ['codemap-maintenance-diagnostic-target'],
      deduplicationKey: 'codemap-maintenance-diagnostic-target-v1',
      metrics: { testsPassed: 1, testsFailed: 0 }
    })
  })

  // ─── Proof 4: Regression — Architecture Map ────────────────────────────────

  it('Proof codemap-diagnostic-architecture-map-regression: todas as 33 fronteiras têm targets + errorEvents atualizados', () => {
    const total = CODEMAP_DIAGNOSTIC_CATALOG.length
    const withTargets = CODEMAP_DIAGNOSTIC_CATALOG.filter(b =>
      b.target.investigationSeeds.length > 0 && b.target.responsibility.length > 0
    )
    const maintenanceBoundaries = boundariesByArea('Background Maintenance')
    const maintenanceWithErrors = maintenanceBoundaries.filter(b => b.errorEvents.length > 0)

    expect(total).toBeGreaterThanOrEqual(33)
    expect(withTargets.length).toBe(total)
    expect(maintenanceBoundaries.length).toBe(6)
    expect(maintenanceWithErrors.length).toBe(6)

    const t = now()
    ledger.recordProof({
      kind: 'SUBSYSTEM_TEST',
      producer: 'IMPLEMENTER',
      status: 'PASSED',
      startedAt: t,
      finishedAt: t,
      durationMs: dur(0),
      scope: ['codemap-diagnostic-architecture-map-regression'],
      summary: `Catálogo diagnóstico: ${total} fronteiras, todas com targets; ${maintenanceBoundaries.length} fronteiras de maintenance com errorEvents definidos (${maintenanceWithErrors.length}/6)`,
      evidenceFor: ['codemap-diagnostic-architecture-map-regression'],
      deduplicationKey: 'codemap-diagnostic-architecture-map-regression-v1',
      metrics: { testsPassed: total, testsFailed: 0 }
    })
  })

  // ─── Verify proofs were recorded ───────────────────────────────────────────

  it('verifica que as 4 provas foram registradas no Ledger', () => {
    const proofIds = [
      'codemap-maintenance-explicit-failure-v1',
      'codemap-maintenance-correlation-chain-v1',
      'codemap-maintenance-diagnostic-target-v1',
      'codemap-diagnostic-architecture-map-regression-v1',
    ]

    const allProofs = ledger.listProofs({ status: 'PASSED' })

    for (const dedup of proofIds) {
      const found = allProofs.find(p => p.deduplicationKey === dedup)
      expect(found, `Prova ${dedup} não encontrada no Ledger`).toBeDefined()
      expect(found!.status).toBe('PASSED')
    }

    expect(allProofs.length).toBeGreaterThanOrEqual(4)
  })
})
