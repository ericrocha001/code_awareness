import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcademyGitMaterializer, assertPublicationPaths, computeGitSnapshotHash, validateGitSnapshot } from './academy-git-materializer'
import type { AcademyGitSnapshotEntry } from './academy-git-materializer'
import { hashAcademyPackage } from '../academy-package'
import { removeSkillDirectory, writeSkillDirectory } from '../academy-filesystem'

const { afterMkdir } = vi.hoisted(() => ({ afterMkdir: vi.fn() }))
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, mkdirSync: (...args: Parameters<typeof original.mkdirSync>) => {
    const result = original.mkdirSync(...args)
    afterMkdir(args[0])
    return result
  } }
})

const roots: string[] = []
const root = () => {
  const value = mkdtempSync(join(tmpdir(), 'academy-mat-'))
  roots.push(value)
  return value
}

const makeSkill = (name: string, body = '# Skill Body', artifacts: Record<string, string> = {}): AcademyGitSnapshotEntry => {
  const pkg = {
    skillMd: `---\nname: ${name}\ndescription: Description for ${name}\n---\n\n${body}\n`,
    artifacts
  }
  return {
    skillId: `id-${name}`,
    name,
    version: 1,
    packageHash: hashAcademyPackage(pkg),
    package: pkg
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  afterMkdir.mockReset()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('AcademyGitMaterializer', () => {
  it.each(['alpha', 'alpha/ref'])('rejects a junction at skills/%s and preserves the external package and sentinel', async (link) => {
    const repo = root(), external = root()
    const target = join(repo, 'skills', link)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(join(external, 'sentinel.txt'), 'preserve sentinel')
    writeFileSync(join(external, 'SKILL.md'), 'external skill')
    symlinkSync(external, target, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(new AcademyGitMaterializer().materialize(repo, [makeSkill('alpha', '# Canonical', { 'ref/doc.md': 'canonical doc' })])).rejects.toMatchObject({ code: 'SYMLINK_NOT_ALLOWED' })
    expect(readFileSync(join(external, 'sentinel.txt'), 'utf8')).toBe('preserve sentinel')
    expect(readFileSync(join(external, 'SKILL.md'), 'utf8')).toBe('external skill')
    expect(existsSync(join(external, 'doc.md'))).toBe(false)
  })

  it('rejects a linked Skill root when the filesystem writer is called directly', async () => {
    const directory = root(), external = root()
    writeFileSync(join(external, 'sentinel.txt'), 'preserve')
    symlinkSync(external, join(directory, 'alpha'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(writeSkillDirectory(join(directory, 'alpha'), makeSkill('alpha').package)).rejects.toMatchObject({ code: 'SYMLINK_NOT_ALLOWED' })
    expect(readFileSync(join(external, 'sentinel.txt'), 'utf8')).toBe('preserve')
    expect(existsSync(join(external, 'SKILL.md'))).toBe(false)
  })
  it('rejects a junction in an obsolete Skill before deleting or updating any existing package', async () => {
    const repo = root(), external = root()
    mkdirSync(join(repo, 'skills', 'safe'), { recursive: true })
    mkdirSync(join(repo, 'skills', 'obsolete'), { recursive: true })
    writeFileSync(join(repo, 'skills', 'safe', 'SKILL.md'), 'existing safe package')
    writeFileSync(join(external, 'sentinel.txt'), 'preserve')
    symlinkSync(external, join(repo, 'skills', 'obsolete', 'ref'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(new AcademyGitMaterializer().materialize(repo, [makeSkill('safe')])).rejects.toMatchObject({ code: 'SYMLINK_NOT_ALLOWED' })
    await expect(removeSkillDirectory(join(repo, 'skills', 'obsolete'))).rejects.toMatchObject({ code: 'SYMLINK_NOT_ALLOWED' })
    expect(readFileSync(join(external, 'sentinel.txt'), 'utf8')).toBe('preserve')
    expect(readFileSync(join(repo, 'skills', 'safe', 'SKILL.md'), 'utf8')).toBe('existing safe package')
  })
  it('rechecks a Skill root replaced after inspection and before the effective write', async () => {
    const directory = root(), external = root()
    const skillPath = join(directory, 'alpha')
    mkdirSync(skillPath)
    writeFileSync(join(external, 'sentinel.txt'), 'preserve')
    afterMkdir.mockImplementation((path) => {
      if (String(path) === skillPath) {
        rmSync(skillPath, { recursive: true })
        symlinkSync(external, skillPath, process.platform === 'win32' ? 'junction' : 'dir')
      }
    })
    await expect(writeSkillDirectory(skillPath, makeSkill('alpha').package)).rejects.toMatchObject({ code: 'SYMLINK_NOT_ALLOWED' })
    expect(readFileSync(join(external, 'sentinel.txt'), 'utf8')).toBe('preserve')
    expect(existsSync(join(external, 'SKILL.md'))).toBe(false)
  })
  it('rejects dangling links in managed parents before projection can write outside its checkout', () => {
    const directory = root()
    symlinkSync(join(directory, 'missing-target'), join(directory, 'assets'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => assertPublicationPaths(directory, ['assets/logo.png'])).toThrow('PUBLICATION_SYMLINK_NOT_ALLOWED')
  })
  it('materializes skills deterministically under skills/ without touching external files', async () => {
    const repo = root()
    // External files that must never be touched
    writeFileSync(join(repo, 'README.md'), '# Academy Repository', 'utf8')
    writeFileSync(join(repo, 'plugin.json'), '{"name": "test"}', 'utf8')

    const materializer = new AcademyGitMaterializer()
    const snapshot: AcademyGitSnapshotEntry[] = [
      makeSkill('skill-b', '# Skill B', { 'ref/doc.md': 'Doc B' }),
      makeSkill('skill-a', '# Skill A')
    ]

    const result = await materializer.materialize(repo, snapshot)
    expect(result.created.sort()).toEqual(['skill-a', 'skill-b'])

    expect(readFileSync(join(repo, 'skills/skill-a/SKILL.md'), 'utf8')).toContain('# Skill A')
    expect(readFileSync(join(repo, 'skills/skill-b/SKILL.md'), 'utf8')).toContain('# Skill B')
    expect(readFileSync(join(repo, 'skills/skill-b/ref/doc.md'), 'utf8')).toBe('Doc B')

    // External files preserved
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# Academy Repository')
    expect(readFileSync(join(repo, 'plugin.json'), 'utf8')).toBe('{"name": "test"}')

    // Deterministic snapshot hash
    const hash1 = computeGitSnapshotHash(snapshot)
    const hash2 = computeGitSnapshotHash([snapshot[1], snapshot[0]])
    expect(hash1).toBe(hash2)

    // Re-materializing the exact same snapshot produces no newly created files and leaves tree identical
    const rematerialized = await materializer.materialize(repo, snapshot)
    expect(rematerialized.created).toHaveLength(0)
    expect(rematerialized.removed).toHaveLength(0)
    expect(rematerialized.updated.sort()).toEqual(['skill-a', 'skill-b'])
  })


  it('handles updates, archive/removal, and renames', async () => {
    const repo = root()
    const materializer = new AcademyGitMaterializer()

    // Initial state: skill-one and skill-to-archive
    const initial: AcademyGitSnapshotEntry[] = [
      makeSkill('skill-one', '# Version 1'),
      makeSkill('skill-to-archive', '# To Archive')
    ]
    await materializer.materialize(repo, initial)
    expect(existsSync(join(repo, 'skills/skill-to-archive'))).toBe(true)

    // Archive skill-to-archive, update skill-one, rename (skill-one -> skill-renamed)
    const updated: AcademyGitSnapshotEntry[] = [
      makeSkill('skill-renamed', '# Renamed Body')
    ]
    const result = await materializer.materialize(repo, updated)
    expect(result.removed.sort()).toEqual(['skill-one', 'skill-to-archive'])
    expect(result.created).toEqual(['skill-renamed'])
    expect(existsSync(join(repo, 'skills/skill-to-archive'))).toBe(false)
    expect(existsSync(join(repo, 'skills/skill-one'))).toBe(false)
    expect(existsSync(join(repo, 'skills/skill-renamed/SKILL.md'))).toBe(true)
  })

  it('rejects secrets and invalid frontmatter names during snapshot validation', () => {
    const safe = [makeSkill('valid-skill')]
    expect(() => validateGitSnapshot(safe)).not.toThrow()

    const withSecret = [
      makeSkill('leaky-skill', '# Leaky', {
        'leak.txt': 'sk-proj-123456789012345678901234'
      })
    ]
    expect(() => validateGitSnapshot(withSecret)).toThrowError(/KNOWN_SECRET_DETECTED/)

    const invalidName: AcademyGitSnapshotEntry = {
      skillId: 'id-invalid',
      name: 'Invalid_Name!',
      version: 1,
      packageHash: 'hash',
      package: {
        skillMd: '---\nname: Invalid_Name!\ndescription: bad\n---\n# Bad',
        artifacts: {}
      }
    }
    expect(() => validateGitSnapshot([invalidName])).toThrowError(/INVALID_SKILL_NAME/)
  })
})
