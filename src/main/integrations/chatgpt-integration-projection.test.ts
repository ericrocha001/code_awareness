import { describe, expect, it } from 'vitest'
import type { ConnectionState } from '../../shared/types/connection-types'
import type { McpLifecycleState } from '../mcp/mcp-lifecycle'
import { ChatGptIntegrationProjection } from './chatgpt-integration-projection'
import type { CodeScopeFunctionalHealth } from '../mcp/code-scope-health'

function fixture() {
  const listeners = new Set<() => void>()
  const onChanged = (listener: (...args: any[]) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  let remote: ConnectionState = { remoteAccessEnabled: true, transportKind: 'relay', status: 'CONNECTED', transport: 'relay', projectId: 'A', externalEndpoint: 'secret-endpoint', localEndpoint: 'local-secret', connectedAt: '2026-09-17T20:00:00.000Z' }
  let mcp: McpLifecycleState = { status: 'RUNNING', available: true, projectId: 'A', endpoint: 'local-secret' }
  let project: { id: string; name: string; path: string } | null = { id: 'A', name: 'project-a', path: '/private-path' }
  let configured = true
  let health: CodeScopeFunctionalHealth = { status: 'OPERATIONAL', lastSuccessfulToolCall: 'discover_repository', lastSuccessfulAt: '2026-09-17T20:00:01.000Z', lastFailedToolCall: null, lastFailedAt: null, lastFailureStage: null, lastError: null }
  const projection = new ChatGptIntegrationProjection({ getState: () => remote, onChanged }, { getState: () => ({ revision: 1, project }), onChanged }, { getState: () => mcp, onChanged }, () => configured, { onChanged }, { getState: () => health, onChanged })
  return { projection, listeners, remote: (value: Partial<ConnectionState>) => { remote = { ...remote, ...value } as ConnectionState }, mcp: (value: McpLifecycleState) => { mcp = value }, project: (value: typeof project) => { project = value }, configured: (value: boolean) => { configured = value }, health: (value: CodeScopeFunctionalHealth) => { health = value }, emit: () => { for (const listener of listeners) listener() } }
}

describe('ChatGPT integration projection', () => {
  it.each<[string, (f: ReturnType<typeof fixture>) => void]>([
    ['DISABLED', (f: ReturnType<typeof fixture>) => { f.remote({ remoteAccessEnabled: false }); f.configured(false) }],
    ['SETUP_REQUIRED', (f: ReturnType<typeof fixture>) => f.configured(false)],
    ['WAITING_FOR_PROJECT', (f: ReturnType<typeof fixture>) => f.project(null)],
    ['CONNECTING', (f: ReturnType<typeof fixture>) => f.mcp({ status: 'STARTING', available: false })],
    ['CONNECTING', (f: ReturnType<typeof fixture>) => f.remote({ status: 'CONNECTING' })],
    ['CONNECTING', (f: ReturnType<typeof fixture>) => f.health({ status: 'UNKNOWN', lastSuccessfulToolCall: null, lastSuccessfulAt: null, lastFailedToolCall: null, lastFailedAt: null, lastFailureStage: null, lastError: null })],
    ['READY', () => {}],
    ['OFFLINE', (f: ReturnType<typeof fixture>) => f.remote({ status: 'ERROR', error: 'RELAY_CLOSED' })],
    ['NEEDS_ATTENTION', (f: ReturnType<typeof fixture>) => { f.remote({ status: 'ERROR', error: 'INVALID_CREDENTIAL' }); f.configured(false) }],
    ['NEEDS_ATTENTION', (f: ReturnType<typeof fixture>) => f.remote({ status: 'ERROR', error: 'INSTALLATION_REVOKED' })],
    ['NEEDS_ATTENTION', (f: ReturnType<typeof fixture>) => f.remote({ transportKind: 'ngrok' })],
    ['CONNECTING', (f: ReturnType<typeof fixture>) => f.project({ id: 'B', name: 'project-b', path: '/b' })]
  ])('projects %s from canonical inputs', (expected, arrange) => {
    const f = fixture(); arrange(f)
    expect(f.projection.getState().status).toBe(expected)
    f.projection.dispose(); expect(f.listeners.size).toBe(0)
  })

  it('publishes live transitions, drops project A and orders hydration with revisions', () => {
    const f = fixture(), states: ReturnType<typeof f.projection.getState>[] = []
    f.projection.onChanged((value) => states.push(value))
    f.project(null); f.emit()
    expect(states.at(-1)).toMatchObject({ status: 'WAITING_FOR_PROJECT', activeProject: null })
    f.project({ id: 'A', name: 'project-a', path: '/a' }); f.remote({ status: 'CONNECTING' }); f.emit()
    expect(states.at(-1)?.status).toBe('CONNECTING')
    f.remote({ status: 'CONNECTED' }); f.emit()
    expect(states.at(-1)?.status).toBe('READY')
    expect(states.at(-1)!.revision).toBeGreaterThan(states[0].revision)
    f.projection.dispose()
  })

  it('allowlists DTO fields and sanitizes unexpected errors', () => {
    const f = fixture()
    f.remote({ status: 'ERROR', error: 'Bearer secret-token' as never, credential: 'credential-secret', source: 'source-secret' } as never)
    const state = f.projection.getState()
    expect(state.lastError).toBe('CONNECTION_ERROR')
    expect(Object.keys(state).sort()).toEqual(['revision', 'status', 'remoteAccessEnabled', 'transport', 'connectionStatus', 'mcpStatus', 'activeProject', 'installationConfigured', 'codeScopeStatus', 'lastSuccessfulToolCall', 'lastSuccessfulAt', 'lastFailedToolCall', 'lastFailedAt', 'lastFailureStage', 'lastError', 'lastStageLatencyMs', 'lastDeadlineRemainingMs'].sort())
    for (const forbidden of ['secret-token', 'credential-secret', 'source-secret', 'secret-endpoint', '/private-path', 'local-secret']) expect(JSON.stringify(state)).not.toContain(forbidden)
    f.projection.dispose()
  })

  it('requires current functional evidence and exposes a failed boundary', () => {
    const f = fixture()
    f.remote({ connectedAt: '2026-09-17T20:01:00.000Z' })
    expect(f.projection.getState()).toMatchObject({ status: 'CONNECTING', codeScopeStatus: 'UNKNOWN' })
    f.health({ status: 'DEGRADED', lastSuccessfulToolCall: 'discover_repository', lastSuccessfulAt: '2026-09-17T20:00:01.000Z', lastFailedToolCall: 'inspect_files', lastFailedAt: '2026-09-17T20:01:01.000Z', lastFailureStage: 'bridge-forward-started', lastError: 'REQUEST_TIMEOUT' })
    expect(f.projection.getState()).toMatchObject({ status: 'NEEDS_ATTENTION', codeScopeStatus: 'DEGRADED', lastError: 'REQUEST_TIMEOUT', lastFailureStage: 'bridge-forward-started' })
    f.projection.dispose()
  })
})
