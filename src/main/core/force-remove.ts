import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

function makeWritableRecursive(target: string): void {
  const stat = lstatSync(target)
  chmodSync(target, 0o700)
  if (!stat.isDirectory()) return
  for (const entry of readdirSync(target)) makeWritableRecursive(join(target, entry))
}

/** Electron 45 on Windows rejects rmSync on read-only Git pack/object files with EPERM. */
export function removeDirectoryForceSync(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES')) throw error
    makeWritableRecursive(target)
    rmSync(target, { recursive: true, force: true })
  }
}
