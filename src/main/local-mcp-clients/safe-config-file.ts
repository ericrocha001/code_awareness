import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'

export function assertUserOwned(path: string): void {
  let existing = path
  while (!existsSync(existing)) existing = dirname(existing)
  if (process.platform === 'win32') {
    const literal = existing.replaceAll("'", "''")
    const command = `$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=if ([System.IO.Directory]::Exists('${literal}')) {[System.IO.Directory]::GetAccessControl('${literal}')} else {[System.IO.File]::GetAccessControl('${literal}')}; $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; if ($me -ne $owner) {exit 1}`
    try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'pipe', windowsHide: true, timeout: 5000 }) }
    catch { throw new Error('PROFILE_OWNERSHIP_UNVERIFIED') }
  } else if (lstatSync(existing).uid !== process.getuid?.()) throw new Error('PROFILE_OWNERSHIP_UNVERIFIED')
}

export interface FileRevision { content: string | null; hash: string; identity: string }
export function assertProfilePath(path: string, profile: string): void {
  const rel = relative(resolve(profile), resolve(path))
  if (!isAbsolute(path) || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('OUTSIDE_USER_PROFILE')
  let current = resolve(path)
  while (true) {
    if (existsSync(current)) {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || stat.nlink > 1 && stat.isFile()) throw new Error('CONFIG_LINK_NOT_ALLOWED')
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}
export function revision(path: string): FileRevision {
  if (!existsSync(path)) return { content: null, hash: 'ABSENT', identity: 'ABSENT' }
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('UNSAFE_CONFIG_FILE')
  const content = readFileSync(path, 'utf8')
  return { content, hash: createHash('sha256').update(content).digest('hex'), identity: `${stat.dev}:${stat.ino}:${stat.mode}` }
}
export function assertRevision(path: string, expected: FileRevision) {
  const actual = revision(path)
  if (actual.hash !== expected.hash || actual.identity !== expected.identity) throw new Error('CONFIG_REVISION_CONFLICT')
}

export function removeConfig(path: string, profile: string, expected: FileRevision): void {
  assertProfilePath(path, profile)
  assertUserOwned(path)
  assertRevision(path, expected)
  if (expected.content === null) return
  const backup = `${path}.${randomUUID()}.rollback`
  renameSync(path, backup)
  try { assertRevision(backup, expected); unlinkSync(backup) }
  catch (error) {
    if (!existsSync(path)) { linkSync(backup, path); unlinkSync(backup) }
    throw error
  }
}

export function writeConfig(path: string, profile: string, expected: FileRevision, content: string, beforePublish?: () => void, afterMove?: () => void): void {
  assertProfilePath(path, profile)
  assertUserOwned(path)
  assertRevision(path, expected)
  if (expected.content === content) return
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  assertProfilePath(path, profile)
  const temp = `${path}.${randomUUID()}.tmp`, backup = `${path}.${randomUUID()}.rollback`
  let moved = false, published = false
  try {
    const fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, content, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
    beforePublish?.()
    assertProfilePath(path, profile)
    assertRevision(path, expected)
    if (expected.content !== null) {
      renameSync(path, backup); moved = true
      assertRevision(backup, expected)
    }
    afterMove?.()
    assertProfilePath(path, profile)
    linkSync(temp, path)
    published = true
    unlinkSync(temp)
    if (moved) unlinkSync(backup)
  } catch (error) {
    if (moved && !published && !existsSync(path)) { linkSync(backup, path); unlinkSync(backup); moved = false }
    if (existsSync(temp)) unlinkSync(temp)
    if (moved && existsSync(backup) && existsSync(path) && readFileSync(path, 'utf8') === expected.content) unlinkSync(backup)
    throw error
  }
}
