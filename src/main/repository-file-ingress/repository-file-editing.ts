import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readFile, realpath, unlink } from 'node:fs/promises'
import { lstatSync, readFileSync, realpathSync, renameSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { RepositoryFileIngress, RepositoryFileIngressError, REPOSITORY_FILE_MAX_BYTES, relativeDestination, type RepositoryFileDescriptor } from './repository-file-ingress'

export class RepositoryFileEditingError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'RepositoryFileEditingError' }
}

export interface FileMutationIntent {
  description: string
  explicitUserAuthorization?: boolean
}

export interface RepositoryWriteReceipt {
  path: string
  operation: 'EDIT' | 'REPLACE'
  beforeSha256: string
  afterSha256: string
  size: number
  changed: boolean
  state: 'CONFIRMED'
}

const TEXT_LIMIT = 1024 * 1024
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const fail = (code: string): never => { throw new RepositoryFileEditingError(code) }

// Fixed program; paths are JSON stdin data, never PowerShell source. File.Replace preserves the Windows DACL.
const WINDOWS_REPLACE = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $v = [Console]::In.ReadToEnd() | ConvertFrom-Json
  foreach ($p in @($v.destination, $v.temporary)) {
    $item = [System.IO.FileInfo]::new($p)
    if (!$item.Exists -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) { exit 12 }
    $dir = $item.Directory
    while ($null -ne $dir) {
      if (($dir.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 12 }
      $dir = $dir.Parent
    }
  }
  $attributes = [System.IO.File]::GetAttributes($v.destination)
  if (($attributes -band ([System.IO.FileAttributes]::Hidden -bor [System.IO.FileAttributes]::System -bor [System.IO.FileAttributes]::ReadOnly)) -ne 0) { exit 14 }
  if ($v.prepare) {
    [System.IO.File]::SetAccessControl($v.temporary, [System.IO.File]::GetAccessControl($v.destination))
    exit 0
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($v.destination)
  try { $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() } finally { $stream.Dispose(); $sha.Dispose() }
  if ($hash -ne $v.expected) { exit 11 }
  [System.IO.File]::Replace($v.temporary, $v.destination, [NullString]::Value, $false)
  exit 0
} catch { exit 13 }
`

function windowsReplace(temporary: string, destination: string, expected: string, prepare = false): void {
  if (process.platform !== 'win32') { renameSync(temporary, destination); return }
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_REPLACE], {
    input: JSON.stringify({ temporary, destination, expected, prepare }), encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 1024
  })
  if (result.status === 11) fail('FILE_REVISION_CONFLICT')
  if (result.status === 12) fail('INVALID_PATH')
  if (result.status === 14) fail('PROTECTED_PATH')
  if (result.status !== 0) fail('WRITE_OUTCOME_UNKNOWN')
}

function commitFile(temporary: string, destination: string, expected: string): void { windowsReplace(temporary, destination, expected) }

export class RepositoryFileEditing {
  private readonly root: string
  private readonly pending = new Map<string, Promise<unknown>>()

  constructor(repositoryRoot: string, private readonly options: {
    isActive: () => boolean
    ingress?: RepositoryFileIngress
    commit?: typeof commitFile
  }) { this.root = realpathSync(repositoryRoot) }

  private active(): void { if (!this.options.isActive()) fail('REPOSITORY_CONTEXT_CHANGED') }

  assertCreationAllowed(value: string): void {
    try { this.target(value, { description: 'Create a new host file' }) } catch (error) {
      const code = error instanceof RepositoryFileEditingError ? error.code : 'INVALID_PATH'
      throw new RepositoryFileIngressError(code === 'PROTECTED_PATH' || code === 'REPOSITORY_CONTEXT_CHANGED' ? code : 'INVALID_PATH')
    }
  }

  private target(value: string, intent?: FileMutationIntent): { relative: string; absolute: string } {
    this.active()
    let relative: string
    try { relative = relativeDestination(value) } catch { return fail('INVALID_PATH') }
    const segments = relative.toLowerCase().split('/')
    if (segments.some(segment => ['.git', '.skills', '.agents', '.codex', '.claude', '.academy', '.continuum', '.code-awareness', '.code_awareness', 'code_awareness', '.aws', '.ssh', '.wrangler'].includes(segment)
      || ['.npmrc', '.netrc', '.git-credentials'].includes(segment) || /^\.env(?:\.|$)/.test(segment) || /(?:credentials|installation|secrets)(?:\.|$)/.test(segment)
      || /\.(?:pem|key|p12|pfx|sqlite|sqlite3|db)(?:-|$)/.test(segment))) fail('PROTECTED_PATH')
    if (intent && segments.some(segment => ['agents.md', 'architect.md'].includes(segment)) && intent.explicitUserAuthorization !== true) fail('PROTECTED_PATH')
    return { relative, absolute: path.join(this.root, ...relative.split('/')) }
  }

  private async snapshot(absolute: string) {
    this.active()
    let current = this.root
    try {
      for (const segment of ['', ...path.relative(this.root, absolute).split(path.sep)]) {
        if (segment) current = path.join(current, segment)
        const stats = await lstat(current)
        if (stats.isSymbolicLink() || !same(await realpath(current), current)) fail('INVALID_PATH')
        if (current !== absolute && !stats.isDirectory()) fail('INVALID_PATH')
      }
      const handle = await open(absolute, 'r')
      try {
        const identity = await handle.stat()
        if (!identity.isFile() || identity.nlink !== 1) fail('INVALID_PATH')
        if (identity.size > REPOSITORY_FILE_MAX_BYTES) fail('REQUEST_TOO_LARGE')
        const bytes = Buffer.alloc(identity.size + 1)
        let size = 0
        while (size < bytes.length) {
          const read = await handle.read(bytes, size, bytes.length - size, size)
          if (!read.bytesRead) break
          size += read.bytesRead
        }
        const after = await handle.stat()
        const named = await lstat(absolute)
        if (size !== identity.size || after.mtimeMs !== identity.mtimeMs || after.ctimeMs !== identity.ctimeMs || named.ino !== identity.ino || named.dev !== identity.dev) fail('FILE_REVISION_CONFLICT')
        this.active()
        return { bytes: bytes.subarray(0, size), identity }
      } finally { await handle.close() }
    } catch (error) {
      if (error instanceof RepositoryFileEditingError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('FILE_NOT_FOUND')
      return fail('WRITE_FAILED')
    }
  }

  private text(bytes: Buffer): string {
    if (bytes.length > TEXT_LIMIT) fail('REQUEST_TOO_LARGE')
    const text = bytes.toString('utf8')
    if (text.includes('\0') || !Buffer.from(text, 'utf8').equals(bytes)) fail('INVALID_UTF8')
    return text
  }

  async inspectFile(value: string, includeContent = false) {
    const target = this.target(value)
    const { bytes } = await this.snapshot(target.absolute)
    return { path: target.relative, size: bytes.length, sha256: digest(bytes), ...(includeContent ? { text: this.text(bytes) } : {}) }
  }

  private async exclusive<T>(absolute: string, work: () => Promise<T>): Promise<T> {
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
    const next = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
    this.pending.set(key, next)
    try { return await next } finally { if (this.pending.get(key) === next) this.pending.delete(key) }
  }

  private async mutate(value: string, expected: string, intent: FileMutationIntent, operation: 'EDIT' | 'REPLACE', content: (before: Buffer) => Promise<Buffer>): Promise<RepositoryWriteReceipt> {
    if (!/^[a-f0-9]{64}$/.test(expected ?? '')) fail('FILE_REVISION_CONFLICT')
    if (!intent || typeof intent.description !== 'string' || !intent.description.trim() || intent.description.length > 1000) fail('INVALID_ARGUMENT')
    const target = this.target(value, intent)
    return this.exclusive(target.absolute, async () => {
      const before = await this.snapshot(target.absolute)
      if (digest(before.bytes) !== expected) fail('FILE_REVISION_CONFLICT')
      const bytes = await content(before.bytes)
      if (bytes.length > REPOSITORY_FILE_MAX_BYTES) fail('REQUEST_TOO_LARGE')
      const afterSha256 = digest(bytes)
      const receipt: RepositoryWriteReceipt = { path: target.relative, operation, beforeSha256: expected, afterSha256, size: bytes.length, changed: !bytes.equals(before.bytes), state: 'CONFIRMED' }
      let temporary: string | undefined
      let attempted = false
      try {
        const latest = await this.snapshot(target.absolute)
        if (digest(latest.bytes) !== expected || latest.identity.ino !== before.identity.ino || latest.identity.dev !== before.identity.dev) fail('FILE_REVISION_CONFLICT')
        if (!receipt.changed) return receipt
        temporary = path.join(path.dirname(target.absolute), `.repository-write-${randomUUID()}.tmp`)
        const handle = await open(temporary, 'wx', before.identity.mode & 0o777)
        const temporaryIdentity = await handle.stat()
        try {
          if ((await handle.stat()).dev !== before.identity.dev) fail('INVALID_PATH')
          if (process.platform === 'win32') windowsReplace(temporary, target.absolute, expected, true)
          else await handle.chmod(before.identity.mode & 0o777)
          await handle.writeFile(bytes)
          await handle.sync()
        } finally { await handle.close() }
        if (digest(await readFile(temporary)) !== afterSha256) fail('WRITE_FAILED')
        // Synchronous final guard and commit prevent the Main active-context revision from changing between them.
        this.active()
        const publishedIdentity = lstatSync(temporary)
        if (!publishedIdentity.isFile() || publishedIdentity.isSymbolicLink() || publishedIdentity.nlink !== 1 || publishedIdentity.dev !== temporaryIdentity.dev || publishedIdentity.ino !== temporaryIdentity.ino) fail('INVALID_PATH')
        let current = this.root
        for (const segment of ['', ...path.relative(this.root, target.absolute).split(path.sep)]) {
          if (segment) current = path.join(current, segment)
          if (lstatSync(current).isSymbolicLink() || !same(realpathSync(current), current)) fail('INVALID_PATH')
        }
        const identity = lstatSync(target.absolute)
        if (!identity.isFile() || identity.nlink !== 1 || identity.ino !== before.identity.ino || identity.dev !== before.identity.dev || digest(readFileSync(target.absolute)) !== expected) fail('FILE_REVISION_CONFLICT')
        attempted = true
        const commit = this.options.commit ?? commitFile
        commit(temporary, target.absolute, expected)
        if (digest(readFileSync(target.absolute)) !== afterSha256) fail('WRITE_OUTCOME_UNKNOWN')
        return receipt
      } catch (error) {
        if (error instanceof RepositoryFileEditingError && ['FILE_REVISION_CONFLICT', 'INVALID_PATH', 'PROTECTED_PATH', 'REPOSITORY_CONTEXT_CHANGED'].includes(error.code)) throw error
        if (attempted) {
          try {
            const observed = digest(readFileSync(target.absolute))
            if (observed === afterSha256) return receipt
            if (observed === expected) fail('WRITE_FAILED')
          } catch (reconciliation) {
            if (reconciliation instanceof RepositoryFileEditingError) throw reconciliation
          }
          fail('WRITE_OUTCOME_UNKNOWN')
        }
        if (error instanceof RepositoryFileEditingError) throw error
        return fail('WRITE_FAILED')
      } finally {
        if (temporary) {
          try { await unlink(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail(attempted ? 'WRITE_OUTCOME_UNKNOWN' : 'WRITE_FAILED') }
        }
      }
    })
  }

  editText(value: string, expected: string, replacements: Array<{ oldText: string; newText: string }>, intent: FileMutationIntent) {
    return this.mutate(value, expected, intent, 'EDIT', async before => {
      if (!Array.isArray(replacements) || replacements.length < 1 || replacements.length > 32) fail('INVALID_ARGUMENT')
      const text = this.text(before)
      const patches = replacements.map(patch => {
        if (!patch || typeof patch.oldText !== 'string' || !patch.oldText || typeof patch.newText !== 'string' || Object.keys(patch).some(key => !['oldText', 'newText'].includes(key))) fail('INVALID_ARGUMENT')
        const start = text.indexOf(patch.oldText)
        if (start < 0 || text.indexOf(patch.oldText, start + 1) !== -1) fail('PATCH_AMBIGUOUS')
        return { start, end: start + patch.oldText.length, newText: patch.newText }
      }).sort((a, b) => a.start - b.start)
      if (patches.some((patch, index) => index > 0 && patch.start < patches[index - 1].end)) fail('PATCH_AMBIGUOUS')
      let result = text
      for (const patch of patches.reverse()) result = result.slice(0, patch.start) + patch.newText + result.slice(patch.end)
      const bytes = Buffer.from(result, 'utf8')
      if (this.text(bytes) !== result) fail('INVALID_UTF8')
      return bytes
    })
  }

  replaceFile(value: string, expected: string, source: { text?: string; file?: RepositoryFileDescriptor }, intent: FileMutationIntent) {
    return this.mutate(value, expected, intent, 'REPLACE', async () => {
      if ((typeof source.text === 'string') === (source.file !== undefined)) fail('INVALID_ARGUMENT')
      if (source.text !== undefined) {
        const bytes = Buffer.from(source.text, 'utf8')
        if (this.text(bytes) !== source.text) fail('INVALID_UTF8')
        return bytes
      }
      if (!this.options.ingress) fail('INVALID_FILE')
      const name = `.repository-upload-${randomUUID()}.tmp`
      try {
        const imported = await this.options.ingress!.importFile(source.file!, name)
        const bytes = await readFile(path.join(this.root, name))
        if (bytes.length !== imported.size || digest(bytes) !== imported.sha256) fail('WRITE_FAILED')
        return bytes
      } catch (error) {
        if (error instanceof RepositoryFileEditingError) throw error
        const code = (error as { code?: string }).code
        return fail(code === 'FILE_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : ['INVALID_FILE', 'REQUEST_TIMEOUT', 'DOWNLOAD_FAILED'].includes(code ?? '') ? code! : 'WRITE_FAILED')
      } finally {
        try { await unlink(path.join(this.root, name)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('WRITE_FAILED') }
      }
    })
  }
}
