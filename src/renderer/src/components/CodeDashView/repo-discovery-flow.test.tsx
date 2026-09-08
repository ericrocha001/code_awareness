// @vitest-environment jsdom

import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashService } from '../../../../main/core/dash/dash-service'
import { DashDiscoveryService } from '../../../../main/core/dash/dash-discovery-service'
import type { OneClickXmlService } from '../../../../main/core/one-click-xml-service'
import { RepoDiscovery } from '../../../../main/core/context/repo-discovery'
import { getCanonicalTokenizer } from '../../../../main/core/tokenizer'
import { registerDashHandlers } from '../../../../main/ipc/dash-handler'
import { RepoDiscoveryPanel } from './RepoDiscoveryPanel'

const handlers = new Map<string, Function>()

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: Function) => handlers.set(channel, handler)) }
}))

describe('Repo Discovery token count flow', () => {
  beforeEach(() => {
    handlers.clear()
    const discovery = new RepoDiscovery({
      awaitSnapshot: vi.fn(async () => undefined),
      getFiles: vi.fn(() => [{
        id: 'a', repositoryId: 'repo', relativePath: 'src/a.ts', language: 'typescript', extension: '.ts',
        lines: 1, sizeBytes: 12, mtime: 1, contentHash: 'hash', tokenCount: 4, status: 'indexed'
      }]),
      getElements: vi.fn(() => []),
      getRelationships: vi.fn(() => []),
    })
    const service = new DashDiscoveryService({ discover: (repoPath, layer) => discovery.generate(repoPath, layer) })
    registerDashHandlers({} as DashService, {} as OneClickXmlService, service)
    window.codeAwareness = {
      dashDiscover: (request, repoPath) => handlers.get('dash:discover')!({}, request, repoPath),
      saveMarkdown: vi.fn(async () => ({ success: true }))
    } as unknown as typeof window.codeAwareness
  })

  it('shows exactly the canonical token count returned through IPC', async () => {
    render(<RepoDiscoveryPanel repoPath="C:/repo" projectName="repo" />)
    fireEvent.click(screen.getByRole('button', { name: /Generate Repo Map/i }))
    const handlerResult = await handlers.get('dash:discover')!({}, {
      protocol: 'repo-discovery/v1', operation: 'discovery', layer: 1
    }, 'C:/repo')
    const expected = getCanonicalTokenizer().count(handlerResult.data.content)
    expect(handlerResult.data.tokenCount).toBe(expected)
    await waitFor(() => expect(screen.getByText(`${expected} Repo Map tokens`)).toBeTruthy())
  })
})
