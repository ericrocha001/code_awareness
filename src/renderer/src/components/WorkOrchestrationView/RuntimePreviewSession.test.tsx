// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RuntimePreviewSession } from './RuntimePreviewSession'
afterEach(cleanup)
const selection = { repositoryId: 'repo', worktreeId: 'tree', generation: 'generation', profileId: 'web', fingerprint: 'hash' }
const session = { sessionId: 'session', operationId: 'operation', selection, profileRevision: 1, revision: 4, at: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: null,
  state: 'CLEANUP_INCOMPLETE', readiness: 'UNVERIFIABLE', observation: 'UNVERIFIABLE', resources: 'UNVERIFIABLE', failure: 'ENDPOINT_RELEASE_UNVERIFIED', source: null, coverage: [{ stage: 'LOADED_COMPONENT', component: 'WEB', status: 'STALE', reasonCode: 'HMR_PARTIAL', evidenceRef: 'app.js', at: new Date().toISOString() }], qualifications: [], endpoint: null }
const reply = (data: unknown) => ({ kind: 'PREVIEW_RUNTIME', result: { success: true, data } })
it('has no idle probes and shows incomplete stop with a session-specific retry', async () => {
  const query = vi.fn(async (_operation: unknown) => reply({ kind: 'SESSION', session, pending: false }))
  render(<RuntimePreviewSession selection={selection} repositoryId="repo" worktreeId="tree" startAllowed disabled={false} query={query as any}/> )
  expect(query).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Iniciar preview'))
  await screen.findByText('CLEANUP_INCOMPLETE')
  expect(screen.getByText('HMR_PARTIAL')).toBeTruthy()
  expect(screen.queryByText('Abrir aplicação isolada')).toBeNull()
  fireEvent.click(screen.getByText('Parar esta sessão'))
  expect(query.mock.calls.at(-1)?.[0]).toEqual({ action: 'PREVIEW_RUNTIME', request: { action: 'STOP', sessionId: 'session' } })
})
it('does not turn READY or a historical session into a validated feature', async () => {
  const query = vi.fn(async () => reply({ kind: 'SESSION', session: { ...session, state: 'RUNNING', readiness: 'READY', observation: 'HISTORICAL' }, pending: false }))
  render(<RuntimePreviewSession selection={selection} repositoryId="repo" worktreeId="tree" startAllowed disabled={false} query={query as any}/> )
  fireEvent.click(screen.getByText('Iniciar preview')); await screen.findByText('RUNNING')
  expect(screen.getByText('Observação: HISTORICAL')).toBeTruthy()
  expect(screen.queryByText('PASSED')).toBeNull()
  expect(screen.getByText(/A funcionalidade exige evidência comportamental/)).toBeTruthy()
})

it('keeps the explicitly inspected historical session when another operation completes in the same Worktree', async () => {
  const historical = { ...session, sessionId: 'historical-A', startedAt: '2026-10-21T12:00:00Z' }, latest = { ...session, sessionId: 'latest-B', startedAt: '2026-10-22T12:00:00Z' }
  const query = vi.fn(async (operation: any) => reply(operation.request.action === 'INSPECT' ? { kind: 'SESSION', session: historical, pending: false } : { kind: 'SESSIONS', sessions: [latest, historical], pendingOperationId: null, nextCursor: null, lastOperation: { result: { success: true, data: { kind: 'SESSION', session: latest, pending: false } } } }))
  render(<RuntimePreviewSession selection={selection} repositoryId="repo" worktreeId="tree" startAllowed disabled={false} query={query as any}/> )
  fireEvent.click(screen.getByText('Consultar sessões'))
  fireEvent.click(await screen.findByRole('button', { name: /21\/10\/2026/ }))
  await screen.findByText('historical-A', { selector: 'p code' })
  fireEvent.click(screen.getByText('Consultar sessões'))
  await screen.findByText('historical-A', { selector: 'p code' })
  expect(screen.queryByText('latest-B', { selector: 'p code' })).toBeNull()
})
