// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RepositoryRecord } from '../../../../shared/types'
import { HomeView } from './HomeView'

vi.mock('../DocumentPropagator/DocumentPropagator', () => ({ DocumentPropagator: () => null }))

const records: RepositoryRecord[] = [
  {
    id: 'catalog-git', name: 'Git Repo', status: 'ACTIVE', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    localCheckout: { path: 'C:\\repos\\git', availability: 'AVAILABLE', gitState: 'GIT' }, github: null
  },
  {
    id: 'catalog-non-git', name: 'Plain Repo', status: 'ACTIVE', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    localCheckout: { path: 'C:\\repos\\plain', availability: 'AVAILABLE', gitState: 'NON_GIT' }, github: null
  },
  {
    id: 'catalog-missing', name: 'Missing Repo', status: 'ACTIVE', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    localCheckout: { path: 'C:\\repos\\missing', availability: 'MISSING', gitState: 'GIT' }, github: null
  },
  {
    id: 'catalog-remote', name: 'Remote Repo', status: 'ACTIVE', createdAt: '2026-01-01', updatedAt: '2026-01-01', localCheckout: null,
    github: { repositoryId: '99', ownerId: '7', ownerLogin: 'owner', name: 'remote', fullName: 'owner/remote', visibility: 'PRIVATE', htmlUrl: 'https://github.com/owner/remote', cloneUrl: 'https://github.com/owner/remote.git', accessState: 'AVAILABLE', lastSeenAt: '2026-01-01' }
  }
]

beforeEach(() => {
  window.codeAwareness = {
    refreshRepositories: vi.fn(async () => records),
    importRepositoryRoot: vi.fn(async () => records),
    importLocalRepository: vi.fn(async () => records),
    hideRepository: vi.fn(async (id: string) => records.filter((record) => record.id !== id))
    ,getGitHubStatus: vi.fn(async () => ({ state: 'CONNECTED', user: { id: '7', login: 'owner', avatarUrl: '' } }))
    ,cloneGitHubRepository: vi.fn(async () => ({ success: true, repositories: records }))
    ,createGitHubRepository: vi.fn(async () => ({ success: true, repositories: records }))
    ,publishGitHubRepository: vi.fn(async () => ({ success: true, repositories: records }))
    ,refreshGitHub: vi.fn(async () => ({ success: true, repositories: records }))
  } as unknown as Window['codeAwareness']
})

it('shows connected identity and clones remote-only repositories by catalog identity', async () => {
  const { container } = render(<HomeView activeProject={null} onSelectRepository={vi.fn()} onStatusMessage={vi.fn()} />)
  expect(await screen.findByText('GitHub · owner')).toBeTruthy()
  expect(screen.getByTestId('github-mark')).toBeTruthy()
  expect(container.querySelector('.github-connection-avatar img')).toBeNull()
  const remote = (await screen.findByText('Remote Repo')).closest('.project-card')!
  fireEvent.click(Array.from(remote.querySelectorAll('button')).find((button) => button.textContent?.includes('Clone'))!)
  await waitFor(() => expect(window.codeAwareness.cloneGitHubRepository).toHaveBeenCalledWith('catalog-remote'))
})

it('creates and publishes repositories from Home without Settings', async () => {
  render(<HomeView activeProject={null} onSelectRepository={vi.fn()} onStatusMessage={vi.fn()} />)
  await screen.findByText('GitHub · owner')
  fireEvent.click(screen.getByText('Adicionar'))
  fireEvent.click(screen.getByText('New Repository'))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'academy' } })
  fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'PUBLIC' } })
  fireEvent.click(screen.getByText('Create and Clone'))
  await waitFor(() => expect(window.codeAwareness.createGitHubRepository).toHaveBeenCalledWith({ name: 'academy', visibility: 'PUBLIC' }))

  const local = screen.getByText('Git Repo').closest('.project-card')!
  fireEvent.click(Array.from(local.querySelectorAll('button')).find((button) => button.textContent?.includes('Publish to GitHub'))!)
  fireEvent.click(screen.getByText('Publish'))
  await waitFor(() => expect(window.codeAwareness.publishGitHubRepository).toHaveBeenCalledWith({ repositoryId: 'catalog-git', name: 'Git Repo', visibility: 'PRIVATE' }))
})

afterEach(cleanup)

it('renders catalog states and selects by repository identity while Missing remains disabled', async () => {
  const select = vi.fn()
  render(<HomeView activeProject={{ path: 'C:/repos/git', name: 'Git Repo' }} onSelectRepository={select} onStatusMessage={vi.fn()} />)

  expect(await screen.findByText('Repositórios')).toBeTruthy()
  expect(await screen.findByText('Non-Git')).toBeTruthy()
  expect(await screen.findByText('Missing')).toBeTruthy()
  expect(await screen.findByText('Checkout local indisponível')).toBeTruthy()
  expect(await screen.findByText('Selecionado')).toBeTruthy()

  fireEvent.click(screen.getByText('Plain Repo').closest('.project-card')!)
  expect(select).toHaveBeenCalledWith('catalog-non-git')
  fireEvent.click(screen.getByText('Missing Repo').closest('.project-card')!)
  expect(select).toHaveBeenCalledTimes(1)
})

it('hides by catalog identity instead of path', async () => {
  render(<HomeView activeProject={null} onSelectRepository={vi.fn()} onStatusMessage={vi.fn()} />)
  const card = (await screen.findByText('Plain Repo')).closest('.project-card')!
  fireEvent.click(card.querySelector('.project-card-delete-btn')!)
  fireEvent.click(screen.getByText('Confirmar e Remover'))
  await waitFor(() => expect(window.codeAwareness.hideRepository).toHaveBeenCalledWith('catalog-non-git'))
})

it('keeps the local catalog usable when GitHub status is offline', async () => {
  vi.mocked(window.codeAwareness.getGitHubStatus).mockRejectedValueOnce(new Error('offline'))
  const select = vi.fn()
  render(<HomeView activeProject={null} onSelectRepository={select} onStatusMessage={vi.fn()} />)
  fireEvent.click((await screen.findByText('Plain Repo')).closest('.project-card')!)
  expect(select).toHaveBeenCalledWith('catalog-non-git')
})

it('filters the rendered catalog by repository name and GitHub full name', async () => {
  render(<HomeView activeProject={null} onSelectRepository={vi.fn()} onStatusMessage={vi.fn()} />)
  const search = await screen.findByLabelText('Buscar repositórios')

  fireEvent.change(search, { target: { value: 'plain' } })
  expect(screen.getByText('Plain Repo')).toBeTruthy()
  expect(screen.queryByText('Git Repo')).toBeNull()
  expect(screen.queryByText('Remote Repo')).toBeNull()

  fireEvent.change(search, { target: { value: 'owner/remote' } })
  expect(screen.getByText('Remote Repo')).toBeTruthy()
  expect(screen.queryByText('Plain Repo')).toBeNull()

  fireEvent.change(search, { target: { value: '' } })
  expect(screen.getByText('Git Repo')).toBeTruthy()
  expect(screen.getByText('Remote Repo')).toBeTruthy()
})
