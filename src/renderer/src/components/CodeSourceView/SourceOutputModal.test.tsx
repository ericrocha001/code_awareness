// @vitest-environment jsdom
/*
-T ---
*/

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { SourceOutputModal } from './SourceOutputModal'
import { DEFAULT_SOURCE_PROFILE } from '../../../../shared/utils/source-profile'

describe('SourceOutputModal', () => {
  let savedSettings: any

  beforeEach(() => {
    vi.useFakeTimers()

    // Mock simples de ResizeObserver para o ambiente jsdom
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any

    // Mock matchMedia para useTheme
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false
      })
    })

    savedSettings = {
      sourceSettings: {
        outputFormat: 'markdown',
        profile: {
          ...DEFAULT_SOURCE_PROFILE,
          includeDirectoryStructure: false,
          includeEmptyDirectories: true,
          includeFullDirectoryStructure: true
        }
      }
    }

    window.codeAwareness = {
      loadSettings: vi.fn().mockImplementation(async () => ({ ...savedSettings })),
      saveSettings: vi.fn().mockImplementation(async (s) => {
        savedSettings = s
        return { success: true }
      }),
      generateCodeSourceWithProfile: vi.fn().mockResolvedValue({
        success: true,
        content: '# Source Content Generated',
        tokenCount: 150,
        generationId: 1
      }),
      saveToDownloads: vi.fn().mockResolvedValue({ success: true, filePath: 'C:\\Downloads\\file.md' }),
      exportToNotebookLM: vi.fn().mockResolvedValue({ success: true, fileCount: 1 })
    } as any

    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('não renderiza nada quando isOpen é false', () => {
    const { container } = render(
      <SourceOutputModal
        isOpen={false}
        onClose={vi.fn()}
        repoPath="C:\\repo"
        selectedFiles={['src/a.ts']}
      />
    )

    expect(container.firstChild).toBeNull()
  })

  it('renderiza o modal, hidrata configurações e gera preview virtualizado com tokenCount', async () => {
    render(
      <SourceOutputModal
        isOpen={true}
        onClose={vi.fn()}
        repoPath="C:\\repo"
        selectedFiles={['src/a.ts']}
      />
    )

    // Aguarda hidratação do useSourceSettings
    await act(async () => {
      await Promise.resolve()
    })

    // Aguarda debounce de geração do useSourceGeneration (300ms)
    await act(async () => {
      vi.advanceTimersByTime(300)
    })

    expect(screen.getByText('Gerar Code Source')).toBeDefined()
    expect(screen.getByText('150 tokens')).toBeDefined()
    // Deve renderizar container do SourcePreviewVirtualized
    expect(document.querySelector('.spv-virtual-container')).not.toBeNull()
  })

  it('desabilita toggles filhos de estrutura quando includeDirectoryStructure for false', async () => {
    render(
      <SourceOutputModal
        isOpen={true}
        onClose={vi.fn()}
        repoPath="C:\\repo"
        selectedFiles={['src/a.ts']}
      />
    )

    await act(async () => {
      await Promise.resolve()
    })

    // savedSettings tem includeDirectoryStructure: false
    // Os toggles "Incluir diretórios vazios" e "Incluir estrutura completa de diretórios" devem estar com aria-disabled="true"
    const emptyDirsLabel = screen.getByText('Incluir diretórios vazios')
    const emptyDirsToggle = emptyDirsLabel.parentElement?.querySelector('[role="switch"]')
    expect(emptyDirsToggle?.getAttribute('aria-disabled')).toBe('true')

    const fullStructureLabel = screen.getByText('Incluir estrutura completa de diretórios')
    const fullStructureToggle = fullStructureLabel.parentElement?.querySelector('[role="switch"]')
    expect(fullStructureToggle?.getAttribute('aria-disabled')).toBe('true')
  })

  it('aciona ação de cópia com o conteúdo integral do documento', async () => {
    const onStatusMessage = vi.fn()
    render(
      <SourceOutputModal
        isOpen={true}
        onClose={vi.fn()}
        repoPath="C:\\repo"
        selectedFiles={['src/a.ts']}
        onStatusMessage={onStatusMessage}
      />
    )

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(300)
    })

    const copyBtn = screen.getByText('Copiar para a área de transferência')
    await act(async () => {
      fireEvent.click(copyBtn)
    })

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('# Source Content Generated')
    expect(onStatusMessage).toHaveBeenCalledWith('Código fonte copiado!')
  })

  it('aciona exportação para download com o conteúdo integral do documento', async () => {
    const onStatusMessage = vi.fn()
    render(
      <SourceOutputModal
        isOpen={true}
        onClose={vi.fn()}
        repoPath="C:\\repo"
        selectedFiles={['src/a.ts']}
        onStatusMessage={onStatusMessage}
      />
    )

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(300)
    })

    const exportBtn = screen.getByText('Exportar como arquivo')
    await act(async () => {
      fireEvent.click(exportBtn)
    })

    expect(window.codeAwareness.saveToDownloads).toHaveBeenCalledWith(
      '# Source Content Generated',
      'code-source',
      'markdown'
    )
    expect(onStatusMessage).toHaveBeenCalledWith('Exportado para Downloads!')
  })

  it('aciona exportação para NotebookLM quando o formato for Markdown', async () => {
    const onStatusMessage = vi.fn()
    render(
      <SourceOutputModal
        isOpen={true}
        onClose={vi.fn()}
        repoPath="C:\\repo"
        selectedFiles={['src/a.ts']}
        onStatusMessage={onStatusMessage}
      />
    )

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(300)
    })

    const notebookBtn = screen.getByText('Exportar para NotebookLM')
    await act(async () => {
      fireEvent.click(notebookBtn)
    })

    expect(window.codeAwareness.exportToNotebookLM).toHaveBeenCalledWith(
      '# Source Content Generated',
      'code-source'
    )
    expect(onStatusMessage).toHaveBeenCalledWith('Exportado para Downloads (.docx)!')
  })
})
