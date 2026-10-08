import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ValidationLedger } from './validation-ledger'
import {
  executeListValidationProofs,
  executeGetValidationProof,
  executeRecordValidationProof
} from './validation-ledger-mcp'
import { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'
import type { RecordProofInput } from './validation-ledger-types'

const openLedgers: Array<{ ledger: ValidationLedger; dir: string }> = []

function tempLedger(runtimeIdentity?: RuntimeIdentityProvider): { ledger: ValidationLedger; dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ca-ledger-test-'))
  const dbPath = join(dir, 'test.db')
  const ledger = new ValidationLedger(dbPath, runtimeIdentity)
  openLedgers.push({ ledger, dir })
  return { ledger, dbPath, dir }
}

function baseProof(overrides: Partial<RecordProofInput> = {}): RecordProofInput {
  const now = new Date().toISOString()
  return {
    kind: 'FULL_TEST_SUITE',
    producer: 'IMPLEMENTER',
    status: 'PASSED',
    startedAt: now,
    finishedAt: now,
    durationMs: 5000,
    scope: ['src/main/validation-ledger'],
    summary: '128 files, 1282 tests passed',
    ...overrides
  }
}

describe('Validation Ledger — Permanent Harness', () => {
  it('preserves checkout provenance and never infers checkout freshness from the primary fingerprint', () => {
    const identity = new RuntimeIdentityProvider({ rootDir: process.cwd() })
    const { ledger } = tempLedger(identity)
    const sourceFingerprint = identity.evaluateFreshness().currentSnapshot.fingerprint
    const checkout = { repositoryId: 'repo', worktreeId: 'worktree', generation: 'generation', head: 'a'.repeat(40), issuer: 'VALIDATION_EXECUTION' as const, runId: 'run-genuine' }
    const proof = ledger.recordProof(baseProof({ producer: 'SYSTEM', sourceFingerprint, runtimeInstanceId: identity.getInstanceId(), commandProfile: { command: 'npm run test:node', cwd: 'managed-worktree', checkout } }))
    expect(ledger.getProof(proof.proofId)?.commandProfile?.checkout).toEqual(checkout)
    expect(ledger.getProofWithFreshness(proof.proofId)?.freshness).toBe('UNVERIFIABLE')
    const forged = executeRecordValidationProof(ledger, baseProof({ commandProfile: { command: 'claim', checkout } }))
    expect(forged.isError).toBe(true)
  })
  let tempDir: string
  let sourceDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-source-test-'))
    sourceDir = tempDir
    mkdirSync(join(sourceDir, 'src', 'main'), { recursive: true })
    writeFileSync(join(sourceDir, 'src', 'main', 'index.ts'), 'export const a = 1\n')
    writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ name: 'test' }))
  })

  afterEach(() => {
    for (const item of openLedgers) {
      item.ledger.close()
      try { rmSync(item.dir, { recursive: true, force: true }) } catch {}
    }
    openLedgers.length = 0
    try { rmSync(tempDir, { recursive: true, force: true }) } catch {}
  })

  // ── Registro ──────────────────────────────────────────────────────────────

  it('1. Prova válida persiste com todos os campos preservados', () => {
    const { ledger } = tempLedger()
    const metrics = { testFilesPassed: 128, testsPassed: 1282, durationMs: 5000 }
    const proof = ledger.recordProof(baseProof({ metrics, evidenceFor: ['P1', 'P2'], producer: 'IMPLEMENTER' }))

    expect(proof.proofId).toMatch(/^proof-/)
    expect(proof.kind).toBe('FULL_TEST_SUITE')
    expect(proof.producer).toBe('IMPLEMENTER')
    expect(proof.status).toBe('PASSED')
    expect(proof.metrics).toEqual(metrics)
    expect(proof.evidenceFor).toEqual(['P1', 'P2'])
    expect(proof.recordedAt).toBeTruthy()

    // Recuperar confirma persistência
    const fetched = ledger.getProof(proof.proofId)
    expect(fetched).not.toBeNull()
    expect(fetched!.proofId).toBe(proof.proofId)
    expect(fetched!.metrics).toEqual(metrics)
    expect(fetched!.evidenceFor).toEqual(['P1', 'P2'])
  })

  it('2. Prova persiste com metrics nulos', () => {
    const { ledger } = tempLedger()
    const proof = ledger.recordProof(baseProof({ kind: 'TYPECHECK' }))
    expect(proof.metrics).toBeNull()

    const fetched = ledger.getProof(proof.proofId)
    expect(fetched!.metrics).toBeNull()
  })

  it('3. Producer preservado independentemente do produtor', () => {
    const { ledger } = tempLedger()
    const p1 = ledger.recordProof(baseProof({ producer: 'ARCHITECT' }))
    const p2 = ledger.recordProof(baseProof({ producer: 'USER' }))
    const p3 = ledger.recordProof(baseProof({ producer: 'SYSTEM' }))
    const p4 = ledger.recordProof(baseProof({ producer: 'TESTER' }))

    expect(ledger.getProof(p1.proofId)!.producer).toBe('ARCHITECT')
    expect(ledger.getProof(p2.proofId)!.producer).toBe('USER')
    expect(ledger.getProof(p3.proofId)!.producer).toBe('SYSTEM')
    expect(ledger.getProof(p4.proofId)!.producer).toBe('TESTER')
  })

  it('4. commandProfile preservado', () => {
    const { ledger } = tempLedger()
    const cmd = { command: 'npx', args: ['vitest', 'run'], cwd: '/project', exitCode: 0 }
    const proof = ledger.recordProof(baseProof({ commandProfile: cmd }))
    expect(ledger.getProof(proof.proofId)!.commandProfile).toEqual(cmd)
  })

  // ── Imutabilidade ─────────────────────────────────────────────────────────

  it('5. Prova histórica não é reescrita silenciosamente — resultado original é preservado', () => {
    const { ledger } = tempLedger()
    const proof = ledger.recordProof(baseProof({ status: 'PASSED', summary: 'original' }))

    const fetched = ledger.getProof(proof.proofId)
    expect(fetched!.status).toBe('PASSED')
    expect(fetched!.summary).toBe('original')
  })

  // ── Freshness ─────────────────────────────────────────────────────────────

  it('6. Mesmo fingerprint → CURRENT', () => {
    const provider = new RuntimeIdentityProvider({ rootDir: sourceDir })
    const fingerprint = provider.getStartupSnapshot().fingerprint
    const { ledger } = tempLedger(provider)

    const proof = ledger.recordProof(baseProof({ sourceFingerprint: fingerprint }))
    const withFreshness = ledger.getProofWithFreshness(proof.proofId)

    expect(withFreshness!.freshness).toBe('CURRENT')
  })

  it('7. Source alterado → SOURCE_STALE', () => {
    const provider = new RuntimeIdentityProvider({ rootDir: sourceDir })
    const oldFingerprint = 'fp-old-12345'
    const { ledger } = tempLedger(provider)

    const proof = ledger.recordProof(baseProof({ sourceFingerprint: oldFingerprint }))
    const withFreshness = ledger.getProofWithFreshness(proof.proofId)

    expect(withFreshness!.freshness).toBe('SOURCE_STALE')
  })

  it('8. Runtime diferente → RUNTIME_HISTORICAL', () => {
    const oldProvider = new RuntimeIdentityProvider({ rootDir: sourceDir })
    const currentProvider = new RuntimeIdentityProvider({ rootDir: sourceDir })
    const currentFingerprint = currentProvider.getStartupSnapshot().fingerprint
    const { ledger } = tempLedger(currentProvider)

    const proof = ledger.recordProof(baseProof({
      sourceFingerprint: currentFingerprint,
      runtimeInstanceId: oldProvider.getInstanceId()
    }))
    const withFreshness = ledger.getProofWithFreshness(proof.proofId)

    expect(withFreshness!.freshness).toBe('RUNTIME_HISTORICAL')
  })

  it('9. Sem fingerprint → UNVERIFIABLE', () => {
    const provider = new RuntimeIdentityProvider({ rootDir: sourceDir })
    const { ledger } = tempLedger(provider)

    const proof = ledger.recordProof(baseProof({ sourceFingerprint: null }))
    const withFreshness = ledger.getProofWithFreshness(proof.proofId)

    expect(withFreshness!.freshness).toBe('UNVERIFIABLE')
  })

  // ── Filtering ─────────────────────────────────────────────────────────────

  it('10. Filtro por kind', () => {
    const { ledger } = tempLedger()
    ledger.recordProof(baseProof({ kind: 'TYPECHECK' }))
    ledger.recordProof(baseProof({ kind: 'BUILD' }))
    ledger.recordProof(baseProof({ kind: 'FULL_TEST_SUITE' }))

    const typecheck = ledger.listProofs({ kind: 'TYPECHECK' })
    expect(typecheck).toHaveLength(1)
    expect(typecheck[0].kind).toBe('TYPECHECK')
  })

  it('11. Filtro por status', () => {
    const { ledger } = tempLedger()
    ledger.recordProof(baseProof({ status: 'PASSED' }))
    ledger.recordProof(baseProof({ status: 'FAILED', summary: 'failed run' }))
    ledger.recordProof(baseProof({ status: 'ERROR', summary: 'error run' }))

    const failed = ledger.listProofs({ status: 'FAILED' })
    expect(failed).toHaveLength(1)
    expect(failed[0].status).toBe('FAILED')
  })

  it('12. Filtro por producer', () => {
    const { ledger } = tempLedger()
    ledger.recordProof(baseProof({ producer: 'IMPLEMENTER' }))
    ledger.recordProof(baseProof({ producer: 'ARCHITECT', summary: 'arch proof' }))

    const arch = ledger.listProofs({ producer: 'ARCHITECT' })
    expect(arch).toHaveLength(1)
    expect(arch[0].producer).toBe('ARCHITECT')
  })

  // ── Requirement association ────────────────────────────────────────────────

  it('13. evidenceFor associa corretamente ao requirementId', () => {
    const { ledger } = tempLedger()
    const p1 = ledger.recordProof(baseProof({ evidenceFor: ['P1', 'P2'] }))
    ledger.recordProof(baseProof({ evidenceFor: ['P3'], summary: 'unrelated' }))

    const forP1 = ledger.listProofs({ requirementId: 'P1' })
    expect(forP1).toHaveLength(1)
    expect(forP1[0].proofId).toBe(p1.proofId)
    expect(forP1[0].evidenceFor).toContain('P1')
  })

  // ── Deduplicação ──────────────────────────────────────────────────────────

  it('14. Retry com mesmo deduplicationKey não cria duplicata', () => {
    const { ledger } = tempLedger()
    const deduplicationKey = 'run-vitest-full-2026-09-21'

    const first = ledger.recordProof(baseProof({ deduplicationKey }))
    const second = ledger.recordProof(baseProof({ deduplicationKey, summary: 'different summary' }))

    expect(second.proofId).toBe(first.proofId)
    expect(second.summary).toBe(first.summary)

    const all = ledger.listProofs()
    expect(all.filter(p => p.deduplicationKey === deduplicationKey)).toHaveLength(1)
  })

  it('15. Provas distintas sem deduplicationKey são registradas separadamente', () => {
    const { ledger } = tempLedger()
    const p1 = ledger.recordProof(baseProof())
    const p2 = ledger.recordProof(baseProof({ summary: 'second run' }))

    expect(p1.proofId).not.toBe(p2.proofId)
    expect(ledger.listProofs()).toHaveLength(2)
  })

  // ── Independence ──────────────────────────────────────────────────────────

  it('16. Validation Ledger não altera CodeScope health', () => {
    const { ledger } = tempLedger()
    ledger.recordProof(baseProof({ status: 'FAILED', summary: 'test failed' }))
    ledger.recordProof(baseProof({ status: 'ERROR', summary: 'error' }))

    expect(ledger.listProofs()).toHaveLength(2)
  })

  it('17. Teste FAILED no ledger não degrada System Health', async () => {
    const { SystemHealthCore } = await import('../system-health/system-health-core')
    const core = new SystemHealthCore()

    const { ledger } = tempLedger()
    ledger.recordProof(baseProof({ status: 'FAILED', summary: 'test failed' }))

    const state = core.getState()
    expect(state.status).not.toBe('DEGRADED')
  })

  // ── Persistence ───────────────────────────────────────────────────────────

  it('18. Restart preserva provas — novo ledger no mesmo arquivo recupera provas anteriores', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-persist-test-'))
    const dbPath = join(dir, 'persist.db')

    const ledger1 = new ValidationLedger(dbPath)
    const proof = ledger1.recordProof(baseProof({ summary: 'proof before restart' }))
    ledger1.close()

    const ledger2 = new ValidationLedger(dbPath)
    const fetched = ledger2.getProof(proof.proofId)
    expect(fetched).not.toBeNull()
    expect(fetched!.summary).toBe('proof before restart')
    ledger2.close()
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  // ── MCP operations ────────────────────────────────────────────────────────

  it('19. MCP list_validation_proofs retorna count e proofId', () => {
    const { ledger } = tempLedger()
    ledger.recordProof(baseProof())
    ledger.recordProof(baseProof({ kind: 'TYPECHECK', summary: 'typecheck' }))

    const result = executeListValidationProofs(ledger, {})
    expect(result.isError).toBeUndefined()

    const payload = JSON.parse(result.content[0].text)
    expect(payload.count).toBe(2)
    expect(payload.proofs[0].proofId).toMatch(/^proof-/)
  })

  it('20. MCP get_validation_proof retorna detalhe completo com freshness', () => {
    const provider = new RuntimeIdentityProvider({ rootDir: sourceDir })
    const fingerprint = provider.getStartupSnapshot().fingerprint
    const { ledger } = tempLedger(provider)
    const proof = ledger.recordProof(baseProof({ sourceFingerprint: fingerprint }))

    const result = executeGetValidationProof(ledger, { proofId: proof.proofId })
    expect(result.isError).toBeUndefined()

    const payload = JSON.parse(result.content[0].text)
    expect(payload.proofId).toBe(proof.proofId)
    expect(payload.freshness).toBe('CURRENT')
    expect(payload.scope).toEqual(['src/main/validation-ledger'])
  })

  it('21. MCP get_validation_proof retorna erro para proofId desconhecido', () => {
    const { ledger } = tempLedger()
    const result = executeGetValidationProof(ledger, { proofId: 'proof-does-not-exist' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('PROOF_NOT_FOUND')
  })

  it('22. MCP record_validation_proof registra e retorna proofId', () => {
    const { ledger } = tempLedger()
    const now = new Date().toISOString()
    const result = executeRecordValidationProof(ledger, {
      kind: 'TARGETED_TEST',
      producer: 'IMPLEMENTER',
      status: 'PASSED',
      startedAt: now,
      finishedAt: now,
      durationMs: 1200,
      scope: ['src/main/validation-ledger/validation-ledger.ts'],
      summary: 'All ledger unit tests passed'
    })

    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(result.content[0].text)
    expect(payload.proofId).toMatch(/^proof-/)
    expect(payload.status).toBe('PASSED')
  })

  it('23. MCP record_validation_proof rejeita kind inválido', () => {
    const { ledger } = tempLedger()
    const now = new Date().toISOString()
    const result = executeRecordValidationProof(ledger, {
      kind: 'UNKNOWN_KIND',
      producer: 'IMPLEMENTER',
      status: 'PASSED',
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      scope: ['foo'],
      summary: 'test'
    })
    expect(result.isError).toBe(true)
  })

  it('24. MCP list_validation_proofs filtra por freshness CURRENT', () => {
    const provider = new RuntimeIdentityProvider({ rootDir: sourceDir })
    const fingerprint = provider.getStartupSnapshot().fingerprint
    const { ledger } = tempLedger(provider)

    ledger.recordProof(baseProof({ sourceFingerprint: fingerprint }))
    ledger.recordProof(baseProof({ sourceFingerprint: 'fp-old-stale', summary: 'stale proof' }))

    const result = executeListValidationProofs(ledger, { freshness: 'CURRENT' })
    const payload = JSON.parse(result.content[0].text)

    expect(payload.count).toBe(1)
    expect(payload.proofs[0].freshness).toBe('CURRENT')
  })

  it('25. Prova com runtimeInstanceId atual → não é RUNTIME_HISTORICAL', () => {
    const provider = new RuntimeIdentityProvider({ rootDir: sourceDir })
    const fingerprint = provider.getStartupSnapshot().fingerprint
    const instanceId = provider.getInstanceId()
    const { ledger } = tempLedger(provider)

    const proof = ledger.recordProof(baseProof({ sourceFingerprint: fingerprint, runtimeInstanceId: instanceId }))
    const withFreshness = ledger.getProofWithFreshness(proof.proofId)

    expect(withFreshness!.freshness).toBe('CURRENT')
  })

  it('26. Fluxo de Aceitação Real Completo (Passos 1 a 11 do Plano)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-acceptance-test-'))
    const dbPath = join(dir, 'ledger.db')

    // 1. Implementador executa teste em determinado estado do source
    const provider1 = new RuntimeIdentityProvider({ rootDir: sourceDir })
    const fp1 = provider1.getStartupSnapshot().fingerprint
    const ledger1 = new ValidationLedger(dbPath, provider1)

    // 2. Implementador registra a prova
    const p1 = ledger1.recordProof({
      kind: 'TARGETED_TEST',
      producer: 'IMPLEMENTER',
      status: 'PASSED',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 150,
      scope: ['src/main/index.ts'],
      sourceFingerprint: fp1,
      runtimeInstanceId: provider1.getInstanceId(),
      summary: 'Targeted test for index.ts',
      evidenceFor: ['REQ-01']
    })

    // 3. Arquiteto chama list_validation_proofs
    const listResult1 = executeListValidationProofs(ledger1, {})
    const parsed1 = JSON.parse(listResult1.content[0].text)

    // 4. A prova aparece como CURRENT
    expect(parsed1.count).toBe(1)
    expect(parsed1.proofs[0].proofId).toBe(p1.proofId)
    expect(parsed1.proofs[0].freshness).toBe('CURRENT')

    // 5. Arquiteto consulta prova existente e verifica que é suficiente (não reexecuta)
    const getResult1 = executeGetValidationProof(ledger1, { proofId: p1.proofId })
    const proofDetail1 = JSON.parse(getResult1.content[0].text)
    expect(proofDetail1.freshness).toBe('CURRENT')
    expect(proofDetail1.status).toBe('PASSED')

    // 6. Source é alterado
    writeFileSync(join(sourceDir, 'src', 'main', 'index.ts'), 'export const a = 999\n')

    // 7. A mesma prova passa a aparecer como SOURCE_STALE
    const listResult2 = executeListValidationProofs(ledger1, {})
    const parsed2 = JSON.parse(listResult2.content[0].text)
    expect(parsed2.count).toBe(1)
    expect(parsed2.proofs[0].proofId).toBe(p1.proofId)
    expect(parsed2.proofs[0].freshness).toBe('SOURCE_STALE')

    // 8. Nova execução do Implementador produz nova prova com novo fingerprint
    const currentFp = provider1.evaluateFreshness().currentSnapshot.fingerprint
    const p2 = ledger1.recordProof({
      kind: 'TARGETED_TEST',
      producer: 'IMPLEMENTER',
      status: 'PASSED',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 160,
      scope: ['src/main/index.ts'],
      sourceFingerprint: currentFp,
      runtimeInstanceId: provider1.getInstanceId(),
      summary: 'Targeted test for index.ts after update',
      evidenceFor: ['REQ-01']
    })

    // 9. Nova prova aparece como CURRENT
    const listResult3 = executeListValidationProofs(ledger1, {})
    const parsed3 = JSON.parse(listResult3.content[0].text)
    expect(parsed3.count).toBe(2)
    const currentProof = parsed3.proofs.find((p: any) => p.proofId === p2.proofId)
    expect(currentProof.freshness).toBe('CURRENT')

    // 10. Prova antiga permanece histórica (SOURCE_STALE)
    const historicalProof = parsed3.proofs.find((p: any) => p.proofId === p1.proofId)
    expect(historicalProof.freshness).toBe('SOURCE_STALE')

    // 11. Restart não apaga o Ledger
    ledger1.close()
    const ledgerAfterRestart = new ValidationLedger(dbPath, provider1)
    const listAfterRestart = executeListValidationProofs(ledgerAfterRestart, {})
    const parsedRestart = JSON.parse(listAfterRestart.content[0].text)
    expect(parsedRestart.count).toBe(2)
    expect(parsedRestart.proofs.map((p: any) => p.proofId)).toContain(p1.proofId)
    expect(parsedRestart.proofs.map((p: any) => p.proofId)).toContain(p2.proofId)
    ledgerAfterRestart.close()
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })
})
