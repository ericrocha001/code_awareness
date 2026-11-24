import { JSDOM } from 'jsdom'
import { afterEach, expect, it, vi } from 'vitest'
import { attachChatGptFiles } from './chatgpt-attachments'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const files = [
  { name: 'A.md', type: 'text/markdown' as const, encoded: 'IyBB' },
  { name: 'B.md', type: 'text/markdown' as const, encoded: 'IyBC' }
]

function composerFixture(control = '<input type="file" multiple accept=".md">') {
  const { window } = new JSDOM(`<form><div id="prompt-textarea" contenteditable="true">rascunho</div>${control}<span data-testid="composer-attachment">original.md</span><button>Enviar</button></form>`)
  const document = window.document
  const editor = document.querySelector<HTMLElement>('#prompt-textarea')!
  Object.defineProperty(editor, 'innerText', { get: () => editor.textContent })
  window.HTMLElement.prototype.getClientRects = () => [{ width: 1 }] as unknown as DOMRectList
  vi.stubGlobal('Event', window.Event)
  vi.stubGlobal('DataTransfer', class {
    files: File[] = []
    items = { add: (file: File) => this.files.push(file) }
  })
  let attached: File[] = []
  const input = document.querySelector<HTMLInputElement>('input')!
  Object.defineProperty(input, 'files', { get: () => attached, set: (value: File[]) => { attached = value } })
  const change = vi.fn()
  input.addEventListener('change', change)
  return { document, editor, change, input, attached: () => attached }
}

it('keeps the draft and existing attachments and confirms only accepted new chips', async () => {
  vi.useFakeTimers()
  const fixture = composerFixture()
  fixture.input.addEventListener('change', () => {
    const chip = fixture.document.createElement('span')
    chip.dataset.testid = 'composer-attachment'
    chip.textContent = 'A.md'
    fixture.input.after(chip)
  })
  const outcome = attachChatGptFiles(fixture.document, files, () => true)
  await vi.advanceTimersByTimeAsync(5000)
  await expect(outcome).resolves.toEqual({ outcome: 'partial', confirmed: ['A.md'], pending: ['B.md'] })
  expect(fixture.change).toHaveBeenCalledOnce()
  expect(fixture.editor.textContent).toBe('rascunho')
  expect(fixture.document.querySelector('form')!.textContent).toContain('original.md')
  expect(await Promise.all(fixture.attached().map(file => file.text()))).toEqual(['# A', '# B'])
})

it('rejects an ambiguous upload field or a changed conversation before any effect', async () => {
  const ambiguous = composerFixture('<input type="file" multiple><input type="file" multiple>')
  const changed = composerFixture()
  await expect(attachChatGptFiles(ambiguous.document, files, () => true)).resolves.toMatchObject({ outcome: 'unavailable' })
  const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
  await expect(attachChatGptFiles(changed.document, files, isCurrent)).resolves.toMatchObject({ outcome: 'unavailable' })
  expect(ambiguous.change).not.toHaveBeenCalled()
  expect(changed.change).not.toHaveBeenCalled()
})

it('distinguishes an explicit rejection from an unconfirmed upload', async () => {
  const fixture = composerFixture()
  fixture.input.addEventListener('change', () => {
    const chip = fixture.document.createElement('span')
    chip.dataset.testid = 'composer-attachment'
    chip.setAttribute('aria-invalid', 'true')
    chip.title = 'A.md'
    fixture.input.after(chip)
  })
  await expect(attachChatGptFiles(fixture.document, [files[0]], () => true))
    .resolves.toEqual({ outcome: 'failed', confirmed: [], pending: [], failed: ['A.md'] })
})
