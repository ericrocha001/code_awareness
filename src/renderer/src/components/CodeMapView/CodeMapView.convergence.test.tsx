// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CodeMapView } from './CodeMapView'

vi.mock('./CodeMapTree', () => ({ CodeMapTree: () => null }))
vi.mock('./CodeMapReading', () => ({ CodeMapReading: () => null }))
vi.mock('./CodeMapCode', () => ({ CodeMapCode: () => null }))

afterEach(() => { cleanup(); localStorage.clear() })

it('refreshes pending state on confirmation and current state on domain completion', async () => {
  let count = 0
  let confirmed!: (event: { repoPath: string; relativePath: string }) => void
  let indexed!: typeof confirmed
  const unsubscribe = vi.fn()
  window.codeAwareness = {
    openRepository: vi.fn(async () => ({ success: true })),
    getFiles: vi.fn(async () => ({ success: true, data: [] })),
    getElements: vi.fn(async () => ({ success: true, data: [] })),
    getRelationships: vi.fn(async () => ({ success: true, data: [] })),
    getModifiedFilesCount: vi.fn(async () => ({ success: true, data: count })),
    getRepository: vi.fn(async () => ({ success: true, data: { lastIndexedAt: '2026-10-05T12:00:00Z' } })),
    getSyncStatus: vi.fn(async () => ({ success: true, data: { lastSyncAt: null } })),
    getTags: vi.fn(async () => ({ success: true, data: [] })),
    getFileTags: vi.fn(async () => ({ success: true, data: {} })),
    onCodeMapFileConfirmed: vi.fn(callback => { confirmed = callback; return unsubscribe }),
    onCodeMapFileIndexed: vi.fn(callback => { indexed = callback; return unsubscribe })
  } as unknown as Window['codeAwareness']
  const view = render(<CodeMapView activeProject={{ path: 'C:/repo', name: 'repo' }} onSelectProject={vi.fn()} onStatusMessage={vi.fn()} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Code Map Health: Healthy' })).toBeTruthy())
  count = 1
  act(() => confirmed({ repoPath: 'C:\\repo', relativePath: 'file.ts' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Code Map Health: Pending' })).toBeTruthy())
  expect(screen.getByRole('button', { name: 'Code Map Health: Pending' }).querySelector('.cmv-spin')).toBeNull()
  count = 0
  act(() => indexed({ repoPath: 'C:/repo', relativePath: 'file.ts' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Code Map Health: Healthy' })).toBeTruthy())
  expect(window.codeAwareness.getModifiedFilesCount).toHaveBeenCalledTimes(3)
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledTimes(2)
})
