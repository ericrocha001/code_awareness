import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AcademyGitMaterializer, computeGitSnapshotHash, validateGitSnapshot } from './academy-git-materializer'
import type { AcademyGitSnapshotEntry } from './academy-git-materializer'
import { hashAcademyPackage } from '../academy-package'

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
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('AcademyGitMaterializer', () => {
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
