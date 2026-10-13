// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkOrchestrationView } from './WorkOrchestrationView'
import type { OrchestrationOverview, OrchestrationResult } from '../../../../shared/types/work-orchestration-types'
afterEach(cleanup)
const data: OrchestrationOverview = { repositoryId: 'repo', worktrees: [], pairs: [], coverage: 'PARTIAL', reason: 'PAIR_BUDGET_EXCEEDED', automaticLimit: 12 }
it('discards a delayed old project response and clears selection on project change', async () => {
  let complete!: (result: OrchestrationResult<OrchestrationOverview>) => void
  const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    .mockResolvedValue({ success: true, context: { projectId: 'b', revision: 2 }, data })
  window.codeAwareness = { getWorkOrchestration: read } as any
  const view = render(<WorkOrchestrationView state={{ project: { id: 'a', path: '/a', name: 'A' }, revision: 1 }} navigateGit={vi.fn()} />)
  view.rerender(<WorkOrchestrationView state={{ project: { id: 'b', path: '/b', name: 'B' }, revision: 2 }} navigateGit={vi.fn()} />)
  await screen.findByText(/Partial coverage/)
  complete({ success: true, context: { projectId: 'a', revision: 1 }, data: { ...data, coverage: 'COMPLETE', reason: null } })
  await waitFor(() => expect(screen.queryByText(/Partial coverage/)).not.toBeNull())
  expect(read.mock.calls[1][0].context).toEqual({ projectId: 'b', revision: 2 })
})
it('shows uncertainty explicitly, performs real refresh and navigates via Shell without mutations', async () => {
  const read = vi.fn().mockResolvedValue({ success: true, context: { projectId: 'a', revision: 1 }, data })
  const mutation = vi.fn(), navigate = vi.fn()
  window.codeAwareness = { getWorkOrchestration: read, mutateGitManagement: mutation } as any
  render(<WorkOrchestrationView state={{ project: { id: 'a', path: '/a', name: 'A' }, revision: 1 }} navigateGit={navigate} />)
  await screen.findByText(/Partial coverage/)
  expect(screen.queryByText(/No path overlap/)).toBeNull()
  fireEvent.click(screen.getByText('Refresh')); await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  fireEvent.click(screen.getByText('Open Git Management')); expect(navigate).toHaveBeenCalledOnce(); expect(mutation).not.toHaveBeenCalled()
})
