// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BranchAppAction, useBranchAppRuntime } from './BranchAppAction'
import type { BranchRecord } from '../../../../shared/types/branch-orchestration-types'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })
const branch: BranchRecord = { key: 'topic', repositoryId: 'repo', ref: 'refs/heads/topic', name: 'topic', revision: 'r1', generation: 'g1', namespace: 'LOCAL', head: 'a'.repeat(40), upstream: null, creation: { at: null, source: 'UNKNOWN' }, lastCommitAt: null, worktrees: [{ worktreeId: 'tree', generation: 'g1' }] }
const session = (state = 'RUNNING', more = {}) => ({ sessionId: 'session', operationId: 'operation', state, selection: { repositoryId: 'repo', worktreeId: 'tree', generation: 'g1' }, readiness: 'READY', liveness: 'VERIFIED', observation: 'CURRENT', resources: state === 'STOPPED' ? 'RELEASED' : 'RESERVED', source: { branch: 'topic' }, failure: null, ...more })
const list = (sessions: unknown[] = []) => ({ kind: 'SESSIONS', sessions, nextCursor: null, pendingOperationId: null, lastOperation: null })
const reply = (data: unknown) => ({ kind: 'PREVIEW_RUNTIME', result: { success: true, data } })
function Harness({ query, active = true, repo = 'repo' }: { query: any; active?: boolean; repo?: string }) {
  const runtime = useBranchAppRuntime(repo, query, active)
  return <><BranchAppAction branch={{ ...branch, repositoryId: repo }} runtime={runtime} disabled={!active}/>{runtime.uncertain && <button onClick={runtime.reconcile}>Verificar estado</button>}</>
}
const install = (handler: (r: any) => any = () => ({ kind: 'SESSION', session: session(), pending: false })) => vi.fn(async ({ request }) => reply(request.action === 'LIST' ? list() : await handler(request)))
async function runButton() { const button = await screen.findByRole('button', { name: 'Rodar aplicativo: topic' }); await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); return button }
it('runs the card exact branch snapshot with one intent and stops only its session', async () => {
  const query = install(r => ({ kind: 'SESSION', session: session(r.action === 'STOP' ? 'STOPPED' : 'RUNNING'), pending: false }))
  render(<Harness query={query}/>); fireEvent.click(await runButton())
  const stop = await screen.findByRole('button', { name: 'Encerrar aplicativo: topic' })
  expect(query.mock.calls.find(([r]) => r.request.action === 'RUN_BRANCH_APP')?.[0].request).toMatchObject({ repositoryId: 'repo', ref: branch.ref, revision: 'r1', operationId: expect.any(String) })
  expect(query.mock.calls.some(([r]) => ['START', 'PROFILES', 'PREFLIGHT', 'AUTHORIZE'].includes(r.request.action))).toBe(false)
  fireEvent.click(stop); await screen.findByRole('button', { name: 'Rodar aplicativo: topic' })
  expect(query.mock.calls.find(([r]) => r.request.action === 'STOP')?.[0].request).toEqual({ action: 'STOP', sessionId: 'session' })
})
it('reconciles an existing session through INSPECT without another launch or approval', async () => {
  const query = vi.fn(async ({ request }) => reply(request.action === 'LIST' ? list([session()]) : { kind: 'SESSION', session: session(), pending: false }))
  render(<Harness query={query}/>); await screen.findByText('Em execução')
  expect(query.mock.calls.map(([r]) => r.request.action)).toEqual(['LIST', 'INSPECT'])
})
it('retains a pending intent and does not claim running before current evidence', async () => {
  const query = install(() => ({ kind: 'SESSION', session: null, pending: true }))
  render(<Harness query={query}/>); fireEvent.click(await runButton()); await screen.findByText('Preparando…')
  expect(screen.queryByText('Em execução')).toBeNull()
  expect((screen.getByRole('button', { name: 'Rodar aplicativo: topic' }) as HTMLButtonElement).disabled).toBe(true)
})
it.each(['BRANCH_CHECKOUT_REQUIRED', 'APP_COOPERATION_MISSING', 'PROFILE_APPROVAL_REQUIRED', 'APP_PREFLIGHT_BLOCKED'])('shows honest %s diagnostic without false launch', async code => {
  const query = install(() => ({ kind: 'BRANCH_APP', reasonCode: code, message: 'Condição concreta do checkout.' }))
  render(<Harness query={query}/>); fireEvent.click(await runButton()); await screen.findByRole('alert')
  expect(screen.queryByText('Em execução')).toBeNull(); expect(screen.getByText(code)).toBeTruthy()
})
it('asks only for exceptional ambiguity and creates a new explicit intent with exact worktree identity', async () => {
  const query = install(r => r.worktree ? { kind: 'SESSION', session: session(), pending: false } : { kind: 'BRANCH_APP', reasonCode: 'BRANCH_CHECKOUT_AMBIGUOUS', message: 'Escolha o checkout.', candidates: [{ worktreeId: 'chosen', generation: 'g2', path: 'C:/chosen' }] })
  render(<Harness query={query}/>); fireEvent.click(await runButton()); fireEvent.click(await screen.findByText('Rodar neste checkout: C:/chosen'))
  await screen.findByRole('button', { name: 'Encerrar aplicativo: topic' })
  const calls = query.mock.calls.filter(([r]) => r.request.action === 'RUN_BRANCH_APP').map(([r]) => r.request)
  expect(calls[1].operationId).not.toBe(calls[0].operationId)
  expect(calls[1]).toMatchObject({ worktree: { worktreeId: 'chosen', generation: 'g2' } })
})
it('never auto-stops the conflicting session', async () => {
  const query = install(() => ({ kind: 'BRANCH_APP', reasonCode: 'PREVIEW_SESSION_ACTIVE', message: 'Outro aplicativo está ativo.', activeSession: session('RUNNING', { selection: { repositoryId: 'repo', worktreeId: 'other', generation: 'g2' } }) }))
  render(<Harness query={query}/>); fireEvent.click(await runButton()); const stop = await screen.findByText('Encerrar sessão atual')
  expect(query.mock.calls.some(([r]) => r.request.action === 'STOP')).toBe(false)
  fireEvent.click(stop); await waitFor(() => expect(query.mock.calls.some(([r]) => r.request.action === 'STOP' && r.request.sessionId === 'session')).toBe(true))
})
it('ignores a delayed launch result after switching repository', async () => {
  let release!: (data: any) => void
  const query = install(() => new Promise(resolve => { release = resolve }))
  const view = render(<Harness query={query}/>); fireEvent.click(await runButton())
  view.rerender(<Harness query={query} repo="other"/>); release({ kind: 'SESSION', session: session(), pending: false })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Rodar aplicativo: topic' }) as HTMLButtonElement).disabled).toBe(false))
  expect(screen.queryByText('Em execução')).toBeNull()
})
it('keeps unavailable observation explicit and resumes only after a requested check', async () => {
  const query = vi.fn(async () => { throw Error('IPC_TIMEOUT') })
  render(<Harness query={query}/>); fireEvent.click(await screen.findByText('Verificar estado'))
  await waitFor(() => expect(query).toHaveBeenCalledTimes(2))
  expect(screen.queryByText('Em execução')).toBeNull()
})
it('preserves unexpected exit instead of reporting a healthy stop', async () => {
  const query = vi.fn(async ({ request }) => reply(request.action === 'LIST' ? list([session()]) : { kind: 'SESSION', session: session('FAILED', { resources: 'RELEASED', failure: 'UNEXPECTED_PROCESS_EXIT', termination: { kind: 'UNEXPECTED_EXIT' } }), pending: false }))
  render(<Harness query={query}/>); await screen.findByText(/saiu inesperadamente/)
  expect(screen.queryByText('Em execução')).toBeNull(); expect(screen.queryByRole('button', { name: 'Encerrar aplicativo: topic' })).toBeNull()
})

