// @vitest-environment jsdom
import React, { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Button } from './Button/Button'
import { ContextHelp } from './ContextHelp/ContextHelp'
import { SelectField } from './SelectField/SelectField'
import { ActionMenu } from './ActionMenu/ActionMenu'
import { FilterPopover } from './FilterPopover/FilterPopover'

afterEach(cleanup)

describe('opt-in UI primitives', () => {
  it('preserves legacy Button classes, ref, default type and disabled behavior', () => {
    const ref = createRef<HTMLButtonElement>(), click = vi.fn()
    render(<Button ref={ref} variant="ghost" className="sm" disabled onClick={click}>Legado</Button>)
    expect(ref.current?.className).toBe('app-ghost-btn sm')
    expect(ref.current?.type).toBe('button')
    fireEvent.click(ref.current!)
    expect(click).not.toHaveBeenCalled()
  })

  it('exposes selected, named icon, semantic intent and comfortable opt-in variants', () => {
    render(<><Button variant="outline" intent="danger" selected>Excluir seleção</Button>
      <Button variant="solid" intent="primary" iconOnly aria-label="Adicionar" icon={<svg />} /></>)
    const selected = screen.getByRole('button', { name: 'Excluir seleção' })
    expect(selected.getAttribute('aria-pressed')).toBe('true')
    expect(selected.className).toContain('ui-button--danger')
    expect(screen.getByRole('button', { name: 'Adicionar' }).className).toContain('ui-button--icon')
  })

  it('opens help, transfers focus, preserves editing arrows and scopes Escape', async () => {
    const outerKey = vi.fn()
    render(<div onKeyDown={outerKey}><ContextHelp label="Ajuda sobre destino" hint="Escolha onde salvar.">
      <input aria-label="Pesquisar ajuda" /><a href="#detalhes">Detalhes</a>
    </ContextHelp><input aria-label="Fora" /></div>)
    const trigger = screen.getByRole('button', { name: 'Ajuda sobre destino' })
    fireEvent.focus(trigger)
    expect(screen.getByRole('tooltip').textContent).toContain('Escolha')
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Ajuda sobre destino' })
    await waitFor(() => expect(document.activeElement).toBe(dialog))
    expect(trigger.getAttribute('aria-controls')).toBe(dialog.id)
    for (const name of ['Pesquisar ajuda', 'Fora']) {
      const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      expect(screen.getByRole('textbox', { name }).dispatchEvent(event)).toBe(true)
    }
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Fora' }), { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    outerKey.mockClear()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(outerKey).not.toHaveBeenCalled()
  })

  it('closes help outside without stealing focus, and closes on keyboard exit', async () => {
    render(<><ContextHelp label="Sobre o campo"><p>Explicação</p></ContextHelp><button>Próximo</button></>)
    const trigger = screen.getByRole('button', { name: 'Sobre o campo' }), next = screen.getByRole('button', { name: 'Próximo' })
    fireEvent.click(trigger)
    fireEvent.mouseDown(next)
    act(() => next.focus())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(next)
    fireEvent.click(trigger)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('dialog')))
    act(() => next.focus())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps select native, labelled, controlled, described and invalid when needed', () => {
    const change = vi.fn(), ref = createRef<HTMLSelectElement>()
    render(<SelectField ref={ref} label="Destino do arquivo" description="Somente nesta execução" error="Selecione um destino" defaultValue="local" onChange={change}>
      <option value="local">Local</option><option value="temp">Temporário</option>
    </SelectField>)
    const select = screen.getByRole('combobox', { name: 'Destino do arquivo' })
    expect(select).toBe(ref.current)
    expect(select.getAttribute('aria-invalid')).toBe('true')
    expect(select.getAttribute('aria-describedby')?.split(' ').every(id => document.getElementById(id))).toBe(true)
    fireEvent.change(select, { target: { value: 'temp' } })
    expect(ref.current?.value).toBe('temp')
    expect(change).toHaveBeenCalledOnce()
  })

  it.each(['action', 'filter'])('preserves %s menu navigation guard, selection and closing', kind => {
    render(kind === 'action'
      ? <ActionMenu icon={<svg />} label="Ações"><button role="menuitem">Aplicar</button></ActionMenu>
      : <FilterPopover activeCount={1} closeOnSelect><button role="menuitem">Aplicar</button></FilterPopover>)
    fireEvent.click(screen.getByRole('button', { name: kind === 'action' ? 'Ações' : 'Filtros (1 ativo)' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    const arrow = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    expect(document.body.dispatchEvent(arrow)).toBe(false)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Aplicar' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
