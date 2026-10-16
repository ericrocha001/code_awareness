import type { AppSettings } from '@shared/types'

let pending: Promise<unknown> = Promise.resolve()

export function updateSettings(change: (current: AppSettings) => AppSettings): Promise<AppSettings> {
  const operation = pending.then(async () => {
    const settings = change(await window.codeAwareness.loadSettings())
    const result = await window.codeAwareness.saveSettings(settings)
    if (!result.success) throw new Error('Falha ao salvar configurações')
    return settings
  })
  pending = operation.catch(() => {})
  return operation
}
