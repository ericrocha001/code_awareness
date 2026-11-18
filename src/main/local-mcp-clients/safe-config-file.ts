import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promises as fs, type Stats } from 'node:fs'

function existingAncestor(path: string): string {
  while (!existsSync(path)) path = dirname(path)
  return path
}

function assertOwnership(paths: string[], timeout: number): void {
  if (process.platform === 'win32') {
    const literals = paths.map(path => "'" + path.replaceAll("'", "''") + "'").join(',')
    const command = `$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; foreach ($p in @(${literals})) { $acl=if ([System.IO.Directory]::Exists($p)) {[System.IO.Directory]::GetAccessControl($p)} else {[System.IO.File]::GetAccessControl($p)}; if ($me -ne $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) {exit 1} }`
    try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'pipe', windowsHide: true, timeout }) }
    catch { throw new Error('PROFILE_OWNERSHIP_UNVERIFIED') }
  } else if (paths.some(path => lstatSync(path).uid !== process.getuid?.())) throw new Error('PROFILE_OWNERSHIP_UNVERIFIED')
}

export function assertUserOwned(path: string): void {
  assertOwnership([existingAncestor(path)], 5000)
}

export function verifyConfigWriteOwnership(paths: readonly string[], timeout: number): (path: string) => void {
  const ancestors = new Map(paths.map(path => [path, existingAncestor(path)]))
  const identity = (path: string) => {
    const stat = lstatSync(path, { bigint: true })
    return [stat.dev, stat.ino, stat.birthtimeNs].join(':')
  }
  const observed = new Map([...new Set(ancestors.values())].map(path => [path, identity(path)]))
  assertOwnership([...observed.keys()], timeout)
  const checked = new Set<string>()
  return path => {
    const ancestor = ancestors.get(path)
    if (!ancestor || checked.has(path) || identity(ancestor) !== observed.get(ancestor)) throw new Error('PROFILE_OWNERSHIP_UNVERIFIED')
    checked.add(path)
  }
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

export function removeConfig(path: string, profile: string, expected: FileRevision, verifyOwner = assertUserOwned): void {
  assertProfilePath(path, profile)
  verifyOwner(path)
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

export function writeConfig(path: string, profile: string, expected: FileRevision, content: string, beforePublish?: () => void, afterMove?: () => void, verifyOwner = assertUserOwned): void {
  assertProfilePath(path, profile)
  verifyOwner(path)
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

export async function assertUserOwnedAsync(path: string): Promise<void> {
  let existing = path
  while (!existsSync(existing)) existing = dirname(existing)
  if (process.platform !== 'win32') {
    if ((await fs.lstat(existing)).uid !== process.getuid?.()) throw new Error('PROFILE_OWNERSHIP_UNVERIFIED')
    return
  }
  const literal = existing.split("'").join("''")
  const command = `$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=if ([System.IO.Directory]::Exists('${literal}')) {[System.IO.Directory]::GetAccessControl('${literal}')} else {[System.IO.File]::GetAccessControl('${literal}')}; if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $me) {exit 1}`
  await new Promise<void>((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 5000 }, error => error ? reject(new Error('PROFILE_OWNERSHIP_UNVERIFIED')) : resolve()))
}

export async function revisionAsync(path: string): Promise<FileRevision> {
  let stat: Stats
  try { stat = await fs.lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: null, hash: 'ABSENT', identity: 'ABSENT' }
    throw error
  }
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('UNSAFE_CONFIG_FILE')
  const content = await fs.readFile(path, 'utf8')
  return { content, hash: createHash('sha256').update(content).digest('hex'), identity: `${stat.dev}:${stat.ino}:${stat.mode}` }
}

export async function writeConfigAsync(path: string, profile: string, expected: FileRevision, content: string): Promise<void> {
  const check = async (target = path) => {
    const actual = await revisionAsync(target)
    if (actual.hash !== expected.hash || actual.identity !== expected.identity) throw new Error('CONFIG_REVISION_CONFLICT')
  }
  assertProfilePath(path, profile); await assertUserOwnedAsync(path); await check()
  if (expected.content === content) return
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  assertProfilePath(path, profile)
  const temp = `${path}.${randomUUID()}.tmp`, backup = `${path}.${randomUUID()}.rollback`
  let moved = false, published = false
  try {
    const file = await fs.open(temp, 'wx', 0o600)
    try { await file.writeFile(content, 'utf8'); await file.sync() } finally { await file.close() }
    assertProfilePath(path, profile); await check()
    if (expected.content !== null) { await fs.rename(path, backup); moved = true; await check(backup) }
    assertProfilePath(path, profile)
    await fs.link(temp, path); published = true
    await fs.unlink(temp)
    if (moved) await fs.unlink(backup)
  } catch (error) {
    if (moved && !published && !existsSync(path)) { await fs.link(backup, path); await fs.unlink(backup); moved = false }
    if (existsSync(temp)) await fs.unlink(temp)
    if (moved && existsSync(backup) && existsSync(path) && await fs.readFile(path, 'utf8') === expected.content) await fs.unlink(backup)
    throw error
  }
}
