// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeDashView } from './CodeDashView'
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
