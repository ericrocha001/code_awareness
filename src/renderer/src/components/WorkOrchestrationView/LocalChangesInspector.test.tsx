// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { LocalChangesInspector } from './LocalChangesInspector'
import type { LocalChange } from '../../../../shared/types/local-change-types'
import type { LocalChangesPage, ObservableWorktree, OrchestrationRequest, OrchestrationResult, OrchestrationData } from '../../../../shared/types/work-orchestration-types'

afterEach(cleanup)
const tree: ObservableWorktree = { worktreeId: 'a'.repeat(64), generation: 'g', path: '/repo', branch: 'main', head: 'b'.repeat(40), detached: false,
  locked: false, missing: false, prunable: false, reference: true, snapshot: null, snapshotRevision: 'c'.repeat(64), observation: 'VERIFIED',
  stagedCount: 3, unstagedCount: 3, untrackedCount: 1, conflictCount: 1, reason: null }
const change = (path: string, stagedState: string | null, unstagedState: string | null, extra: Partial<LocalChange> = {}): LocalChange => ({ path, stagedState, unstagedState, untracked: false, deleted: false, renamed: false, conflicted: false, ...extra })
const success = (changes: LocalChange[], totalCount = changes.length, nextCursor: string | null = null): OrchestrationResult<OrchestrationData> => ({ success: true,
  context: { projectId: 'p', revision: 1 }, data: { repositoryId: 'r', worktreeId: tree.worktreeId, generation: tree.generation, snapshotRevision: tree.snapshotRevision!,
    changes, totalCount, revision: 'page', nextCursor } satisfies LocalChangesPage })
const renderInspector = (query: ReturnType<typeof vi.fn>, selected = tree, stale = vi.fn()) => render(<LocalChangesInspector tree={selected} query={query} revalidate={vi.fn()} stale={stale} />)

it('lists human classifications without a filter or prefix request and preserves multistate evidence', async () => {
  const changes = [change('added.txt', 'A', null), change('new.txt', null, null, { untracked: true }), change('modified.txt', null, 'M'),
    change('deleted.txt', null, 'D', { deleted: true }), change('renamed.txt', 'R', null, { renamed: true, previousPath: 'old.txt' }),
    change('conflict.txt', 'D', 'D', { conflicted: true, deleted: true }), change('both.txt', 'A', 'M'), change('unknown.txt', 'X', null)]
  const query = vi.fn().mockResolvedValue(success(changes))
  renderInspector(query)
  await screen.findByText('8 arquivos · página 1')
  const section = screen.getByLabelText('Arquivos alterados')
  expect(within(section).queryByRole('textbox')).toBeNull(); expect(within(section).queryByRole('button', { name: 'Filtrar' })).toBeNull()
  expect(screen.queryByPlaceholderText('Arquivo exato ou prefixo de diretório')).toBeNull()
  expect(query).toHaveBeenCalledTimes(1)
  expect(query.mock.calls[0][0].changes).not.toHaveProperty('pathPrefix')
  const row = (path: string) => within(screen.getByText(path).closest('li')!)
  for (const [path, classification] of [['added.txt', 'Adicionado'], ['new.txt', 'Não rastreado'], ['modified.txt', 'Modificado'], ['deleted.txt', 'Excluído'], ['renamed.txt', 'Renomeado'], ['conflict.txt', 'Em conflito'], ['unknown.txt', 'Estado não classificado']]) expect(row(path).getByText(classification)).toBeTruthy()
  expect(row('renamed.txt').getByText('Origem: old.txt')).toBeTruthy()
  expect(row('conflict.txt').queryByText('Excluído')).toBeNull()
  expect(row('new.txt').queryByText('Adicionado')).toBeNull()
  expect(row('both.txt').getByText('Adicionado · Modificado')).toBeTruthy()
  expect(row('both.txt').getByText('Adicionado ao índice; Modificado no diretório de trabalho')).toBeTruthy()
  expect(section.querySelectorAll('li')).toHaveLength(8)
  const original = row('both.txt').getByText('Estado Git original').closest('details')!
  expect(original.open).toBe(false); fireEvent.click(row('both.txt').getByText('Estado Git original'))
  expect(row('both.txt').getByText('Staged: A · Unstaged: M')).toBeTruthy()
  expect(query).toHaveBeenCalledTimes(1)
})

it('keeps bounded pages, cursors and stale errors without extra reads per file', async () => {
  const first = Array.from({ length: 50 }, (_, i) => change(`file-${i}.txt`, null, 'M'))
  const query = vi.fn().mockResolvedValueOnce(success(first, 53, 'cursor:50')).mockResolvedValueOnce(success([change('file-50.txt', 'A', null), change('file-51.txt', 'A', null), change('file-52.txt', 'A', null)], 53))
    .mockResolvedValueOnce({ success: false, code: 'GIT_STATE_CHANGED' })
  const stale = vi.fn(); renderInspector(query, tree, stale)
  await screen.findByText('53 arquivos · página 1'); expect(document.querySelectorAll('.wo-local-changes li')).toHaveLength(50)
  fireEvent.click(screen.getByText('Próxima página'))
  await screen.findByText('53 arquivos · página 2'); expect(document.querySelectorAll('.wo-local-changes li')).toHaveLength(3)
  expect(query.mock.calls[1][0].changes.cursor).toBe('cursor:50')
  fireEvent.click(screen.getByText('Página anterior')); await screen.findByText(/O estado Git mudou/)
  expect(document.querySelectorAll('.wo-local-changes li')).toHaveLength(0); expect(stale).toHaveBeenCalledOnce()
  expect(query).toHaveBeenCalledTimes(3)
  for (const [request] of query.mock.calls as [OrchestrationRequest][]) expect(request.changes).not.toHaveProperty('pathPrefix')
})

it('preserves empty and generic argument failures without instructions about the removed filter', async () => {
  const query = vi.fn().mockResolvedValueOnce(success([])).mockResolvedValueOnce({ success: false, code: 'INVALID_ARGUMENT' })
  const stale = vi.fn(), view = renderInspector(query, tree, stale)
  await screen.findByText('Nenhuma alteração local nesta observação.')
  view.rerender(<LocalChangesInspector tree={{ ...tree, snapshotRevision: 'd'.repeat(64) }} query={query} revalidate={vi.fn()} stale={stale} />)
  await screen.findByText(/Parâmetros de leitura inválidos/)
  expect(screen.queryByText(/curingas/)).toBeNull(); expect(screen.queryByText(/prefixo/)).toBeNull()
  expect(stale).not.toHaveBeenCalled()
})
