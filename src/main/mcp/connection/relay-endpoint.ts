import { ConnectionError } from './connection-transport-port'

declare const __CODE_AWARENESS_RELAY_ENDPOINT__: string | undefined

function injectedEndpoint(): string {
  if (typeof __CODE_AWARENESS_RELAY_ENDPOINT__ !== 'undefined') return __CODE_AWARENESS_RELAY_ENDPOINT__
  return process.env.CODE_AWARENESS_RELAY_ENDPOINT ?? ''
}

export function resolveRelayEndpoint(configured: string = injectedEndpoint()): string {
  const value = configured.trim()
  if (!value) throw new ConnectionError('RELAY_ENDPOINT_NOT_CONFIGURED')

  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    throw new ConnectionError('RELAY_ENDPOINT_NOT_CONFIGURED')
  }

  const localDevelopment = endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1'
  const validProtocol = endpoint.protocol === 'https:' || localDevelopment
  const validShape = !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === '/mcp'
  if (!validProtocol || !validShape) throw new ConnectionError('RELAY_ENDPOINT_NOT_CONFIGURED')

  return endpoint.href
}
