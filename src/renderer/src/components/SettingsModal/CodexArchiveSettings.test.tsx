// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexArchiveSettings } from './CodexArchiveSettings'
import type { CodexArchiveReadiness } from '../../../../shared/types/codex-archive-types'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { handlers, choose, confirm } = vi.hoisted(() => ({ handlers: new Map<string, Function>(), choose: vi.fn(), confirm: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, callback: Function) => handlers.set(name, callback) }, dialog: { showOpenDialog: choose, showMessageBox: confirm } }))
vi.mock('../../../../main/local-mcp-clients/safe-config-file', async original => ({ ...await original<object>(), assertUserOwnedAsync: vi.fn(async () => {}) }))
import { registerCodexArchiveHandlers } from '../../../../main/ipc/codex-archive-handler'
import { CodexArchiveBridge } from '../../../../main/session-context/codex-archive-bridge'
import { candidateView, verifyCodexCandidate } from '../../../../main/session-context/codex-discovery'
import { queryCodexArchive, type AuthorizedCodexArchiveConnection } from '../../../../main/session-context/codex-archive'

const discovery = { state: 'ONE_VERIFIED_CANDIDATE', selectedId: 'fixture', candidates: [{ id: 'fixture', executable: 'C:/fixture/codex.exe', profile: 'C:/fixture/.codex' }] } as const

afterEach(cleanup)
it('requires choosing a discovered ambiguous installation and keeps missing/unsafe discovery disconnected', async () => {
  const select = vi.fn(async () => ({ state: 'NOT_CONFIGURED', discovery })), enable = vi.fn()
  window.codeAwareness = { codexArchive: { inspect: async () => ({ state: 'NOT_CONFIGURED', discovery: { ...discovery, state: 'AMBIGUOUS', selectedId: undefined } }), onChanged: () => () => {}, select, enable } } as any
  const view = render(<CodexArchiveSettings />)
  const choices = await screen.findByRole('combobox', { name: 'Instalação Codex' })
  expect((screen.getByRole('button', { name: 'Conectar ao Codex' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(choices, { target: { value: 'fixture' } })
  await screen.findByText('Pronto para conectar')
  expect(select).toHaveBeenCalledWith('fixture'); expect(enable).not.toHaveBeenCalled()
  view.unmount()
  for (const state of ['NOT_FOUND', 'INVALID']) {
    window.codeAwareness.codexArchive.inspect = async () => ({ state: 'NOT_CONFIGURED', discovery: { state, candidates: [] } }) as any
    const absent = render(<CodexArchiveSettings />)
    await screen.findByRole('note')
    expect((screen.getByRole('button', { name: 'Conectar ao Codex' }) as HTMLButtonElement).disabled).toBe(true)
    expect(enable).not.toHaveBeenCalled(); absent.unmount()
  }
})
it('inspects readiness without connecting, requires explicit action and reflects loss of authorization', async () => {
  let changed!: (value: CodexArchiveReadiness) => void
  const unsubscribe = vi.fn(), enable = vi.fn(async () => ({ state: 'READY', version: '0.155.0', discovery })), disable = vi.fn(async () => ({ state: 'NOT_CONFIGURED', discovery }))
  window.codeAwareness = { codexArchive: { inspect: async () => ({ state: 'NOT_CONFIGURED', discovery }), enable, disable, onChanged: (callback: typeof changed) => { changed = callback; return unsubscribe } } } as any
  const view = render(<CodexArchiveSettings />)
  const connect = await screen.findByRole('button', { name: 'Conectar ao Codex' })
  await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false))
  expect(enable).not.toHaveBeenCalled()
  fireEvent.click(connect)
  const disconnect = await screen.findByRole('button', { name: 'Desconectar' })
  expect(screen.getByRole('status').textContent).toContain('Codex 0.155.0')
  fireEvent.click(disconnect)
  await screen.findByRole('button', { name: 'Conectar ao Codex' })
  expect(disable).toHaveBeenCalledOnce()
  changed({ state: 'ACCOUNT_IDENTITY_UNAVAILABLE' })
  await screen.findByText('Não foi possível confirmar a conta')
  view.unmount(); expect(unsubscribe).toHaveBeenCalledOnce()
})

it('connects UI through protected IPC and the real bridge with one click, zero pickers/confirmations and metadata-only scoped requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-one-click-')), executable = join(root, 'codex.exe'), directory = join(root, '.codex')
  mkdirSync(directory); writeFileSync(executable, 'safe fixture, never executed')
  let connection: AuthorizedCodexArchiveConnection | undefined
  const candidate = await verifyCodexCandidate({ executable, directory }), listeners = new Set<(readiness: CodexArchiveReadiness) => void>()
  const probe = vi.fn(async () => ({ version: '0.155.0', supports: { archived: true, cwd: true, stateDbOnly: true } }))
  const request = vi.fn(async (method: string) => method === 'initialize' ? { userAgent: 'codex/0.155.0' } : method === 'account/read' ? { account: { type: 'chatgpt', email: 'fixture@example.invalid' } } : { data: [{ id: 'fixture-session', cwd: root, preview: 'PRIVATE' }], nextCursor: null })
  const close = vi.fn(), bridge = new CodexArchiveBridge({ repositoryId: 'repo', root, isCurrent: () => true,
    changed: (value, readiness) => { connection = value; for (const listener of listeners) listener(readiness) }, probe, connect: () => ({ request, close, initialized: () => {} }) })
  try {
    const frame = { url: 'file:///fixture/index.html' }, sender = { mainFrame: frame }, event = { sender, senderFrame: frame }, nativeWindow = { webContents: sender, isDestroyed: () => false }
    registerCodexArchiveHandlers(() => bridge, () => nativeWindow as any, frame.url, async () => ({ view: { state: 'ONE_VERIFIED_CANDIDATE', candidates: [candidateView(candidate)] }, candidates: [candidate] }))
    const invoke = (name: string) => handlers.get('codex-archive:' + name)!(event)
    window.codeAwareness = { codexArchive: { inspect: () => invoke('inspect'), enable: () => invoke('enable'), disable: () => invoke('disable'), onChanged: (listener: (readiness: CodexArchiveReadiness) => void) => { listeners.add(listener); return () => listeners.delete(listener) } } } as any
    render(<CodexArchiveSettings />)
    await screen.findByText('Pronto para conectar')
    expect(screen.getByText(/Perfil:/).textContent).toContain(directory)
    expect(probe).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Conectar ao Codex' }))
    await screen.findByRole('button', { name: 'Desconectar' })
    expect(probe).toHaveBeenCalledOnce(); expect(choose).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled()
    expect(request.mock.calls.map(call => call[0])).toEqual(['initialize', 'account/read'])
    const result = await queryCodexArchive(connection, 'repo', root, new AbortController().signal)
    expect(result.code).toBe('ARCHIVE_OBSERVED'); expect(JSON.stringify(result)).not.toMatch(/PRIVATE|example.invalid/)
    expect(request).toHaveBeenCalledWith('thread/list', { archived: true, cwd: root, limit: 20, useStateDbOnly: true }, expect.any(AbortSignal))
    fireEvent.click(screen.getByRole('button', { name: 'Desconectar' }))
    await screen.findByText('Pronto para conectar'); expect(close).toHaveBeenCalledOnce(); expect(connection).toBeUndefined()
  } finally { bridge.disable(); rmSync(root, { recursive: true, force: true }) }
})
