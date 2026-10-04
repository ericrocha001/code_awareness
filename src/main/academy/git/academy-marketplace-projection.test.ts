import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AcademyGitProfile, AcademyMarketplaceState, AcademyOpenAiPluginProfile } from '../../../shared/types/academy-types'
import type { RepositoryRecord } from '../../../shared/types/repository-catalog-types'
import { AcademyMarketplaceProjection } from './academy-marketplace-projection'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const record: RepositoryRecord = {
  id: 'catalog-1', name: 'Academy', status: 'ACTIVE',
  localCheckout: { path: 'C:/Academy', availability: 'AVAILABLE', gitState: 'GIT' },
  github: {
    repositoryId: 'github-1', ownerId: 'owner-1', ownerLogin: 'owner', name: 'Academy',
    fullName: 'owner/Academy', visibility: 'PUBLIC', htmlUrl: 'https://github.com/owner/Academy',
    cloneUrl: 'https://github.com/owner/Academy.git', accessState: 'AVAILABLE', lastSeenAt: '2026-10-03T00:00:00.000Z'
  },
  createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z'
}

const gitProfile: AcademyGitProfile = {
  repositoryCatalogId: 'catalog-1', githubRepositoryId: 'github-1', branch: 'main',
  lastSnapshotHash: null, lastCommitSha: null, lastPushedCommitSha: null,
  syncState: 'DIRTY', lastError: null, updatedAt: '2026-10-03T00:00:00.000Z'
}

const pluginProfile: AcademyOpenAiPluginProfile = {
  name: 'academy-skills', displayName: 'Academy Skills', description: 'Academy skills', author: { name: 'Academy' },
  openAiInterface: { category: 'Productivity' }, logoPath: null, publishedVersion: '0.1.4',
  deletionSemantics: 'UNKNOWN', deletionSemanticsEvidence: null,
  createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z'
}

const unsupported: AcademyMarketplaceState = {
  takeoverStatus: 'TAKEOVER_UNSUPPORTED', mode: 'SOURCE_AVAILABLE',
  observedPluginId: 'academy-skills@academy-marketplace-probe', evidence: 'probe', updatedAt: '2026-10-03T00:00:00.000Z'
}

describe('AcademyMarketplaceProjection', () => {
  it('projects only marketplace.json from catalog and Git profile without the personal plugin ID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'academy-marketplace-'))
    roots.push(root)
    mkdirSync(join(root, '.agents', 'custom'), { recursive: true })
    writeFileSync(join(root, '.agents', 'custom', 'keep.json'), '{}')

    await new AcademyMarketplaceProjection().project(root, record, gitProfile, pluginProfile, unsupported)

    const marketplace = JSON.parse(readFileSync(join(root, '.agents', 'plugins', 'marketplace.json'), 'utf8'))
    expect(marketplace.name).toBe('academy')
    expect(marketplace.plugins[0].source).toEqual({ source: 'url', url: 'https://github.com/owner/Academy.git', ref: 'main' })
    expect(marketplace.plugins[0]).not.toHaveProperty('pluginId')
    expect(existsSync(join(root, '.agents', 'custom', 'keep.json'))).toBe(true)
  })

  it('refuses to crystallize a marketplace while takeover evidence is inconclusive', () => {
    const state: AcademyMarketplaceState = { ...unsupported, takeoverStatus: 'INCONCLUSIVE', mode: 'PENDING_EVIDENCE' }
    expect(() => new AcademyMarketplaceProjection().render(record, gitProfile, pluginProfile, state)).toThrow(/MARKETPLACE_TAKEOVER_INCONCLUSIVE/)
  })
})
