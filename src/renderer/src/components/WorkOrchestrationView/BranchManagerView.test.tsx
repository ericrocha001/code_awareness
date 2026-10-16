// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { BranchManagerView, orderBranches } from './BranchManagerView'
import { WorkOrchestrationTab } from './WorkOrchestrationTab'
import type { BranchInventory, BranchRecord } from '../../../../shared/types/branch-orchestration-types'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const state = { project: { id: 'local', path: '/fixture', name: 'Fixture' }, revision: 1 }
const branch = (name: string): BranchRecord => ({ key: name, repositoryId: 'local', ref: `refs/heads/${name}`, name, namespace: 'LOCAL', head: 'a'.repeat(40), upstream: null, generation: 'g', revision: name + '-one', creation: { at: null, source: 'UNKNOWN' }, lastCommitAt: '2026-01-01T00:00:00Z', worktrees: [] })
const inventory: BranchInventory = { repositoryId: 'local', source: 'GIT_LOCAL', coverage: 'COMPLETE', observedAt: '2026-01-01T00:00:00Z', revision: 'one', branches: [branch('main'), branch('topic')], worktrees: [], unassignedWorktrees: [] }
const ok = (data: unknown) => ({ success: true, context: { projectId: 'local', revision: 1 }, data })
const catalog = { repositoryId: 'local', repository: 'owner/repo', providerRepositoryId: '1', source: 'GITHUB_REST', coverage: 'UNAVAILABLE', observedAt: '2026-01-01T00:00:00Z', revision: 'remote', defaultBranch: 'main', reason: 'NOT_CONNECTED', items: [] }
const unavailable = { kind: 'PULL_REQUESTS', inventoryRevision: 'one', pullRequests: { repositoryId: 'local', catalog, relations: [], orphaned: [] } }
function install(extra: (operation: any) => unknown = () => null, supplied = inventory) {
  const read = vi.fn(async ({ operation }) => ok(operation.action === 'INVENTORY' ? { kind: 'INVENTORY', inventory: supplied } : operation.action === 'PULL_REQUESTS' ? unavailable : operation.action === 'EXECUTIONS' ? { kind: 'EXECUTIONS', page: { repositoryId: supplied.repositoryId, branchRef: operation.ref, branchRevision: operation.revision, bindings: [], coverage: 'COMPLETE' } } : await extra(operation)))
  window.codeAwareness = { getBranchOrchestration: read, onContinuumChanged: () => () => {} } as any
  return read
}
it('renders local branches before GitHub resolves, preserves unknown creation and exposes offline coverage', async () => {
  let release!: (result: ReturnType<typeof ok>) => void
  const read = install()
  read.mockImplementation(async ({ operation }) => operation.action === 'INVENTORY' ? ok({ kind: 'INVENTORY', inventory }) : new Promise(resolve => { release = resolve }))
  render(<BranchManagerView state={state}/>)
  await screen.findByText('topic')
  expect(screen.getByText('Data de criação desconhecida')).toBeTruthy()
  expect(screen.getByText(/O inventário local já está disponível/)).toBeTruthy()
  release(ok(unavailable))
  await screen.findByText(/cobertura indisponível/)
  fireEvent.click(screen.getByText('topic'))
  expect(screen.getByText('Sem checkout associado a esta referência.')).toBeTruthy()
  expect(screen.queryByText(/Criada em/)).toBeNull()
})
it('uses explicit bases and correct reachable/exclusive semantics with commit navigation', async () => {
  const onCommit = vi.fn()
  const read = install(op => ({ kind: 'COMMITS', page: { repositoryId: 'local', ref: 'refs/heads/topic', head: 'a'.repeat(40), revision: 'topic-one', mode: op.query.mode, base: op.query.baseRef ? { ref: op.query.baseRef, head: 'b'.repeat(40) } : null, commits: [{ sha: 'c'.repeat(40), title: 'Own commit', committedAt: '2026-01-01', author: 'Test', parents: [] }], nextCursor: null } }))
  render(<BranchManagerView state={state} onCommit={onCommit}/>)
  fireEvent.click(await screen.findByText('topic'))
  fireEvent.click(screen.getByText('Commits exclusivos'))
  await screen.findByText(/Exclusivos em relação a refs\/heads\/main/)
  expect(read.mock.calls.some(([r]) => r.operation.action === 'COMMITS' && r.operation.query.baseRef === 'refs/heads/main')).toBe(true)
  fireEvent.click(screen.getByText(/Own commit/))
  expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ commitSha: 'c'.repeat(40), projectId: 'local' }))
  fireEvent.click(screen.getByText('História alcançável'))
  await screen.findByText(/inclui ancestrais herdados/)
})
it('requires a preview and explicit preservation consent before branch discard', async () => {
  const read = install(op => op.action === 'PREPARE_DISCARD' ? { kind: 'DISCARD_PREVIEW', preview: { previewId: 'preview', repositoryId: 'local', branch: branch('topic'), base: { ref: 'refs/heads/main', head: 'b'.repeat(40) }, exclusiveCount: 1, exclusiveSample: ['a'.repeat(40)], integrated: false, recoveryRequired: true, blockers: [], worktrees: [], remote: { knownPullRequests: [], coverage: 'COMPLETE' } } } : { kind: 'MUTATION', result: { value: { recoveryRef: 'refs/code-awareness/recovery/fixture', recoveryHead: 'a'.repeat(40) } } })
  render(<BranchManagerView state={state}/>)
  fireEvent.click(await screen.findByText('topic'))
  fireEvent.click(screen.getByText('Preparar descarte da branch…'))
  const modal = await screen.findByRole('dialog')
  const confirm = within(modal).getByText('Confirmar descarte') as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  expect(read.mock.calls.some(([r]) => r.operation.action === 'EXECUTE_DISCARD')).toBe(false)
  fireEvent.click(within(modal).getByRole('checkbox'))
  fireEvent.click(confirm)
  await screen.findByText(/Branch descartada. Recuperação:/)
  await waitFor(() => expect((screen.getByText('Atualizar').closest('button') as HTMLButtonElement).disabled).toBe(false))
  expect(read.mock.calls.find(([r]) => r.operation.action === 'EXECUTE_DISCARD')![0].operation.request).toMatchObject({ confirmed: true, preserveExclusive: true })
})
it('keeps blockers visible and prevents destructive confirmation', async () => {
  install(() => ({ kind: 'DISCARD_PREVIEW', preview: { previewId: 'preview', repositoryId: 'local', branch: branch('topic'), base: { ref: 'refs/heads/main', head: 'b'.repeat(40) }, exclusiveCount: 1, exclusiveSample: [], blockers: ['WORKTREE_BRANCH_OCCUPIED'], worktrees: [], remote: { knownPullRequests: [] } } }))
  render(<BranchManagerView state={state}/>)
  fireEvent.click(await screen.findByText('topic')); fireEvent.click(screen.getByText('Preparar descarte da branch…'))
  const modal = await screen.findByRole('dialog')
  expect(within(modal).getByText('Branch em checkout numa Worktree')).toBeTruthy()
  expect(within(modal).queryByRole('checkbox')).toBeNull()
  expect((within(modal).getByText('Confirmar descarte') as HTMLButtonElement).disabled).toBe(true)
})
it('pages 101 branches, filters real records and groups unknown dates stably', async () => {
  const branches = Array.from({ length: 101 }, (_, i) => branch(`branch-${String(i).padStart(3, '0')}`))
  install(undefined, { ...inventory, branches })
  render(<BranchManagerView state={state}/>)
  await screen.findByText('branch-049')
  expect(screen.queryByText('branch-100')).toBeNull()
  fireEvent.click(screen.getByText('Mostrar mais branches')); fireEvent.click(screen.getByText('Mostrar mais branches'))
  expect(screen.getByText('branch-100')).toBeTruthy()
  fireEvent.change(screen.getByPlaceholderText('Nome ou referência'), { target: { value: 'branch-100' } })
  expect(screen.queryByText('branch-000')).toBeNull()
  expect(orderBranches([branch('z'), branch('a')]).map(b => b.name)).toEqual(['a', 'z'])
})
it('invalidates actions and drops delayed detail responses when hidden', async () => {
  let release!: (value: unknown) => void
  install(() => new Promise(resolve => { release = resolve }))
  const view = render(<BranchManagerView state={state}/>)
  fireEvent.click(await screen.findByText('topic')); fireEvent.click(screen.getByText('História alcançável'))
  view.rerender(<BranchManagerView state={state} active={false}/>)
  release({ kind: 'COMMITS', page: { commits: [{ sha: 'delayed', title: 'Delayed stale result' }] } })
  await waitFor(() => expect(screen.getByText('Estado precisa de atualização antes de agir.')).toBeTruthy())
  expect(screen.queryByText('Delayed stale result')).toBeNull()
})
it('mounts lazily and revalidates only selected executions on tab return while preserving inventory state', async () => {
  const read = install()
  const view = render(<WorkOrchestrationTab state={state} active={false}/>)
  expect(read).not.toHaveBeenCalled()
  view.rerender(<WorkOrchestrationTab state={state} active/>)
  fireEvent.click(await screen.findByText('topic'))
  fireEvent.change(screen.getByPlaceholderText('Nome ou referência'), { target: { value: 'topic' } })
  await screen.findByText(/cobertura indisponível/)
  const count = read.mock.calls.length
  view.rerender(<WorkOrchestrationTab state={state} active={false}/>)
  view.rerender(<WorkOrchestrationTab state={state} active/>)
  await waitFor(() => expect(read).toHaveBeenCalledTimes(count + 1))
  expect(read.mock.calls[count][0].operation.action).toBe('EXECUTIONS')
  expect((screen.getByPlaceholderText('Nome ou referência') as HTMLInputElement).value).toBe('topic')
  expect(screen.getByRole('complementary', { name: 'Detalhes da branch' })).toBeTruthy()
  expect(screen.getByText('Estado precisa de atualização antes de agir.')).toBeTruthy()
})
