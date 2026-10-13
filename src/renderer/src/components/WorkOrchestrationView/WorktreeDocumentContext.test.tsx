// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorktreeDocumentContext } from './WorktreeDocumentContext'
import type { ObservableWorktree, OrchestrationData, OrchestrationResult } from '../../../../shared/types/work-orchestration-types'
import type { WorktreeDocumentContext as Context } from '../../../../shared/types/worktree-document-context-types'
afterEach(cleanup)
const tree: ObservableWorktree = { worktreeId: 'a'.repeat(64), generation: 'g', path: '/repo', head: null, branch: 'main', detached: false, reference: true, locked: false, missing: false, prunable: false,
  observation: 'VERIFIED', snapshot: null, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictCount: 0, reason: null }
const context = (mode: Context['mode'] = 'EXACT', names: string[] = ['Trabalho A', 'Trabalho B']): Context => ({ repositoryId: 'repo', worktreeId: tree.worktreeId, generation: 'g', mode,
  queriedAt: '2026-10-13T12:00:00Z', coverage: 'COMPLETE', relations: [], artifacts: names.map((name, i) => ({ artifactId: `artifact-${i}`, name, description: `Objetivo de ${name}`, kind: 'OBSERVATION', status: 'COMPLETED', updatedAt: '2026-10-13T11:00:00Z' })) })
const success = (data: Context): OrchestrationResult<OrchestrationData> => ({ success: true, context: { projectId: 'p', revision: 1 }, data })
const open = () => { const element = screen.getByText('Contexto documentado').closest('details')!; element.open = true; fireEvent(element, new Event('toggle')); return element }
it('reads only on explicit opening and displays multiple documentary states without activity attribution', async () => {
  const query = vi.fn().mockResolvedValue(success(context()))
  const view = render(<WorktreeDocumentContext tree={tree} query={query} />)
  expect(query).not.toHaveBeenCalled(); expect(screen.getByText('Não consultado')).toBeTruthy()
  const details = open(); await screen.findByText('Trabalho A'); expect(screen.getByText('Trabalho B')).toBeTruthy()
  expect(query).toHaveBeenCalledTimes(1); expect(query.mock.calls[0][0].documents).toEqual({ worktreeId: tree.worktreeId, generation: 'g', mode: 'EXACT' })
  expect(screen.getAllByText('Tipo: OBSERVATION · Estado documental: COMPLETED')).toHaveLength(2)
  expect(screen.getByLabelText('ID do Artifact Trabalho A').getAttribute('readonly')).not.toBeNull()
  details.open = false; fireEvent(details, new Event('toggle')); details.open = true; fireEvent(details, new Event('toggle'))
  view.rerender(<WorktreeDocumentContext tree={{ ...tree, observation: 'LAST_KNOWN' }} query={query} />)
  expect(query).toHaveBeenCalledTimes(1)
})
it('keeps failure distinct from no association and queries historical references under a separate action', async () => {
  const query = vi.fn().mockResolvedValueOnce(success(context('EXACT', []))).mockResolvedValueOnce({ success: false, code: 'CONTINUUM_UNAVAILABLE' }).mockResolvedValueOnce(success(context('HISTORICAL', ['Registro antigo'])))
  render(<WorktreeDocumentContext tree={tree} query={query} />); open()
  await screen.findByText('Sem vínculo explícito encontrado. Isso não significa ausência de trabalho.')
  fireEvent.click(screen.getByText('Atualizar vínculos')); await screen.findByText(/Consulta indisponível ou obsoleta/)
  expect(screen.getByRole('alert').textContent).toContain('Exibindo a última consulta, não revalidada.')
  fireEvent.click(screen.getByText('Consultar referências históricas por caminho')); await screen.findByText('Registro antigo')
  expect(screen.getByText('Referência histórica por caminho — não comprovada')).toBeTruthy()
  expect(query.mock.calls[2][0].documents.mode).toBe('HISTORICAL')
})
it('pages explicit results and expands only a selected declarer', async () => {
  const first = { ...context(), coverage: 'PARTIAL' as const, nextCursor: 'cursor-next' }
  const query = vi.fn().mockResolvedValueOnce(success(first)).mockResolvedValueOnce(success(context('EXACT', ['Página seguinte']))).mockResolvedValueOnce(success({ ...context('RELATED', ['Plano relacionado']), sourceArtifactId: 'artifact-0' }))
  render(<WorktreeDocumentContext tree={tree} query={query} />); open(); await screen.findByText('Trabalho A')
  fireEvent.click(screen.getByText('Próxima página de documentos')); await screen.findByText('Página seguinte')
  expect(query.mock.calls[1][0].documents.cursor).toBe('cursor-next')
  fireEvent.click(screen.getByText('Ver Plano e handoff relacionados')); await screen.findByText('Plano relacionado')
  expect(query.mock.calls[2][0].documents).toMatchObject({ mode: 'RELATED', artifactId: 'artifact-0' })
})
it('discards a delayed result after selection identity changes', async () => {
  let finish!: (result: OrchestrationResult<OrchestrationData>) => void
  const query = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = render(<WorktreeDocumentContext tree={tree} query={query} />); open()
  view.rerender(<WorktreeDocumentContext tree={{ ...tree, generation: 'replacement' }} query={query} />)
  finish(success(context()))
  await waitFor(() => expect(screen.queryByText('Trabalho A')).toBeNull())
  expect(screen.getByText('Não consultado')).toBeTruthy(); expect(query).toHaveBeenCalledTimes(1)
})
