// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ObservableWorktree } from '../../../../shared/types/work-orchestration-types'
import { WorktreeStatusBadges } from './WorktreeStatusBadges'

afterEach(cleanup)
const tree = { observation: 'VERIFIED', reason: null, stagedCount: 1, unstagedCount: 1, untrackedCount: 0, conflictCount: 0, localChanges: { total: 1 } } as ObservableWorktree

it('uses the unique path count instead of adding staged and unstaged counts', () => {
  render(<WorktreeStatusBadges tree={tree} />)
  expect(screen.getByText('1 caminho local')).toBeTruthy()
  expect(screen.getByText('Observação verificada')).toBeTruthy()
})
it('labels a verified conflict explicitly without claiming a clean worktree', () => {
  render(<WorktreeStatusBadges tree={{ ...tree, conflictCount: 1 }} />)
  expect(screen.getByText('1 em conflito')).toBeTruthy()
  expect(screen.queryByText('Sem alterações locais')).toBeNull()
})
it('removes verified and clean badges when observation becomes stale or unavailable', () => {
  const view = render(<WorktreeStatusBadges tree={{ ...tree, localChanges: { total: 0 } as any }} />)
  expect(screen.getByText('Sem alterações locais')).toBeTruthy()
  for (const observation of ['LAST_KNOWN', 'STALE', 'UNAVAILABLE', 'NOT_OBSERVED', 'REVALIDATING'] as const) {
    view.rerender(<WorktreeStatusBadges tree={{ ...tree, observation }} />)
    expect(screen.queryByText('Observação verificada')).toBeNull()
    expect(screen.queryByText('Sem alterações locais')).toBeNull()
    expect(screen.queryByText('1 caminho local')).toBeNull()
    expect(view.container.querySelector('.wo-status--verified')).toBeNull()
  }
})
