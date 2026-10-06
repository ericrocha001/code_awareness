// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CodeMapView } from './CodeMapView'

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

it('keeps repository totals, selected source and persisted pane widths through search and visibility changes', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  const files = ['alpha.ts', 'beta.ts'].map((relativePath, index) => ({
    id: String(index), repositoryId: 'repo', relativePath, extension: '.ts', language: 'typescript',
    lines: 1, sizeBytes: 20, mtime: 1, contentHash: 'hash', tokenCount: 1, status: 'indexed'
  }))
  window.codeAwareness = {
    openRepository: vi.fn(async () => ({ success: true })),
    getFiles: vi.fn(async () => ({ success: true, data: files })),
    getElements: vi.fn(async () => ({ success: true, data: [] })),
    getRelationships: vi.fn(async () => ({ success: true, data: [] })),
    getModifiedFilesCount: vi.fn(async () => ({ success: true, data: 0 })),
    getRepository: vi.fn(async () => ({ success: true, data: { name: 'repo', lastIndexedAt: '2026-10-05T12:00:00Z' } })),
    getSyncStatus: vi.fn(async () => ({ success: true, data: { lastSyncAt: null } })),
    getTags: vi.fn(async () => ({ success: true, data: [] })),
    getFileTags: vi.fn(async () => ({ success: true, data: {} })),
    getFileContent: vi.fn(async () => ({ success: true, data: { content: 'export const alpha = 1', truncated: false } })),
    onCodeMapFileConfirmed: vi.fn(() => () => {}),
    onCodeMapFileIndexed: vi.fn(() => () => {})
  } as unknown as Window['codeAwareness']
  localStorage.setItem('codeMap:columns:C:/repo', JSON.stringify({ tree: 0.3, reading: 0.4 }))
  const { container } = render(<CodeMapView activeProject={{ path: 'C:/repo', name: 'repo' }} onSelectProject={vi.fn()} onStatusMessage={vi.fn()} />)
  await screen.findByText('Nenhum source selecionado')
  expect((container.querySelector('.cmv-tree-zone') as HTMLElement).style.flexBasis).toBe('30%')
  fireEvent.click(container.querySelector('[data-type="file"]')!)
  await waitFor(() => expect(window.codeAwareness.getFileContent).toHaveBeenCalledWith('C:/repo', 'alpha.ts'))
  fireEvent.change(screen.getByRole('textbox', { name: 'Buscar arquivos, símbolos e elementos estruturais' }), { target: { value: 'beta' } })
  expect(container.querySelectorAll('[data-type="file"]')).toHaveLength(1)
  expect(container.querySelector('.cmv-awareness-stats')?.textContent).toContain('2arquivos')
  expect(container.querySelector('.cmp-file-name')?.textContent).toBe('alpha.ts')
  fireEvent.click(screen.getByRole('button', { name: 'Ocultar Explorer' }))
  fireEvent.click(screen.getByRole('button', { name: 'Ocultar Código' }))
  expect(container.querySelector('.cmv-code-zone')).toBeNull()
  expect(parseFloat((container.querySelector('.cmv-reading-zone') as HTMLElement).style.flexBasis)).toBeCloseTo(100)
  fireEvent.click(screen.getByRole('button', { name: 'Exibir Explorer' }))
  fireEvent.click(screen.getByRole('button', { name: 'Exibir Código' }))
  expect((container.querySelector('.cmv-reading-zone') as HTMLElement).style.flexBasis).toBe('40%')
  expect(container.querySelector('.cmp-file-name')?.textContent).toBe('alpha.ts')
})
