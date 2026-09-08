// @vitest-environment jsdom
/*
-T ---
*/

import React from 'react'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { RestoreModal } from './RestoreModal'
import { getRevertedCheckpointNames } from '../../utils/reverted-checkpoints'
import type {
  RestorePreviewResult,
  RestorePlan,
  RestoreFileChange,
  OrphanFile,
  CheckpointSummary
} from '../../../../shared/types'

afterEach(cleanup)

// ─── Fixtures ──────────────────────────────────────────────────────────────

const CHANGES: RestoreFileChange[] = [
  { relativePath: 'src/a.ts', status: 'modified', addedLines: 2, removedLines: 1 },
  { relativePath: 'src/novo.ts', status: 'created', addedLines: 5, removedLines: 0 }
]

const ORPHAN: OrphanFile = {
  relativePath: 'src/orfao.ts',
  originCheckpointId: 'cp-origem',
  originCheckpointName: 'CP Origem'
}

function makePlan(overrides: Partial<RestorePlan> = {}): RestorePlan {
  return {
    targetCheckpointId: 'cp-alvo',
    targetCheckpointName: 'CP Alvo',
    repoPath: '/repo/teste',
    filesToWrite: [],
    orphanFiles: [],
    currentRestorePoint: null,
    canRestore: [],
    cannotRestore: [],
    fileChanges: [],
    stateHash: 'hash-alvo',
    createdAt: 1000,
    ...overrides
  }
}

function makePreview(planOverrides: Partial<RestorePlan> = {}): RestorePreviewResult {
  return { plan: makePlan(planOverrides) }
}

/** Renderiza o RestoreModal com defaults seguros e espiões, permitindo overrides por teste. */
function setup(overrides: Partial<React.ComponentProps<typeof RestoreModal>> = {}) {
  const onClose = vi.fn()
  const onConfirm = vi.fn()
  const props: React.ComponentProps<typeof RestoreModal> = {
    isOpen: true,
    onClose,
    onConfirm,
    preview: makePreview(),
    checkpointName: 'CP Alvo',
    revertedCheckpointNames: [],
    isExecuting: false,
    ...overrides
  }
  const utils = render(<RestoreModal {...props} />)
  return { onClose, onConfirm, props, ...utils }
}

function clickRestaurar() {
  fireEvent.click(screen.getByRole('button', { name: 'Restaurar' }))
}

/** Leitura direta do estado checked de um checkbox localizado por rótulo. */
function isChecked(label: RegExp) {
  return (screen.getByLabelText(label) as HTMLInputElement).checked
}

// ─── PA-M01 — Renderização condicional e resistência a crash (regressão) ──

describe('PA-M01 — Renderização condicional e resistência a crash', () => {
  it('fechado: não renderiza nada', () => {
    setup({ isOpen: false })
    expect(screen.queryByRole('heading', { name: 'Confirmar Restauração' })).toBeNull()
  })

  it('aberto com preview null: não renderiza nada', () => {
    setup({ preview: null })
    expect(screen.queryByRole('heading', { name: 'Confirmar Restauração' })).toBeNull()
  })

  it('aberto com preview legado sem plan (regressão do crash): não renderiza nada e não lança', () => {
    // @ts-expect-error simula payload legado sem o campo plan
    setup({ preview: {} })
    expect(screen.queryByRole('heading', { name: 'Confirmar Restauração' })).toBeNull()
  })

  it('aberto com preview válido: título, checkpoint e frase-guia', () => {
    setup()
    expect(screen.getByRole('heading', { name: 'Confirmar Restauração' })).not.toBeNull()
    expect(screen.getByText((_, element) => (
      element?.tagName === 'STRONG' && element.textContent === '"CP Alvo"'
    ))).not.toBeNull()
    expect(screen.getByText('A restauração fará as seguintes alterações:')).not.toBeNull()
  })
})

// ─── PA-M02 — Fidelidade da lista de mudanças ─────────────────────────────

