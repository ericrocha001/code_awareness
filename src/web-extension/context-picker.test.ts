import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { afterEach, expect, it, vi } from 'vitest'
import type { PickerCatalog, PickerRequest } from '../shared/web-activation/context-picker-contract'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('ignores stale searches and preserves selections and actions while estimating', async () => {
  vi.useFakeTimers()
  const { window } = new JSDOM(readFileSync(new URL('./context-picker.html', import.meta.url), 'utf8'), {
    url: 'https://extension.example/context-picker.html'
  })
  const { document } = window
  for (const key of ['document', 'location', 'FormData', 'Option', 'HTMLButtonElement'] as const) {
    vi.stubGlobal(key, window[key])
  }
  vi.stubGlobal('window', window)
  const pending: Array<{ request: PickerRequest; respond: (value: unknown) => void }> = []
  vi.stubGlobal('chrome', { runtime: { sendMessage: (value: { request: PickerRequest }, respond: (result: unknown) => void) => {
    pending.push({ request: value.request, respond })
  } } })
  const scope = { repositoryId: 'repo', binding: 'binding' }
  const page = (name: string, nextCursor?: string): PickerCatalog => ({
    scope, projectName: 'Projeto A', artifacts: [{ artifactId: name, name, revision: 1, kind: 'DOCUMENT' }],
    tags: [{ slug: 'arquitetura', name: 'Arquitetura' }],
    nextCursor
  })
  const respond = async (index: number, value: unknown) => {
    pending[index].respond(value)
    await Promise.resolve()
  }
  const input = document.querySelector<HTMLInputElement>('[name=query]')!
  const search = (value: string) => {
    input.value = value
    input.dispatchEvent(new window.Event('input'))
  }
  await import('./context-picker')
  window.dispatchEvent(new window.MessageEvent('message', {
    source: window as unknown as Window, data: { type: 'PICKER_PANEL_READY' }
  }))
  await respond(0, { ok: true, result: page('Primeiro') })
  document.querySelector<HTMLInputElement>('#results input')!.click()
  expect(document.querySelector<HTMLButtonElement>('#copy')!.disabled).toBe(false)
  expect(document.querySelector('#preview')!.textContent).toBe('Calculando…')
  search('a')
  search('ab')
  await vi.advanceTimersByTimeAsync(250)
  expect(pending[2].request).toMatchObject({ filters: { query: 'ab' } })
  search('abc')
  await vi.advanceTimersByTimeAsync(250)
  await respond(3, { ok: true, result: page('Atual') })
  await respond(2, { ok: true, result: page('Obsoleto') })
  await respond(1, { ok: false, error: { code: 'TIMEOUT', message: 'TIMEOUT' } })
  expect(document.querySelector('#results')!.textContent).toContain('Atual')
  expect(document.querySelector('#results')!.textContent).not.toContain('Obsoleto')
  expect(document.querySelector('#selected')!.textContent).toContain('Primeiro')
  expect(document.querySelector('#preview')!.textContent).toBe('Estimativa indisponível')
  expect(document.querySelector<HTMLButtonElement>('#copy')!.disabled).toBe(false)
  expect(input.disabled).toBe(false)
  const tag = document.querySelector<HTMLSelectElement>('[name=tag]')!
  tag.value = 'arquitetura'
  tag.dispatchEvent(new window.Event('change'))
  expect(pending[4].request).toMatchObject({ filters: { query: 'abc', tag: 'arquitetura' } })
  await respond(4, { ok: true, result: page('Filtrado') })
  expect(document.querySelector('#results')!.textContent).toContain('Filtrado')
  expect(document.querySelector('#selected')!.textContent).toContain('Primeiro')
  window.close()
})
