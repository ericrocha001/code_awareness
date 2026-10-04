import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AcademyPluginRepositoryProjection } from './academy-plugin-repository-projection'
import { AcademyGitMaterializer } from './academy-git-materializer'
import type {
  AcademyOpenAiPluginProfile,
  AcademyOpenAiSnapshotEntry,
  AcademyPluginPackageRevision
} from '../../../shared/types/academy-types'
import { hashAcademyPackage } from '../academy-package'

const roots: string[] = []
const root = () => {
  const value = mkdtempSync(join(tmpdir(), 'academy-proj-test-'))
  roots.push(value)
  return value
}

const revision: AcademyPluginPackageRevision = {
  id: 'revision-1',
  version: '0.1.3',
  contentFingerprint: 'content',
  skillSnapshotHash: 'skills',
  profileFingerprint: 'profile',
  assetHash: 'asset',
  delta: { added: [], updated: [], removed: [], renamed: [], destructive: false },
  createdAt: '2026-09-01T00:00:00.000Z'
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function png(width = 512, height = 512): Buffer {
  const value = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(value)
  value.writeUInt32BE(width, 16)
  value.writeUInt32BE(height, 20)
  return value
}

function makeProfile(tempDir: string, options?: { withLogo?: boolean; invalidLogo?: boolean }): AcademyOpenAiPluginProfile {
  let logoPath: string | null = null
  if (options?.withLogo) {
    logoPath = join(tempDir, 'source-logo.png')
    writeFileSync(logoPath, options?.invalidLogo ? Buffer.from('not-a-png') : png())
  }
  return {
    name: 'academy-skills',
    displayName: 'Academy Skills',
    description: 'Autonomous procedural knowledge for agents',
    author: { name: 'Academy Team' },
    openAiInterface: {
      displayName: 'Academy Skills',
      shortDescription: 'Procedural skills for agents',
      longDescription: 'Curated skills maintained canonically by Academy',
      developerName: 'Academy',
      category: 'Productivity',
      capabilities: ['Interactive'],
      defaultPrompt: ['Help me write code']
    },
    logoPath,
    publishedVersion: '0.1.3',
    deletionSemantics: 'UNKNOWN',
    deletionSemanticsEvidence: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z'
  }
}

describe('AcademyPluginRepositoryProjection', () => {
  it('manifest: generates valid plugin.json matching profile, schema and semver', async () => {
    const repo = root()
    const profile = makeProfile(repo, { withLogo: true })
    const snapshot: AcademyOpenAiSnapshotEntry[] = []
    const projection = new AcademyPluginRepositoryProjection()

    const result = await projection.project(repo, profile, snapshot, revision)
    expect(result.version).toBe('0.1.3')

    const manifestRaw = readFileSync(join(repo, 'plugin.json'), 'utf8')
    const manifest = JSON.parse(manifestRaw)

    expect(manifest.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
    expect(manifest.name).toBe('academy-skills')
    expect(manifest.version).toBe('0.1.3')
    expect(manifest.description).toBe(profile.description)
    expect(manifest.author).toEqual(profile.author)
    expect(manifest.extensions['com.openai'].interface.displayName).toBe('Academy Skills')
    expect(manifest.extensions['com.openai'].interface.composerIcon).toBe('./assets/logo.png')
    expect(manifest.extensions['com.openai'].interface.logo).toBe('./assets/logo.png')
  })

  it('asset: copies logo to assets/logo.png when configured', async () => {
    const repo = root()
    const profile = makeProfile(repo, { withLogo: true })
    const projection = new AcademyPluginRepositoryProjection()

    await projection.project(repo, profile, [], revision)

    expect(existsSync(join(repo, 'assets', 'logo.png'))).toBe(true)
    const logoContent = readFileSync(join(repo, 'assets', 'logo.png'))
    expect(logoContent.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  it('asset: throws if configured logo does not exist', async () => {
    const repo = root()
    const profile = makeProfile(repo, { withLogo: false })
    profile.logoPath = join(repo, 'non-existent-logo.png')
    const projection = new AcademyPluginRepositoryProjection()

    await expect(projection.project(repo, profile, [], revision)).rejects.toThrow(/OPENAI_PLUGIN_LOGO_INVALID/)
  })

  it('managed boundary: does not touch or delete unrelated files in repository root', async () => {
    const repo = root()
    writeFileSync(join(repo, 'README.md'), '# Human documentation', 'utf8')
    writeFileSync(join(repo, 'LICENSE'), 'MIT License', 'utf8')
    mkdirSync(join(repo, '.agents', 'custom'), { recursive: true })
    writeFileSync(join(repo, '.agents', 'custom', 'config.json'), '{}', 'utf8')

    const profile = makeProfile(repo, { withLogo: true })
    const projection = new AcademyPluginRepositoryProjection()

    await projection.project(repo, profile, [], revision)

    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# Human documentation')
    expect(readFileSync(join(repo, 'LICENSE'), 'utf8')).toBe('MIT License')
    expect(existsSync(join(repo, '.agents', 'custom', 'config.json'))).toBe(true)
  })

  it('validation: passes for a complete, well-formed plugin repository', async () => {
    const repo = root()
    const profile = makeProfile(repo, { withLogo: true })
    const pkg = {
      skillMd: '---\nname: my-skill\ndescription: Test skill\n---\n# My Skill\n',
      artifacts: { 'references/guide.md': '# Guide\n' }
    }
    const materializer = new AcademyGitMaterializer()
    const snapshot: AcademyOpenAiSnapshotEntry[] = [
      {
        skillId: 's1',
        name: 'my-skill',
        academyVersion: 1,
        packageHash: hashAcademyPackage(pkg)
      }
    ]

    await materializer.materialize(repo, [
      {
        skillId: 's1',
        name: 'my-skill',
        version: 1,
        packageHash: hashAcademyPackage(pkg),
        package: pkg
      }
    ])

    const projection = new AcademyPluginRepositoryProjection()
    await projection.project(repo, profile, snapshot, revision)

    // Validate must pass without throwing
    await expect(projection.validate(repo, profile, snapshot)).resolves.toBeUndefined()
  })

  it('validation: rejects if logo is missing when configured', async () => {
    const repo = root()
    const profile = makeProfile(repo, { withLogo: true })
    const pkg = {
      skillMd: '---\nname: my-skill\ndescription: Test skill\n---\n# My Skill\n',
      artifacts: {}
    }
    const materializer = new AcademyGitMaterializer()
    const snapshot: AcademyOpenAiSnapshotEntry[] = [
      { skillId: 's1', name: 'my-skill', academyVersion: 1, packageHash: hashAcademyPackage(pkg) }
    ]
    await materializer.materialize(repo, [
      { skillId: 's1', name: 'my-skill', version: 1, packageHash: hashAcademyPackage(pkg), package: pkg }
    ])

    const projection = new AcademyPluginRepositoryProjection()
    await projection.project(repo, profile, snapshot, revision)

    // Delete the logo manually
    rmSync(join(repo, 'assets', 'logo.png'))

    await expect(projection.validate(repo, profile, snapshot)).rejects.toThrow(/CONFIGURED_LOGO_MISSING/)
  })

  it('validation: rejects if logo has invalid format or dimensions', async () => {
    const repo = root()
    const profile = makeProfile(repo, { withLogo: true, invalidLogo: true })
    const pkg = {
      skillMd: '---\nname: my-skill\ndescription: Test skill\n---\n# My Skill\n',
      artifacts: {}
    }
    const materializer = new AcademyGitMaterializer()
    const snapshot: AcademyOpenAiSnapshotEntry[] = [
      { skillId: 's1', name: 'my-skill', academyVersion: 1, packageHash: hashAcademyPackage(pkg) }
    ]
    await materializer.materialize(repo, [
      { skillId: 's1', name: 'my-skill', version: 1, packageHash: hashAcademyPackage(pkg), package: pkg }
    ])

    const projection = new AcademyPluginRepositoryProjection()
    await projection.project(repo, profile, snapshot, revision)

    await expect(projection.validate(repo, profile, snapshot)).rejects.toThrow(/LOGO_UNSUPPORTED_FORMAT/)
  })
})
