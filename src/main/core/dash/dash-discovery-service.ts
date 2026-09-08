import {
  REPO_DISCOVERY_PROTOCOL_VERSION,
  type RepoDiscoveryLayer,
  type RepoDiscoveryRequest,
  type RepoDiscoveryResult
} from '../../../shared/types/repo-discovery-types'

export interface DiscoveryEnginePort {
  discover(repoPath: string, layer: RepoDiscoveryLayer): Promise<RepoDiscoveryResult>
}

function isLayer(value: unknown): value is RepoDiscoveryLayer {
  return value === 1 || value === 2
}

export class DashDiscoveryService {
  constructor(private readonly contextEngine: DiscoveryEnginePort) {}

  async execute(request: unknown, repoPath: string): Promise<RepoDiscoveryResult> {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new Error('Discovery request must be an object.')
    }
    const candidate = request as Partial<RepoDiscoveryRequest>
    const fields = Object.keys(candidate)
    if (fields.some((field) => !['protocol', 'operation', 'layer'].includes(field))) {
      throw new Error('Discovery request contains an unknown field.')
    }
    if (candidate.protocol !== REPO_DISCOVERY_PROTOCOL_VERSION) {
      throw new Error(`Unsupported Discovery protocol: ${String(candidate.protocol)}`)
    }
    if (candidate.operation !== 'discovery') {
      throw new Error('Discovery operation must be "discovery".')
    }
    if (!isLayer(candidate.layer)) {
      throw new Error('Discovery layer must be 1 or 2.')
    }
    return this.contextEngine.discover(repoPath, candidate.layer)
  }
}
