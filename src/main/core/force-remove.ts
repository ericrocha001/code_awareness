import { chmodSync, lstatSync, readdirSync, realpathSync, rmdirSync, Stats, unlinkSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'

function isSameOrInside(root: string, candidate: string): boolean {
  const norm = (value: string) => {
    const resolved = normalize(value).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const base = norm(root)
  const target = norm(candidate)
  return target === base || target.startsWith(base + sep)
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EACCES'
}

function unlinkSymbolicLink(target: string): void {
  try {
    unlinkSync(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return
    if (code === 'EPERM' || code === 'EISDIR') {
      rmdirSync(target)
      return
    }
    throw error
  }
}

function unlinkRegularEntry(target: string): void {
  try {
    unlinkSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return
    if (!isPermissionError(error)) throw error
    if (lstatSync(target).isSymbolicLink()) {
      unlinkSymbolicLink(target)
      return
    }
    chmodSync(target, 0o600)
    unlinkSync(target)
  }
}

function removeDirectoryEntry(target: string, rootRealPath: string): void {
  let stat: Stats
  try {
    stat = lstatSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return
    throw error
  }

  if (stat.isSymbolicLink()) {
    unlinkSymbolicLink(target)
    return
  }

  if (!stat.isDirectory()) {
    unlinkRegularEntry(target)
    return
  }

  const currentRealPath = realpathSync(target)
  if (!isSameOrInside(rootRealPath, currentRealPath)) {
    throw new Error(`FORCE_REMOVE_ESCAPE: ${target}`)
  }

  let entries: string[]
  try {
    entries = readdirSync(target)
  } catch (error) {
    if (!isPermissionError(error)) throw error
    if (lstatSync(target).isSymbolicLink()) {
      unlinkSymbolicLink(target)
      return
    }
    chmodSync(target, 0o700)
    entries = readdirSync(target)
  }

  for (const entry of entries) {
    removeDirectoryEntry(join(target, entry), rootRealPath)
  }

  try {
    rmdirSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return
    if (!isPermissionError(error)) throw error
    if (lstatSync(target).isSymbolicLink()) {
      unlinkSymbolicLink(target)
      return
    }
    chmodSync(target, 0o700)
    rmdirSync(target)
  }
}

/** Electron 45 on Windows fails rmSync on read-only Git files with EPERM and follows junctions; traverse with lstat confinement instead. */
export function removeDirectoryForceSync(target: string): void {
  let stat: Stats
  try {
    stat = lstatSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return
    throw error
  }

  if (stat.isSymbolicLink()) {
    unlinkSymbolicLink(target)
    return
  }

  if (!stat.isDirectory()) {
    unlinkRegularEntry(target)
    return
  }

  const rootRealPath = realpathSync(target)
  removeDirectoryEntry(target, rootRealPath)
}
