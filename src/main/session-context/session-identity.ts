export function sessionIdentity(provider: string, providerId: string, agent = 'codex'): string {
  return provider === 'entire' && agent !== 'codex' ? `entire-agent:${agent}:${providerId}` : `${provider}:${providerId}`
}
export function sessionSelector(identity: string): { provider: string; id: string; agent?: string } {
  const split = identity.indexOf(':')
  if (identity.startsWith('entire-agent:')) {
    const separator = identity.indexOf(':', split + 1)
    return { provider: 'entire', agent: identity.slice(split + 1, separator), id: identity.slice(separator + 1) }
  }
  return { provider: identity.slice(0, split), id: identity.slice(split + 1) }
}
