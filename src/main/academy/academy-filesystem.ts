import { lstat, readFile, readdir, realpath, rm, rename } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { AcademyPackage } from '../../shared/types/academy-types'
import { AcademyError, hashAcademyPackage, normalizeAcademyPackage } from './academy-package'

const decoder = new TextDecoder('utf-8', { fatal: true })

export interface AcademyDiskObservation { hash: string; package: AcademyPackage | null }

export async function observeSkillDirectory(directory: string): Promise<AcademyDiskObservation> {
  try {
    const pkg = await readSkillDirectory(directory)
    return { hash: hashAcademyPackage(pkg), package: pkg }
  } catch (error: any) {
    try { await lstat(directory) } catch (missing: any) {
      if (missing.code === 'ENOENT') return { hash: 'DELETED', package: null }
      throw missing
    }
    const hash = createHash('sha256')
    const visit = async (path: string): Promise<void> => {
      for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = join(path, entry.name)
        hash.update(JSON.stringify(relative(directory, absolute)))
        if (entry.isSymbolicLink()) hash.update('SYMLINK')
        else if (entry.isDirectory()) await visit(absolute)
        else if (entry.isFile()) hash.update(await readFile(absolute))
      }
    }
    if ((await lstat(directory)).isSymbolicLink()) hash.update('SYMLINK_ROOT')
    else await visit(directory)
    return { hash: `INVALID:${error.code ?? 'PACKAGE'}:${hash.digest('hex')}`, package: null }
  }
}

export async function observeStableSkillDirectory(directory: string, delayMs = 250): Promise<AcademyDiskObservation | null> {
  let previous: AcademyDiskObservation | null = null
  for (let attempt = 0; attempt < 4; attempt++) {
    let current: AcademyDiskObservation | null
    try { current = await observeSkillDirectory(directory) } catch { current = null }
    if (previous && current?.hash === previous.hash) return current
    previous = current
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return null
}

export async function replaceSkillDirectory(directory: string, pkg: AcademyPackage, expectedHash: string): Promise<void> {
  const staging = join(dirname(directory), `.academy-stage-${randomUUID()}`)
  const backup = join(dirname(directory), `.academy-backup-${randomUUID()}`)
  let moved = false
  try {
    await writeSkillDirectory(staging, pkg)
    if ((await observeSkillDirectory(directory)).hash !== expectedHash) throw new AcademyError('PROJECTION_CHANGED')
    if (expectedHash !== 'DELETED') {
      await rename(directory, backup)
      moved = true
      if ((await observeSkillDirectory(backup)).hash !== expectedHash) throw new AcademyError('PROJECTION_CHANGED')
    }
    await rename(staging, directory)
    if (moved) await rm(backup, { recursive: true, force: true })
  } catch (error) {
    if (moved) {
      try { await rename(backup, directory) } catch { throw new AcademyError('PROJECTION_RECOVERY_REQUIRED', `Preserved original package at ${backup}`) }
    }
    throw error
  } finally { await rm(staging, { recursive: true, force: true }) }
}

export async function readSkillDirectory(directory: string): Promise<AcademyPackage> {
  if ((await lstat(directory)).isSymbolicLink()) throw new AcademyError('SYMLINK_NOT_ALLOWED', `Symbolic links are not allowed: ${directory}`)
  const root = await realpath(directory)
  const artifacts: Record<string, string> = {}
  let skillMd: string | null = null
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isSymbolicLink() || (await lstat(absolute)).isSymbolicLink()) throw new AcademyError('SYMLINK_NOT_ALLOWED', `Symbolic links are not allowed: ${absolute}`)
      if (entry.isDirectory()) { await visit(absolute); continue }
      if (!entry.isFile()) continue
      const canonical = await realpath(absolute)
      if (!isWithin(root, canonical)) throw new AcademyError('PATH_ESCAPE', `File escaped skill directory: ${absolute}`)
      const path = relative(root, canonical).split(sep).join('/')
      let content: string
      try { content = decoder.decode(await readFile(canonical)) } catch { throw new AcademyError('NON_TEXT_ARTIFACT', `Artifact is not UTF-8 text: ${path}`) }
      if (path === 'SKILL.md') skillMd = content
      else artifacts[path] = content
    }
  }
  await visit(root)
  if (skillMd === null) throw new AcademyError('SKILL_MD_MISSING', `SKILL.md not found in ${directory}`)
  return normalizeAcademyPackage({ skillMd, artifacts })
}