describe('PA-M02 — Fidelidade da lista (só criados/modificados; bloqueados; vazio)', () => {
  it('misto: +2/−1 para modified, badge Criar para created, unchanged ausente', () => {
    setup({
      preview: makePreview({
        fileChanges: [
          ...CHANGES,
          { relativePath: 'src/igual.ts', status: 'unchanged', addedLines: 0, removedLines: 0 }
        ]
      })
    })
    expect(screen.getByText('+2')).not.toBeNull()
    expect(screen.getByText('−1')).not.toBeNull()
    expect(screen.getByText('Criar')).not.toBeNull()
    expect(screen.getByText('src/a.ts')).not.toBeNull()
    expect(screen.queryByText('src/igual.ts')).toBeNull()
  })

  it('modified com contagens null: rótulo "alterado", sem +0/−0', () => {
    setup({
      preview: makePreview({
        fileChanges: [{ relativePath: 'g.ts', status: 'modified', addedLines: null, removedLines: null }]
      })
    })
    expect(screen.getByText('alterado')).not.toBeNull()
    expect(screen.queryByText('+0')).toBeNull()
    expect(screen.queryByText('−0')).toBeNull()
  })

  it('modified com contagens 0/0: rótulo "alterado", sem +0/−0', () => {
    setup({
      preview: makePreview({
        fileChanges: [{ relativePath: 'g.ts', status: 'modified', addedLines: 0, removedLines: 0 }]
      })
    })
    expect(screen.getByText('alterado')).not.toBeNull()
    expect(screen.queryByText('+0')).toBeNull()
    expect(screen.queryByText('−0')).toBeNull()
  })

  it('apenas bloqueados: seção com motivo presente e sem estado vazio', () => {
    setup({
      preview: makePreview({
        fileChanges: [{ relativePath: 'x.ts', status: 'blocked', addedLines: null, removedLines: null, reason: 'permissão negada' }]
      })
    })
    expect(screen.getByText('x.ts')).not.toBeNull()
    expect(screen.getByText(/permissão negada/)).not.toBeNull()
    expect(screen.getByText(/Arquivos bloqueados/)).not.toBeNull()
    expect(screen.queryByText('Nenhuma alteração de arquivos.')).toBeNull()
  })

  it('tudo vazio: estado vazio explícito', () => {
    setup({ preview: makePreview({ fileChanges: [] }) })
    expect(screen.getByText('Nenhuma alteração de arquivos.')).not.toBeNull()
  })
})

// ─── PA-M03 — Exclusão de órfãos opt-in ───────────────────────────────────

describe('PA-M03 — Exclusão de órfãos é opt-in', () => {
  it('sem órfãos: sem seção de remanescentes nem checkbox de limpeza', () => {
    setup()
    expect(screen.queryByText(/Arquivos criados após este ponto/)).toBeNull()
    expect(screen.queryByLabelText(/Apagar estes 1 arquivo/)).toBeNull()
  })

  it('com órfãos e limpeza desmarcada: sem badge "será excluído"', () => {
    setup({ preview: makePreview({ orphanFiles: [ORPHAN] }) })
    expect(isChecked(/Apagar estes 1 arquivo/)).toBe(false)
    expect(screen.queryByText('será excluído')).toBeNull()
  })

  it('com órfãos e limpeza marcada: badge "será excluído" e payload de cleanupFiles exato', () => {
    const { onConfirm } = setup({ preview: makePreview({ orphanFiles: [ORPHAN] }) })
    fireEvent.click(screen.getByLabelText(/Apagar estes 1 arquivo/))
    expect(screen.getByText('será excluído')).not.toBeNull()
    clickRestaurar()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0].cleanupFiles).toEqual(['src/orfao.ts'])
  })
})

// ─── PA-M04 — Defaults seguros e reset a cada abertura ────────────────────

describe('PA-M04 — Defaults seguros e reset a cada abertura', () => {
  it('por padrão: backup marcado e limpeza desmarcada', () => {
    setup({ preview: makePreview({ orphanFiles: [ORPHAN] }) })
    expect(isChecked(/Criar backup de segurança/)).toBe(true)
    expect(isChecked(/Apagar estes 1 arquivo/)).toBe(false)
  })

  it('alterar → fechar → reabrir: checkboxes resetam aos defaults', async () => {
    const { rerender, props } = setup({ preview: makePreview({ orphanFiles: [ORPHAN] }) })
    fireEvent.click(screen.getByLabelText(/Criar backup de segurança/))
    fireEvent.click(screen.getByLabelText(/Apagar estes 1 arquivo/))
    expect(isChecked(/Criar backup de segurança/)).toBe(false)

    rerender(<RestoreModal {...props} isOpen={false} />)
    rerender(<RestoreModal {...props} isOpen={true} />)

    await waitFor(() => {
      expect(isChecked(/Criar backup de segurança/)).toBe(true)
      expect(isChecked(/Apagar estes 1 arquivo/)).toBe(false)
    })
  })
})

// ─── PA-M05 — Proteção em execução + fechamento normal ────────────────────

