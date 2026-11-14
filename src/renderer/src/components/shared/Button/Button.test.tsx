// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Button } from './Button'

afterEach(cleanup)

describe('Button busy state', () => {
  it('keeps the idle contract unchanged', () => {
    const onClick = vi.fn()
    render(<Button variant="outline" icon={<svg data-testid="icon" />} onClick={onClick}>Baixar</Button>)
    const button = screen.getByRole('button', { name: 'Baixar' })
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(button.getAttribute('aria-busy')).toBeNull()
    expect(button.getAttribute('aria-disabled')).toBeNull()
    expect(screen.getByTestId('icon')).toBeTruthy()
  })

  it('exposes controlled pending semantics, replaces the icon in place and blocks repeated clicks', () => {
    const onClick = vi.fn()
    const { container } = render(
      <Button variant="outline" icon={<svg data-testid="icon" />} busy busyLabel="Baixando" onClick={onClick}>Baixar</Button>
    )
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(screen.queryByTestId('icon')).toBeNull()
    expect(container.querySelector('.btn-spinner')?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Baixando')
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('stays keyboard-focusable while busy and resumes when the caller clears the state', () => {
    const onClick = vi.fn()
    const { rerender } = render(<Button busy onClick={onClick}>Salvar</Button>)
    const button = screen.getByRole('button', { name: 'Salvar' })
    button.focus()
    expect(document.activeElement).toBe(button)
    rerender(<Button onClick={onClick}>Salvar</Button>)
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('respects reduced motion and the shared design tokens in the stylesheet', () => {
    const css = readFileSync(join(__dirname, 'Button.css'), 'utf8')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.btn-spinner\s*\{[^}]*animation: none/)
    expect(css).toMatch(/\.btn-spinner\s*\{[^}]*border: 2px solid currentColor/)
    expect(css).not.toMatch(/\.btn-spinner[^{]*\{[^}]*#[0-9a-fA-F]{3,6}/)
  })

  it('prevents native form submit via click and keyboard while busy, then allows submit again once ready', () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    const onClick = vi.fn()
    const { rerender } = render(
      <form onSubmit={onSubmit}>
        <Button type="submit" busy busyLabel="Salvando" onClick={onClick}>Salvar</Button>
      </form>
    )
    const button = screen.getByRole('button')
    expect(fireEvent.click(button)).toBe(false)
    expect(fireEvent.keyDown(button, { key: 'Enter' })).toBe(false)
    expect(fireEvent.keyDown(button, { key: ' ' })).toBe(false)
    expect(onClick).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()

    const Harness = () => {
      const [pending, setPending] = React.useState(false)
      return (
        <form onSubmit={event => { event.preventDefault(); onSubmit(event); setPending(true) }}>
          <Button type="submit" busy={pending} busyLabel="Salvando" onClick={onClick}>Enviar</Button>
        </form>
      )
    }
    rerender(<Harness />)
    const submitButton = screen.getByRole('button')
    fireEvent.click(submitButton)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(fireEvent.click(submitButton)).toBe(false)
    expect(fireEvent.keyDown(submitButton, { key: 'Enter' })).toBe(false)
    expect(onSubmit).toHaveBeenCalledTimes(1)

    rerender(
      <form onSubmit={onSubmit}>
        <Button type="submit" busy={false} onClick={onClick}>Enviar</Button>
      </form>
    )
    fireEvent.click(screen.getByRole('button'))
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })
})
