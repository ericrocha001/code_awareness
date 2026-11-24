import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readFile, realpath, unlink } from 'node:fs/promises'
import { linkSync, lstatSync, readFileSync, realpathSync, renameSync, type Stats } from 'node:fs'
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

export type TextChange =
  | { operation: 'EDIT'; path: string; expectedSha256: string; replacements: Array<{ oldText: string; newText: string }> }
  | { operation: 'CREATE'; path: string; text: string }

export type TextFileState = 'CONFIRMED' | 'NO_CHANGE' | 'NOT_STARTED' | 'REJECTED' | 'CONFLICT' | 'UNKNOWN'

export interface TextBatchFile {
  path: string
  operation: 'EDIT' | 'CREATE'
  beforeSha256: string | null
  afterSha256: string | null
  size: number | null
  changed: boolean
  state: TextFileState
  code?: string
}

export interface TextBatchResult {
  state: 'APPLIED' | 'NO_CHANGE' | 'REJECTED' | 'PARTIAL' | 'UNKNOWN'
  code?: string
  files: TextBatchFile[]
  previews: Array<{ path: string; before: string; after: string }>
}

const TEXT_LIMIT = 1024 * 1024
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const fail = (code: string): never => { throw new RepositoryFileEditingError(code) }
const hasErrno = (error: unknown, code: string) => !!error && typeof error === 'object' && 'code' in error && error.code === code

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

function applyReplacements(text: string, replacements: Array<{ oldText: string; newText: string }>): string {
  if (!Array.isArray(replacements) || replacements.length < 1 || replacements.length > 32) fail('INVALID_ARGUMENT')
  const patches = replacements.map(patch => {
    if (!patch || typeof patch.oldText !== 'string' || !patch.oldText || typeof patch.newText !== 'string' || Object.keys(patch).some(key => !['oldText', 'newText'].includes(key))) fail('INVALID_ARGUMENT')
    const start = text.indexOf(patch.oldText)
    if (start < 0 || text.indexOf(patch.oldText, start + 1) !== -1) fail('PATCH_AMBIGUOUS')
    return { start, end: start + patch.oldText.length, newText: patch.newText }
  }).sort((a, b) => a.start - b.start)
  if (patches.some((patch, index) => index > 0 && patch.start < patches[index - 1].end)) fail('PATCH_AMBIGUOUS')
  let result = text
  for (const patch of patches.reverse()) result = result.slice(0, patch.start) + patch.newText + result.slice(patch.end)
  return result
}

export class RepositoryFileEditing {
  private readonly root: string
  private readonly pending = new Map<string, Promise<unknown>>()

