import * as fs from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PreviewProfile } from './preview-profile'
import { bytesFingerprint, previewFingerprint } from './preview-profile'

type PackageEntry = { version?: string; optional?: boolean; link?: boolean; resolved?: string; hasInstallScript?: boolean }
type PackageManifest = { name?: string; version?: string }
type Lock = { lockfileVersion: number; packages: Record<string, PackageEntry> }
type RootManifest = { workspaces?: string[] | { packages?: string[] }; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
type Files = Pick<typeof fs, 'readFile' | 'realpath' | 'lstat'>
export interface DependencyDiagnostic { reasonCode: string; message: string; status: 'MISSING' | 'INCOMPATIBLE' | 'UNKNOWN' }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
function contained(root: string, path: string) {
  const value = relative(root, path)
  if (value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) throw new Error('PATH_OUTSIDE_WORKTREE')
}
function localPath(root: string, path: string) {
  if (isAbsolute(path) || path.includes('\\') || path.split('/').includes('..')) throw new Error('DEPENDENCY_LINK_UNSUPPORTED')
  const absolute = resolve(root, path); contained(root, absolute); return absolute
}
function workspaceDeclared(manifest: RootManifest, path: string): boolean | null {
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages
  if (!Array.isArray(patterns)) return false
  if (!patterns.every(p => typeof p === 'string' && /^[a-zA-Z0-9_@./*-]+$/.test(p.replace(/^!/, '')) && !p.split('/').includes('..'))) return null
  const match = (pattern: string) => {
    if (!/^[a-zA-Z0-9_@./*-]+$/.test(pattern) || pattern.split('/').includes('..')) return false
    const segments = pattern.replace(/^\.\//, '').replace(/\/$/, '').split('/')
    const expression = segments.map((segment, index) => segment === '**' ? index === segments.length - 1 ? '.*' : '(?:[^/]+/)*' : segment.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + (index < segments.length - 1 ? '/' : '')).join('')
    return new RegExp(`^${expression}$`).test(path)
  }
  return patterns.some(p => typeof p === 'string' && !p.startsWith('!') && match(p)) && !patterns.some(p => typeof p === 'string' && p.startsWith('!') && match(p.slice(1)))
}

export class PreviewNpmDependencies {
  private readonly manifests = new Map<string, { stamp: string; manifest: PackageManifest }>()
  private readonly plans = new Map<string, { installed: Array<[string, PackageEntry]>; packages: Map<string, PackageEntry> }>()
  private readonly contexts = new Map<string, string>()
  constructor(private readonly files: Files = fs) {}

  private async installedManifest(directory: string) {
    const path = join(directory, 'package.json')
    const before = await this.files.lstat(path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('DEPENDENCY_MANIFEST_LINK_UNSUPPORTED')
    const stamp = [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(':')
    const cached = this.manifests.get(path)
    if (cached?.stamp === stamp) return { manifest: cached.manifest, stamp }
    const manifest = JSON.parse(await this.files.readFile(path, 'utf8')) as PackageManifest
    const after = await this.files.lstat(path, { bigint: true })
    if ([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(':') !== stamp || !after.isFile()) throw new Error('DEPENDENCY_INSTALLATION_CHANGED')
    if (this.manifests.size >= 4096) this.manifests.delete(this.manifests.keys().next().value!)
    this.manifests.set(path, { manifest, stamp })
    return { manifest, stamp }
  }

  async inspect(rootPath: string, profile: PreviewProfile, generation: string, manifestBytes: Buffer, lockBytes: Buffer) {
    const root = await this.files.realpath(rootPath), diagnostics: DependencyDiagnostic[] = []
    const context = previewFingerprint([profile.repositoryId, generation, profile.dependencies, profile.runtime, profile.runtimeVersion, profile.command.executableHash, bytesFingerprint(manifestBytes), bytesFingerprint(lockBytes)])
    if (this.contexts.get(root) !== context) {
      for (const path of this.manifests.keys()) if (path.startsWith(root + sep)) this.manifests.delete(path)
      if (this.contexts.size >= 32) { this.contexts.clear(); this.manifests.clear() }
      this.contexts.set(root, context)
    }
    const hash = bytesFingerprint(lockBytes)
    let plan = this.plans.get(hash)
    if (!plan) {
      const lock = JSON.parse(lockBytes.toString()) as Lock
      if (!lock.packages || lock.lockfileVersion < 2) throw new Error('LOCKFILE_UNSUPPORTED')
      const entries = Object.entries(lock.packages)
      if (entries.length > 50000) throw new Error('DEPENDENCY_LIMIT_EXCEEDED')
      if (this.plans.size >= 16) this.plans.delete(this.plans.keys().next().value!)
      plan = { installed: entries.filter(([path]) => /(^|\/)node_modules\//.test(path)), packages: new Map(entries) }
      this.plans.set(hash, plan)
    }
    const manifest = JSON.parse(manifestBytes.toString()) as RootManifest
    const required = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter(name => !Object.hasOwn(manifest.optionalDependencies ?? {}, name)).map(name => `node_modules/${name}`))
    const evidence: unknown[] = []
    for (const path of required) if (!plan.packages.has(path)) diagnostics.push({ reasonCode: 'DEPENDENCY_MISMATCH', message: `Dependência obrigatória sem entrada no lockfile: ${path}`, status: 'INCOMPATIBLE' })
    for (const [path, entry] of plan.installed) {
      const logical = localPath(root, path)
      let workspace: { target: string; declared: boolean | null } | undefined
      if (entry.link) {
        if (!entry.resolved) throw new Error('DEPENDENCY_LINK_UNSUPPORTED')
        workspace = { target: localPath(root, entry.resolved), declared: workspaceDeclared(manifest, entry.resolved) }
        if (workspace.declared === false || samePath(workspace.target, root)) throw new Error('DEPENDENCY_LINK_UNSUPPORTED')
      }
      let physical: string
      try { physical = await this.files.realpath(logical) }
      catch (error) {
        if (!missing(error)) throw error
        if (entry.optional && !required.has(path)) {
          try { await this.files.lstat(logical) } catch (absent) {
            if (missing(absent)) { evidence.push([path, 'OPTIONAL_ABSENT']); continue }
            throw absent
          }
          throw new Error('DEPENDENCY_LINK_BROKEN')
        }
        diagnostics.push({ reasonCode: 'DEPENDENCIES_MISSING', message: `Dependência obrigatória ausente: ${path}`, status: 'MISSING' }); evidence.push([path, 'MISSING']); continue
      }
      contained(root, physical)
      let expected = entry
      if (workspace) {
        const { target, declared } = workspace
        if (!samePath(target, await this.files.realpath(target)) || !samePath(physical, target)) throw new Error('DEPENDENCY_LINK_UNSUPPORTED')
        expected = plan.packages.get(entry.resolved!) ?? {}
        if (declared === null || !expected.version) diagnostics.push({ reasonCode: 'DEPENDENCY_WORKSPACE_UNVERIFIABLE', message: `Declaração ou versão do workspace não verificável: ${path}`, status: 'UNKNOWN' })
      } else if (!samePath(physical, logical)) throw new Error('DEPENDENCY_LINK_UNDECLARED')
      let installed: Awaited<ReturnType<PreviewNpmDependencies['installedManifest']>>
      try { installed = await this.installedManifest(physical) }
      catch (error) {
        if (!missing(error)) throw error
        diagnostics.push({ reasonCode: 'DEPENDENCY_MISMATCH', message: `Pacote materializado sem manifest: ${path}`, status: 'INCOMPATIBLE' }); continue
      }
      if (expected.version && installed.manifest.version !== expected.version) diagnostics.push({ reasonCode: 'DEPENDENCY_MISMATCH', message: 'DEPENDENCY_VERSION_MISMATCH', status: 'INCOMPATIBLE' })
      if (!entry.link && !expected.version) diagnostics.push({ reasonCode: 'DEPENDENCY_VERSION_UNVERIFIABLE', message: `Versão esperada não verificável: ${path}`, status: 'UNKNOWN' })
      if (entry.link && installed.manifest.name !== path.split(/(?:^|\/)node_modules\//).pop()) throw new Error('DEPENDENCY_WORKSPACE_NAME_MISMATCH')
      if (expected.hasInstallScript && !diagnostics.some(d => d.reasonCode === 'ABI_UNVERIFIED')) diagnostics.push({ reasonCode: 'ABI_UNVERIFIED', message: 'Instalação nativa/scripts exige prova específica de materialização e ABI.', status: 'UNKNOWN' })
      evidence.push([path, physical, installed.stamp])
    }
    return { basis: previewFingerprint([context, evidence]), diagnostics }
  }
}
