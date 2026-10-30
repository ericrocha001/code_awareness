// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { GitActions } from './GitActions'
import type {
  GitOverview,
  GitMutationRequest
} from '../../../../shared/types/git-management-types'

afterEach(() => {
  cleanup()
  sessionStorage.clear()
})
const overview: GitOverview = {
  state: {
    branch: 'main',
    head: 'a'.repeat(40),
    indexRevision: 'b'.repeat(64),
    worktreeRevision: 'c'.repeat(64),
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty: true,
    stagedCount: 1,
    unstagedCount: 1,
    untrackedCount: 1,
    conflictCount: 0,
    operation: null
  },
  changes: [
    {
      path: 'staged.txt',
      stagedState: 'M',
      unstagedState: null,
      untracked: false,
      deleted: false,
      renamed: false,
      conflicted: false
    },
    {
      path: 'new.txt',
      stagedState: null,
      unstagedState: null,
      untracked: true,
      deleted: false,
      renamed: false,
      conflicted: false
    }
  ]
}
const context = { projectId: 'a', revision: 1 }
it('prepares only selected paths and commits only after displaying the exact index preview', async () => {
  const mutate = vi.fn(async (_request: GitMutationRequest) => ({
    success: true,
    context,
    data: { value: {} }
  }))
  window.codeAwareness = {
    mutateGitManagement: mutate
  } as unknown as Window['codeAwareness']
  render(
    <GitActions
      context={context}
      overview={overview}
      history={null}
      refresh={async () => {}}
      blocked={false}
    />
  )
  fireEvent.click(screen.getByLabelText('new.txt'))
  fireEvent.click(screen.getByText('Preparar selecionados'))
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
  expect(mutate.mock.calls[0][0]).toMatchObject({
    snapshot: overview.state,
    operation: { action: 'STAGE', paths: ['new.txt'] }
  })
  await waitFor(() =>
    expect(screen.getByText('Registrar commit…').hasAttribute('disabled')).toBe(
      true
    )
  )
  fireEvent.change(screen.getByLabelText('Mensagem do commit'), {
    target: { value: 'Commit prepared version' }
  })
  fireEvent.click(screen.getByText('Registrar commit…'))
  expect(screen.getByRole('dialog').textContent).toContain('1 arquivos')
  expect(mutate).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByText('Confirmar operação'))
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
  expect(mutate.mock.calls[1][0]).toMatchObject({
    operation: { action: 'COMMIT', message: 'Commit prepared version' },
    snapshot: overview.state
  })
})
it('retains the same operationId after a lost response, including a remount', async () => {
  const mutate = vi
    .fn()
    .mockRejectedValueOnce(new Error('lost'))
    .mockResolvedValue({
      success: true,
      context,
      data: { isError: true, value: { code: 'OPERATION_OUTCOME_UNKNOWN' } }
    })
  window.codeAwareness = {
    mutateGitManagement: mutate
  } as unknown as Window['codeAwareness']
  const props = {
    context,
    overview,
    history: null,
    refresh: async () => {},
    blocked: false
  }
  const view = render(<GitActions {...props} />)
  fireEvent.click(screen.getByLabelText('new.txt'))
  fireEvent.click(screen.getByText('Preparar selecionados'))
  await screen.findByText(
    'A resposta foi perdida. Recupere a mesma operação antes de continuar.'
  )
  const request = mutate.mock.calls[0][0]
  view.unmount()
  render(<GitActions {...props} />)
  expect(
    screen.getByText('Preparar selecionados').hasAttribute('disabled')
  ).toBe(true)
  fireEvent.click(screen.getByText('Recuperar mesma operação'))
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
  expect(mutate.mock.calls[1][0]).toEqual(request)
  await screen.findByText(/Resultado ainda não confirmado/)
})

it('does not rebind an old pending intent to a new project revision', async () => {
  const mutate = vi.fn().mockRejectedValue(new Error('lost'))
  window.codeAwareness = { mutateGitManagement: mutate } as any
  const props = { context, overview, history: null, refresh: async () => {}, blocked: false }
  const view = render(<GitActions {...props} />)
  fireEvent.click(screen.getByLabelText('new.txt')); fireEvent.click(screen.getByText('Preparar selecionados'))
  await screen.findByText(/A resposta foi perdida/)
  const original = JSON.parse(sessionStorage.getItem(`git-management:pending:${context.projectId}`)!)
  view.unmount()
  render(<GitActions {...props} context={{ ...context, revision: 2 }} />)
  fireEvent.click(screen.getByText('Recuperar mesma operação'))
  await screen.findByText(/O projeto ativo mudou/)
  expect(mutate).toHaveBeenCalledTimes(1)
  expect(JSON.parse(sessionStorage.getItem(`git-management:pending:${context.projectId}`)!)).toEqual(original)
})
