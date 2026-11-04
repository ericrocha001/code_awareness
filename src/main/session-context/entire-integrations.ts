export interface EntireIntegration { agent: string; surface: 'CLI' | 'AGENT'; hooks: 'READY' | 'HOOKS_MISSING' }
export function parseEntireAgentList(text: string): EntireIntegration[] {
  const lines = text.replace(/\r/g, '').trimEnd().split('\n')
  if (lines.shift() !== 'Agents:') throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
  const integrations: EntireIntegration[] = []
  for (const line of lines) {
    if (!line || line === "No agents installed. Use 'entire agent add <name>' to install hooks.") continue
    const match = line.match(/^  (✓ |  )([a-z][a-z0-9-]{0,79})$/)
    if (!match || integrations.some(item => item.agent === match[2])) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
    integrations.push({ agent: match[2], surface: match[2] === 'antigravity' ? 'CLI' : 'AGENT', hooks: match[1] === '✓ ' ? 'READY' : 'HOOKS_MISSING' })
  }
  if (!integrations.length) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
  return integrations
}
export interface EntireCapture { configured: boolean; reason: string; providerSessionId?: string; agent?: string; integrations?: EntireIntegration[] }
