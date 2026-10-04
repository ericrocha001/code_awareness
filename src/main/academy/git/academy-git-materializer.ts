import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AcademyPackage } from '../../../shared/types/academy-types'
import { AcademyError, normalizeAcademyPackage, parseSkillMetadata } from '../academy-package'
import { removeSkillDirectory, writeSkillDirectory } from '../academy-filesystem'

export interface AcademyGitSnapshotEntry {
  skillId: string
  name: string
  version: number
  packageHash: string
  package: AcademyPackage
}

export function computeGitSnapshotHash(entries: Array<Omit<AcademyGitSnapshotEntry, 'package'>>): string {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  const hash = createHash('sha256')
  for (const item of sorted) {
    hash.update(`${item.skillId}:${item.name}:${item.version}:${item.packageHash};`)
  }
  return hash.digest('hex')
}

export function validateGitSnapshot(
  entries: AcademyGitSnapshotEntry[],
  options?: { isPublic?: boolean }
): void {
  for (const entry of entries) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(entry.name)) {
      throw new AcademyError('INVALID_SKILL_NAME', `INVALID_SKILL_NAME: ${entry.name}`)
    }
    const pkg = normalizeAcademyPackage(entry.package)
    const meta = parseSkillMetadata(pkg.skillMd)
    if (meta.name !== entry.name) {
      throw new AcademyError('SKILL_NAME_MISMATCH', `SKILL_NAME_MISMATCH: ${meta.name} does not match directory ${entry.name}`)
    }
    const allTexts = [pkg.skillMd, ...Object.values(pkg.artifacts)]
    for (const text of allTexts) {
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b/.test(text)) {
        throw new AcademyError('KNOWN_SECRET_DETECTED', `KNOWN_SECRET_DETECTED: ${entry.name}`)
      }
    }
  }
}

export class AcademyGitMaterializer {
  async materialize(repoRoot: string, entries: AcademyGitSnapshotEntry[]): Promise<{
    created: string[]
    updated: string[]
    removed: string[]
  }> {
    const skillsDir = join(repoRoot, 'skills')
    const activeNames = new Set(entries.map((e) => e.name))
    const existingDirs = existsSync(skillsDir)
      ? (await readdir(skillsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
      : []

    const created: string[] = []
    const updated: string[] = []
    const removed: string[] = []

    for (const dirName of existingDirs) {
      if (!activeNames.has(dirName)) {
        await removeSkillDirectory(join(skillsDir, dirName))
        removed.push(dirName)
      }
    }

    for (const entry of entries) {
      const targetDir = join(skillsDir, entry.name)
      const isExisting = existingDirs.includes(entry.name)
      await writeSkillDirectory(targetDir, entry.package)
      if (isExisting) updated.push(entry.name)
      else created.push(entry.name)
    }

    return { created, updated, removed }
  }
}
