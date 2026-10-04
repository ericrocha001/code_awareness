import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AcademyPackage } from '../../shared/types/academy-types'
import { AcademyError, normalizeAcademyPackage } from './academy-package'

const decoder = new TextDecoder('utf-8', { fatal: true })

export async function readSkillDirectory(directory: string): Promise<AcademyPackage> {
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

export async function writeSkillDirectory(directory: string, input: AcademyPackage): Promise<void> {
  const pkg = normalizeAcademyPackage(input)
  await mkdir(directory, { recursive: true })
  const root = resolve(directory)
  const expected = new Set(['SKILL.md', ...Object.keys(pkg.artifacts)])
  const existing: string[] = []
  const collect = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isSymbolicLink()) throw new AcademyError('SYMLINK_NOT_ALLOWED', `Refusing to project through symbolic link: ${absolute}`)
      if (entry.isDirectory()) await collect(absolute)
      else if (entry.isFile()) existing.push(relative(root, absolute).split(sep).join('/'))
    }
  }
  await collect(directory)
  const entries: Array<[string, string]> = [['SKILL.md', pkg.skillMd], ...Object.entries(pkg.artifacts)]
  for (const [path, content] of entries) {
    const absolute = resolve(root, ...path.split('/'))
    if (!isWithin(root, absolute)) throw new AcademyError('PATH_ESCAPE')
    await mkdir(dirname(absolute), { recursive: true })
    let same = false
    try { same = decoder.decode(await readFile(absolute)) === content } catch {}
    if (!same) await writeFile(absolute, content, 'utf8')
  }
  for (const path of existing.filter((path) => !expected.has(path)).sort((a, b) => b.length - a.length)) {
    const absolute = resolve(root, ...path.split('/'))
    if (isWithin(root, absolute)) await rm(absolute, { force: true })
  }
  await removeEmptyDirectories(directory)
}

export async function removeSkillDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true })
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function removeEmptyDirectories(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const child = join(root, entry.name)
    await removeEmptyDirectories(child)
    if ((await readdir(child)).length === 0) await rm(child, { recursive: true })
  }
}
