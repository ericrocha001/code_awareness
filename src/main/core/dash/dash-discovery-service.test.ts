import { describe, expect, it, vi } from 'vitest'
import { REPO_DISCOVERY_PROTOCOL_VERSION } from '../../../shared/types/repo-discovery-types'
import { DashDiscoveryService } from './dash-discovery-service'

describe('DashDiscoveryService', () => {
  it('routes the explicit Discovery protocol to Context Engine', async () => {
    const result = {
      protocol: REPO_DISCOVERY_PROTOCOL_VERSION, layer: 2 as const, content: 'map', tokenCount: 1, mapTokenCount: 1,
      tokenizerId: 'test', tokenizerEncoding: 'test', fileCount: 1, generationMs: 2,
      timings: {
        readinessMs: 0, projectionMs: 0,
        serializationMs: 0, outputTokenizationMs: 0, totalMs: 2
      }
    }
    const discover = vi.fn(async () => result)
    const service = new DashDiscoveryService({ discover })
    await expect(service.execute({
      protocol: REPO_DISCOVERY_PROTOCOL_VERSION,
      operation: 'discovery',
      layer: 2
    }, 'repo')).resolves.toEqual(result)
    expect(discover).toHaveBeenCalledWith('repo', 2)
  })

  it('rejects invalid layers, versions and unknown fields', async () => {
    const service = new DashDiscoveryService({ discover: vi.fn() })
    await expect(service.execute({ protocol: 'code-dash/v1', operation: 'discovery', layer: 1 }, 'repo')).rejects.toThrow('Unsupported')
    await expect(service.execute({ protocol: REPO_DISCOVERY_PROTOCOL_VERSION, operation: 'discovery', layer: 3 }, 'repo')).rejects.toThrow('1 or 2')
    await expect(service.execute({ protocol: REPO_DISCOVERY_PROTOCOL_VERSION, operation: 'discovery', layer: 4 }, 'repo')).rejects.toThrow('1 or 2')
    await expect(service.execute({ protocol: REPO_DISCOVERY_PROTOCOL_VERSION, operation: 'discovery', layer: 5 }, 'repo')).rejects.toThrow('1 or 2')
    await expect(service.execute({ protocol: REPO_DISCOVERY_PROTOCOL_VERSION, operation: 'discovery', layer: 1, items: [] }, 'repo')).rejects.toThrow('unknown field')
  })
})
