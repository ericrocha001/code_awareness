import { expect, it, vi } from 'vitest'
import { PickerRouter } from './context-picker-router'

const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const href = 'https://chatgpt.com/c/first'
const tab = { id: 1, url: href }
const top = { id, tab, frameId: 0, url: href }
const frame = { id, tab, frameId: 2, documentId: 'panel', url: `chrome-extension://${id}/context-picker.html`, origin: `chrome-extension://${id}` }
const challenge = '12345678-1234-1234-1234-123456789abc'

it('binds the private picker to the tab and extension document without sharing authority with the page', async () => {
  const native = vi.fn(async () => ({ ok: true, result: 'private' }))
  const router = new PickerRouter(id, native)
  const read = { type: 'PICKER_REQUEST', challenge, request: { action: 'catalog', filters: {} } } as const
  expect(await router.handle(read, top)).toMatchObject({ ok: false })
  expect(await router.handle(read, frame)).toMatchObject({ ok: false })
  expect(await router.handle({ type: 'PICKER_BIND', challenge }, frame)).toMatchObject({ ok: false })
  expect(await router.handle({ type: 'PICKER_BIND', challenge }, top)).toEqual({ ok: true })
  expect(await router.handle(read, { ...frame, origin: 'https://chatgpt.com' })).toMatchObject({ ok: false })
  expect(await router.handle(read, frame)).toEqual({ ok: true, result: 'private' })
  expect(await router.handle(read, { ...frame, documentId: 'other' })).toMatchObject({ ok: false })
  expect(await router.handle(read, { ...frame, tab: { ...tab, url: 'https://chatgpt.com/c/second' } })).toMatchObject({ ok: false })
  expect(await router.handle({ type: 'PICKER_CLOSE', challenge }, top)).toEqual({ ok: true })
  expect(await router.handle(read, frame)).toMatchObject({ ok: false })
  expect(native).toHaveBeenCalledExactlyOnceWith('https://chatgpt.com', read.request)
})

it('returns only the draft outcome, and declines repetitions after uncertain delivery', async () => {
  const native = vi.fn(async () => ({ ok: true, result: { markdown: '# Private document' } }))
  const insertion = vi.fn(async () => ({ outcome: 'uncertain' }))
  const router = new PickerRouter(id, native, insertion)
  await router.handle({ type: 'PICKER_BIND', challenge }, { ...top, documentId: 'top' })
  const message = {
    type: 'PICKER_REQUEST', challenge,
    request: {
      action: 'text', scope: { repositoryId: 'repo', binding: 'project' },
      selected: [{ artifactId: 'a', expectedRevision: 1 }]
    }
  } as const
  const action = { ...message, request: { ...message.request, selected: [...message.request.selected] } }
  expect(await router.handle(action, frame)).toEqual({ ok: true, result: { outcome: 'uncertain' } })
  expect(insertion).toHaveBeenCalledExactlyOnceWith(1, 'top', href, challenge, '# Private document')
  expect(await router.handle(action, frame)).toMatchObject({ ok: false })
  expect(native).toHaveBeenCalledOnce()
})