describe('PA-M05 — Proteção em execução e fechamento normal', () => {
  it('executando: ESC, overlay e X não fecham; botões desabilitados e rótulo "Restaurando..."', () => {
    const { onClose } = setup({ isExecuting: true })

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(document.querySelector('.cc-modal-overlay') as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))
    expect(onClose).not.toHaveBeenCalled()

    expect(screen.getByRole('button', { name: 'Restaurando...' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Cancelar' }).disabled).toBe(true)
  })

  it('não executando: ESC, overlay e X fecham; clique no conteúdo não fecha', () => {
    const { onClose } = setup()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(document.querySelector('.cc-modal-content') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(document.querySelector('.cc-modal-overlay') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})

// ─── PA-M06 — Delegação fiel com plano congelado ──────────────────────────

describe('PA-M06 — Delegação fiel com plano congelado', () => {
  it('payload default: backup ligado, cleanup vazio e identidade do plan preservada', () => {
    const { onConfirm, props } = setup()
    clickRestaurar()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    const payload = onConfirm.mock.calls[0][0]
    expect(payload.createSafety).toBe(true)
    expect(payload.cleanupFiles).toEqual([])
    expect(payload.plan).toBe(props.preview!.plan)
  })

  it('backup desmarcado: createSafety false', () => {
    const { onConfirm } = setup()
    fireEvent.click(screen.getByLabelText(/Criar backup de segurança/))
    clickRestaurar()
    expect(onConfirm.mock.calls[0][0].createSafety).toBe(false)
  })

  it('limpeza marcada: cleanupFiles com o caminho do órfão', () => {
    const { onConfirm } = setup({ preview: makePreview({ orphanFiles: [ORPHAN] }) })
    fireEvent.click(screen.getByLabelText(/Apagar estes 1 arquivo/))
    clickRestaurar()
    expect(onConfirm.mock.calls[0][0].cleanupFiles).toEqual(['src/orfao.ts'])
  })
})

// ─── PA-M07 — Pele do design system ──────────────────────────────────────

describe('PA-M07 — Pele do design system', () => {
  it('confirmar é pílula de perigo contornada; cancelar é fantasma', () => {
    setup()
    const confirmar = screen.getByRole('button', { name: 'Restaurar' })
    const cancelar = screen.getByRole('button', { name: 'Cancelar' })
    expect(confirmar.className).toContain('app-pill-btn')
    expect(confirmar.className).toContain('danger-outline')
    expect(cancelar.className).toContain('app-ghost-btn')
  })

  it('X do cabeçalho tem aria-label "Fechar"', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Fechar' })).not.toBeNull()
  })

  it('sem emojis no cabeçalho e no rodapé (regressão)', () => {
    setup()
    const heading = screen.getByRole('heading', { name: 'Confirmar Restauração' })
    expect(heading.textContent).toBe('Confirmar Restauração')
    expect(screen.getByRole('button', { name: 'Cancelar' }).textContent).toBe('Cancelar')
    expect(screen.getByRole('button', { name: 'Restaurar' }).textContent).toBe('Restaurar')
    expect(screen.queryByText(/🔄/)).toBeNull()
  })
})

// ─── PA-M08 — Implementações revertidas ───────────────────────────────────

describe('PA-M08 — Implementações revertidas', () => {
  it('lista não vazia: seção presente e ordem ascendente preservada', () => {
    setup({ revertedCheckpointNames: ['A', 'B'] })
    expect(screen.getByText('Implementações afetadas:')).not.toBeNull()
    const items = Array.from(document.querySelectorAll('.rm-reverted-list li'))
    expect(items.map(li => li.textContent)).toEqual(['A', 'B'])
  })

  it('lista vazia: seção ausente', () => {
    setup({ revertedCheckpointNames: [] })
    expect(screen.queryByText('Implementações afetadas:')).toBeNull()
  })
})

// ─── PA-M09 — Cálculo puro dos revertidos (unitária, sem DOM) ─────────────

function cp(id: string, name: string, createdAt: string): CheckpointSummary {
  return { id, name, createdAt, fileCount: 0, restoredAt: null, hasContent: true }
}

describe('PA-M09 — getRevertedCheckpointNames (unitária)', () => {
  const c1 = cp('c1', 'Um', '2024-01-01T00:00:00Z')
  const c2 = cp('c2', 'Dois', '2024-01-02T00:00:00Z')
  const c3 = cp('c3', 'Tres', '2024-01-03T00:00:00Z')
  const cIgual = cp('cIgual', 'Igual', '2024-01-02T00:00:00Z') // mesmo createdAt de c2

  it('targetId null: retorna vazio', () => {
    expect(getRevertedCheckpointNames([c1, c2], null)).toEqual([])
  })

  it('alvo mais recente: nenhum checkpoint posterior, retorna vazio', () => {
    expect(getRevertedCheckpointNames([c1, c2, c3], 'c3')).toEqual([])
  })

  it('alvo no meio: retorna posteriores ordenados por data, ignorando ordem do input', () => {
    expect(getRevertedCheckpointNames([c3, c1, c2], 'c1')).toEqual(['Dois', 'Tres'])
  })

  it('datas iguais: excluídas (estritamente depois)', () => {
    expect(getRevertedCheckpointNames([c2, cIgual], 'c2')).toEqual([])
  })
})




