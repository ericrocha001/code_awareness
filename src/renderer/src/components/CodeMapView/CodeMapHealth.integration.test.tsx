// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { IntegrityCheckResult, IntegrityIssue } from '../../../../shared/types'
import { CodeMapView } from './CodeMapView'

afterEach(() => { cleanup(); localStorage.clear() })

const healthy: IntegrityCheckResult = {
  status: 'healthy', filesChecked: 2, hashesChecked: 2, hashesMismatched: 0, filesMissing: 0,
  filesUnexpected: 0, orphanElements: 0, invalidRelationships: 0, databaseInconsistencies: 0,
  details: [], durationMs: 20
}

async function mount() {
  const api = {
    openRepository: vi.fn(async () => ({ success: true })),
    getFiles: vi.fn(async () => ({ success: true, data: [] })),
    getElements: vi.fn(async () => ({ success: true, data: [] })),
    getRelationships: vi.fn(async () => ({ success: true, data: [] })),
    getModifiedFilesCount: vi.fn(async () => ({ success: true, data: 0 })),
    getRepository: vi.fn(async () => ({ success: true, data: { name: 'repo', lastIndexedAt: '2026-10-05T12:00:00Z' } })),
    getSyncStatus: vi.fn(async () => ({ success: true, data: { lastSyncAt: null } })),
    getTags: vi.fn(async () => ({ success: true, data: [] })),
    getFileTags: vi.fn(async () => ({ success: true, data: {} })),
    onCodeMapFileConfirmed: vi.fn(() => () => {}),
    onCodeMapFileIndexed: vi.fn(() => () => {}),
    verifyIntegrity: vi.fn<Window['codeAwareness']['verifyIntegrity']>(async () => ({ success: true, data: healthy })),
    indexRepository: vi.fn<Window['codeAwareness']['indexRepository']>(),
    saveToDownloads: vi.fn(async () => ({ success: true, filePath: 'C:/exports/integrity.md' }))
  }
  window.codeAwareness = api as unknown as Window['codeAwareness']
  const status = vi.fn()
  render(<CodeMapView activeProject={{ path: 'C:/repo', name: 'repo' }} onSelectProject={vi.fn()} onStatusMessage={status} />)
  await screen.findByRole('button', { name: 'Code Map Health: Healthy' })
  return { api, status }
}

function verify() {
  fireEvent.click(screen.getByRole('button', { name: 'Code Map Health: Healthy' }))
  fireEvent.click(screen.getByRole('button', { name: /Verificar integridade/ }))
}

it('shows Working during verification and reports healthy without an empty modal', async () => {
  const { api, status } = await mount()
  let finish!: (result: Awaited<ReturnType<typeof api.verifyIntegrity>>) => void
  api.verifyIntegrity.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  verify()
  expect(screen.getByRole('button', { name: 'Code Map Health: Working' }).querySelector('.cmv-spin')).toBeTruthy()
  await act(async () => finish({ success: true, data: healthy }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(status).toHaveBeenLastCalledWith('CodeMap íntegro — Nenhuma inconsistência encontrada.', false)
  const trigger = screen.getByRole('button', { name: 'Code Map Health: Healthy' })
  expect(trigger.querySelector('.cmv-spin')).toBeNull()
  fireEvent.click(trigger)
  expect(screen.getByText('Saudável')).toBeTruthy()
})

it.each([
  { success: false, error: 'Controlled verification failure' },
  { success: true, data: { ...healthy, status: 'unknown' as const } }
])('does not report Healthy after a failed or unknown integrity result: %j', async result => {
  const { api, status } = await mount()
  api.verifyIntegrity.mockResolvedValueOnce(result)
  verify()
  const trigger = await screen.findByRole('button', { name: 'Code Map Health: Issue' })
  expect(trigger.querySelector('.cmv-spin')).toBeNull()
  expect(status).toHaveBeenLastCalledWith(expect.any(String), true)
  fireEvent.click(trigger)
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Revisar inconsistências/ })).toBeNull()
})

