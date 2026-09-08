/*
-T ---
*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../../shared/types'
import type { CodeAwarenessIgnoreService } from '../core/code-awareness-ignore-service'
import type { CompressionService } from '../core/compression-service'
import type { SettingsService } from '../core/settings-service'
import type { WatcherService } from '../core/watcher-service'
import { registerGitHandlers } from './git-handler'

const registeredHandlers = new Map<string, Function>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      registeredHandlers.set(channel, handler)
    })
  },
  shell: {
    showItemInFolder: vi.fn()
  }
}))

describe('git-handler — Ignore IPC Regression', () => {
  let mockWatcherService: WatcherService
  let mockSettingsService: SettingsService
  let mockCompressionService: CompressionService
  let mockIgnoreService: CodeAwarenessIgnoreService
  let fakeSettings: AppSettings

  beforeEach(() => {
    registeredHandlers.clear()

    fakeSettings = {
      rootFolders: [],
      individualProjects: [],
      hiddenProjects: [],
      ignoredDiffFiles: {
        '/test/repo': ['src/ignored.ts']
      },
      tags: {},
      fileTags: {},
      projectPreferences: {}
    }

    mockWatcherService = {
      subscribe: vi.fn(),
      stop: vi.fn()
    } as unknown as WatcherService

    mockSettingsService = {
      loadSettings: vi.fn().mockReturnValue(fakeSettings),
      saveSettings: vi.fn()
    } as unknown as SettingsService

    mockCompressionService = {
      generateCompressionMarkdown: vi.fn()
    } as unknown as CompressionService

    mockIgnoreService = {
      add: vi.fn(),
      remove: vi.fn(),
      list: vi.fn(),
      isIgnored: vi.fn(),
      reconcile: vi.fn(),
      normalizePath: vi.fn((p: string) => p.replace(/\\/g, '/'))
    } as unknown as CodeAwarenessIgnoreService

    registerGitHandlers(
      mockWatcherService,
      mockSettingsService,
      mockCompressionService,
      mockIgnoreService
    )
  })

  it('deve registrar os canais IPC de ignore', () => {
    expect(registeredHandlers.has('git:add-ignored-file')).toBe(true)
    expect(registeredHandlers.has('git:remove-ignored-file')).toBe(true)
    expect(registeredHandlers.has('git:reconcile-ignored-files')).toBe(true)
  })

  describe('git:add-ignored-file', () => {
    const getHandler = () => registeredHandlers.get('git:add-ignored-file')!

    it('retorna null e não delega ao serviço para entradas vazias ou inválidas', async () => {
      const handler = getHandler()

      const res1 = await handler({}, '', 'src/a.ts')
      expect(res1).toBeNull()
      expect(mockIgnoreService.add).not.toHaveBeenCalled()

      const res2 = await handler({}, '/repo', '')
      expect(res2).toBeNull()
      expect(mockIgnoreService.add).not.toHaveBeenCalled()
    })

    it('delega ao serviço com parâmetros corretos e retorna o AppSettings', async () => {
      const handler = getHandler()
      const updatedSettings = { ...fakeSettings, ignoredDiffFiles: { '/repo': ['src/a.ts'] } }
      vi.mocked(mockIgnoreService.add).mockReturnValue(updatedSettings)

      const result = await handler({}, '/repo', 'src/a.ts')
      expect(mockIgnoreService.add).toHaveBeenCalledWith('/repo', 'src/a.ts')
      expect(result).toEqual(updatedSettings)
    })
  })

  describe('git:remove-ignored-file', () => {
    const getHandler = () => registeredHandlers.get('git:remove-ignored-file')!

    it('retorna null e não delega ao serviço para entradas vazias ou inválidas', async () => {
      const handler = getHandler()

      const res1 = await handler({}, '', 'src/a.ts')
      expect(res1).toBeNull()
      expect(mockIgnoreService.remove).not.toHaveBeenCalled()

      const res2 = await handler({}, '/repo', '')
      expect(res2).toBeNull()
      expect(mockIgnoreService.remove).not.toHaveBeenCalled()
    })

    it('delega ao serviço com parâmetros corretos e retorna o AppSettings', async () => {
      const handler = getHandler()
      const updatedSettings = { ...fakeSettings, ignoredDiffFiles: { '/repo': [] } }
      vi.mocked(mockIgnoreService.remove).mockReturnValue(updatedSettings)

      const result = await handler({}, '/repo', 'src/a.ts')
      expect(mockIgnoreService.remove).toHaveBeenCalledWith('/repo', 'src/a.ts')
      expect(result).toEqual(updatedSettings)
    })
  })

  describe('git:reconcile-ignored-files', () => {
    const getHandler = () => registeredHandlers.get('git:reconcile-ignored-files')!

    it('retorna null e não delega ao serviço para repoPath vazio ou inválido', async () => {
      const handler = getHandler()

      const res1 = await handler({}, '', ['src/a.ts'])
      expect(res1).toBeNull()
      expect(mockIgnoreService.reconcile).not.toHaveBeenCalled()
    })

    it('delega ao serviço com repoPath e retorna o AppSettings reconciliado', async () => {
      const handler = getHandler()
      const updatedSettings = { ...fakeSettings, ignoredDiffFiles: { '/repo': ['src/existing.ts'] } }
      vi.mocked(mockIgnoreService.reconcile).mockReturnValue(updatedSettings)

      const result = await handler({}, '/repo', ['src/existing.ts'])
      expect(mockIgnoreService.reconcile).toHaveBeenCalledWith('/repo')
      expect(result).toEqual(updatedSettings)
    })
  })
})
