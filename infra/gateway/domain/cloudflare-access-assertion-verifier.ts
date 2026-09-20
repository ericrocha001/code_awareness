import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { VerifiedExternalIdentity } from './external-identity-resolver'

type JWTKeyFetcher = Parameters<typeof jwtVerify>[1]

export interface CloudflareAccessAssertionVerifierPort {
  verify(assertion: string): Promise<VerifiedExternalIdentity>
}

export interface CloudflareAccessAssertionConfig {
  teamDomain: string
  audience: string
  cooldownDuration?: number
  cacheMaxAge?: number
  jwksFetcher?: JWTKeyFetcher
}

export class CloudflareAccessAssertionError extends Error {
  constructor(public readonly code: 'ACCESS_ASSERTION_MISSING' | 'ACCESS_ASSERTION_INVALID' | 'ACCESS_ASSERTION_EXPIRED' | 'ACCESS_CONFIGURATION_ERROR', message: string) {
    super(message)
    this.name = 'CloudflareAccessAssertionError'
  }
}

export class CloudflareAccessAssertionVerifier implements CloudflareAccessAssertionVerifierPort {
  private readonly issuer: string
  private readonly audience: string
  private readonly getKey: JWTKeyFetcher

  constructor(config: CloudflareAccessAssertionConfig) {
    this.issuer = this.parseTeamDomain(config?.teamDomain)
    if (!config?.audience || typeof config.audience !== 'string' || !config.audience.trim()) {
      throw new CloudflareAccessAssertionError('ACCESS_CONFIGURATION_ERROR', 'Missing required configuration: audience')
    }
    this.audience = config.audience.trim()
    this.getKey = config.jwksFetcher ?? createRemoteJWKSet(new URL('/cdn-cgi/access/certs', this.issuer), {
      cooldownDuration: config.cooldownDuration ?? 30_000,
      cacheMaxAge: config.cacheMaxAge ?? 600_000
    })
  }

  async verify(assertion: string): Promise<VerifiedExternalIdentity> {
    if (!assertion || typeof assertion !== 'string' || !assertion.trim()) {
      throw new CloudflareAccessAssertionError('ACCESS_ASSERTION_MISSING', 'Missing Cloudflare Access assertion')
    }

    let payload
    try {
      const verified = await jwtVerify(assertion, this.getKey, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['RS256']
      })
      payload = verified.payload
    } catch (error: any) {
      if (error?.code === 'ERR_JWT_EXPIRED') {
        throw new CloudflareAccessAssertionError('ACCESS_ASSERTION_EXPIRED', 'Cloudflare Access assertion is expired')
      }
      throw new CloudflareAccessAssertionError('ACCESS_ASSERTION_INVALID', 'Invalid Cloudflare Access assertion')
    }

    if (!payload.sub || typeof payload.sub !== 'string' || !payload.sub.trim()) {
      throw new CloudflareAccessAssertionError('ACCESS_ASSERTION_INVALID', 'Cloudflare Access assertion is missing a valid subject')
    }
    return { issuer: this.issuer, subject: payload.sub }
  }

  private parseTeamDomain(value: string): string {
    if (!value || typeof value !== 'string' || !value.trim()) {
      throw new CloudflareAccessAssertionError('ACCESS_CONFIGURATION_ERROR', 'Missing required configuration: teamDomain')
    }
    try {
      const url = new URL(value.trim())
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error()
      return url.origin
    } catch {
      throw new CloudflareAccessAssertionError('ACCESS_CONFIGURATION_ERROR', 'Invalid Cloudflare Access team domain')
    }
  }
}
