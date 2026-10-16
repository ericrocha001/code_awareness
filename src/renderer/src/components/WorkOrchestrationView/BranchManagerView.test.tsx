import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BranchManagerView } from './BranchManagerView'

function renderBranchManagerView(branch: string = 'main', originCount = 2, destinationCount = 1) {
  return render(<BranchManagerView
    branch={branch}
    pullRequests={{
      branch,
      origin: Array.from({ length: originCount }, (_, i) => ({
        prNumber: i + 1,
        title: `PR enviado #${i + 1}`,
        htmlUrl: `https://github.com/owner/repo/pull/${i + 1}`,
        createdAt: new Date(Date.now() - i * 3600000).toISOString(),
        state: i === 0 ? 'merged' : 'open'
      })),
      destination: Array.from({ length: destinationCount }, (_, i) => ({
        prNumber: 100 + i,
        title: `PR recebido #${i + 1}`,
        htmlUrl: `https://github.com/owner/repo/pull/${100 + i}`,
        createdAt: new Date(Date.now() - (i + 1) * 3600000).toISOString(),
        state: 'open'
      }))
    }}
  />)
}

describe('BranchManagerView', () => {
  it('renders PRs enviados section with origin PRs', () => {
    renderBranchManagerView('main', 2, 1)
    expect(screen.getByText('PRs enviados desta branch')).toBeInTheDocument()
    expect(screen.getByText('PR enviado #1')).toBeInTheDocument()
    expect(screen.getByText('PR enviado #2')).toBeInTheDocument()
  })

  it('renders PRs destinados section with destination PRs', () => {
    renderBranchManagerView('main', 2, 1)
    expect(screen.getByText('PRs destinados a esta branch')).toBeInTheDocument()
    expect(screen.getByText('PR recebido #1')).toBeInTheDocument()
  })

  it('shows empty state when no PRs', () => {
    render(<BranchManagerView branch="main" pullRequests={{ branch: 'main', origin: [], destination: [] }} />)
    expect(screen.getByText(/Nenhum PR originado desta branch/)).toBeInTheDocument()
  })

  it('shows destination empty state', () => {
    render(<BranchManagerView branch="main" pullRequests={{ branch: 'main', origin: [{ prNumber: 1, title: 'x', htmlUrl: '#', createdAt: new Date().toISOString(), state: 'open' }], destination: [] }} />)
    expect(screen.getByText(/Nenhum PR recebido nesta branch/)).toBeInTheDocument()
  })
})
