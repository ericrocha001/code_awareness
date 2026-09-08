// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RepoDiscoveryPanel } from './RepoDiscoveryPanel'

describe('RepoDiscoveryPanel', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } })
    window.codeAwareness = {
      dashDiscover: vi.fn(async (request) => ({
        success: true,
        data: {
          protocol: request.protocol,
          layer: request.layer,
          content: 'REPO MAP',
          tokenCount: 42,
          mapTokenCount: 42,
          tokenizerId: 'test',
          tokenizerEncoding: 'test',
          fileCount: 7,
          generationMs: 12,
          timings: {
            readinessMs: 1, projectionMs: 1,
            serializationMs: 1, outputTokenizationMs: 9, totalMs: 12
          }
        }
      })),
      saveMarkdown: vi.fn(async () => ({ success: true }))
    } as unknown as typeof window.codeAwareness
  })

  it('selects a layer, generates, displays cost and copies the Repo Map', async () => {
    render(<RepoDiscoveryPanel repoPath="C:/repo" projectName="repo" />)
    expect(screen.queryByText('Structure')).toBeNull()
    expect(screen.queryByText('Semantic Compression')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /L2 Connections/i }))
    fireEvent.click(screen.getByRole('button', { name: /Generate Repo Map/i }))
    await waitFor(() => expect(screen.getByText('42 Repo Map tokens')).toBeTruthy())
    expect(screen.getByText('7 files')).toBeTruthy()
    expect(screen.getByText('Layer 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('REPO MAP'))
  })
})
