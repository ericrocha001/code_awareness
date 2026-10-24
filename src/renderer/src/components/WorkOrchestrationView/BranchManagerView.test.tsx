// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GitHubPullRequestCatalog } from '../../../../main/github/github-pull-request-catalog'
import type { PullRequestCatalog } from '../../../../shared/types/branch-pull-request-types'
import { BranchManagerView, orderBranches } from './BranchManagerView'
import { WorkOrchestrationTab } from './WorkOrchestrationTab'
import type { BranchInventory, BranchRecord } from '../../../../shared/types/branch-orchestration-types'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const state = { project: { id: 'local', path: '/fixture', name: 'Fixture' }, revision: 1 }
const branch = (name: string): BranchRecord => ({ key: name, repositoryId: 'local', ref: `refs/heads/${name}`, name, namespace: 'LOCAL', head: 'a'.repeat(40), upstream: null, generation: 'g', revision: name + '-one', creation: { at: null, source: 'UNKNOWN' }, lastCommitAt: '2026-01-01T00:00:00Z', worktrees: [] })
const inventory: BranchInventory = { repositoryId: 'local', source: 'GIT_LOCAL', coverage: 'COMPLETE', observedAt: '2026-01-01T00:00:00Z', revision: 'one', branches: [branch('main'), branch('topic')], worktrees: [], unassignedWorktrees: [] }
const ok = (data: unknown) => ({ success: true, context: { projectId: 'local', revision: 1 }, data })
const catalog = { repositoryId: 'local', repository: 'owner/repo', providerRepositoryId: '1', source: 'GITHUB_REST', coverage: 'UNAVAILABLE', observedAt: '2026-01-01T00:00:00Z', revision: 'remote', defaultBranch: 'main', reason: 'NOT_CONNECTED', items: [] }
const unavailable = { kind: 'PULL_REQUESTS', inventoryRevision: 'one', pullRequests: { repositoryId: 'local', catalog, relations: [], received: [], orphaned: [] } }
function install(extra: (operation: any) => unknown = () => null, supplied = inventory) {
  const read = vi.fn(async ({ operation }) => ok(operation.action === 'INVENTORY' ? { kind: 'INVENTORY', inventory: supplied } : operation.action === 'PULL_REQUESTS' ? unavailable : operation.action === 'PREVIEW_RUNTIME' ? { kind: 'PREVIEW_RUNTIME', result: { success: true, data: { kind: 'SESSIONS', sessions: [], nextCursor: null, pendingOperationId: null, lastOperation: null } } } : operation.action === 'EXECUTIONS' ? { kind: 'EXECUTIONS', page: { repositoryId: supplied.repositoryId, branchRef: operation.ref, branchRevision: operation.revision, bindings: [], coverage: 'COMPLETE' } } : await extra(operation)))
  window.codeAwareness = { getBranchOrchestration: read, onContinuumChanged: () => () => {} } as any
  return read
}
it('renders local branches before GitHub resolves, preserves unknown creation and exposes offline coverage', async () => {
  let release!: (result: ReturnType<typeof ok>) => void
  const read = install()
  read.mockImplementation(async ({ operation }) => operation.action === 'INVENTORY' ? ok({ kind: 'INVENTORY', inventory }) : operation.action === 'PULL_REQUESTS' ? new Promise(resolve => { release = resolve }) : ok({ kind: 'EXECUTIONS', page: { bindings: [], coverage: 'COMPLETE' } }))
  render(<BranchManagerView state={state}/>)
  await screen.findByText('topic')
  expect(screen.queryByText('Data de criação desconhecida')).toBeNull()
  fireEvent.click(screen.getByText('topic'))
  expect(screen.getByText(/O inventário local já está disponível/)).toBeTruthy()
  release(ok(unavailable))
  await screen.findByText(/cobertura indisponível/)
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
it('mounts lazily and revalidates inventory automatically on tab return while preserving selection and filter', async () => {
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
  await waitFor(() => expect(read.mock.calls.slice(count).some(([r]) => r.operation.action === 'EXECUTIONS')).toBe(true))
  expect(read.mock.calls.slice(count).every(([r]) => ['EXECUTIONS', 'PREVIEW_RUNTIME', 'INVENTORY', 'PULL_REQUESTS'].includes(r.operation.action))).toBe(true)
  expect((screen.getByPlaceholderText('Nome ou referência') as HTMLInputElement).value).toBe('topic')
  expect(screen.getByRole('complementary', { name: 'Detalhes da branch' })).toBeTruthy()
  await waitFor(() => expect(screen.queryByText('Estado precisa de atualização antes de agir.')).toBeNull())
})

const historyCatalog = (coverage: PullRequestCatalog['coverage'] = 'COMPLETE'): PullRequestCatalog => ({
  ...catalog, source: 'GITHUB_REST', coverage, reason: coverage === 'COMPLETE' ? null : 'RATE_LIMITED', items: [
    [1, true, 'deleted-a', '2026-01-04T00:00:00Z'], [2, true, 'deleted-b', '2026-01-04T00:00:00Z'], [32, false, 'topic', null]
  ].map(([number, merged, ref, mergedAt]) => ({ id: String(number), number: number as number, title: 'History ' + number, url: 'https://github.com/owner/repo/pull/' + number, state: 'closed', draft: false, merged: merged as boolean, mergedAt: mergedAt as string | null, mergeCommit: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z', base: { repositoryId: '1', repository: 'owner/repo', ref: 'main', sha: 'b'.repeat(40) }, head: { repositoryId: merged ? null : '1', repository: merged ? null : 'owner/repo', ref: ref as string, sha: 'a'.repeat(40) } }))
})
function installHistory(remoteCatalog = historyCatalog(), supplied = inventory) {
  const read = install(undefined, supplied)
  const projection = new GitHubPullRequestCatalog({} as any).project(supplied, remoteCatalog)
  read.mockImplementation(async ({ operation }) => ok(operation.action === 'INVENTORY' ? { kind: 'INVENTORY', inventory: supplied } : operation.action === 'PULL_REQUESTS' ? { kind: 'PULL_REQUESTS', inventoryRevision: supplied.revision, pullRequests: projection } : { kind: 'EXECUTIONS', page: { bindings: [], coverage: 'COMPLETE' } }))
  return { read, projection }
}
it('composes catalog and renderer: main receives extinct origins, closed #32 is not integrated and cards retain both directions', async () => {
  const { read } = installHistory()
  render(<BranchManagerView state={state}/>)
  fireEvent.click(await screen.findByText('main', { selector: 'strong' }))
  const received = await screen.findByRole('region', { name: 'PRs destinados a esta branch' })
  await within(received).findByText('#1 · History 1')
  expect(within(received).getAllByRole('listitem').map(li => li.querySelector('strong')?.textContent)).toEqual(['#2 · History 2', '#1 · History 1', '#32 · History 32'])
  expect(within(received).getAllByText('Integrado no GitHub')).toHaveLength(2)
  expect(within(received).getByText('Fechado sem merge')).toBeTruthy()
  expect(within(received).getAllByText(/Mergeado em/)).toHaveLength(2)
  expect(within(received).getByText('Origem removida:deleted-a → owner/repo:main')).toBeTruthy()
  expect(within(screen.getByRole('region', { name: 'PRs enviados desta branch' })).getByText('Nenhum PR observado nesta direção.')).toBeTruthy()
  expect(screen.getByText(/PRs sem vínculo corrente confirmado/)).toBeTruthy()
  expect(screen.getByText('main', { selector: 'strong' }).closest('article')?.textContent).not.toContain('recebido(s)')
  fireEvent.click(screen.getByText('topic', { selector: 'strong' }))
  expect(within(screen.getByRole('region', { name: 'PRs enviados desta branch' })).getByText('Origem corrente confirmada')).toBeTruthy()
  expect(within(screen.getByRole('region', { name: 'PRs destinados a esta branch' })).queryByText('#1 · History 1')).toBeNull()
  expect(read.mock.calls.filter(([r]) => r.operation.action === 'PULL_REQUESTS')).toHaveLength(1)
})
it.each(['PARTIAL', 'UNAVAILABLE'] as const)('keeps empty %s coverage inconclusive with reason and observation', async coverage => {
  installHistory({ ...historyCatalog(coverage), items: [] })
  render(<BranchManagerView state={state}/>)
  fireEvent.click(await screen.findByText('main', { selector: 'strong' }))
  await screen.findByText(/RATE_LIMITED/)
  expect(screen.getAllByText('Consulta inconclusiva. Consulte a cobertura GitHub acima.')).toHaveLength(2)
  expect(screen.queryByText('Nenhum PR observado nesta direção.')).toBeNull()
  expect(screen.getByText(/RATE_LIMITED/).textContent).toContain('observado em')
})
it('keeps candidates distinct from confirmed origins and filters obsolete branch revisions', async () => {
  const supplied = { ...inventory, branches: [branch('main'), { ...branch('topic'), head: 'different' }] }
  const { projection } = installHistory(historyCatalog(), supplied)
  projection.received.push({ ...projection.received[0], branchKey: 'topic', branchRevision: 'old' })
  render(<BranchManagerView state={state}/>)
  fireEvent.click(await screen.findByText('topic', { selector: 'strong' }))
  await screen.findByText('Candidato — HEAD divergente')
  expect(within(screen.getByRole('region', { name: 'PRs destinados a esta branch' })).queryByText('#1 · History 1')).toBeNull()
})
it('uses current selection for a delayed repository catalog and drops it after a project change', async () => {
  const { read, projection } = installHistory()
  let release!: (value: any) => void
  read.mockImplementation(async ({ operation }) => operation.action === 'INVENTORY' ? ok({ kind: 'INVENTORY', inventory }) : operation.action === 'PULL_REQUESTS' ? new Promise(resolve => { release = resolve }) : ok({ kind: 'EXECUTIONS', page: { bindings: [], coverage: 'COMPLETE' } }))
  const view = render(<BranchManagerView state={state}/>)
  fireEvent.click(await screen.findByText('main', { selector: 'strong' }))
  fireEvent.click(screen.getByText('topic', { selector: 'strong' }))
  release(ok({ kind: 'PULL_REQUESTS', inventoryRevision: 'one', pullRequests: projection }))
  await screen.findByText('#32 · History 32')
  expect(within(screen.getByRole('region', { name: 'PRs destinados a esta branch' })).queryByText('#1 · History 1')).toBeNull()
  fireEvent.click(screen.getByText('Atualizar'))
  await waitFor(() => expect(screen.getByText(/O inventário local já está disponível/)).toBeTruthy())
  const old = release
  view.rerender(<BranchManagerView state={{ project: { id: 'other', path: '/other', name: 'Other' }, revision: 2 }}/>)
  old(ok({ kind: 'PULL_REQUESTS', inventoryRevision: 'one', pullRequests: projection }))
  await waitFor(() => expect(screen.queryByText('#32 · History 32')).toBeNull())
})

it('keeps failed remote reads inconclusive instead of claiming absence', async () => {
  const read = install()
  read.mockImplementation(async ({ operation }) => {
    if (operation.action === 'PULL_REQUESTS') throw new Error('NETWORK_UNAVAILABLE')
    return ok(operation.action === 'INVENTORY' ? { kind: 'INVENTORY', inventory } : { kind: 'EXECUTIONS', page: { bindings: [], coverage: 'COMPLETE' } })
  })
  render(<BranchManagerView state={state}/>)
  await screen.findByText('PRs indisponíveis: NETWORK_UNAVAILABLE')
  fireEvent.click(screen.getByText('main', { selector: 'strong' }))
  expect(screen.getAllByText('Consulta inconclusiva. Consulte a cobertura GitHub acima.')).toHaveLength(2)
  expect(screen.queryByText('Nenhum PR observado nesta direção.')).toBeNull()
})
