// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorktreeIntegrationDetails } from './WorktreeIntegrationDetails'
import { CommitWorktrees } from '../GitManagementView/CommitWorktrees'
import type { ObservableWorktree } from '../../../../shared/types/work-orchestration-types'
import type { WorktreeTimelinePage } from '../../../../shared/types/worktree-integration-evidence-types'
afterEach(cleanup)
const context = { projectId: 'p', revision: 1 }, sha = 'a'.repeat(40), tree = { worktreeId: '1'.repeat(64), generation: 'g', head: sha } as ObservableWorktree
const page: WorktreeTimelinePage = { repositoryId:'r',worktreeId:tree.worktreeId,generation:tree.generation,head:sha,source:'HEAD_REFLOG',revision:'page',observedAt:'now',coverage:'PARTIAL',reasons:['REFLOG_RETENTION_NOT_ATTESTED'],observedEvents:1,identifiedCount:1,omitted:0,truncated:false,items:[{sha,title:'Commit histórico',reachability:'HEAD_CURRENT',events:[{operation:'COMMIT',eventAt:'2026-10-14T12:00:00Z',sequence:1}]}] }
function openCommits(){const details=screen.getByText('Commits desta worktree').closest('details')!;details.open=true;fireEvent(details,new Event('toggle'))}
it('reads only on disclosure expansion under StrictMode, reveals rows on scroll and emits the exact navigation intent', async () => {
  const items=Array.from({length:61},(_,i)=>({...page.items[0],sha:i.toString(16).padStart(40,'0'),title:`Local commit ${i}`}))
  const read = vi.fn(async request => ({ success: true, context, data: { repositoryId: 'r', timeline: {...page,identifiedCount:61,items} } }))
  window.codeAwareness = { getWorkOrchestration: read } as any
  const onCommit = vi.fn(), view = render(<React.StrictMode><WorktreeIntegrationDetails tree={tree} context={context} onCommit={onCommit} /></React.StrictMode>)
  expect(read).not.toHaveBeenCalled();openCommits()
  fireEvent.click(await screen.findByRole('button', { name: /Local commit 0 ·/ }))
  expect(onCommit.mock.calls[0][0]).toMatchObject({ ...context, commitSha: items[0].sha, requestId: expect.any(String) })
  expect(read).toHaveBeenCalledTimes(1)
  expect(read.mock.calls.some(([request]) => request.integration)).toBe(false)
  expect(screen.queryByText(/Local commit 60/)).toBeNull()
  fireEvent.scroll(screen.getByLabelText('Lista de commits locais'));await screen.findByText(/Local commit 60/)
  expect(screen.queryByText('Carregar mais commits')).toBeNull()
  expect(read).toHaveBeenCalledTimes(1)
  view.rerender(<WorktreeIntegrationDetails tree={tree} context={context} active={false} />)
})
it('requires an explicit branch and renders backend pending reasons; late context responses are discarded', async () => {
  let complete!: (v: unknown) => void
  const read = vi.fn(request => request.integration ? new Promise(resolve => { complete = resolve }) : Promise.resolve({ success: true, context, data: { repositoryId: 'r', timeline: page } }))
  window.codeAwareness = { getWorkOrchestration: read } as any
  const view = render(<WorktreeIntegrationDetails tree={tree} context={context} />)
  expect(read).not.toHaveBeenCalled()
  expect((screen.getByText('Avaliar integração') as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Branch de destino'), { target: { value: 'chosen' } }); fireEvent.submit(screen.getByText('Avaliar integração').closest('form')!)
  expect(read.mock.calls.at(-1)![0].integration.targetBranch).toBe('chosen')
  view.rerender(<WorktreeIntegrationDetails tree={tree} context={{ projectId: 'other', revision: 2 }} />)
  complete({ success: true, context, data: { state: 'ELIGIBLE_FOR_REVIEW', nextAction: 'OLD_FAVORABLE' } })
  await waitFor(() => expect(screen.queryByText('OLD_FAVORABLE')).toBeNull())
})
it('discards closed disclosure responses, rereads on reopening and clears provenance after context changes',async()=>{
  let finish!:(v:unknown)=>void
  const read=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve})).mockResolvedValue({success:true,context,data:{repositoryId:'r',timeline:page}})
  window.codeAwareness={getWorkOrchestration:read} as any
  const view=render(<WorktreeIntegrationDetails tree={tree} context={context}/>)
  openCommits();expect(read).toHaveBeenCalledTimes(1)
  const details=screen.getByText('Commits desta worktree').closest('details')!;details.open=false;fireEvent(details,new Event('toggle'))
  openCommits();await screen.findByText(/Commit histórico/);expect(read).toHaveBeenCalledTimes(2)
  finish({success:true,data:{timeline:{...page,items:[{...page.items[0],title:'RESPOSTA ANTIGA'}]}}})
  await waitFor(()=>expect(screen.queryByText('RESPOSTA ANTIGA')).toBeNull())
  view.rerender(<WorktreeIntegrationDetails tree={tree} context={{projectId:'other',revision:2}}/>)
  expect(screen.queryByText(/Commit histórico/)).toBeNull();expect(read).toHaveBeenCalledTimes(2)
})
it('shows unavailable reflog as uncertainty instead of verified zero commits',async()=>{
  window.codeAwareness={getWorkOrchestration:vi.fn().mockResolvedValue({success:true,context,data:{timeline:{...page,items:[],identifiedCount:0,coverage:'UNAVAILABLE'}}})} as any
  render(<WorktreeIntegrationDetails tree={tree} context={context}/>);openCommits()
  await screen.findByText(/Histórico de commits realizados nesta worktree indisponível/)
  expect(screen.queryByText(/Nenhum commit identificável/)).toBeNull()
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
