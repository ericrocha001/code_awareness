import { describe, expect, it, vi } from 'vitest'
import { PreviewStackAdapter } from './adapters'

function fixture() {
  const adapter = Object.assign(Object.create(PreviewStackAdapter.prototype), {
    profile: { adapter: { port: 51313 }, probes: { readiness: { timeoutMs: 2000 } } },
    directory: 'absent-readiness-fixture'
  }) as PreviewStackAdapter
  const owner = { inspect: vi.fn(async () => ({ rootSignaled: false })), endpoint: vi.fn() }
  return { adapter, owner }
}

describe('adapter readiness observation fixtures', () => {
  it('retries an absent endpoint without mistaking its subsequent appearance for a foreign owner', async () => {
    const { adapter, owner } = fixture()
    owner.endpoint.mockResolvedValueOnce({ listeners: [] }).mockResolvedValue({ listeners: [{ member: true, loopback: true }] })
    const observe = adapter.observe.bind(adapter)
    vi.spyOn(adapter, 'observe').mockImplementationOnce(observe).mockResolvedValueOnce({ readiness: 'READY' } as any)
    await expect(adapter.awaitReady(owner as any)).resolves.toMatchObject({ readiness: 'READY' })
    expect(owner.endpoint).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ member: false, loopback: true }],
    [{ member: true, loopback: false }],
    [{ member: true, loopback: true }, { member: true, loopback: true }]
  ])('rejects an endpoint with incompatible ownership: %j', async (...listeners) => {
    const { adapter, owner } = fixture()
    owner.endpoint.mockResolvedValue({ listeners })
    await expect(adapter.awaitReady(owner as any)).rejects.toThrow('WRONG_ENDPOINT_OWNER')
    expect(owner.endpoint).toHaveBeenCalledTimes(1)
  })
})