it('preserves issue groups, selection, review, export and selected repair', async () => {
  const { api } = await mount()
  const issues: IntegrityIssue[] = [
    { id: 'hash:a', type: 'hash_mismatch', severity: 'warning', target: 'src/a.ts', description: 'Conteúdo divergente' },
    { id: 'missing:b', type: 'file_missing', severity: 'error', target: 'src/b.ts', description: 'Arquivo ausente' }
  ]
  api.verifyIntegrity.mockResolvedValueOnce({ success: true, data: { ...healthy, status: 'inconsistent', details: issues, hashesMismatched: 1, filesMissing: 1, staleHealed: 2 } })
  verify()
  let modal = await screen.findByRole('dialog', { name: 'Inconsistências encontradas' })
  expect(screen.queryByRole('region', { name: 'Saúde do CodeMap' })).toBeNull()
  expect(within(modal).getByText('Estados obsoletos curados: 2')).toBeTruthy()
  fireEvent.click(within(modal).getByRole('button', { name: 'Cancelar' }))
  fireEvent.click(screen.getByRole('button', { name: 'Code Map Health: Issue' }))
  fireEvent.click(screen.getByRole('button', { name: /Revisar inconsistências/ }))
  modal = screen.getByRole('dialog')
  fireEvent.click(within(modal).getByRole('checkbox', { name: /src\/b.ts/ }))
  fireEvent.click(within(modal).getByRole('button', { name: /Conteúdo divergente/ }))
  expect(within(modal).getByRole('button', { name: /Corrigir selecionados \(1\)/ })).toBeTruthy()
  fireEvent.click(within(modal).getByRole('button', { name: 'Exportar relatório' }))
  await waitFor(() => expect(api.saveToDownloads).toHaveBeenCalledWith(expect.stringContaining('src/a.ts'), expect.stringContaining('integridade_repo'), 'markdown'))
  api.verifyIntegrity.mockResolvedValueOnce({ success: true, data: healthy })
  fireEvent.click(within(modal).getByRole('button', { name: /Corrigir selecionados \(1\)/ }))
  await waitFor(() => expect(api.verifyIntegrity).toHaveBeenLastCalledWith('C:/repo', { autoRepair: true, selectedIssues: ['hash:a'], issues: [issues[0]] }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('cancels without rebuilding, confirms once, reloads on success and retains a visible failure', async () => {
  const { api, status } = await mount()
  const requestRebuild = () => {
    const trigger = screen.getByRole('button', { name: /Code Map Health:/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('Avançado'))
    fireEvent.click(screen.getByRole('button', { name: /Reconstruir índice/ }))
    return screen.getByRole('dialog', { name: 'Reconstruir o índice do CodeMap?' })
  }
  fireEvent.click(within(requestRebuild()).getByRole('button', { name: 'Cancelar' }))
  expect(api.indexRepository).not.toHaveBeenCalled()
  let finish!: (result: Awaited<ReturnType<typeof api.indexRepository>>) => void
  api.indexRepository.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.click(within(requestRebuild()).getByRole('button', { name: 'Reconstruir índice' }))
  expect(api.indexRepository).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: 'Code Map Health: Working' }).querySelector('.cmv-spin')).toBeTruthy()
  await act(async () => finish({ success: true, data: { filesIndexed: 2, elementsExtracted: 4 } }))
  await screen.findByRole('button', { name: 'Code Map Health: Healthy' })
  expect(api.getFiles).toHaveBeenCalledTimes(2)
  api.indexRepository.mockResolvedValueOnce({ success: false, error: 'Controlled rebuild failure' })
  fireEvent.click(within(requestRebuild()).getByRole('button', { name: 'Reconstruir índice' }))
  const trigger = await screen.findByRole('button', { name: 'Code Map Health: Issue' })
  expect(trigger.querySelector('.cmv-spin')).toBeNull()
  expect(status).toHaveBeenLastCalledWith(expect.stringContaining('Controlled rebuild failure'), true)
})
