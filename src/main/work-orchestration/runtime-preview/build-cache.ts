import * as fs from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { bytesFingerprint, previewFingerprint, type PreviewProfile } from '../preview-profile'
import type { PreviewSelection } from '../../../shared/types/runtime-preview-types'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const limit = 64 * 1048576
export const buildCacheReceipt = z.object({ status: z.enum(['DISABLED', 'MISS', 'HIT', 'REBUILT', 'REJECTED']), key: digest.nullable(),
  restoredBytes: z.number().int().nonnegative().max(limit), retainedBytes: z.number().int().nonnegative().max(limit),
  reasonCode: z.string().max(80).nullable(), mainPreload: z.literal('RECOMPILED') }).strict()
const manifestSchema = z.object({ key: digest, files: z.array(z.object({ name: z.string().regex(/^[\w.-]+$/).refine(name => name !== '.' && name !== '..'), hash: digest, bytes: z.number().int().min(0).max(limit) }).strict()).max(1024),
  inputs: z.array(z.object({ path: z.string().max(2048), hash: digest }).strict()).max(4096) }).strict()
type Manifest = z.infer<typeof manifestSchema>
const inside = (root: string, file: string) => {
  const path = relative(root, resolve(file))
  if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) throw new Error('BUILD_CACHE_PATH_INVALID')
}
const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

