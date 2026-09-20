import { describe, expect, it, vi } from "vitest"
import { DesktopEnrollmentClient } from "./desktop-enrollment-client"
import { InstallationIdentityService } from "./installation-identity-service"

describe("DesktopEnrollmentClient", () => {
  it("interacts with enrollment endpoints through InstallationEnrollmentPort contract", async () => {
    const mockIdentity = {
      getId: vi.fn(() => "00000000-0000-4000-8000-000000000001"),
      getCredential: vi.fn(() => "mock-cred-123456789012345678901234567890123"),
      rotateCredential: vi.fn(),
      clearCredential: vi.fn()
    } as unknown as InstallationIdentityService

    const client = new DesktopEnrollmentClient("http://gateway.test", mockIdentity)

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      enrollmentId: "enroll-1",
      verificationUri: "http://gateway.test/enroll/enroll-1",
      expiresAt: "2026-09-11T20:00:00.000Z"
    }), { status: 200, headers: { "Content-Type": "application/json" } }))

    const state = await client.enroll()
    expect(state.status).toBe("PENDING")
    if (state.status === "PENDING") {
      expect(state.verificationUri).toBe("http://gateway.test/enroll/enroll-1")
    }

    expect(fetchSpy).toHaveBeenCalledWith("http://gateway.test/enroll/begin", expect.objectContaining({
      method: "POST"
    }))

    const cur = await client.getEnrollmentState()
    expect(cur.status).toBe("ENROLLED")

    await client.rotateCredential()
    expect(mockIdentity.rotateCredential).toHaveBeenCalled()

    await client.revoke()
    expect(mockIdentity.clearCredential).toHaveBeenCalled()

    fetchSpy.mockRestore()
  })
})
