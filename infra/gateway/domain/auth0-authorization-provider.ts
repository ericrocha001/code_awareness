import { createRemoteJWKSet, jwtVerify, type FlattenedJWSInput, type JWSHeaderParameters } from "jose"
import type { AuthorizationProviderPort, ExternallyVerifiedAuthorization } from "../../../src/shared/distribution/authorization-ports"

export type JWTKeyFetcher = Parameters<typeof jwtVerify>[1]

export interface Auth0AuthorizationConfig {
  issuer: string
  audience: string
  jwksUri?: string
  cooldownDuration?: number
  cacheMaxAge?: number
  jwksFetcher?: JWTKeyFetcher
}

export class Auth0AuthorizationError extends Error {
  constructor(public readonly code: "AUTH_MISSING" | "AUTH_INVALID" | "AUTH_EXPIRED" | "AUTH_INSUFFICIENT_SCOPE" | "AUTH_CONFIGURATION_ERROR", message: string) {
    super(message)
    this.name = "Auth0AuthorizationError"
  }
}

export class Auth0AuthorizationProvider implements AuthorizationProviderPort {
  private readonly issuer: string
  private readonly audience: string
  private readonly getKey: JWTKeyFetcher

  constructor(config: Auth0AuthorizationConfig) {
    if (!config || !config.issuer || typeof config.issuer !== "string" || !config.issuer.trim()) {
      throw new Auth0AuthorizationError("AUTH_CONFIGURATION_ERROR", "Missing required configuration: issuer")
    }
    if (!config.audience || typeof config.audience !== "string" || !config.audience.trim()) {
      throw new Auth0AuthorizationError("AUTH_CONFIGURATION_ERROR", "Missing required configuration: audience")
    }

    this.issuer = config.issuer.endsWith("/") ? config.issuer : config.issuer + "/"
    this.audience = config.audience

    if (config.jwksFetcher) {
      this.getKey = config.jwksFetcher
    } else {
      const uri = config.jwksUri ?? (this.issuer + ".well-known/jwks.json")
      try {
        const jwksUrl = new URL(uri)
        this.getKey = createRemoteJWKSet(jwksUrl, {
          cooldownDuration: config.cooldownDuration ?? 30_000,
          cacheMaxAge: config.cacheMaxAge ?? 600_000
        })
      } catch {
        throw new Auth0AuthorizationError("AUTH_CONFIGURATION_ERROR", "Invalid JWKS URI: " + uri)
      }
    }
  }

  async authorize(accessToken: string, _resource: string): Promise<ExternallyVerifiedAuthorization> {
    if (!accessToken || typeof accessToken !== "string" || !accessToken.trim()) {
      throw new Auth0AuthorizationError("AUTH_MISSING", "Missing access token")
    }

    let payload
    try {
      const verified = await jwtVerify(accessToken, this.getKey, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ["RS256"]
      })
      payload = verified.payload
    } catch (error: any) {
      const code = error?.code
      if (code === "ERR_JWT_EXPIRED") {
        throw new Auth0AuthorizationError("AUTH_EXPIRED", "Token is expired")
      }
      throw new Auth0AuthorizationError("AUTH_INVALID", "Invalid token")
    }

    if (!payload.sub || typeof payload.sub !== "string" || !payload.sub.trim()) {
      throw new Auth0AuthorizationError("AUTH_INVALID", "Token missing valid sub claim")
    }

    const rawScopes: string[] = []
    if (typeof payload.scope === "string") {
      rawScopes.push(...payload.scope.split(" ").filter(Boolean))
    }
    if (Array.isArray(payload.permissions)) {
      rawScopes.push(...payload.permissions.filter((p: unknown) => typeof p === "string" && Boolean(p)))
    }

    const scopes = Array.from(new Set(rawScopes))

    return {
      issuer: this.issuer,
      subject: payload.sub,
      scopes
    }
  }
}
