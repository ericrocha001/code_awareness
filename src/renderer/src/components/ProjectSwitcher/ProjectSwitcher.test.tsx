// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RepositoryRecord } from '../../../../shared/types'
import { ProjectSwitcher } from './ProjectSwitcher'

const repository = (id: string, path: string, availability: 'AVAILABLE' | 'MISSING'): RepositoryRecord => ({
  id, name: id, status: 'ACTIVE', createdAt: '', updatedAt: '',
  localCheckout: { path, availability, gitState: 'GIT' }
})

beforeEach(() => {
  window.codeAwareness = {
    listRepositories: vi.fn(async () => [
      repository('active', 'C:\\repos\\active', 'AVAILABLE'),
      repository('available', 'C:\\repos\\available', 'AVAILABLE'),
      repository('missing', 'C:\\repos\\missing', 'MISSING')
    ])
  } as unknown as Window['codeAwareness']
})

afterEach(cleanup)

it('lists only other available repositories and selects by catalog id', async () => {
  const select = vi.fn()
  render(<ProjectSwitcher activeProject={{ path: 'C:/repos/active', name: 'active' }} onSelectRepository={select} />)
  fireEvent.click(screen.getByRole('button'))
  expect(await screen.findByText('available')).toBeTruthy()
  const popover = screen.getByRole('listbox', { name: 'Projetos disponíveis' })
  expect(popover.parentElement).toBe(document.body)
  expect(popover.style.position).toBe('fixed')
  expect(popover.style.zIndex).toBe('1400')
  expect(screen.queryByText('missing')).toBeNull()
  expect(screen.queryByRole('option', { name: /active/ })).toBeNull()
  fireEvent.click(screen.getByText('available'))
  expect(select).toHaveBeenCalledWith('available')
})

it('keeps the portaled popover interactive and closes it with Escape', async () => {
  render(<ProjectSwitcher activeProject={null} onSelectRepository={vi.fn()} />)
  const trigger = screen.getByRole('button')
  fireEvent.click(trigger)
  expect(await screen.findByRole('listbox', { name: 'Projetos disponíveis' })).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('listbox', { name: 'Projetos disponíveis' })).toBeNull()
  expect(document.activeElement).toBe(trigger)
})
