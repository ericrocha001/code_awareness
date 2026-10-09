// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeDashView } from './CodeDashView'
import { DashCodeSurface } from './DashCodeSurface'
afterEach(cleanup)
describe('single execution and exact copy', () => {
  it('executes once and copies only context', async () => {
    const context = '[{"name":"Sync"}]'
    const execute = vi.fn(async () => ({
      success: true,
      context,
      tokenCount: 8,
      report: { steps: [{ id: 'x', type: 'element-set', count: 1 }] }
    }))
    Object.defineProperty(window, 'codeAwareness', {
      configurable: true,
      value: { dashExecute: execute }
    })
    const copy = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: copy }
    })
    render(<CodeDashView repoPath="repo" />)
    expect(screen.queryByText(/XML|L1|L2|Compression/i)).toBeNull()
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '{"protocol":"code-dash/v2"}' }
    })
    fireEvent.click(screen.getByText('Gerar contexto'))
    await screen.findByText('Copiar contexto')
    fireEvent.click(screen.getByText('Copiar contexto'))
    await waitFor(() => expect(copy).toHaveBeenCalledWith(context))
    expect(execute).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Relatório de resolução').textContent).toContain('x: 1')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new' } })
    expect(screen.queryByLabelText('Context Packet')).toBeNull()
  })
  it('failure exposes report and no copyable packet', async () => {
    Object.defineProperty(window, 'codeAwareness', {
      configurable: true,
      value: {
        dashExecute: async () => ({
          success: false,
          report: {
            steps: [],
            error: { code: 'CARDINALITY_MISMATCH', message: 'Too many matches' }
          }
        })
      }
    })
    render(<CodeDashView repoPath="repo" />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{}' } })
    fireEvent.click(screen.getByText('Gerar contexto'))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText('Copiar contexto')).toBeNull()
    expect(screen.queryByLabelText('Context Packet')).toBeNull()
  })
})

describe('Signal states and literal code surfaces', () => {
  const success = {
    success: true as const,
    context: '[{"source":"literal <>& 🚀\\r\\n","name":"Sync"}]\r\n',
    tokenCount: 37,
    report: { steps: [{ id: 'target', type: 'element-set' as const, count: 1 }] }
  }
  const setup = (execute = vi.fn(async () => success), copy = vi.fn(async () => {})) => {
    Object.defineProperty(window, 'codeAwareness', {
      configurable: true,
      value: { dashExecute: execute }
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: copy }
    })
    return { execute, copy }
  }
  const submit = () => {
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '{\n  "protocol": "code-dash/v2"\n}' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Gerar contexto' }))
  }
  it('has a truthful no-project state and no execution control', () => {
    setup()
    render(<CodeDashView />)
    expect(screen.getByText('Selecione um projeto para usar o Code Dash.')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByText('Solicitação resolvida')).toBeNull()
  })
  it('shows loading only during execution, disables controls and rejects a stale project response', async () => {
    let resolve!: (value: typeof success) => void
    const execute = vi.fn(
      () =>
        new Promise<typeof success>((done) => {
          resolve = done
        })
    )
    setup(execute)
    const view = render(<CodeDashView repoPath="first" />)
    expect(
      (screen.getByRole('button', { name: 'Gerar contexto' }) as HTMLButtonElement).disabled
    ).toBe(true)
    submit()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Limpar' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(screen.getByText('Resolvendo solicitação…')).toBeTruthy()
    view.rerender(<CodeDashView repoPath="second" />)
    resolve(success)
    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false)
    )
    expect(screen.queryByLabelText('Context Packet')).toBeNull()
    expect(execute).toHaveBeenCalledExactlyOnceWith('{\n  "protocol": "code-dash/v2"\n}', 'first')
  })
  it('keeps literal preview/clipboard, real metadata and clear semantics', async () => {
    const { copy } = setup()
    render(<CodeDashView repoPath="repo" projectName="A long project" />)
    submit()
    const preview = await screen.findByLabelText('Context Packet')
    expect(preview.textContent).toBe(success.context)
    expect(preview.querySelector('.dash-token-property')).toBeTruthy()
    expect(screen.getByText('37 tokens')).toBeTruthy()
    expect(screen.getByText('target: 1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copiar contexto' }))
    await screen.findByRole('button', { name: 'Contexto copiado' })
    expect(copy).toHaveBeenCalledExactlyOnceWith(success.context)
    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
    expect(screen.queryByLabelText('Context Packet')).toBeNull()
    expect(screen.queryByText('Solicitação resolvida')).toBeNull()
  })
  it('never announces success for a failed or stale clipboard completion', async () => {
    const copy = vi.fn(async (): Promise<void> => {
      throw new Error('Denied')
    })
    setup(undefined, copy)
    const view = render(<CodeDashView repoPath="repo" />)
    submit()
    fireEvent.click(await screen.findByRole('button', { name: 'Copiar contexto' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Não foi possível copiar o contexto. Tente novamente.'
    )
    expect(screen.queryByRole('button', { name: 'Contexto copiado' })).toBeNull()
    let done!: () => void
    copy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          done = resolve
        })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copiar contexto' }))
    view.rerender(<CodeDashView repoPath="other" />)
    done()
    await waitFor(() => expect(screen.queryByLabelText('Context Packet')).toBeNull())
    submit()
    await screen.findByRole('button', { name: 'Copiar contexto' })
    expect(screen.queryByRole('button', { name: 'Contexto copiado' })).toBeNull()
  })
  it('keeps editing and IME in the native textarea, with safe fallback for large payloads', () => {
    const change = vi.fn()
    const value = '{\n  "source": "<>🚀\\n"\n}\n'
    const view = render(<DashCodeSurface value={value} onChange={change} />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(input.value).toBe(value)
    fireEvent.compositionStart(input)
    expect(view.container.querySelector('.dash-code-overlay')).toBeNull()
    fireEvent.change(input, { target: { value: '日本語' } })
    expect(change).toHaveBeenCalledWith('日本語')
    fireEvent.compositionEnd(input)
    expect(view.container.querySelector('.dash-code-overlay')).toBeTruthy()
    const large = '["' + 'large<>🚀'.repeat(25_000) + '"]\r\n日本語\n'
    view.rerender(<DashCodeSurface value={large} />)
    expect(screen.getByLabelText('Context Packet').textContent).toBe(large)
    expect(view.container.querySelector('.dash-token-string')).toBeNull()
    expect(view.container.querySelector('.dash-line-numbers')).toBeNull()
  })
})
