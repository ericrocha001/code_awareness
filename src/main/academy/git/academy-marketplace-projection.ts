import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AcademyGitProfile, AcademyMarketplaceState, AcademyOpenAiPluginProfile } from '../../../shared/types/academy-types'
import type { RepositoryRecord } from '../../../shared/types/repository-catalog-types'
import { AcademyError } from '../academy-package'
import { canonicalJson, sha256 } from '../publication/openai-plugin-model'

export interface AcademyMarketplaceProjectionResult {
  path: string
  contentHash: string
}

export class AcademyMarketplaceProjection {
  render(
    repository: RepositoryRecord,
    gitProfile: AcademyGitProfile,
    pluginProfile: AcademyOpenAiPluginProfile,
    marketplaceState: AcademyMarketplaceState
  ): Record<string, unknown> {
    if (marketplaceState.takeoverStatus === 'INCONCLUSIVE') throw new AcademyError('MARKETPLACE_TAKEOVER_INCONCLUSIVE')
    if (!repository.github?.fullName) throw new AcademyError('MARKETPLACE_GITHUB_SOURCE_MISSING')
    if (repository.id !== gitProfile.repositoryCatalogId || repository.github.repositoryId !== gitProfile.githubRepositoryId) {
      throw new AcademyError('MARKETPLACE_GITHUB_PROFILE_MISMATCH')
    }

    const plugin: Record<string, unknown> = {
      name: pluginProfile.name,
      source: {
        source: 'url',
        url: `https://github.com/${repository.github.fullName}.git`,
        ref: gitProfile.branch
      },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: String(pluginProfile.openAiInterface.category ?? 'Productivity'),
      interface: { displayName: pluginProfile.displayName }
    }
    if (marketplaceState.takeoverStatus === 'TAKEOVER_PROVEN' && marketplaceState.observedPluginId) {
      plugin.pluginId = marketplaceState.observedPluginId
    }

    return {
      name: 'academy',
      interface: { displayName: 'Academy' },
      plugins: [plugin]
    }
  }

  fingerprint(
    repository: RepositoryRecord,
    gitProfile: AcademyGitProfile,
    pluginProfile: AcademyOpenAiPluginProfile,
    marketplaceState: AcademyMarketplaceState
  ): string {
    return sha256(canonicalJson(this.render(repository, gitProfile, pluginProfile, marketplaceState)))
  }

  async project(
    repoRoot: string,
    repository: RepositoryRecord,
    gitProfile: AcademyGitProfile,
    pluginProfile: AcademyOpenAiPluginProfile,
    marketplaceState: AcademyMarketplaceState
  ): Promise<AcademyMarketplaceProjectionResult> {
    const manifest = this.render(repository, gitProfile, pluginProfile, marketplaceState)
    const target = join(repoRoot, '.agents', 'plugins', 'marketplace.json')
    await mkdir(dirname(target), { recursive: true })
    const content = `${canonicalJson(manifest)}\n`
    await writeFile(target, content, 'utf8')
    return { path: '.agents/plugins/marketplace.json', contentHash: sha256(content) }
  }
}
