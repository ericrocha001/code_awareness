import { afterEach, describe, expect, it, vi } from "vitest"
import { createLocalGateway, MemoryInstallationRegistry } from "../testing/local-gateway"
import { newInstallationId, READ_SCOPE, type UserId } from "../../../src/shared/distribution/relay-protocol"
import { ENROLL_SCOPE } from "./enrollment-service"
import { McpLifecycle } from "../../../src/main/mcp/mcp-lifecycle"
import { RelayTransport } from "../../../src/main/mcp/connection/relay-transport"
import { ConnectionLifecycle } from "../../../src/main/mcp/connection/connection-lifecycle"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function setup() {
  const registry = new MemoryInstallationRegistry()
  const gateway = await createLocalGateway(registry, { async verify() { throw new Error('UNUSED') } }, {
    async authorize(token) {
      if (token === "token-user-a") return { issuer: "https://auth0.example.com/", subject: "user-a", scopes: [READ_SCOPE, ENROLL_SCOPE] }
      if (token === "token-user-b") return { issuer: "https://auth0.example.com/", subject: "user-b", scopes: [READ_SCOPE, ENROLL_SCOPE] }
      if (token === "token-no-enroll") return { issuer: "https://auth0.example.com/", subject: "user-a", scopes: [READ_SCOPE] }
      throw new Error("UNAUTHORIZED")
    }
  })
  cleanup.push(() => gateway.close())

  const post = async (path: string, body: unknown, token?: string) => {
    const res = await fetch(`${gateway.origin}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    })
    return { status: res.status, body: await res.json().catch(() => null) as any }
  }

  const get = async (path: string) => {
    const res = await fetch(`${gateway.origin}${path}`)
    return { status: res.status, body: await res.json().catch(() => null) as any }
  }

  return { registry, gateway, post, get }
}

describe("Enrollment User <-> Installation", () => {
  it("executes the full happy path: begin -> PENDING -> claim -> ACTIVE -> Relay connects", async () => {
    const f = await setup()
    const instId = newInstallationId()
    const credential = "a".repeat(43)

    const beginRes = await f.post("/enroll/begin", { installationId: instId, credential })
    expect(beginRes.status).toBe(200)
    expect(beginRes.body.enrollmentId).toBeDefined()
    expect(beginRes.body.claimSecret).toBeDefined()
    expect(beginRes.body.verificationUri).toContain(`/enroll/${beginRes.body.enrollmentId}`)

    const status1 = await f.get(`/enroll/status/${beginRes.body.enrollmentId}`)
    expect(status1.body.status).toBe("PENDING")

    const mcp = new McpLifecycle({ log: () => {} })
    const relay = new RelayTransport(f.gateway.endpoint, { getId: () => instId, getCredential: () => credential })
    const conn = new ConnectionLifecycle(mcp, relay, () => ({}), () => {})
    cleanup.push(async () => { await conn.dispose(); await mcp.dispose() })

    await mcp.activate("user-a", { discoverRepository: vi.fn(), getRelationships: vi.fn(async () => ({ files: [] })), inspectFiles: vi.fn(), readCode: vi.fn() })
    const connectBefore = await conn.connect()
    expect(connectBefore.success).toBe(false)

    const claimRes = await f.post("/enroll/claim", {
      enrollmentId: beginRes.body.enrollmentId,
      claimSecret: beginRes.body.claimSecret
    }, "token-user-a")
    expect(claimRes.status).toBe(200)
    expect(claimRes.body.status).toBe("ACTIVE")

    const status2 = await f.get(`/enroll/status/${beginRes.body.enrollmentId}`)
    expect(status2.body.status).toBe("CLAIMED")

    const inst = await f.registry.get(instId)
    expect(inst).toBeDefined()
    const userAId = await f.gateway.resolver.resolve({ issuer: "https://auth0.example.com/", subject: "user-a" })
    expect(userAId).toBeDefined()
    expect(inst?.ownerUserId).toBe(userAId)
    expect(inst?.status).toBe("ACTIVE")

    const connectAfter = await conn.connect()
    expect(connectAfter.success).toBe(true)
  })

  it("requires authentication to claim (401)", async () => {
    const f = await setup()
    const instId = newInstallationId()
    const begin = await f.post("/enroll/begin", { installationId: instId, credential: "b".repeat(43) })

    const claimNoAuth = await f.post("/enroll/claim", {
      enrollmentId: begin.body.enrollmentId,
      claimSecret: begin.body.claimSecret
    })
    expect(claimNoAuth.status).toBe(401)
  })

  it("requires enrollment scope to claim (403)", async () => {
    const f = await setup()
    const instId = newInstallationId()
    const begin = await f.post("/enroll/begin", { installationId: instId, credential: "c".repeat(43) })

    const claimNoScope = await f.post("/enroll/claim", {
      enrollmentId: begin.body.enrollmentId,
      claimSecret: begin.body.claimSecret
    }, "token-no-enroll")
    expect(claimNoScope.status).toBe(403)
  })

  it("rejects invalid claim secret", async () => {
    const f = await setup()
    const instId = newInstallationId()
    const begin = await f.post("/enroll/begin", { installationId: instId, credential: "d".repeat(43) })

    const claimWrongSecret = await f.post("/enroll/claim", {
      enrollmentId: begin.body.enrollmentId,
      claimSecret: "wrong-secret"
    }, "token-user-a")
    expect(claimWrongSecret.status).toBe(403)

    const inst = await f.registry.get(instId)
    expect(inst).toBeNull()
  })

  it("rejects claim when enrollment has expired", async () => {
    const f = await setup()
    const instId = newInstallationId()
    const begin = await f.post("/enroll/begin", { installationId: instId, credential: "e".repeat(43) })

    const pending = await f.registry.getPending(begin.body.enrollmentId)
    if (pending) {
      pending.expiresAt = new Date(Date.now() - 1000).toISOString()
      await f.registry.savePending(pending)
    }

    const claimExpired = await f.post("/enroll/claim", {
      enrollmentId: begin.body.enrollmentId,
      claimSecret: begin.body.claimSecret
    }, "token-user-a")
    expect(claimExpired.status).toBe(403)
  })

  it("enforces cross-user isolation: User B cannot claim User A already claimed enrollment", async () => {
    const f = await setup()
    const instId = newInstallationId()
    const begin = await f.post("/enroll/begin", { installationId: instId, credential: "f".repeat(43) })

    const claimA = await f.post("/enroll/claim", {
      enrollmentId: begin.body.enrollmentId,
      claimSecret: begin.body.claimSecret
    }, "token-user-a")
    expect(claimA.status).toBe(200)

    const claimB = await f.post("/enroll/claim", {
      enrollmentId: begin.body.enrollmentId,
      claimSecret: begin.body.claimSecret
    }, "token-user-b")
    expect(claimB.status).toBe(403)

    const inst = await f.registry.get(instId)
    const userAId = await f.gateway.resolver.resolve({ issuer: "https://auth0.example.com/", subject: "user-a" })
    expect(inst?.ownerUserId).toBe(userAId)
  })

  it("handles identical retry from the same user idempotently", async () => {
    const f = await setup()
    const instId = newInstallationId()
    const begin = await f.post("/enroll/begin", { installationId: instId, credential: "g".repeat(43) })

    const claim1 = await f.post("/enroll/claim", {
      enrollmentId: begin.body.enrollmentId,
      claimSecret: begin.body.claimSecret
    }, "token-user-a")
    expect(claim1.status).toBe(200)

    const claim2 = await f.post("/enroll/claim", {
      enrollmentId: begin.body.enrollmentId,
      claimSecret: begin.body.claimSecret
    }, "token-user-a")
    expect(claim2.status).toBe(200)
    expect(claim2.body.installationId).toBe(instId)
  })

  it("guarantees race condition has exactly one winner", async () => {
    const f = await setup()
    const instId = newInstallationId()
    const begin = await f.post("/enroll/begin", { installationId: instId, credential: "h".repeat(43) })

    const [resA, resB] = await Promise.all([
      f.post("/enroll/claim", { enrollmentId: begin.body.enrollmentId, claimSecret: begin.body.claimSecret }, "token-user-a"),
      f.post("/enroll/claim", { enrollmentId: begin.body.enrollmentId, claimSecret: begin.body.claimSecret }, "token-user-b")
    ])

    const statuses = [resA.status, resB.status]
    expect(statuses).toContain(200)
    expect(statuses).toContain(403)
  })

  it("verifies secrets are hashed and never stored in plaintext", async () => {
    const f = await setup()
    const instId = newInstallationId()
    const credential = "i".repeat(43)
    const begin = await f.post("/enroll/begin", { installationId: instId, credential })

    const pending = await f.registry.getPending(begin.body.enrollmentId)
    expect(pending?.credentialHash).toHaveLength(64)
    expect(pending?.credentialHash).not.toBe(credential)
    expect(pending?.claimSecretHash).toHaveLength(64)
    expect(pending?.claimSecretHash).not.toBe(begin.body.claimSecret)

    await f.post("/enroll/claim", {
      enrollmentId: begin.body.enrollmentId,
      claimSecret: begin.body.claimSecret
    }, "token-user-a")

    const inst = await f.registry.get(instId)
    expect(inst?.credentialHash).toHaveLength(64)
    expect(inst?.credentialHash).not.toBe(credential)
  })
})
