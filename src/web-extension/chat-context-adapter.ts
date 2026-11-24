import type { ContextPickerSite } from '../shared/web-activation/context-picker-sites'

import type { DraftOutcome } from '../shared/web-activation/context-picker-contract'

interface ChatContextAdapter {
  findComposer(document: Document): HTMLElement | null
}

const adapters: Partial<Record<ContextPickerSite, ChatContextAdapter>> = {
  chatgpt: {
    findComposer(document) {
      const candidates = [...document.querySelectorAll<HTMLElement>('#prompt-textarea[contenteditable="true"]')]
        .filter(element => element.getClientRects().length > 0 && !element.closest('[inert], [aria-disabled="true"], [hidden]'))
      return candidates.length === 1 ? candidates[0] : null
    }
  }
}

export async function insertDraftText(
  site: ContextPickerSite,
  document: Document,
  markdown: string,
  isCurrent: () => boolean
): Promise<DraftOutcome> {
  const unavailable = (reason: string): DraftOutcome => ({ outcome: 'unavailable', reason })
  const adapter = adapters[site]
  if (!adapter) return unavailable('Automatic insertion is unavailable on this site.')
  const composer = adapter.findComposer(document)
  if (!composer || !markdown || !isCurrent()) return unavailable('No unique editable composer in the current conversation.')

  const priorText = composer.innerText
  const normalized = markdown.replace(/\r\n?/g, '\n')
  const text = priorText.trim() ? `\n\n${normalized}` : normalized
  const selection = document.getSelection()
  if (!selection) return unavailable('The browser selection is unavailable.')
  const range = document.createRange()
  composer.focus({ preventScroll: true })
  if (adapter.findComposer(document) !== composer || !isCurrent() ||
    composer.innerText !== priorText || document.activeElement !== composer) {
    return unavailable('The composer changed before insertion.')
  }
  range.selectNodeContents(composer)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)

  try {
    const fragment = document.createElement('div')
    for (const [index, line] of text.split('\n').entries()) {
      if (index) fragment.append(document.createElement('br'))
      fragment.append(document.createTextNode(line))
    }
    document.execCommand('insertHTML', false, fragment.innerHTML)
  } catch {
    return { outcome: 'uncertain', reason: 'Check the draft before trying again.' }
  }
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  if (!isCurrent() || adapter.findComposer(document) !== composer ||
    !composer.innerText.startsWith(priorText.trim() ? priorText : '') ||
    !composer.innerText.endsWith(normalized)) {
    return { outcome: 'uncertain', reason: 'The editor did not confirm the exact appended text. Check the draft before trying again.' }
  }
  return { outcome: 'inserted' }
}