it('reconciles pending completion automatically using its operation identity', async () => {
  vi.useFakeTimers()
  let operationId: string | undefined
  const query = vi.fn(async ({ request }) => reply(request.action === 'LIST' ? operationId ? { ...list(), lastOperation: { operationId, code: null, result: { success: true, data: { kind: 'SESSION', session: session(), pending: false } } } } : list() : (operationId = request.operationId, { kind: 'SESSION', session: null, pending: true })))
  render(<Harness query={query}/>); await act(async () => {})
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Rodar aplicativo: topic' })) })
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(screen.getByText('Em execução')).toBeTruthy()
  expect(query.mock.calls.filter(([r]) => r.request.action === 'RUN_BRANCH_APP')).toHaveLength(1)
})
it('does not swallow a click or accept stale evidence while a background read is outstanding', async () => {
  vi.useFakeTimers()
  let release!: (value: any) => void, reads = 0
  const query = vi.fn(async ({ request }) => request.action === 'LIST' ? ++reads === 1 ? reply(list()) : new Promise(resolve => { release = resolve }) : reply({ kind: 'SESSION', session: session(), pending: false }))
  render(<Harness query={query}/>); await act(async () => {})
  await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Rodar aplicativo: topic' })) })
  expect(screen.getByText('Em execução')).toBeTruthy()
  await act(async () => { release(reply(list([session('STOPPED')]))) })
  expect(screen.getByText('Em execução')).toBeTruthy()
})

it('consumes asynchronous inspect receipts without relaunching or promoting historical records by assumption', async () => {
  vi.useFakeTimers()
  const record = session('RUNNING', { observation: 'HISTORICAL' })
  let inspected = false
  const query = vi.fn(async ({ request }) => reply(request.action === 'LIST' ? { ...list([record]), lastOperation: inspected ? { operationId: 'operation', code: null, result: { success: true, data: { kind: 'SESSION', session: record, pending: false } } } : null } : (inspected = true, { kind: 'SESSION', session: null, pending: true })))
  render(<Harness query={query}/>); await act(async () => {})
  expect(screen.queryByText('Em execução')).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(screen.getByText('Em execução')).toBeTruthy()
  expect(record.observation).toBe('HISTORICAL')
  expect(query.mock.calls.filter(([r]) => r.request.action === 'INSPECT')).toHaveLength(1)
})
it('does not send a competing inspect while the launch operation is pending', async () => {
  const query = vi.fn(async () => reply({ ...list([session('PREPARING')]), pendingOperationId: 'operation' }))
  render(<Harness query={query}/>); await act(async () => {})
  expect(query).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('Em execução')).toBeNull()
})
