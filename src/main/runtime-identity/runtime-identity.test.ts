import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeIdentityProvider } from './runtime-identity-provider'
import { executeGetRuntimeIdentity, RUNTIME_IDENTITY_MCP_TOOL } from './runtime-identity-mcp'
import { ContextNavigationMcpAdapter } from '../mcp/context-navigation-mcp-adapter'
import { SystemHealthCore } from '../system-health/system-health-core'
import { executeGetSystemHealth } from '../system-health/system-health-mcp'
import type { CodeScopeTraceEvent } from '../mcp/code-scope-health'
import { createDecoratedTraceSink } from './trace-decorator'

describe('Runtime Identity & Freshness — Permanent Harness', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-runtime-test-'))
    mkdirSync(join(tempDir, 'src', 'main'), { recursive: true })
    mkdirSync(join(tempDir, 'src', 'shared'), { recursive: true })
    mkdirSync(join(tempDir, 'docs'), { recursive: true })

    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0' }))
    writeFileSync(join(tempDir, 'src', 'main', 'index.ts'), 'export const a = 1\n')
    writeFileSync(join(tempDir, 'src', 'shared', 'types.ts'), 'export type T = string\n')
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('1. Identidade de processo: mesma instância mantém instanceId; nova instanciação gera novo ID; startedAt é imutável', () => {
    const provider1 = new RuntimeIdentityProvider({ rootDir: tempDir })
    const id1 = provider1.getInstanceId()
    const startedAt1 = provider1.getStartedAt()

    expect(id1).toBe(provider1.getInstanceId())
    expect(startedAt1).toBe(provider1.getStartedAt())
    expect(id1).toMatch(/^inst-/)

    const provider2 = new RuntimeIdentityProvider({ rootDir: tempDir })
    expect(provider2.getInstanceId()).not.toBe(id1)
  })

  it('2. Source unchanged: startup e current iguais resultam em MATCH e zero divergências', () => {
    const provider = new RuntimeIdentityProvider({ rootDir: tempDir })
    const payload = provider.getIdentityPayload()

    expect(payload.freshness.state).toBe('MATCH')
    expect(payload.freshness.divergence).toBeUndefined()
    expect(payload.startupSource.fingerprint).toBe(payload.currentSource.fingerprint)
    expect(payload.startupSource.fileCount).toBeGreaterThan(0)
    expect(payload.startupSource.fileCount).toBe(payload.currentSource.fileCount)

    const summary = provider.getSummary()
    expect(summary.freshness).toBe('MATCH')
    expect(summary.changedFileCount).toBeUndefined()
    expect(summary.recommendedAction).toBeUndefined()
  })

  it('3. Arquivo modificado: detecta SOURCE_CHANGED_SINCE_START e lista arquivo em modifiedFiles', () => {
    const provider = new RuntimeIdentityProvider({ rootDir: tempDir })
    const initialFingerprint = provider.getStartupSnapshot().fingerprint

    // Modificar arquivo do runtime
    writeFileSync(join(tempDir, 'src', 'main', 'index.ts'), 'export const a = 2\n')

    const payload = provider.getIdentityPayload()
    expect(payload.freshness.state).toBe('SOURCE_CHANGED_SINCE_START')
    expect(payload.currentSource.fingerprint).not.toBe(initialFingerprint)
    expect(payload.freshness.divergence).toBeDefined()
    expect(payload.freshness.divergence?.changedFileCount).toBe(1)
    expect(payload.freshness.divergence?.modifiedFiles).toEqual(['src/main/index.ts'])
    expect(payload.freshness.divergence?.recommendedAction).toBe('RESTART_RUNTIME')

    const summary = provider.getSummary()
    expect(summary.freshness).toBe('SOURCE_CHANGED_SINCE_START')
    expect(summary.changedFileCount).toBe(1)
    expect(summary.recommendedAction).toBe('RESTART_RUNTIME')
  })

  it('4. Arquivo adicionado: detecta novo arquivo e o lista em addedFiles', () => {
    const provider = new RuntimeIdentityProvider({ rootDir: tempDir })

    writeFileSync(join(tempDir, 'src', 'shared', 'utils.ts'), 'export const util = () => true\n')

    const payload = provider.getIdentityPayload()
    expect(payload.freshness.state).toBe('SOURCE_CHANGED_SINCE_START')
    expect(payload.freshness.divergence?.addedFiles).toEqual(['src/shared/utils.ts'])
    expect(payload.freshness.divergence?.changedFileCount).toBe(1)
    expect(payload.freshness.divergence?.recommendedAction).toBe('RESTART_RUNTIME')
  })

  it('5. Arquivo removido: detecta remoção e o lista em removedFiles', () => {
    const provider = new RuntimeIdentityProvider({ rootDir: tempDir })

    rmSync(join(tempDir, 'src', 'shared', 'types.ts'))

    const payload = provider.getIdentityPayload()
    expect(payload.freshness.state).toBe('SOURCE_CHANGED_SINCE_START')
    expect(payload.freshness.divergence?.removedFiles).toEqual(['src/shared/types.ts'])
    expect(payload.freshness.divergence?.changedFileCount).toBe(1)
  })

  it('6. Arquivo alterado e restaurado: volta deterministicamente a MATCH', () => {
    const originalContent = 'export const a = 1\n'
    const provider = new RuntimeIdentityProvider({ rootDir: tempDir })
    const initialFingerprint = provider.getStartupSnapshot().fingerprint

    // Alterar
    writeFileSync(join(tempDir, 'src', 'main', 'index.ts'), 'export const a = 999\n')
    expect(provider.evaluateFreshness().freshness.state).toBe('SOURCE_CHANGED_SINCE_START')

    // Restaurar ao conteúdo idêntico
    writeFileSync(join(tempDir, 'src', 'main', 'index.ts'), originalContent)
    const afterRestore = provider.getIdentityPayload()
    expect(afterRestore.freshness.state).toBe('MATCH')
    expect(afterRestore.currentSource.fingerprint).toBe(initialFingerprint)
    expect(afterRestore.freshness.divergence).toBeUndefined()
  })

  it('7. Ruído excluído: alterações em testes e docs não invalidam freshness do backend', () => {
    const provider = new RuntimeIdentityProvider({ rootDir: tempDir })
    const initialFingerprint = provider.getStartupSnapshot().fingerprint

    // Criar e alterar testes, fixtures e markdown
    writeFileSync(join(tempDir, 'src', 'main', 'index.test.ts'), 'test("mock", () => {})\n')
    writeFileSync(join(tempDir, 'src', 'shared', 'spec.test.tsx'), 'export {}\n')
    writeFileSync(join(tempDir, 'docs', 'README.md'), '# Documentation\n')

    const payload = provider.getIdentityPayload()
    expect(payload.freshness.state).toBe('MATCH')
    expect(payload.currentSource.fingerprint).toBe(initialFingerprint)
  })

  it('8. Independência do CodeMap: get_runtime_identity responde mesmo com CodeMap bloqueado ou offline', async () => {
    const provider = new RuntimeIdentityProvider({ rootDir: tempDir })

    // Simular navegação cujo CodeMap pendura ou lança
    const hangingNavigation = {
      discoverRepository: vi.fn(async () => {
        throw new Error('CodeMap hung in snapshot maintenance')
      }),
      getRelationships: vi.fn(),
      inspectFiles: vi.fn(),
      readCode: vi.fn(),
      getReferences: vi.fn(),
      getSymbolDependencies: vi.fn(),
      getSymbolHierarchy: vi.fn()
    }

    const adapter = new ContextNavigationMcpAdapter(hangingNavigation as any, undefined, provider)

    // get_runtime_identity responde imediatamente sem tocar a navegação
    const result = await adapter.callTool('get_runtime_identity', {})
    expect(result.isError).toBeUndefined()
    expect(hangingNavigation.discoverRepository).not.toHaveBeenCalled()

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.runtime.instanceId).toBe(provider.getInstanceId())
    expect(parsed.freshness.state).toBe('MATCH')
  })

  it('9. Tool get_runtime_identity está listada no catálogo público do MCP com schema protegido', () => {
    const provider = new RuntimeIdentityProvider({ rootDir: tempDir })
    const adapter = new ContextNavigationMcpAdapter({} as any, undefined, provider)

    const tools = adapter.listTools()
    const tool = tools.find((t) => t.name === 'get_runtime_identity')
    expect(tool).toBeDefined()
    expect(tool?.description).toContain('Inspect the running backend instance identity')
    expect(tool?.securitySchemes).toEqual([{ type: 'oauth2', scopes: [] }])

    const directExec = executeGetRuntimeIdentity(provider, {})
    expect(directExec.isError).toBeUndefined()
    expect(JSON.parse(directExec.content[0].text).runtime.instanceId).toBe(provider.getInstanceId())
  })

  it('10. System Health: freshness divergente projeta summary com recommendedAction mas mantém OPERATIONAL nos 12 estágios', () => {
    const provider = new RuntimeIdentityProvider({ rootDir: tempDir })
    const core = new SystemHealthCore({ runtimeIdentityProvider: provider })

    // Simular chamada bem sucedida end-to-end
    const ts = new Date().toISOString()
    const events: CodeScopeTraceEvent[] = [
      { timestamp: ts, requestId: 'req-h1', sessionId: 'sess-h1', method: 'tools/call', tool: 'discover_repository', stage: 'gateway-request-started', durationMs: 0, status: 'started' },
      { timestamp: ts, requestId: 'req-h1', sessionId: 'sess-h1', method: 'tools/call', tool: 'discover_repository', stage: 'desktop-request-received', durationMs: 10, status: 'started' },
      { timestamp: ts, requestId: 'req-h1', sessionId: 'sess-h1', method: 'tools/call', tool: 'discover_repository', stage: 'codescope-response-produced', durationMs: 20, status: 'success' },
      { timestamp: ts, requestId: 'req-h1', sessionId: 'sess-h1', method: 'tools/call', tool: 'discover_repository', stage: 'mcp-response-sent', durationMs: 25, status: 'success' },
      { timestamp: ts, requestId: 'req-h1', sessionId: 'sess-h1', method: 'tools/call', tool: 'discover_repository', stage: 'gateway-response-delivered', durationMs: 30, status: 'success' }
    ]
    for (const ev of events) core.sink.record(ev)

    // Modificar arquivo para causar divergência de source
    writeFileSync(join(tempDir, 'src', 'main', 'index.ts'), 'export const a = 42\n')

    const res = executeGetSystemHealth(core, {})
    const payload = JSON.parse(res.content[0].text)

    // Invariante: a saúde operacional permanece OPERATIONAL
    expect(payload.status).toBe('OPERATIONAL')
    expect(payload.stages.every((s: { status: string }) => s.status !== 'FAILED')).toBe(true)

    // A projeção de identidade reflete a divergência sem corromper a saúde operacional
    expect(payload.runtimeIdentity).toBeDefined()
    expect(payload.runtimeIdentity.instanceId).toBe(provider.getInstanceId())
    expect(payload.runtimeIdentity.freshness).toBe('SOURCE_CHANGED_SINCE_START')
    expect(payload.runtimeIdentity.changedFileCount).toBe(1)
    expect(payload.runtimeIdentity.recommendedAction).toBe('RESTART_RUNTIME')
  })

  it('11. Trace correlation: decorator injeta runtimeInstanceId e provas o registram', () => {
    const provider = new RuntimeIdentityProvider({ rootDir: tempDir })
    const core = new SystemHealthCore({ runtimeIdentityProvider: provider })
    const decoratedSink = createDecoratedTraceSink(core.sink, provider)

    const ts = new Date().toISOString()
    const base = { requestId: 'req-c1', sessionId: 'sess-c1', method: 'tools/call', tool: 'discover_repository', timestamp: ts }

    decoratedSink.record({ ...base, stage: 'gateway-request-started', durationMs: 0, status: 'started' })
    decoratedSink.record({ ...base, stage: 'desktop-request-received', durationMs: 10, status: 'started' })
    decoratedSink.record({ ...base, stage: 'codescope-response-produced', durationMs: 20, status: 'success' })
    decoratedSink.record({ ...base, stage: 'gateway-response-delivered', durationMs: 30, status: 'success' })

    const state = core.getState()
    expect(state.status).toBe('OPERATIONAL')
    expect(state.lastFunctionalProof?.runtimeInstanceId).toBe(provider.getInstanceId())
  })

  it('12. Consciência de restart: falha com instanceId anterior é marcada como isHistoricalRuntime', () => {
    const oldProvider = new RuntimeIdentityProvider({ rootDir: tempDir })
    const currentProvider = new RuntimeIdentityProvider({ rootDir: tempDir })
    expect(oldProvider.getInstanceId()).not.toBe(currentProvider.getInstanceId())

    const core = new SystemHealthCore({ runtimeIdentityProvider: currentProvider })

    const ts = new Date().toISOString()
    // Evento contendo o instanceId do runtime anterior
    const failEvents: CodeScopeTraceEvent[] = [
      { timestamp: ts, requestId: 'req-old', sessionId: 'sess-old', method: 'tools/call', tool: 'discover_repository', stage: 'gateway-request-started', durationMs: 0, status: 'started', runtimeInstanceId: oldProvider.getInstanceId() },
      { timestamp: ts, requestId: 'req-old', sessionId: 'sess-old', method: 'tools/call', tool: 'discover_repository', stage: 'desktop-request-received', durationMs: 10, status: 'started', runtimeInstanceId: oldProvider.getInstanceId() },
      { timestamp: ts, requestId: 'req-old', sessionId: 'sess-old', method: 'tools/call', tool: 'discover_repository', stage: 'relay-response-forwarded', durationMs: 20, status: 'error', error: 'RELAY_CLOSED', runtimeInstanceId: oldProvider.getInstanceId() }
    ]
    for (const ev of failEvents) core.sink.record(ev)

    const res = executeGetSystemHealth(core, {})
    const payload = JSON.parse(res.content[0].text)

    expect(payload.lastFailure).toBeDefined()
    expect(payload.lastFailure.runtimeInstanceId).toBe(oldProvider.getInstanceId())
    expect(payload.lastFailure.isHistoricalRuntime).toBe(true)
    expect(payload.lastFailureDiagnosis.isHistoricalRuntime).toBe(true)
    expect(payload.lastFailureDiagnosis.evidenceState).toBe('HISTORICAL')
  })
})
