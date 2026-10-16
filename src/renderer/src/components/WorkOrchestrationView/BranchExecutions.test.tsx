// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BranchExecutions } from './BranchExecutions'
import type { BranchRecord } from '../../../../shared/types/branch-orchestration-types'
afterEach(cleanup)
const branch = { repositoryId: 'repo', ref: 'refs/heads/topic', revision: 'r1', generation: 'g1' } as BranchRecord
const binding = { artifactId: 'binding', executionId: 'run-A', sourceArtifactId: 'plan', branchRef: branch.ref, branchGeneration: 'g1', sourceHeadAtBinding: 'abc123456', observedAt: '2026-10-16', classification: 'VERIFIED_CURRENT', checkout: 'CURRENT' }
const page = { kind: 'EXECUTIONS', page: { repositoryId: 'repo', branchRef: branch.ref, branchRevision: 'r1', bindings: [binding], coverage: 'COMPLETE' } }
it('reads only on disclosure, lists execution documents without bodies, navigates through existing Continuum', async () => {
  const query = vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce({ kind: 'EXECUTION_DOCUMENTS', page: { repositoryId: 'repo', executionId: 'run-A', artifacts: [{ artifactId: 'plan', name: 'Canonical plan', kind: 'EXECUTABLE_PLAN', status: 'PENDING' }], nextCursor: 'next' } })
  const onArtifact = vi.fn()
  render(<BranchExecutions branch={branch} active query={query} onArtifact={onArtifact}/>);
  expect(query).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Execuções do Continuum'))
  await screen.findByText('Vínculo corrente verificado')
  expect(query).toHaveBeenNthCalledWith(1, { action: 'EXECUTIONS', ref: branch.ref, revision: branch.revision })
  fireEvent.click(screen.getByText('Ver Artifacts desta execução'))
  await screen.findByText('Canonical plan')
  fireEvent.click(screen.getByText('Abrir no Continuum'))
  expect(onArtifact).toHaveBeenCalledWith({ repositoryId: 'repo', artifactId: 'plan' })
  expect(screen.getByText('Próxima página de Artifacts')).toBeTruthy()
  expect(query).toHaveBeenCalledTimes(2)
})
it('drops responses after rapid branch change and never turns failure into absence', async () => {
  let resolve!: (value: unknown) => void
  const query = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done })).mockRejectedValueOnce(new Error('CONTINUUM_UNAVAILABLE'))
  const view = render(<BranchExecutions branch={branch} active query={query}/>)
  fireEvent.click(screen.getByText('Atualizar execuções'))
  view.rerender(<BranchExecutions branch={{ ...branch, ref: 'refs/heads/other' }} active query={query}/>)
  resolve(page)
  await waitFor(() => expect(screen.queryByText('run-A')).toBeNull())
  fireEvent.click(screen.getByText('Atualizar execuções'))
  await screen.findByRole('alert')
  expect(screen.queryByText(/Sem vínculo explícito/)).toBeNull()
})
it('clears current certification while hidden and requires an explicit fresh read', async () => {
  const query = vi.fn().mockResolvedValue(page)
  const view = render(<BranchExecutions branch={branch} active query={query}/>)
  fireEvent.click(screen.getByText('Atualizar execuções')); await screen.findByText('Vínculo corrente verificado')
  view.rerender(<BranchExecutions branch={branch} active={false} query={query}/>)
  expect(screen.queryByText('Vínculo corrente verificado')).toBeNull()
  view.rerender(<BranchExecutions branch={branch} active query={query}/>)
  expect(query).toHaveBeenCalledTimes(1)
})
