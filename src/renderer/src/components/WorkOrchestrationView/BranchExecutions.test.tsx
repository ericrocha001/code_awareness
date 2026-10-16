// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BranchExecutions } from './BranchExecutions'
import type { BranchRecord } from '../../../../shared/types/branch-orchestration-types'
import type { ContinuumChange } from '../../../../shared/types/continuum-ui-types'
import type { BranchManagerData } from '../../../../shared/types/branch-manager-types'
import type { ExecutionBinding } from '../../../../shared/types/execution-branch-types'

const listeners = new Set<(change: ContinuumChange) => void>()
beforeEach(() => {
  window.codeAwareness = { onContinuumChanged: callback => { listeners.add(callback); return () => { listeners.delete(callback) } } } as typeof window.codeAwareness
})
afterEach(() => { cleanup(); expect(listeners.size).toBe(0) })
const branch = { repositoryId: 'repo', ref: 'refs/heads/topic', revision: 'r1', generation: 'g1' } as BranchRecord
const binding: ExecutionBinding = { artifactId: 'binding', executionId: 'run-A', sourceArtifactId: 'plan', branchRef: branch.ref, branchGeneration: 'g1', sourceHeadAtBinding: 'abc123456', observedAt: '2026-10-16', classification: 'VERIFIED_CURRENT', checkout: 'CURRENT' }
const page: Extract<BranchManagerData, { kind: 'EXECUTIONS' }> = { kind: 'EXECUTIONS', page: { repositoryId: 'repo', branchRef: branch.ref, branchRevision: 'r1', bindings: [binding], coverage: 'COMPLETE' } }
const documents = (name = 'Canonical plan', nextCursor?: string): Extract<BranchManagerData, { kind: 'EXECUTION_DOCUMENTS' }> => ({ kind: 'EXECUTION_DOCUMENTS', page: { repositoryId: 'repo', executionId: 'run-A', artifacts: [{ artifactId: 'plan', name, kind: 'EXECUTABLE_PLAN', status: 'PENDING', updatedAt: '2026-10-16T15:00:00Z' }], nextCursor } })
const emit = (repositoryId: string | null = 'repo') => act(() => { for (const listener of [...listeners]) listener({ repositoryId }) })
it('automatically reads the selected branch, lists documents and opens the existing Continuum inspector', async () => {
  const query = vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce(documents('Canonical plan', 'next'))
  const onArtifact = vi.fn()
  render(<BranchExecutions branch={branch} active query={query} onArtifact={onArtifact}/>);
  expect(screen.getByRole('status').textContent).toContain('Consultando')
  await screen.findByText('Vínculo corrente verificado')
  expect(screen.queryByText('Atualizar execuções')).toBeNull()
  expect(document.querySelector('.bm-executions')?.tagName).toBe('SECTION')
  expect(query).toHaveBeenNthCalledWith(1, { action: 'EXECUTIONS', ref: branch.ref, revision: branch.revision })
  fireEvent.click(screen.getByText('Ver Artifacts desta execução'))
  await screen.findByText('Canonical plan')
  fireEvent.click(screen.getByText('Abrir no Continuum'))
  expect(onArtifact).toHaveBeenCalledWith({ repositoryId: 'repo', artifactId: 'plan' })
  expect(screen.getByText('Próxima página de Artifacts')).toBeTruthy()
  expect(query).toHaveBeenCalledTimes(2)
})
it('reacts to a new binding in the current repository and ignores other repositories', async () => {
  const query = vi.fn().mockResolvedValueOnce({ ...page, page: { ...page.page, bindings: [] } }).mockResolvedValue(page)
  render(<BranchExecutions branch={branch} active query={query}/>)
  await screen.findByText(/Sem vínculo explícito/)
  emit('other'); expect(query).toHaveBeenCalledTimes(1)
  emit(); await screen.findByText('Vínculo corrente verificado')
  expect(query).toHaveBeenCalledTimes(2)
})
it('refreshes open documents of the same execution on publication without another click', async () => {
  let name = 'Canonical plan'
  const query = vi.fn(async op => op.action === 'EXECUTIONS' ? page : documents(name))
  render(<BranchExecutions branch={branch} active query={query}/>)
  fireEvent.click(await screen.findByText('Ver Artifacts desta execução')); await screen.findByText('Canonical plan')
  name = 'New handoff'; emit()
  await screen.findByText('New handoff')
  expect(screen.queryByText('Canonical plan')).toBeNull()
  expect(query.mock.calls.map(([op]) => op.action)).toEqual(['EXECUTIONS', 'EXECUTION_DOCUMENTS', 'EXECUTIONS', 'EXECUTION_DOCUMENTS'])
})
it('coalesces two notifications during a slow read and drops the obsolete response', async () => {
  let resolve!: (value: unknown) => void
  const query = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValue({ ...page, page: { ...page.page, bindings: [{ ...binding, executionId: 'latest' }] } })
  render(<BranchExecutions branch={branch} active query={query}/>)
  emit(); emit(); expect(query).toHaveBeenCalledTimes(1)
  await act(async () => { resolve(page) })
  await screen.findByText('latest')
  expect(screen.queryByText('run-A')).toBeNull()
  expect(query).toHaveBeenCalledTimes(2)
})
it('invalidates slow document pages when a publication arrives and reloads latest membership', async () => {
  let resolve!: (value: unknown) => void
  const query = vi.fn().mockResolvedValueOnce(page).mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValueOnce(page).mockResolvedValueOnce(documents('Latest handoff'))
  render(<BranchExecutions branch={branch} active query={query}/>)
  fireEvent.click(await screen.findByText('Ver Artifacts desta execução'))
  emit(); emit(); await act(async () => { resolve(documents('Obsolete handoff')) })
  await screen.findByText('Latest handoff')
  expect(screen.queryByText('Obsolete handoff')).toBeNull()
  expect(query).toHaveBeenCalledTimes(4)
})
it('drops old branch/repository responses, unsubscribes while hidden, and reads again on activation', async () => {
  let resolve!: (value: unknown) => void
  const nextBranch = { ...branch, repositoryId: 'other', ref: 'refs/heads/other', revision: 'r2', generation: 'g2' }
  const nextPage = { ...page, page: { ...page.page, repositoryId: 'other', branchRef: nextBranch.ref, branchRevision: 'r2', bindings: [{ ...binding, executionId: 'other-run' }] } }
  const query = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValue(nextPage)
  const view = render(<BranchExecutions branch={branch} active query={query}/>)
  view.rerender(<BranchExecutions branch={nextBranch} active query={query}/>)
  expect(listeners.size).toBe(1)
  await act(async () => { resolve(page) }); await screen.findByText('other-run')
  expect(screen.queryByText('run-A')).toBeNull()
  view.rerender(<BranchExecutions branch={nextBranch} active={false} query={query}/>)
  expect(listeners.size).toBe(0); emit('other'); expect(query).toHaveBeenCalledTimes(2)
  view.rerender(<BranchExecutions branch={nextBranch} active query={query}/>)
  await screen.findByText('other-run'); expect(query).toHaveBeenCalledTimes(3)
})
it('keeps failures inconclusive and recovers on a notification without attributing unbound documents', async () => {
  const query = vi.fn().mockRejectedValueOnce(new Error('CONTINUUM_UNAVAILABLE')).mockResolvedValue({ ...page, page: { ...page.page, bindings: [] } })
  render(<BranchExecutions branch={branch} active query={query}/>)
  await screen.findByRole('alert'); expect(screen.queryByText(/Sem vínculo explícito/)).toBeNull()
  emit(); await screen.findByText(/Sem vínculo explícito/)
  expect(query.mock.calls.every(([op]) => op.action === 'EXECUTIONS')).toBe(true)
})
it('retains bounded pagination and resets cursors after a change event', async () => {
  const query = vi.fn().mockResolvedValueOnce({ ...page, page: { ...page.page, nextCursor: 'bindings-next' } }).mockResolvedValueOnce(page).mockResolvedValueOnce(documents('Page one', 'docs-next')).mockResolvedValueOnce(documents('Page two')).mockResolvedValueOnce(page).mockResolvedValueOnce(documents('Fresh first page'))
  render(<BranchExecutions branch={branch} active query={query}/>)
  fireEvent.click(await screen.findByText('Próxima página de execuções'))
  await waitFor(() => expect(screen.queryByText('Próxima página de execuções')).toBeNull())
  fireEvent.click(screen.getByText('Ver Artifacts desta execução')); await screen.findByText('Page one')
  fireEvent.click(screen.getByText('Próxima página de Artifacts')); await screen.findByText('Page two')
  expect(query.mock.calls[1][0].cursor).toBe('bindings-next'); expect(query.mock.calls[3][0].cursor).toBe('docs-next')
  emit(); await screen.findByText('Fresh first page'); expect(query.mock.calls[4][0].cursor).toBeUndefined(); expect(query.mock.calls[5][0].cursor).toBeUndefined()
})
it('reports Git drift explicitly and never keeps a previous current certification', async () => {
  const query = vi.fn().mockResolvedValueOnce(page).mockRejectedValueOnce(new Error('GIT_STATE_CHANGED'))
  render(<BranchExecutions branch={branch} active query={query}/>)
  await screen.findByText('Vínculo corrente verificado'); emit(); await screen.findByRole('alert')
  expect(screen.queryByText('Vínculo corrente verificado')).toBeNull()
  expect(screen.queryByText(/Sem vínculo explícito/)).toBeNull()
})
it('preserves focus during an event refresh while marking the retained snapshot unverified', async () => {
  let resolve!: (value: unknown) => void
  const query = vi.fn().mockResolvedValueOnce(page).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  render(<BranchExecutions branch={branch} active query={query}/>)
  const button = await screen.findByText('Ver Artifacts desta execução')
  button.focus(); emit()
  expect(document.activeElement).toBe(button)
  expect(screen.queryByText('Vínculo corrente verificado')).toBeNull()
  expect(screen.getByText(/vínculo ainda não revalidado/)).toBeTruthy()
  fireEvent.click(button); expect(query).toHaveBeenCalledTimes(2)
  await act(async () => { resolve(page) })
  await screen.findByText('Vínculo corrente verificado')
  expect(document.activeElement).toBe(button)
})
it('refreshes the previously opened execution automatically on tab reactivation', async () => {
  let name = 'Before hiding'
  const query = vi.fn(async op => op.action === 'EXECUTIONS' ? page : documents(name))
  const view = render(<BranchExecutions branch={branch} active query={query}/>)
  fireEvent.click(await screen.findByText('Ver Artifacts desta execução')); await screen.findByText('Before hiding')
  view.rerender(<BranchExecutions branch={branch} active={false} query={query}/>)
  name = 'Published while hidden'; emit(); expect(query).toHaveBeenCalledTimes(2)
  view.rerender(<BranchExecutions branch={branch} active query={query}/>)
  await screen.findByText('Published while hidden'); expect(query).toHaveBeenCalledTimes(4)
})
