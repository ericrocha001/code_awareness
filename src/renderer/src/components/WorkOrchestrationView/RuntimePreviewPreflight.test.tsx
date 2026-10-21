// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RuntimePreviewPreflight } from './RuntimePreviewPreflight'
afterEach(cleanup)
const worktrees = [{ worktreeId: 'tree', generation: 'gen', path: 'selected checkout' }] as any
it('has no idle reads or process controls and sends only verified selection fields', async () => {
  const query = vi.fn().mockResolvedValueOnce({ kind: 'PREVIEW_PROFILES', profiles: [{ profileId: 'web', revision: 1, fingerprint: 'hash', approved: false }] })
    .mockResolvedValueOnce({ kind: 'PREVIEW_PREFLIGHT', preflight: { status: 'INCOMPATIBLE', diagnostics: [{ reasonCode: 'SECURITY_ISOLATION_UNAVAILABLE', message: 'Missing protection', missingRequirements: [{ capability: 'NETWORK_EGRESS_RESTRICTION', guarantee: 'loopback enforced', availableMechanism: { name: 'No firewall', basis: 'No enforcement' }, resolutions: [{ description: 'Independent review' }] }] }] } })
  render(<RuntimePreviewPreflight repositoryId="repo" worktrees={worktrees} query={query} disabled={false}/> )
  expect(query).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: /iniciar|parar/i })).toBeNull()
  fireEvent.click(screen.getByText('Consultar perfis'))
  fireEvent.click(await screen.findByText('Verificar compatibilidade'))
  expect(await screen.findByText('SECURITY_ISOLATION_UNAVAILABLE')).toBeTruthy()
  expect(screen.getByText('NETWORK_EGRESS_RESTRICTION: loopback enforced')).toBeTruthy()
  expect(query.mock.calls[1][0]).toEqual({ action: 'PREVIEW_PREFLIGHT', selection: { repositoryId: 'repo', worktreeId: 'tree', generation: 'gen', profileId: 'web', fingerprint: 'hash' } })
})
it('drops delayed responses after disabling the selected context', async () => {
  let release!: (data: any) => void
  const query = vi.fn(() => new Promise<any>(resolve => { release = resolve }))
  const view = render(<RuntimePreviewPreflight repositoryId="repo" worktrees={worktrees} query={query} disabled={false}/> )
  fireEvent.click(screen.getByText('Consultar perfis'))
  view.rerender(<RuntimePreviewPreflight repositoryId="repo" worktrees={worktrees} query={query} disabled/> )
  release({ kind: 'PREVIEW_PROFILES', profiles: [{ profileId: 'old', revision: 1 }] })
  expect(screen.queryByText(/old/)).toBeNull()
})
it('selects another catalog repository without activating it and clears the original worktree and profile', async () => {
  const activate = vi.fn(), list = vi.fn(async () => [{ id: 'repo', name: 'Active repository', status: 'ACTIVE', localCheckout: { availability: 'AVAILABLE', gitState: 'GIT' } }, { id: 'other', name: 'Other repository', status: 'ACTIVE', localCheckout: { availability: 'AVAILABLE', gitState: 'GIT' } }])
  window.codeAwareness = { listRepositories: list, activateRepository: activate } as any
  const query = vi.fn(async (op: any) => {
    if (op.action === 'PREVIEW_WORKTREES') return { kind: 'PREVIEW_WORKTREES', repositoryId: 'other', worktrees: [{ worktreeId: 'other-tree', generation: 'other-gen', path: 'other checkout', branch: 'feature-b' }] }
    if (op.action === 'PREVIEW_PROFILES') return { kind: 'PREVIEW_PROFILES', profiles: [{ profileId: 'other-profile', fingerprint: 'other-fingerprint', revision: 2, approved: true }] }
    return { kind: 'PREVIEW_PREFLIGHT', preflight: { status: 'UNKNOWN', diagnostics: [] } }
  })
  render(<RuntimePreviewPreflight repositoryId="repo" worktrees={worktrees} query={query as any} disabled={false}/> )
  expect(list).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Escolher repositório gerenciado'))
  await screen.findByText('Other repository')
  fireEvent.change(screen.getByLabelText('Repositório do runtime'), { target: { value: 'other' } })
  await screen.findByText('feature-b · other checkout')
  fireEvent.click(screen.getByText('Consultar perfis'))
  fireEvent.click(await screen.findByText('Verificar compatibilidade'))
  await screen.findByRole('status')
  expect(query.mock.calls.at(-1)![0]).toEqual({ action: 'PREVIEW_PREFLIGHT', selection: { repositoryId: 'other', worktreeId: 'other-tree', generation: 'other-gen', profileId: 'other-profile', fingerprint: 'other-fingerprint' } })
  expect(activate).not.toHaveBeenCalled()
})
