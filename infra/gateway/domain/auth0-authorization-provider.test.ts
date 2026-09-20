import { describe, expect, it, afterEach } from "vitest"
import { createServer, type Server } from "node:http"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { Auth0AuthorizationProvider, Auth0AuthorizationError } from "./auth0-authorization-provider"
import { READ_SCOPE } from "../../../src/shared/distribution/relay-protocol"

describe("Auth0AuthorizationProvider", () => {
  const issuer = "https://tenant.auth0.com/"
  const audience = "https://gateway.example.com/mcp"

  const serversToClose: Server[] = []
  afterEach(async () => {
    for (const server of serversToClose.splice(0)) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
  })

  async function createKey(kid = "key-1") {
    const pair = await generateKeyPair("RS256")
    const publicJwk = await exportJWK(pair.publicKey)
    publicJwk.kid = kid
    publicJwk.alg = "RS256"
    publicJwk.use = "sig"
    return { ...pair, kid, publicJwk }
  }

  async function signToken(key: any, payload: Record<string, unknown>, options?: { issuer?: string; audience?: string; expiresIn?: string | number; notBefore?: string | number; kid?: string }) {
    const jwt = new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: options?.kid ?? key.kid })
      .setIssuer(options?.issuer ?? issuer)
      .setAudience(options?.audience ?? audience)
    if (options?.expiresIn !== undefined) {
      jwt.setExpirationTime(options.expiresIn)
    } else {
      jwt.setExpirationTime("1h")
    }
    if (options?.notBefore !== undefined) {
      jwt.setNotBefore(options.notBefore)
    }
    return jwt.sign(key.privateKey)
  }

  it("throws AUTH_CONFIGURATION_ERROR when required config is missing", () => {
    expect(() => new Auth0AuthorizationProvider({ issuer: "", audience })).toThrow(Auth0AuthorizationError)
    expect(() => new Auth0AuthorizationProvider({ issuer, audience: "" })).toThrow(Auth0AuthorizationError)
    expect(() => new Auth0AuthorizationProvider({ issuer, audience, jwksUri: "not a valid uri" })).toThrow(Auth0AuthorizationError)
  })

  it("successfully validates a valid RS256 token and returns verified subject with scopes", async () => {
    const key = await createKey("k1")
    const provider = new Auth0AuthorizationProvider({
      issuer,
      audience,
      jwksFetcher: async () => key.publicKey
    })

    const token = await signToken(key, {
      sub: "auth0|user-123",
      scope: `${READ_SCOPE} profile email`,
      permissions: [READ_SCOPE]
    })

    const user = await provider.authorize(token, audience)
    expect(user.subject).toBe("auth0|user-123")
    expect(user.issuer).toBe(issuer)
    expect(user.scopes).toContain(READ_SCOPE)
    expect(user.scopes).toContain("profile")
    expect(user.scopes).toContain("email")
  })

  it("rejects token with invalid signature", async () => {
    const key1 = await createKey("k1")
    const key2 = await createKey("k2")
    const provider = new Auth0AuthorizationProvider({
      issuer,
      audience,
      jwksFetcher: async () => key1.publicKey
    })

    const token = await signToken(key2, { sub: "user-abc", scope: READ_SCOPE })
    await expect(provider.authorize(token, audience)).rejects.toThrow(Auth0AuthorizationError)
    await expect(provider.authorize(token, audience)).rejects.toMatchObject({ code: "AUTH_INVALID" })
  })

  it("rejects token from wrong issuer (e.g. different Auth0 tenant)", async () => {
    const key = await createKey()
    const provider = new Auth0AuthorizationProvider({
      issuer,
      audience,
      jwksFetcher: async () => key.publicKey
    })

    const token = await signToken(key, { sub: "user-abc", scope: READ_SCOPE }, { issuer: "https://evil.auth0.com/" })
    await expect(provider.authorize(token, audience)).rejects.toMatchObject({ code: "AUTH_INVALID" })
  })

  it("rejects token for different audience (different API)", async () => {
    const key = await createKey()
    const provider = new Auth0AuthorizationProvider({
      issuer,
      audience,
      jwksFetcher: async () => key.publicKey
    })

    const token = await signToken(key, { sub: "user-abc", scope: READ_SCOPE }, { audience: "https://other-api.com" })
    await expect(provider.authorize(token, audience)).rejects.toMatchObject({ code: "AUTH_INVALID" })
  })

  it("rejects expired token with AUTH_EXPIRED", async () => {
    const key = await createKey()
    const provider = new Auth0AuthorizationProvider({
      issuer,
      audience,
      jwksFetcher: async () => key.publicKey
    })

    const token = await signToken(key, { sub: "user-abc", scope: READ_SCOPE }, { expiresIn: "-10s" })
    await expect(provider.authorize(token, audience)).rejects.toMatchObject({ code: "AUTH_EXPIRED" })
  })

  it("rejects token missing valid sub claim", async () => {
    const key = await createKey()
    const provider = new Auth0AuthorizationProvider({
      issuer,
      audience,
      jwksFetcher: async () => key.publicKey
    })

    const token = await signToken(key, { scope: READ_SCOPE })
    await expect(provider.authorize(token, audience)).rejects.toMatchObject({ code: "AUTH_INVALID" })
  })

  it("rejects malformed token cleanly with AUTH_INVALID or AUTH_MISSING", async () => {
    const key = await createKey()
    const provider = new Auth0AuthorizationProvider({
      issuer,
      audience,
      jwksFetcher: async () => key.publicKey
    })

    await expect(provider.authorize("", audience)).rejects.toMatchObject({ code: "AUTH_MISSING" })
    await expect(provider.authorize("not-a-jwt", audience)).rejects.toMatchObject({ code: "AUTH_INVALID" })
    await expect(provider.authorize("a.b.c", audience)).rejects.toMatchObject({ code: "AUTH_INVALID" })
  })

  it("supports key rotation by kid", async () => {
    const keyOld = await createKey("kid-old")
    const keyNew = await createKey("kid-new")
    const keyStore = new Map([
      ["kid-old", keyOld.publicKey],
      ["kid-new", keyNew.publicKey]
    ])

    const provider = new Auth0AuthorizationProvider({
      issuer,
      audience,
      jwksFetcher: async (header) => {
        const k = keyStore.get(header?.kid ?? "")
        if (!k) throw new Error("Key not found")
        return k
      }
    })

    const tokenOld = await signToken(keyOld, { sub: "user-old", scope: READ_SCOPE })
    const userOld = await provider.authorize(tokenOld, audience)
    expect(userOld.subject).toBe("user-old")

    const tokenNew = await signToken(keyNew, { sub: "user-new", scope: READ_SCOPE })
    const userNew = await provider.authorize(tokenNew, audience)
    expect(userNew.subject).toBe("user-new")
  })

  it("caches JWKS HTTP requests using createRemoteJWKSet and avoids refetching for same kid, while refreshing on new kid", async () => {
    const key1 = await createKey("kid-1")
    const key2 = await createKey("kid-2")
    const currentKeys = [key1.publicJwk]
    let requestCount = 0

    const server = createServer((req, res) => {
      if (req.url === "/.well-known/jwks.json") {
        requestCount++
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ keys: currentKeys }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    serversToClose.push(server)
    const port = (server.address() as { port: number }).port
    const localIssuer = `http://127.0.0.1:${port}/`

    const provider = new Auth0AuthorizationProvider({
      issuer: localIssuer,
      audience,
      cooldownDuration: 0,
      cacheMaxAge: 600_000
    })

    const token1 = await signToken(key1, { sub: "user-1", scope: READ_SCOPE }, { issuer: localIssuer })
    const token2 = await signToken(key1, { sub: "user-2", scope: READ_SCOPE }, { issuer: localIssuer })

    const res1 = await provider.authorize(token1, audience)
    expect(res1.subject).toBe("user-1")
    expect(requestCount).toBe(1)

    const res2 = await provider.authorize(token2, audience)
    expect(res2.subject).toBe("user-2")
    expect(requestCount).toBe(1)

    currentKeys.push(key2.publicJwk)
    const token3 = await signToken(key2, { sub: "user-3", scope: READ_SCOPE }, { issuer: localIssuer })

    const res3 = await provider.authorize(token3, audience)
    expect(res3.subject).toBe("user-3")
    expect(requestCount).toBe(2)
  })
})
