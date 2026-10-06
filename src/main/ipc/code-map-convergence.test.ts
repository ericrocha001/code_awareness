import { afterEach, expect, it, vi } from 'vitest'
import { repositoryEventBus } from '../core/repository-events'
import type { CodeMapService } from '../core/code-map-service'
import type { ActiveProjectService } from '../core/active-project-service'

const { send, handle } = vi.hoisted(() => ({ send: vi.fn(), handle: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle }, shell: {},
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }] }
}))
import { registerCodeMapHandlers } from './code-map-handler'

afterEach(() => {
  repositoryEventBus.removeAllListeners()
  vi.clearAllMocks()
})

it('projects domain completion independently of manual IPC invocation', () => {
  registerCodeMapHandlers({} as CodeMapService, {} as ActiveProjectService)
  repositoryEventBus.emitFileConfirmed('C:/repo', 'src/file.ts', 'causal-id')
  repositoryEventBus.emitFileIndexed('C:/repo', 'src/file.ts', 'causal-id')
  expect(send.mock.calls).toEqual([
    ['code-map:file-confirmed', { repoPath: 'C:/repo', relativePath: 'src/file.ts' }],
    ['code-map:file-indexed', { repoPath: 'C:/repo', relativePath: 'src/file.ts' }]
  ])
})
