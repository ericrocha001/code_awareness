/*
-T ---
*/

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileListingPort } from './file-listing-port'
import { IgnorePolicy, type SettingsReader } from './ignore-policy'
import type { CodeAwarenessIgnoreService } from './code-awareness-ignore-service'

describe('IgnorePolicy', () => {
  let tempDirs: string[] = []

  const createTempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ignore-policy-test-'))
    tempDirs.push(dir)
    return dir
  }

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

  it('1. Arquivos ignorados pelo Git (.gitignore) não entram na allowlist', async () => {
    const tempDir = createTempDir()
    writeFileSync(join(tempDir, '.gitignore'), '*.log\nbuild/\ntemp.ts\n', 'utf-8')

    const mockLister: FileListingPort = {
      listAllFiles: vi.fn().mockResolvedValue([
        { relativePath: 'src/main.ts' },
        { relativePath: 'src/app.log' },
        { relativePath: 'build/output.js' },
        { relativePath: 'temp.ts' }
      ])
    }

    const policy = new IgnorePolicy(mockLister)
    const allowlist = await policy.resolveAllowlist(tempDir)

    expect(allowlist).toEqual(['src/main.ts'])
  })

  it('2. Arquivos ignorados pelo Code Awareness (settings) não entram na allowlist', async () => {
    const tempDir = createTempDir()

    const mockLister: FileListingPort = {
      listAllFiles: vi.fn().mockResolvedValue([
        { relativePath: 'src/main.ts' },
        { relativePath: 'src/secret.ts' },
        { relativePath: 'package.json' }
      ])
    }

    const mockSettings: SettingsReader = {
      loadSettings: vi.fn().mockReturnValue({
        ignoredDiffFiles: {
          [tempDir]: ['src/secret.ts']
        }
      })
    }

    const policy = new IgnorePolicy(mockLister, mockSettings)
    const allowlist = await policy.resolveAllowlist(tempDir)

    expect(allowlist).toEqual(['package.json', 'src/main.ts'])
    expect(allowlist).not.toContain('src/secret.ts')
  })

  it('3. Arquivos permitidos (nem no Git Ignore nem no Code Awareness) permanecem na allowlist', async () => {
    const tempDir = createTempDir()
    writeFileSync(join(tempDir, '.gitignore'), '*.tmp\n', 'utf-8')

    const mockLister: FileListingPort = {
      listAllFiles: vi.fn().mockResolvedValue([
        { relativePath: 'src/a.ts' },
        { relativePath: 'src/b.ts' },
        { relativePath: 'src/c.tmp' },
        { relativePath: 'src/d.ts' }
      ])
    }

    const mockSettings: SettingsReader = {
      loadSettings: vi.fn().mockReturnValue({
        ignoredDiffFiles: {
          [tempDir]: ['src/b.ts']
        }
      })
    }

    const policy = new IgnorePolicy(mockLister, mockSettings)
    const allowlist = await policy.resolveAllowlist(tempDir)

    expect(allowlist).toEqual(['src/a.ts', 'src/d.ts'])
  })

  it('4. Caminhos com barras invertidas (Windows) são normalizados e deduplicados', async () => {
    const tempDir = createTempDir()

    const mockLister: FileListingPort = {
      listAllFiles: vi.fn().mockResolvedValue([
        { relativePath: 'src\\components\\Button.tsx' },
        { relativePath: 'src/components/Button.tsx' },
        { relativePath: 'src\\utils\\helper.ts' }
      ])
    }

    const policy = new IgnorePolicy(mockLister)
    const allowlist = await policy.resolveAllowlist(tempDir)

    expect(allowlist).toEqual([
      'src/components/Button.tsx',
      'src/utils/helper.ts'
    ])
  })

  it('5. Duplicatas na lista de candidatos são removidas', async () => {
    const tempDir = createTempDir()

    const mockLister: FileListingPort = {
      listAllFiles: vi.fn().mockResolvedValue([
        { relativePath: 'src/index.ts' },
        { relativePath: 'src/index.ts' },
        { relativePath: 'src/index.ts' }
      ])
    }

    const policy = new IgnorePolicy(mockLister)
    const allowlist = await policy.resolveAllowlist(tempDir)

    expect(allowlist).toEqual(['src/index.ts'])
  })

  it('6. A allowlist retornada possui ordem alfabética determinística', async () => {
    const tempDir = createTempDir()

    const mockLister: FileListingPort = {
      listAllFiles: vi.fn().mockResolvedValue([
        { relativePath: 'z.ts' },
        { relativePath: 'a.ts' },
        { relativePath: 'm.ts' },
        { relativePath: 'b.ts' }
      ])
    }

    const policy = new IgnorePolicy(mockLister)
    const allowlist = await policy.resolveAllowlist(tempDir)

    expect(allowlist).toEqual(['a.ts', 'b.ts', 'm.ts', 'z.ts'])
  })

  it('7. Ausência de .gitignore não bloqueia a listagem e aplica apenas Code Awareness Ignore', async () => {
    const tempDir = createTempDir() // sem .gitignore

    const mockLister: FileListingPort = {
      listAllFiles: vi.fn().mockResolvedValue([
        { relativePath: 'src/a.ts' },
        { relativePath: 'src/ignored.ts' }
      ])
    }

    const mockSettings: SettingsReader = {
      loadSettings: vi.fn().mockReturnValue({
        ignoredDiffFiles: {
          [tempDir]: ['src/ignored.ts']
        }
      })
    }

    const policy = new IgnorePolicy(mockLister, mockSettings)
    const allowlist = await policy.resolveAllowlist(tempDir)

    expect(allowlist).toEqual(['src/a.ts'])
  })

  it('8. Propaga erros lançados pelo listador de arquivos', async () => {
    const tempDir = createTempDir()

    const mockLister: FileListingPort = {
      listAllFiles: vi.fn().mockRejectedValue(new Error('Disco corrompido ou inacessível'))
    }

    const policy = new IgnorePolicy(mockLister)
    await expect(policy.resolveAllowlist(tempDir)).rejects.toThrow(
      'Disco corrompido ou inacessível'
    )
  })

  it('9. Utiliza CodeAwarenessIgnoreService quando injetado para filtrar arquivos ignorados', async () => {
    const tempDir = createTempDir()

    const mockLister: FileListingPort = {
      listAllFiles: vi.fn().mockResolvedValue([
        { relativePath: 'src/main.ts' },
        { relativePath: 'src/config.ts' },
        { relativePath: 'src/secret.ts' }
      ])
    }

    const mockIgnoreService: CodeAwarenessIgnoreService = {
      list: vi.fn().mockReturnValue(['src/secret.ts'])
    } as unknown as CodeAwarenessIgnoreService

    const policy = new IgnorePolicy(mockLister, undefined, mockIgnoreService)
    const allowlist = await policy.resolveAllowlist(tempDir)

    expect(mockIgnoreService.list).toHaveBeenCalledWith(tempDir)
    expect(allowlist).toEqual(['src/config.ts', 'src/main.ts'])
  })

  it('10. CodeAwarenessIgnoreService tem precedência sobre settingsReader quando ambos são injetados', async () => {
    const tempDir = createTempDir()

    const mockLister: FileListingPort = {
      listAllFiles: vi.fn().mockResolvedValue([
        { relativePath: 'src/a.ts' },
        { relativePath: 'src/b.ts' },
        { relativePath: 'src/c.ts' }
      ])
    }

    const mockSettings: SettingsReader = {
      loadSettings: vi.fn().mockReturnValue({
        ignoredDiffFiles: {
          [tempDir]: ['src/b.ts']
        }
      })
    }

    const mockIgnoreService: CodeAwarenessIgnoreService = {
      list: vi.fn().mockReturnValue(['src/c.ts'])
    } as unknown as CodeAwarenessIgnoreService

    const policy = new IgnorePolicy(mockLister, mockSettings, mockIgnoreService)
    const allowlist = await policy.resolveAllowlist(tempDir)

    expect(mockIgnoreService.list).toHaveBeenCalledWith(tempDir)
    expect(mockSettings.loadSettings).not.toHaveBeenCalled()
    expect(allowlist).toEqual(['src/a.ts', 'src/b.ts'])
  })
})
