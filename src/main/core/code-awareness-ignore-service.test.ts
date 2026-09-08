/*
-T ---
*/

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../../shared/types'
import { CodeAwarenessIgnoreService, type SettingsStoragePort } from './code-awareness-ignore-service'

describe('CodeAwarenessIgnoreService', () => {
  let tempDirs: string[] = []
  let mockSettings: AppSettings
  let mockSettingsService: SettingsStoragePort

  const createTempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ignore-service-test-'))
    tempDirs.push(dir)
    return dir
  }

  beforeEach(() => {
    mockSettings = {
      rootFolders: [],
      individualProjects: [],
      hiddenProjects: [],
      ignoredDiffFiles: {},
      tags: {},
      fileTags: {},
      projectPreferences: {}
    }

    mockSettingsService = {
      loadSettings: vi.fn(() => JSON.parse(JSON.stringify(mockSettings))),
      saveSettings: vi.fn((updated: AppSettings) => {
        mockSettings = JSON.parse(JSON.stringify(updated))
      })
    }
  })

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Ignora erros de limpeza no Windows
      }
    }
    tempDirs = []
  })

  describe('add', () => {
    it('1. Adiciona um caminho novo ao repositório', () => {
      const service = new CodeAwarenessIgnoreService(mockSettingsService)
      const result = service.add('/repo/test', 'src/secret.ts')

      expect(result).not.toBeNull()
      expect(result?.ignoredDiffFiles['/repo/test']).toEqual(['src/secret.ts'])
      expect(mockSettingsService.saveSettings).toHaveBeenCalled()
    })

    it('2. Adiciona caminho duplicado mantendo idempotência', () => {
      const service = new CodeAwarenessIgnoreService(mockSettingsService)
      service.add('/repo/test', 'src/secret.ts')
      const result = service.add('/repo/test', 'src/secret.ts')

      expect(result?.ignoredDiffFiles['/repo/test']).toEqual(['src/secret.ts'])
      expect(result?.ignoredDiffFiles['/repo/test'].length).toBe(1)
    })

    it('3. Normaliza barras invertidas (Windows) para barras normais (/) na adição', () => {
      const service = new CodeAwarenessIgnoreService(mockSettingsService)
      const result = service.add('/repo/test', 'src\\components\\Button.tsx')

      expect(result?.ignoredDiffFiles['/repo/test']).toEqual(['src/components/Button.tsx'])
    })

    it('4. Retorna null se repoPath ou relativePath forem inválidos', () => {
      const service = new CodeAwarenessIgnoreService(mockSettingsService)

      expect(service.add('', 'src/file.ts')).toBeNull()
      expect(service.add('/repo/test', '')).toBeNull()
      expect(service.add('/repo/test', '   ')).toBeNull()
      // @ts-expect-error teste defensivo com tipo inválido
      expect(service.add(null, 'src/file.ts')).toBeNull()
      // @ts-expect-error teste defensivo com tipo inválido
      expect(service.add('/repo/test', undefined)).toBeNull()
    })
  })

  describe('remove', () => {
    it('5. Remove caminho existente da lista de ignorados', () => {
      mockSettings.ignoredDiffFiles['/repo/test'] = ['src/a.ts', 'src/b.ts']
      const service = new CodeAwarenessIgnoreService(mockSettingsService)

      const result = service.remove('/repo/test', 'src/a.ts')
      expect(result?.ignoredDiffFiles['/repo/test']).toEqual(['src/b.ts'])
      expect(mockSettingsService.saveSettings).toHaveBeenCalled()
    })

    it('6. Remover caminho inexistente não falha e mantém o estado inalterado', () => {
      mockSettings.ignoredDiffFiles['/repo/test'] = ['src/b.ts']
      const service = new CodeAwarenessIgnoreService(mockSettingsService)

      const result = service.remove('/repo/test', 'src/non-existent.ts')
      expect(result?.ignoredDiffFiles['/repo/test']).toEqual(['src/b.ts'])
    })

    it('7. Remove caminho comparando de forma normalizada (barras invertidas)', () => {
      mockSettings.ignoredDiffFiles['/repo/test'] = ['src/components/Button.tsx']
      const service = new CodeAwarenessIgnoreService(mockSettingsService)

      const result = service.remove('/repo/test', 'src\\components\\Button.tsx')
      expect(result?.ignoredDiffFiles['/repo/test']).toEqual([])
    })

    it('8. Retorna null para argumentos inválidos na remoção', () => {
      const service = new CodeAwarenessIgnoreService(mockSettingsService)

      expect(service.remove('', 'src/file.ts')).toBeNull()
      expect(service.remove('/repo/test', '')).toBeNull()
    })
  })

  describe('list', () => {
    it('9. Lista os caminhos de um repositório com caminhos normalizados', () => {
      mockSettings.ignoredDiffFiles['/repo/test'] = ['src\\a.ts', 'src/b.ts']
      const service = new CodeAwarenessIgnoreService(mockSettingsService)

      const list = service.list('/repo/test')
      expect(list).toEqual(['src/a.ts', 'src/b.ts'])
    })

    it('10. Retorna array vazio para repositório sem ignores', () => {
      const service = new CodeAwarenessIgnoreService(mockSettingsService)
      expect(service.list('/repo/untracked')).toEqual([])
    })

    it('11. Retorna array vazio para repoPath inválido', () => {
      const service = new CodeAwarenessIgnoreService(mockSettingsService)
      expect(service.list('')).toEqual([])
      // @ts-expect-error teste defensivo com tipo inválido
      expect(service.list(null)).toEqual([])
    })
  })

  describe('isIgnored', () => {
    it('12. Retorna true para caminho ignorado e false para não ignorado', () => {
      mockSettings.ignoredDiffFiles['/repo/test'] = ['src/secret.ts']
      const service = new CodeAwarenessIgnoreService(mockSettingsService)

      expect(service.isIgnored('/repo/test', 'src/secret.ts')).toBe(true)
      expect(service.isIgnored('/repo/test', 'src\\secret.ts')).toBe(true)
      expect(service.isIgnored('/repo/test', 'src/public.ts')).toBe(false)
    })

    it('13. Retorna false para entradas inválidas', () => {
      const service = new CodeAwarenessIgnoreService(mockSettingsService)
      expect(service.isIgnored('', 'src/a.ts')).toBe(false)
      expect(service.isIgnored('/repo/test', '')).toBe(false)
    })
  })

  describe('reconcile', () => {
    it('14. Remove caminhos inexistentes e preserva os existentes no disco', () => {
      const tempDir = createTempDir()
      writeFileSync(join(tempDir, 'existing.ts'), 'content', 'utf-8')

      mockSettings.ignoredDiffFiles[tempDir] = ['existing.ts', 'deleted.ts']
      const service = new CodeAwarenessIgnoreService(mockSettingsService)

      const result = service.reconcile(tempDir)
      expect(result?.ignoredDiffFiles[tempDir]).toEqual(['existing.ts'])
    })

    it('15. Preserva entradas com curinga (*) mesmo que não existam como arquivo literal no disco', () => {
      const tempDir = createTempDir()
      writeFileSync(join(tempDir, 'existing.ts'), 'content', 'utf-8')

      mockSettings.ignoredDiffFiles[tempDir] = [
        'existing.ts',
        'deleted.ts',
        '*.log',
        'src/*.test.ts'
      ]
      const service = new CodeAwarenessIgnoreService(mockSettingsService)

      const result = service.reconcile(tempDir)
      expect(result?.ignoredDiffFiles[tempDir]).toEqual([
        'existing.ts',
        '*.log',
        'src/*.test.ts'
      ])
    })

    it('16. Retorna null se repoPath for inválido na reconciliação', () => {
      const service = new CodeAwarenessIgnoreService(mockSettingsService)
      expect(service.reconcile('')).toBeNull()
      // @ts-expect-error teste defensivo com tipo inválido
      expect(service.reconcile(null)).toBeNull()
    })
  })
})
