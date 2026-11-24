export const contextPickerSites = {
  chatgpt: 'https://chatgpt.com',
  claude: 'https://claude.ai',
  gemini: 'https://gemini.google.com',
  deepseek: 'https://chat.deepseek.com',
  qwen: 'https://chat.qwen.ai'
} as const

export type ContextPickerSite = keyof typeof contextPickerSites

export function contextPickerSite(href?: string): ContextPickerSite | undefined {
  if (!href) return undefined
  let origin: string
  try {
    origin = new URL(href).origin
  } catch {
    return undefined
  }
  return (Object.keys(contextPickerSites) as ContextPickerSite[]).find(
    (site) => contextPickerSites[site] === origin
  )
}

export function supportsDraftInsertion(site: ContextPickerSite): boolean {
  return site === 'chatgpt'
}
