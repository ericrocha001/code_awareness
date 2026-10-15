// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorktreeIntegrationDetails } from './WorktreeIntegrationDetails'
import { CommitWorktrees } from '../GitManagementView/CommitWorktrees'
import type { ObservableWorktree } from '../../../../shared/types/work-orchestration-types'
afterEach(cleanup)
const context = { projectId: 'p', revision: 1 }, sha = 'a'.repeat(40), tree = { worktreeId: '1'.repeat(64), generation: 'g', head: sha } as ObservableWorktree
const page = { direction: 'WORKTREE_COMMITS', repositoryId: 'r', revision: 'page', observedAt: 'now', worktree: tree, mode: 'REACHABLE', reference: null, coverage: 'PARTIAL', outcome: 'MATCHES', nextCursor: 'next', items: [{ sha, title: 'Commit histórico', committerDate: '2026-10-14T12:00:00Z', relation: 'HEAD_EXACT', referenceRelation: null }] }
it('reads one batch under StrictMode, paginates and emits the exact typed navigation intent without evaluating integration automatically', async () => {
  const read = vi.fn(async request => ({ success: true, context, data: { repositoryId: 'r', timeline: request.timeline?.cursor ? { ...page, coverage: 'COMPLETE', nextCursor: null, items: [{ ...page.items[0], sha: 'b'.repeat(40), title: 'Ancestral' }] } : page } }))
  window.codeAwareness = { getWorkOrchestration: read } as any
  const onCommit = vi.fn(), view = render(<React.StrictMode><WorktreeIntegrationDetails tree={tree} context={context} onCommit={onCommit} /></React.StrictMode>)
  fireEvent.click(await screen.findByRole('button', { name: /Commit histórico/ }))
  expect(onCommit.mock.calls[0][0]).toMatchObject({ ...context, commitSha: sha, requestId: expect.any(String) })
  expect(read).toHaveBeenCalledTimes(1)
  expect(read.mock.calls.some(([request]) => request.integration)).toBe(false)
  fireEvent.click(screen.getByText('Carregar mais commits')); await screen.findByText(/Ancestral/)
  expect(screen.getByText(/Commit histórico/)).toBeTruthy()
  view.rerender(<WorktreeIntegrationDetails tree={tree} context={context} active={false} />)
})
it('requires an explicit branch and renders backend pending reasons; late context responses are discarded', async () => {
  let complete!: (v: unknown) => void
  const read = vi.fn(request => request.integration ? new Promise(resolve => { complete = resolve }) : Promise.resolve({ success: true, context, data: { repositoryId: 'r', timeline: page } }))
  window.codeAwareness = { getWorkOrchestration: read } as any
  const view = render(<WorktreeIntegrationDetails tree={tree} context={context} />)
  await screen.findByText(/Commit histórico/)
  expect((screen.getByText('Avaliar integração') as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Branch de destino'), { target: { value: 'chosen' } }); fireEvent.submit(screen.getByText('Avaliar integração').closest('form')!)
  expect(read.mock.calls.at(-1)![0].integration.targetBranch).toBe('chosen')
  view.rerender(<WorktreeIntegrationDetails tree={tree} context={{ projectId: 'other', revision: 2 }} />)
  complete({ success: true, context, data: { state: 'ELIGIBLE_FOR_REVIEW', nextAction: 'OLD_FAVORABLE' } })
  await waitFor(() => expect(screen.queryByText('OLD_FAVORABLE')).toBeNull())
})
it('keeps partial inverse coverage honest and discards associations for a previous commit', async () => {
  let finish!: (v: unknown) => void
  const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue({ success: true, context, data: { direction: 'COMMIT_WORKTREES', items: [], unavailable: [], revision: 'r', coverage: 'PARTIAL', outcome: 'UNKNOWN', nextCursor: 'next', scope: { total: 101, end: 20, unavailable: 1 } } })
  window.codeAwareness = { getGitCommitCorrelation: read } as any
  const view = render(<CommitWorktrees sha={sha} context={context} />)
  view.rerender(<CommitWorktrees sha={'b'.repeat(40)} context={context} />)
  await screen.findByText(/Cobertura parcial/)
  finish({ success: true, data: { direction: 'COMMIT_WORKTREES', items: [{ worktreeId: 'old', branch: 'OLD_BRANCH' }], scope: {}, coverage: 'COMPLETE' } })
  await waitFor(() => expect(screen.queryByText(/OLD_BRANCH/)).toBeNull())
  expect(screen.queryByText(/Nenhuma associação/)).toBeNull()
})
