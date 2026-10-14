import { expect, it, vi } from 'vitest'
import { WorkOrchestrationService } from './work-orchestration-service'
it('shares only in-flight snapshots and limits background and viewport reads together', async () => {
  const releases = new Map<string, (value: any) => void>()
  const read = vi.fn((id: string) => new Promise<any>(resolve => releases.set(id, resolve)))
  const service = new WorkOrchestrationService({ getCoordinationSnapshot: read } as any)
  const a = service.coordinationSnapshot('a'), duplicate = service.coordinationSnapshot('a'), b = service.coordinationSnapshot('b'), c = service.coordinationSnapshot('c')
  expect(duplicate).toBe(a); expect(read).toHaveBeenCalledTimes(2)
  releases.get('a')!({ record: 'a' }); await a
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3))
  releases.get('b')!({ record: 'b' }); releases.get('c')!({ record: 'c' }); await Promise.all([b, c])
  const fresh = service.coordinationSnapshot('a'); expect(read).toHaveBeenCalledTimes(4)
  releases.get('a')!({ record: 'fresh' }); expect(await fresh).toEqual({ record: 'fresh' })
})
