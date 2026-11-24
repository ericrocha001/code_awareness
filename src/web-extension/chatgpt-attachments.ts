import type { PickerAttachment, PickerFile } from '../shared/web-activation/context-picker-contract'

export async function attachChatGptFiles(
  document: Document,
  files: PickerFile[],
  isCurrent: () => boolean
): Promise<PickerAttachment> {
  const names = files.map(file => file.name)
  const unavailable: PickerAttachment = { outcome: 'unavailable', confirmed: [], pending: names }
  const composers = [...document.querySelectorAll<HTMLElement>('#prompt-textarea[contenteditable="true"]')]
    .filter(element => element.getClientRects().length > 0 && !element.closest('[inert], [aria-disabled="true"], [hidden]'))
  if (composers.length !== 1 || !isCurrent() || !files.length || new Set(names).size !== names.length) return unavailable
  const composer = composers[0]
  const form = composer.closest('form')
  if (!form) return unavailable

  const inputs = [...form.querySelectorAll<HTMLInputElement>('input[type="file"]:enabled')]
    .filter(input => {
      const accept = input.accept.split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
      return !accept.length || accept.some(value => ['.md', 'text/markdown', 'text/*', '*/*'].includes(value))
    })
  const input = inputs[0]
  if (inputs.length !== 1 || !input || input.files?.length || (files.length > 1 && !input.multiple)) return unavailable

  const attachmentSelector = '[data-testid="composer-attachment"], [data-testid="file-thumbnail"], [data-testid="attachment"]'
  const currentChips = () => [...form.querySelectorAll<HTMLElement>(attachmentSelector)]
  const initial = new Set(currentChips())
  const chipMatches = (element: HTMLElement, name: string) =>
    element.title === name || element.textContent?.trim() === name ||
    [...element.querySelectorAll<HTMLElement>('[title]')].some(child => child.title === name)
  if (names.some(name => [...initial].some(chip => chipMatches(chip, name)))) return unavailable

  const transfer = new DataTransfer()
  try {
    for (const item of files) {
      if (item.type !== 'text/markdown' || !item.name.endsWith('.md')) return unavailable
      const bytes = Uint8Array.from(atob(item.encoded), character => character.charCodeAt(0))
      transfer.items.add(new File([bytes], item.name, { type: item.type }))
    }
  } catch {
    return unavailable
  }

  if (!isCurrent() || !input.isConnected || !composer.isConnected || composer.closest('form') !== form || input.form !== form) return unavailable
  try {
    input.files = transfer.files
  } catch {
    return unavailable
  }
  if (input.files?.length !== files.length) return unavailable

  const report = (confirmed: string[], failed: string[] = []): PickerAttachment => ({
    outcome: confirmed.length === names.length ? 'attached' : confirmed.length ? 'partial' : failed.length === names.length ? 'failed' : 'uncertain',
    confirmed,
    pending: names.filter(name => !confirmed.includes(name) && !failed.includes(name)),
    ...(failed.length ? { failed } : {})
  })
  const beforeText = composer.innerText
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
  let confirmed: string[] = []
  let failed: string[] = []
  const deadline = Date.now() + 5000
  do {
    if (!isCurrent() || !composer.isConnected || composer.innerText !== beforeText) return report([])
    const candidates = currentChips().filter(chip => !initial.has(chip) && chip.getClientRects().length > 0)
    const newChips = candidates.filter(chip =>
      !chip.matches('[aria-busy="true"], [aria-invalid="true"]') &&
      !chip.querySelector('progress, [role="progressbar"], [aria-busy="true"], [aria-invalid="true"]')
    )
    confirmed = names.filter(name => newChips.some(chip => chipMatches(chip, name)))
    failed = names.filter(name => !confirmed.includes(name) && candidates.some(chip =>
      chipMatches(chip, name) && (chip.getAttribute('aria-invalid') === 'true' || Boolean(chip.querySelector('[aria-invalid="true"]')))
    ))
    if (confirmed.length + failed.length === names.length) return report(confirmed, failed)
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  return report(confirmed, failed)
}
