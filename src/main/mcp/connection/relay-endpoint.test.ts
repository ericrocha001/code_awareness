import { describe, expect, it } from 'vitest'
import { resolveRelayEndpoint } from './relay-endpoint'

describe('resolveRelayEndpoint', () => {
  it('accepts a deployment-specific HTTPS MCP endpoint', () => {
    expect(resolveRelayEndpoint('https://gateway.example.com/mcp')).toBe('https://gateway.example.com/mcp')
  })

  it('accepts loopback HTTP for local development', () => {
    expect(resolveRelayEndpoint('http://127.0.0.1:8787/mcp')).toBe('http://127.0.0.1:8787/mcp')
  })

  it.each([
    '',
    'not-a-url',
    'http://gateway.example.com/mcp',
    'https://gateway.example.com/',
    'https://gateway.example.com/mcp?token=secret',
    'https://user:pass@gateway.example.com/mcp'
  ])('fails explicitly for missing or unsafe configuration: %s', (value) => {
    expect(() => resolveRelayEndpoint(value)).toThrowError(expect.objectContaining({ code: 'RELAY_ENDPOINT_NOT_CONFIGURED' }))
  })
})