  constructor(repositoryRoot: string, private readonly options: {
    isActive: () => boolean
    ingress?: RepositoryFileIngress
    commit?: typeof commitFile
    create?: (temporary: string, destination: string) => void
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

  private async validateAncestors(absolute: string, requireLeafDirectory: boolean, missingParentCode: 'FILE_NOT_FOUND' | 'PARENT_DIRECTORY_NOT_FOUND' = 'FILE_NOT_FOUND'): Promise<void> {
    let current = this.root
    for (const segment of ['', ...path.relative(this.root, absolute).split(path.sep)]) {
      if (segment) current = path.join(current, segment)
      let stats: Stats
      try { stats = await lstat(current) } catch (error) {
        if (hasErrno(error, 'ENOENT')) fail(current === absolute ? missingParentCode : missingParentCode === 'PARENT_DIRECTORY_NOT_FOUND' ? 'PARENT_DIRECTORY_NOT_FOUND' : 'FILE_NOT_FOUND')
        if (hasErrno(error, 'ENOTDIR')) fail('INVALID_PATH')
        return fail('INVALID_PATH')
      }
      if (stats.isSymbolicLink() || !same(await realpath(current), current)) fail('INVALID_PATH')
      if ((current !== absolute || requireLeafDirectory) && !stats.isDirectory()) fail('INVALID_PATH')
    }
  }

  private validateAncestorsSync(absolute: string, requireLeafDirectory = false): void {
    let current = this.root
    for (const segment of ['', ...path.relative(this.root, absolute).split(path.sep)]) {
      if (segment) current = path.join(current, segment)
      const stats = lstatSync(current)
      if (stats.isSymbolicLink() || !same(realpathSync(current), current)) fail('INVALID_PATH')
      if (requireLeafDirectory && !stats.isDirectory()) fail('INVALID_PATH')
    }
  }

  private async snapshot(absolute: string) {
    this.active()
    try {
      await this.validateAncestors(absolute, false, 'FILE_NOT_FOUND')
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
      if (hasErrno(error, 'ENOENT')) fail('FILE_NOT_FOUND')
      return fail('WRITE_FAILED')
    }
  }

  private text(bytes: Buffer): string {
    if (bytes.length > TEXT_LIMIT) fail('REQUEST_TOO_LARGE')
    const text = bytes.toString('utf8')
    if (text.includes('\0') || !Buffer.from(text, 'utf8').equals(bytes)) fail('INVALID_UTF8')
    return text
  }

  private utf8Bytes(value: string): Buffer {
    const bytes = Buffer.from(value, 'utf8')
    if (bytes.length > TEXT_LIMIT) fail('REQUEST_TOO_LARGE')
    if (this.text(bytes) !== value) fail('INVALID_UTF8')
    return bytes
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

  private async publishReplacement(
    target: { relative: string; absolute: string },
    before: { bytes: Buffer; identity: Stats },
    bytes: Buffer,
    expected: string,
    receipt: RepositoryWriteReceipt
  ): Promise<RepositoryWriteReceipt> {
    let temporary: string | undefined
    let attempted = false
    const afterSha256 = receipt.afterSha256
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
      this.validateAncestorsSync(target.absolute, false)
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
        try { await unlink(temporary) } catch (error) { if (!hasErrno(error, 'ENOENT')) fail(attempted ? 'WRITE_OUTCOME_UNKNOWN' : 'WRITE_FAILED') }
      }
    }
  }

  private async publishCreation(target: { relative: string; absolute: string }, bytes: Buffer, afterSha256: string): Promise<TextBatchFile> {
    this.active()
    const parent = path.dirname(target.absolute)
    await this.validateAncestors(parent, true, 'PARENT_DIRECTORY_NOT_FOUND')
    try {
      await lstat(target.absolute)
      fail('FILE_ALREADY_EXISTS')
    } catch (error) {
      if (error instanceof RepositoryFileEditingError) throw error
      if (!hasErrno(error, 'ENOENT')) fail('INVALID_PATH')
    }
    const temporary = path.join(parent, `.repository-write-${randomUUID()}.tmp`)
    let tempExists = false
    let linked = false
    try {
      const handle = await open(temporary, 'wx', 0o644)
      tempExists = true
      const temporaryIdentity = await handle.stat()
      try {
        const parentIdentity = await lstat(parent)
        if (!parentIdentity.isDirectory() || temporaryIdentity.dev !== parentIdentity.dev) fail('INVALID_PATH')
        if (process.platform !== 'win32') await handle.chmod(0o644)
        await handle.writeFile(bytes)
        await handle.sync()
      } finally { await handle.close() }
      if (digest(await readFile(temporary)) !== afterSha256) fail('WRITE_FAILED')
      this.active()
      const publishedIdentity = lstatSync(temporary)
      if (!publishedIdentity.isFile() || publishedIdentity.isSymbolicLink() || publishedIdentity.nlink !== 1 || publishedIdentity.dev !== temporaryIdentity.dev || publishedIdentity.ino !== temporaryIdentity.ino) fail('INVALID_PATH')
      this.validateAncestorsSync(parent, true)
      if (lstatSync(target.absolute, { throwIfNoEntry: false })) fail('FILE_ALREADY_EXISTS')
      const create = this.options.create ?? linkSync
      try {
        create(temporary, target.absolute)
        linked = true
      } catch (error) {
        if (hasErrno(error, 'EEXIST')) fail('FILE_ALREADY_EXISTS')
        if (error instanceof RepositoryFileEditingError) throw error
        fail('WRITE_FAILED')
      }
      try { await unlink(temporary); tempExists = false } catch (error) { if (!hasErrno(error, 'ENOENT')) fail('WRITE_OUTCOME_UNKNOWN') }
      const created = lstatSync(target.absolute, { throwIfNoEntry: false })
      if (!created || !created.isFile() || created.isSymbolicLink() || created.nlink !== 1 || digest(readFileSync(target.absolute)) !== afterSha256) fail('WRITE_OUTCOME_UNKNOWN')
      return { path: target.relative, operation: 'CREATE', beforeSha256: null, afterSha256, size: bytes.length, changed: true, state: 'CONFIRMED' }
    } catch (error) {
      if (error instanceof RepositoryFileEditingError) throw error
      return fail(linked ? 'WRITE_OUTCOME_UNKNOWN' : 'WRITE_FAILED')
    } finally {
      if (tempExists) {
        try { await unlink(temporary) } catch (error) { if (!hasErrno(error, 'ENOENT')) fail(linked ? 'WRITE_OUTCOME_UNKNOWN' : 'WRITE_FAILED') }
      }
    }
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
      return this.publishReplacement(target, before, bytes, expected, receipt)
    })
  }

  editText(value: string, expected: string, replacements: Array<{ oldText: string; newText: string }>, intent: FileMutationIntent) {
    return this.mutate(value, expected, intent, 'EDIT', async before => {
      const text = this.text(before)
      const result = applyReplacements(text, replacements)
      return this.utf8Bytes(result)
    })
  }

  replaceFile(value: string, expected: string, source: { text?: string; file?: RepositoryFileDescriptor }, intent: FileMutationIntent) {
    return this.mutate(value, expected, intent, 'REPLACE', async () => {
      if ((typeof source.text === 'string') === (source.file !== undefined)) fail('INVALID_ARGUMENT')
      if (source.text !== undefined) return this.utf8Bytes(source.text)
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
        try { await unlink(path.join(this.root, name)) } catch (error) { if (!hasErrno(error, 'ENOENT')) fail('WRITE_FAILED') }
      }
    })
  }

  async applyTextBatch(
    changes: TextChange[],
    intent: FileMutationIntent,
    beforePublish?: (index: number) => Promise<void>
  ): Promise<TextBatchResult> {
    if (!intent || typeof intent !== 'object' || Array.isArray(intent) || typeof intent.description !== 'string' || !intent.description.trim() || intent.description.length > 1000) {
      return { state: 'REJECTED', code: 'INVALID_ARGUMENT', files: [], previews: [] }
    }
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > 16) {
      return { state: 'REJECTED', code: 'INVALID_ARGUMENT', files: [], previews: [] }
    }
    try { this.active() } catch (error) {
      const code = error instanceof RepositoryFileEditingError ? error.code : 'REPOSITORY_CONTEXT_CHANGED'
      return { state: 'REJECTED', code, files: [], previews: [] }
    }

    const batchIntent: FileMutationIntent = { description: intent.description }
    const files: TextBatchFile[] = changes.map(change => ({
      path: change && typeof change === 'object' && typeof change.path === 'string' ? change.path : '',
      operation: change && typeof change === 'object' && change.operation === 'CREATE' ? 'CREATE' : 'EDIT',
      beforeSha256: null,
      afterSha256: null,
      size: null,
      changed: false,
      state: 'NOT_STARTED'
    }))

    type PreparedItem =
      | { kind: 'NO_CHANGE'; target: { relative: string; absolute: string }; file: TextBatchFile }
      | { kind: 'EDIT'; target: { relative: string; absolute: string }; expectedSha256: string; identity: Stats; bytes: Buffer; afterSha256: string; beforeText: string; afterText: string }
      | { kind: 'CREATE'; target: { relative: string; absolute: string }; bytes: Buffer; afterSha256: string; afterText: string }

    const prepared: PreparedItem[] = []
    const seenPaths = new Set<string>()
    let aggregateBytes = 0

    for (let i = 0; i < changes.length; i++) {
      const change = changes[i]
      try {
        this.active()
        if (!change || typeof change !== 'object' || Array.isArray(change)) fail('INVALID_ARGUMENT')
        if (change.operation !== 'EDIT' && change.operation !== 'CREATE') fail('INVALID_ARGUMENT')
        const allowedKeys = change.operation === 'EDIT' ? ['operation', 'path', 'expectedSha256', 'replacements'] : ['operation', 'path', 'text']
        if (Object.keys(change).some(key => !allowedKeys.includes(key))) fail('INVALID_ARGUMENT')
        const target = this.target(change.path, batchIntent)
        files[i].path = target.relative
        const dedupeKey = process.platform === 'win32' ? target.relative.toLowerCase() : target.relative
        if (seenPaths.has(dedupeKey)) fail('INVALID_ARGUMENT')
        seenPaths.add(dedupeKey)

        if (change.operation === 'EDIT') {
          if (typeof change.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(change.expectedSha256)) fail('INVALID_ARGUMENT')
          if (!Array.isArray(change.replacements) || change.replacements.length < 1 || change.replacements.length > 32) fail('INVALID_ARGUMENT')
          for (const patch of change.replacements) {
            if (!patch || typeof patch !== 'object' || Array.isArray(patch) || typeof patch.oldText !== 'string' || !patch.oldText || typeof patch.newText !== 'string' || Object.keys(patch).some(key => !['oldText', 'newText'].includes(key))) {
              fail('INVALID_ARGUMENT')
            }
            const oldBytes = this.utf8Bytes(patch.oldText)
            const newBytes = this.utf8Bytes(patch.newText)
            aggregateBytes += oldBytes.length + newBytes.length
            if (aggregateBytes > TEXT_LIMIT) fail('REQUEST_TOO_LARGE')
          }
          const before = await this.snapshot(target.absolute)
          if (digest(before.bytes) !== change.expectedSha256) fail('FILE_REVISION_CONFLICT')
          const beforeText = this.text(before.bytes)
          const afterText = applyReplacements(beforeText, change.replacements)
          const bytes = this.utf8Bytes(afterText)
          const afterSha256 = digest(bytes)
          if (bytes.equals(before.bytes)) {
            const noChangeFile: TextBatchFile = {
              path: target.relative,
              operation: 'EDIT',
              beforeSha256: change.expectedSha256,
              afterSha256: change.expectedSha256,
              size: before.bytes.length,
              changed: false,
              state: 'NO_CHANGE'
            }
            files[i] = noChangeFile
            prepared.push({ kind: 'NO_CHANGE', target, file: noChangeFile })
          } else {
            prepared.push({ kind: 'EDIT', target, expectedSha256: change.expectedSha256, identity: before.identity, bytes, afterSha256, beforeText, afterText })
          }
        } else {
          if (typeof change.text !== 'string') fail('INVALID_ARGUMENT')
          const bytes = this.utf8Bytes(change.text)
          aggregateBytes += bytes.length
          if (aggregateBytes > TEXT_LIMIT) fail('REQUEST_TOO_LARGE')
          await this.validateAncestors(path.dirname(target.absolute), true, 'PARENT_DIRECTORY_NOT_FOUND')
          try {
            await lstat(target.absolute)
            fail('FILE_ALREADY_EXISTS')
          } catch (error) {
            if (error instanceof RepositoryFileEditingError) throw error
            if (!hasErrno(error, 'ENOENT')) fail('INVALID_PATH')
          }
          prepared.push({ kind: 'CREATE', target, bytes, afterSha256: digest(bytes), afterText: change.text })
        }
      } catch (error) {
        const code = error instanceof RepositoryFileEditingError ? error.code : 'INVALID_ARGUMENT'
        files[i] = { ...files[i], state: 'REJECTED', code }
        return { state: 'REJECTED', code, files, previews: [] }
      }
    }

    const previews: Array<{ path: string; before: string; after: string }> = []
    let confirmedChanges = 0
    let failureCode: string | undefined
    let hasUnknown = false

    for (let i = 0; i < prepared.length; i++) {
      const item = prepared[i]
      if (item.kind === 'NO_CHANGE') continue
      try {
        await beforePublish?.(i)
      } catch (error) {
        failureCode = error instanceof Error && error.message ? error.message : 'GIT_STATE_CHANGED'
        files[i] = { ...files[i], state: 'CONFLICT', code: failureCode }
        break
      }

      try {
        if (item.kind === 'EDIT') {
          const receipt = await this.exclusive(item.target.absolute, async () => {
            const latest = await this.snapshot(item.target.absolute)
            if (digest(latest.bytes) !== item.expectedSha256 || latest.identity.ino !== item.identity.ino || latest.identity.dev !== item.identity.dev) fail('FILE_REVISION_CONFLICT')
            const writeReceipt: RepositoryWriteReceipt = {
              path: item.target.relative,
              operation: 'EDIT',
              beforeSha256: item.expectedSha256,
              afterSha256: item.afterSha256,
              size: item.bytes.length,
              changed: true,
              state: 'CONFIRMED'
            }
            return this.publishReplacement(item.target, latest, item.bytes, item.expectedSha256, writeReceipt)
          })
          files[i] = {
            path: receipt.path,
            operation: 'EDIT',
            beforeSha256: receipt.beforeSha256,
            afterSha256: receipt.afterSha256,
            size: receipt.size,
            changed: receipt.changed,
            state: 'CONFIRMED'
          }
          previews.push({ path: item.target.relative, before: item.beforeText, after: item.afterText })
        } else {
          const createdFile = await this.exclusive(item.target.absolute, () => this.publishCreation(item.target, item.bytes, item.afterSha256))
          files[i] = createdFile
          previews.push({ path: item.target.relative, before: '', after: item.afterText })
        }
        confirmedChanges++
      } catch (error) {
        const code = error instanceof RepositoryFileEditingError ? error.code : 'WRITE_FAILED'
        failureCode = code
        if (code === 'WRITE_OUTCOME_UNKNOWN') {
          hasUnknown = true
          files[i] = { ...files[i], state: 'UNKNOWN', code }
        } else {
          files[i] = { ...files[i], state: 'CONFLICT', code }
        }
        break
      }
    }

    if (hasUnknown) return { state: 'UNKNOWN', code: 'EDIT_OUTCOME_UNKNOWN', files, previews }
    if (failureCode) {
      if (confirmedChanges === 0) return { state: 'REJECTED', code: failureCode, files, previews }
      return { state: 'PARTIAL', code: 'EDIT_PARTIAL', files, previews }
    }
    if (confirmedChanges === 0) return { state: 'NO_CHANGE', files, previews: [] }
    return { state: 'APPLIED', files, previews }
  }
}