export class PreviewBuildCache {
  readonly receipt: z.infer<typeof buildCacheReceipt> = { status: 'DISABLED', key: null, restoredBytes: 0, retainedBytes: 0, reasonCode: null, mainPreload: 'RECOMPILED' }
  private manifest?: Manifest
  private entry?: string
  private restoredMetadata?: string
  private restoredStamp?: string
  private constructor(private readonly root: string, private readonly worktree: string, private readonly directory: string,
    private readonly profile: PreviewProfile, private readonly selection: PreviewSelection, private readonly basis: string,
    private readonly forbidden: string[], private readonly signal?: AbortSignal) {}
  private async safe(file: string) {
    if (!same(await fs.realpath(file), resolve(file)) || (await fs.lstat(file)).isSymbolicLink()) throw new Error('BUILD_CACHE_LINK')
  }
  private async bytes(file: string) {
    this.signal?.throwIfAborted()
    await this.safe(file)
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.size > limit) throw new Error('BUILD_CACHE_LIMIT')
    return fs.readFile(file)
  }
  private async input(file: string) {
    const path = resolve(file); inside(join(this.worktree, 'node_modules'), path)
    return { path, hash: bytesFingerprint(await this.bytes(path)) }
  }
  private async key() {
    const files = [...this.profile.command.inputs.map(input => input.path), this.profile.dependencies.manifest, this.profile.dependencies.lockfile,
      ...this.profile.adapter!.artifacts.filter(a => a.component === 'ELECTRON_RENDERER').map(a => a.path),
      'node_modules/vite/package.json', 'node_modules/electron-vite/package.json', 'node_modules/esbuild/package.json',
      'node_modules/@vitejs/plugin-react/package.json', 'node_modules/vite/dist/node/index.js', 'node_modules/electron-vite/dist/index.mjs']
    const entries = []
    const compilerFiles: string[] = []
    const compilerInputs = async (folder: string): Promise<void> => {
      await this.safe(folder)
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name)
        if (entry.isSymbolicLink()) throw new Error('BUILD_CACHE_LINK')
        if (entry.isDirectory()) await compilerInputs(path)
        else if (/\.(?:[cm]?js|json|exe|node)$/.test(entry.name)) compilerFiles.push(relative(this.worktree, path))
        if (compilerFiles.length > 512) throw new Error('BUILD_CACHE_LIMIT')
      }
    }
    for (const folder of ['vite/dist', 'electron-vite/dist', '@vitejs/plugin-react/dist', 'esbuild/lib']) await compilerInputs(join(this.worktree, 'node_modules', folder))
    files.push(...compilerFiles.sort())
    let total = 0
    for (const file of files) {
      const path = resolve(this.worktree, file); inside(this.worktree, path)
      const bytes = await this.bytes(path); total += bytes.length
      if (total > limit) throw new Error('BUILD_CACHE_LIMIT')
      entries.push([file, bytesFingerprint(bytes)])
    }
    return previewFingerprint([this.selection.repositoryId, this.selection.worktreeId, this.selection.generation, this.selection.fingerprint, this.profile.revision, this.worktree, this.basis,
      this.profile.dependencies, this.profile.runtimeVersion, this.profile.adapter!.nativeModules, entries])
  }
  private async stamp(file: string) {
    const stat = await fs.lstat(file, { bigint: true })
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
  }
  private reject(code: string) { this.receipt.status = 'REJECTED'; this.receipt.reasonCode = code }
  static async prepare(root: string, worktree: string, directory: string, profile: PreviewProfile, selection: PreviewSelection, basis: string,
    forbidden: string[], signal?: AbortSignal) {
    const cache = new PreviewBuildCache(resolve(root), await fs.realpath(worktree), directory, profile, selection, basis, forbidden, signal)
    if (profile.profileId !== 'code-awareness-' + selection.worktreeId || profile.adapter?.kind !== 'ELECTRON' || profile.adapter.configFile !== 'electron.vite.config.ts' || Object.keys(profile.env).some(key => key !== 'PATH')) return cache
    try {
      inside(resolve(root, '..'), root)
      const scope = relative(worktree, root)
      if (!scope || !(scope === '..' || scope.startsWith('..' + sep) || isAbsolute(scope))) throw new Error('BUILD_CACHE_INSIDE_WORKTREE')
      await fs.mkdir(root, { recursive: true, mode: 0o700 }); await cache.safe(root)
      const key = await cache.key(); cache.receipt.key = key; cache.receipt.status = 'MISS'
      const partition = join(root, previewFingerprint([selection.repositoryId, selection.worktreeId, selection.generation, cache.worktree]))
      await fs.mkdir(partition, { recursive: true, mode: 0o700 }); await cache.safe(partition)
      cache.entry = join(partition, key)
      let raw: Buffer
      try { raw = await cache.bytes(join(cache.entry, 'entry.json')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return cache; throw error }
      if (raw.length > 4 * 1048576) throw new Error('BUILD_CACHE_LIMIT')
      const manifest = manifestSchema.parse(JSON.parse(raw.toString()))
      if (manifest.key !== key) throw new Error('BUILD_CACHE_CORRUPT')
      let total = 0
      for (const input of manifest.inputs) if ((await cache.input(input.path)).hash !== input.hash) throw new Error('BUILD_CACHE_INPUT_CHANGED')
      const destination = join(directory, 'vite-cache', 'deps')
      const content: Array<[string, Buffer]> = []
      for (const file of manifest.files) {
        const bytes = await cache.bytes(join(cache.entry, 'data', file.name)); total += bytes.length
        if (total > limit || bytes.length !== file.bytes || bytesFingerprint(bytes) !== file.hash) throw new Error('BUILD_CACHE_CORRUPT')
        cache.publicBytes(bytes); content.push([file.name, bytes])
      }
      await fs.mkdir(destination, { recursive: true, mode: 0o700 })
      for (const [name, bytes] of content) { signal?.throwIfAborted(); await fs.writeFile(join(destination, name), bytes, { flag: 'wx', mode: 0o600 }) }
      cache.manifest = manifest; cache.receipt.restoredBytes = total
      cache.restoredMetadata = bytesFingerprint(await cache.bytes(join(destination, '_metadata.json')))
      cache.restoredStamp = await cache.stamp(join(destination, '_metadata.json'))
    } catch (error) {
      signal?.throwIfAborted()
      cache.reject(error instanceof Error && /^BUILD_CACHE_[A-Z_]+$/.test(error.message) ? error.message : 'BUILD_CACHE_UNAVAILABLE')
      await cache.remove(join(directory, 'vite-cache'), directory).catch(() => {})
    }
    return cache
  }
  private publicBytes(bytes: Buffer) {
    const text = bytes.toString('utf8')
    if (this.forbidden.some(value => value.length > 4 && text.includes(value)) || bytes.includes(Buffer.from('SQLite format 3\0'))) throw new Error('BUILD_CACHE_PRIVATE_OUTPUT')
  }
  private async remove(file: string, root = this.root) {
    inside(root, file)
    const walk = async (path: string): Promise<void> => {
      await this.safe(path)
      if ((await fs.lstat(path)).isDirectory()) for (const name of await fs.readdir(path)) await walk(join(path, name))
    }
    try { await walk(file) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    await fs.rm(file, { recursive: true })
  }
  async guard() {
    if (!this.entry || !this.receipt.key) return
    if (await this.key() !== this.receipt.key) throw new Error('BUILD_CACHE_INPUT_CHANGED')
    for (const input of this.manifest?.inputs ?? []) if ((await this.input(input.path)).hash !== input.hash) throw new Error('BUILD_CACHE_INPUT_CHANGED')
  }
  async finish(success: boolean) {
    if (!this.entry || !this.receipt.key) return
    if (!success) { await this.remove(this.entry).catch(() => {}); return }
    let temporary: string | undefined
    try {
      await this.guard()
      const policy = await this.bytes(join(this.directory, 'dependency-cache-policy.json'))
      if (policy.length > 1024 || !z.object({ schemaVersion: z.literal(1), nativeOptimizer: z.literal(true) }).strict().safeParse(JSON.parse(policy.toString())).success) throw new Error('BUILD_CACHE_CUSTOM_OPTIMIZER')
      const directory = join(this.directory, 'vite-cache', 'deps'), metadataFile = join(directory, '_metadata.json')
      const metadataStamp = await this.stamp(metadataFile)
      const raw = await this.bytes(metadataFile), metadata = JSON.parse(raw.toString())
      const reused = this.restoredMetadata === bytesFingerprint(raw) && this.restoredStamp === await this.stamp(metadataFile)
      if (!metadata.optimized || !metadata.chunks || typeof metadata.browserHash !== 'string') throw new Error('BUILD_CACHE_METADATA_INVALID')
      const names = await fs.readdir(directory), inputs = new Map<string, string>(), output: Array<[string, Buffer]> = []
      if (names.length > 1024) throw new Error('BUILD_CACHE_LIMIT')
      for (const item of Object.values(metadata.optimized) as Array<{ src: string; file: string }>) {
        const source = await this.input(resolve(directory, item.src)); inputs.set(source.path, source.hash); item.src = source.path
      }
      for (const item of [...Object.values(metadata.optimized), ...Object.values(metadata.chunks)] as Array<{ file: string }>) {
        if (!/^\.?\/?[\w.-]+\.js$/.test(item.file)) throw new Error('BUILD_CACHE_METADATA_INVALID')
      }
      let total = 0
      const stamps: Array<[string, string]> = []
      for (const name of names.sort()) {
        if (name !== '_metadata.json' && name !== 'package.json' && !/^[\w.-]+\.js(?:\.map)?$/.test(name)) throw new Error('BUILD_CACHE_UNSAFE_OUTPUT')
        const path = join(directory, name), stamp = await this.stamp(path)
        const bytes = name === '_metadata.json' ? Buffer.from(JSON.stringify(metadata)) : await this.bytes(path)
        stamps.push([path, stamp])
        this.publicBytes(bytes); total += bytes.length
        if (total > limit) throw new Error('BUILD_CACHE_LIMIT')
        if (name.endsWith('.js') && !names.includes(name + '.map')) throw new Error('BUILD_CACHE_SOURCE_UNVERIFIABLE')
        if (name.endsWith('.js.map')) {
          const map = JSON.parse(bytes.toString())
          if (!Array.isArray(map.sources) || !Array.isArray(map.sourcesContent) || map.sources.length !== map.sourcesContent.length) throw new Error('BUILD_CACHE_SOURCE_UNVERIFIABLE')
          for (let index = 0; index < map.sources.length; index++) {
            const file = resolve(directory, map.sourceRoot ?? '', map.sources[index])
            inside(join(this.worktree, 'node_modules'), file)
            const source = await this.bytes(file)
            const input = await this.input(file)
            if (source.toString('utf8') !== map.sourcesContent[index] || bytesFingerprint(source) !== input.hash) throw new Error('BUILD_CACHE_SOURCE_UNVERIFIABLE')
            inputs.set(input.path, input.hash)
            if (inputs.size > 4096) throw new Error('BUILD_CACHE_LIMIT')
          }
        }
        output.push([name, bytes])
      }
      if (await this.stamp(metadataFile) !== metadataStamp) throw new Error('BUILD_CACHE_CHANGED')
      for (const [path, stamp] of stamps) if (await this.stamp(path) !== stamp) throw new Error('BUILD_CACHE_CHANGED')
      const manifest = manifestSchema.parse({ key: this.receipt.key, files: output.map(([name, bytes]) => ({ name, hash: bytesFingerprint(bytes), bytes: bytes.length })), inputs: [...inputs].map(([path, hash]) => ({ path, hash })) })
      for (const input of manifest.inputs) if ((await this.input(input.path)).hash !== input.hash) throw new Error('BUILD_CACHE_INPUT_CHANGED')
      await this.guard()
      temporary = this.entry + '-' + randomUUID() + '.tmp'
      await fs.mkdir(join(temporary, 'data'), { recursive: true, mode: 0o700 })
      for (const [name, bytes] of output) await fs.writeFile(join(temporary, 'data', name), bytes, { flag: 'wx', mode: 0o600 })
      await fs.writeFile(join(temporary, 'entry.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
      await this.remove(this.entry); await fs.rename(temporary, this.entry); temporary = undefined
      this.receipt.status = reused ? 'HIT' : this.receipt.restoredBytes ? 'REBUILT' : 'MISS'
      this.receipt.retainedBytes = total
      await this.prune()
    } catch (error) {
      this.reject(error instanceof Error && /^BUILD_CACHE_[A-Z_]+$/.test(error.message) ? error.message : 'BUILD_CACHE_UNAVAILABLE')
      if (temporary) await this.remove(temporary).catch(() => {})
      await this.remove(this.entry).catch(() => {})
    }
  }
  private async prune() {
    const entries: Array<{ path: string; at: number; bytes: number }> = []
    for (const partition of await fs.readdir(this.root)) {
      if (!/^[a-f0-9]{64}$/.test(partition)) continue
      const folder = join(this.root, partition); await this.safe(folder)
      for (const key of await fs.readdir(folder)) {
        if (!/^[a-f0-9]{64}$/.test(key)) continue
        const path = join(folder, key)
        try {
          await this.safe(path)
          const bytes = await this.bytes(join(path, 'entry.json'))
          const manifest = manifestSchema.parse(JSON.parse(bytes.toString()))
          entries.push({ path, at: (await fs.stat(path)).mtimeMs, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) })
        } catch { await this.remove(path).catch(() => {}) }
      }
    }
    entries.sort((a, b) => b.at - a.at)
    let bytes = 0
    for (const [index, entry] of entries.entries()) { bytes += entry.bytes; if (index >= 8 || bytes > 256 * 1048576) await this.remove(entry.path) }
    for (const partition of await fs.readdir(this.root)) {
      if (!/^[a-f0-9]{64}$/.test(partition)) continue
      const folder = join(this.root, partition); await this.safe(folder)
      if (!(await fs.readdir(folder)).length) await fs.rmdir(folder)
    }
  }
}
