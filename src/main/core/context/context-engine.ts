import type { RepoDiscoveryLayer, RepoDiscoveryResult } from '../../../shared/types/repo-discovery-types'
import { RepoDiscovery, type CodeMapDiscoveryPort } from './repo-discovery'

export class ContextEngine {
  private readonly repoDiscovery: RepoDiscovery

  constructor(codeMap: CodeMapDiscoveryPort) {
    this.repoDiscovery = new RepoDiscovery(codeMap)
  }

  discover(repoPath: string, layer: RepoDiscoveryLayer): Promise<RepoDiscoveryResult> {
    return this.repoDiscovery.generate(repoPath, layer)
  }
}
