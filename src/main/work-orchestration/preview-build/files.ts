import { createHash } from 'node:crypto'
import * as nodeFiles from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const { lstat, mkdir, readdir, readFile, realpath, rm, writeFile }: typeof nodeFiles = process.versions.electron ? createRequire(__filename)('original-fs').promises : nodeFiles

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
export interface BuildFile { path: string; bytes: number; sha256: string }
export function inside(root: string, path: string) {
  const scope = relative(root, path)
  if (scope === '..' || scope.startsWith('..' + sep) || isAbsolute(scope)) throw Error('BUILD_PATH_REJECTED')
}
export async function physical(path: string) {
  const absolute = resolve(path)
  for (let current = absolute;; current = dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) throw Error('BUILD_PATH_REJECTED')
    if (dirname(current) === current) break
  }
  return realpath(absolute)
}
export async function tree(root: string, select: (path: string, directory: boolean) => boolean = () => true): Promise<string[]> {
  await physical(root)
  const files: string[] = []
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name), path = relative(root, file).replace(/\\/g, '/')
      if (!select(path, entry.isDirectory())) continue
      if (entry.isSymbolicLink()) throw Error('BUILD_PATH_REJECTED')
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) files.push(path)
      else throw Error('BUILD_PATH_REJECTED')
      if (files.length > 100000) throw Error('BUILD_INPUT_LIMIT')
    }
  }
  await visit(root)
  return files.sort()
}
export async function snapshot(root: string, paths: string[], destination?: string): Promise<BuildFile[]> {
  const ordered = [...paths].sort(), files: BuildFile[] = [], names = new Set<string>()
  for (const path of ordered) {
    if (!path || isAbsolute(path) || /[\\:\0]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..') || names.has(path.toLowerCase())) throw Error('BUILD_PATH_REJECTED')
    names.add(path.toLowerCase())
  }
  let total = 0, cursor = 0, inMemory = 0, failure: unknown
  const waiting: Array<() => void> = [], directories = new Map<string, Promise<unknown>>()
  const reserve = async (size: number) => {
    while (inMemory + size > 268435456) await new Promise<void>(accept => waiting.push(accept))
    inMemory += size
    return () => { inMemory -= size; for (const accept of waiting.splice(0)) accept() }
  }
  const capture = async (path: string): Promise<BuildFile> => {
    const file = resolve(root, path); inside(root, file)
    const actual = await realpath(file)
    if ((process.platform === 'win32' ? actual.toLowerCase() !== file.toLowerCase() : actual !== file)) throw Error('BUILD_PATH_REJECTED')
    const before = await lstat(file, { bigint: true })
    if (!before.isFile() || before.size > 268435456n) throw Error('BUILD_INPUT_LIMIT')
    const release = await reserve(Number(before.size))
    try {
      const bytes = await readFile(file), after = await lstat(file, { bigint: true })
      if ([before.ino, before.size, before.mtimeNs, before.ctimeNs].join() !== [after.ino, after.size, after.mtimeNs, after.ctimeNs].join()) throw Error('CAPTURE_SOURCE_CHANGED')
      total += bytes.length
      if (total > 4 * 1024 ** 3) throw Error('BUILD_INPUT_LIMIT')
      if (destination) {
        const target = resolve(destination, path); inside(destination, target)
        const parent = dirname(target)
        if (!directories.has(parent)) directories.set(parent, mkdir(parent, { recursive: true }))
        await directories.get(parent); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
      }
      return { path, bytes: bytes.length, sha256: hash(bytes) }
    } finally { release() }
  }
  await Promise.all(Array.from({ length: Math.min(8, ordered.length) }, async () => {
    while (!failure) {
      const index = cursor++
      if (index >= ordered.length) return
      try { files[index] = await capture(ordered[index]) } catch (error) { failure ??= error }
    }
  }))
  if (failure) throw failure
  return files
}
export async function verify(root: string, files: BuildFile[]) {
  if (digest(await tree(root)) !== digest(files.map(f => f.path).sort()) || digest(await snapshot(root, files.map(f => f.path))) !== digest(files)) throw Error('BUILD_INTEGRITY_FAILED')
}
export async function removeOwned(root: string, target: string) {
  const base = await physical(root), actual = await physical(target)
  inside(base, actual)
  if (actual === base) throw Error('BUILD_PATH_REJECTED')
  await rm(actual, { recursive: true })
}
export const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
