import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { insertDraftText } from './chat-context-adapter'

function fixture(duplicate = false) {
  const composer = '<div id="prompt-textarea" tabindex="0" contenteditable="true">Prior draft</div>'
  const { window } = new JSDOM(`<div aria-label="Existing attachment">example.md</div>${composer}${duplicate ? composer : ''}<button>Send</button>`)
  const { document } = window
  for (const element of document.querySelectorAll<HTMLElement>('[contenteditable]')) {
    Object.defineProperty(element, 'innerText', { get: () => element.textContent })
    vi.spyOn(element, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
  }
  const exec = vi.fn((_command: string, _ui: boolean, html: string) => {
    const fragment = document.createElement('div')
    fragment.innerHTML = html
    const text = Array.from(fragment.childNodes, node => node.nodeName === 'BR' ? '\n' : node.textContent).join('')
    const range = document.getSelection()!.getRangeAt(0)
    range.insertNode(document.createTextNode(text))
    return true
  })
  Object.defineProperty(document, 'execCommand', { value: exec })
  return { document, exec }
}

it('appends selected Markdown to the current composer while preserving the draft and attachments', async () => {
  const { document, exec } = fixture()
  const send = vi.fn()
  document.querySelector('button')!.addEventListener('click', send)
  const markdown = '# Selected\n\n  literal text'
  await expect(insertDraftText('chatgpt', document, markdown, () => true)).resolves.toEqual({ outcome: 'inserted' })
  expect(document.querySelector('#prompt-textarea')?.textContent).toBe(`Prior draft\n\n${markdown}`)
  expect(document.querySelector('[aria-label="Existing attachment"]')?.textContent).toBe('example.md')
  expect(exec).toHaveBeenCalledOnce()
  expect(send).not.toHaveBeenCalled()
})

it('refuses ambiguous and changed destinations before modifying any draft', async () => {
  const ambiguous = fixture(true)
  await expect(insertDraftText('chatgpt', ambiguous.document, 'Context', () => true))
    .resolves.toMatchObject({ outcome: 'unavailable' })
  const changing = fixture()
  const current = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
  await expect(insertDraftText('chatgpt', changing.document, 'Context', current))
    .resolves.toMatchObject({ outcome: 'unavailable' })
  expect(ambiguous.exec).not.toHaveBeenCalled()
  expect(changing.exec).not.toHaveBeenCalled()
})

it('reports uncertain editor effects without retry when insertion cannot be observed', async () => {
  const { document, exec } = fixture()
  exec.mockReturnValue(false)
  await expect(insertDraftText('chatgpt', document, 'Context', () => true))
    .resolves.toMatchObject({ outcome: 'uncertain' })
  expect(exec).toHaveBeenCalledOnce()
})