export function assertAcademyPathHasNoLinks(path: string): void {
  const absolute = resolve(path)
  const anchor = parse(absolute).root
  let current = anchor
  for (const part of relative(anchor, absolute).split(sep).filter(Boolean)) {
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new AcademyError('SYMLINK_NOT_ALLOWED', `Unsafe Academy mutation path: ${current}`)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}

export function listSkillFilesWithoutLinks(directory: string): string[] {
  assertAcademyPathHasNoLinks(directory)
  try { lstatSync(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files: string[] = []
  const collect = (current: string): void => {
    assertAcademyPathHasNoLinks(current)
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      assertAcademyPathHasNoLinks(absolute)
      if (lstatSync(absolute).isDirectory()) collect(absolute)
      else files.push(relative(directory, absolute).split(sep).join('/'))
    }
  }
  collect(directory)
  return files
}

export async function writeSkillDirectory(directory: string, input: AcademyPackage): Promise<void> {
  const pkg = normalizeAcademyPackage(input)
  const root = resolve(directory)
  const expected = new Set(['SKILL.md', ...Object.keys(pkg.artifacts)])
  const existing = listSkillFilesWithoutLinks(directory)
  const entries: Array<[string, string]> = [['SKILL.md', pkg.skillMd], ...Object.entries(pkg.artifacts)]
  // Keep link verification and each mutation synchronous; an await would reopen the checked path.
  for (const [path, content] of entries) {
    const absolute = resolve(root, ...path.split('/'))
    if (!isWithin(root, absolute)) throw new AcademyError('PATH_ESCAPE')
    assertAcademyPathHasNoLinks(absolute)
    mkdirSync(dirname(absolute), { recursive: true })
    assertAcademyPathHasNoLinks(absolute)
    let same = false
    try { same = decoder.decode(readFileSync(absolute)) === content } catch {}
    if (!same) {
      assertAcademyPathHasNoLinks(absolute)
      const file = openSync(absolute, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0))
      try {
        assertAcademyPathHasNoLinks(absolute)
        const current = lstatSync(absolute), opened = fstatSync(file)
        if (!opened.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) throw new AcademyError('PROJECTION_CHANGED')
        ftruncateSync(file, 0)
        writeFileSync(file, content, 'utf8')
      } finally { closeSync(file) }
    }
  }
  for (const path of existing.filter((path) => !expected.has(path)).sort((a, b) => b.length - a.length)) {
    const absolute = resolve(root, ...path.split('/'))
    if (isWithin(root, absolute)) {
      assertAcademyPathHasNoLinks(absolute)
      rmSync(absolute, { force: true })
    }
  }
  removeEmptyDirectories(directory)
}

export async function removeSkillDirectory(directory: string): Promise<void> {
  listSkillFilesWithoutLinks(directory)
  assertAcademyPathHasNoLinks(directory)
  rmSync(directory, { recursive: true, force: true })
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function removeEmptyDirectories(root: string): void {
  assertAcademyPathHasNoLinks(root)
  const entries = readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const child = join(root, entry.name)
    assertAcademyPathHasNoLinks(child)
    removeEmptyDirectories(child)
    assertAcademyPathHasNoLinks(child)
    if (readdirSync(child).length === 0) {
      assertAcademyPathHasNoLinks(child)
      rmSync(child, { recursive: true })
    }
  }
}
