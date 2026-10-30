import { mkdir, mkdtemp, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BuildCapture, PreviewCaptureStore } from './capture'
import type { PreviewBuildToolchains } from './toolchain'
import { compileElectronBundle, electronBuildRecipe, validateBundleFiles, type CompiledBundle } from './electron-build'
import { absent, digest, physical, removeOwned, snapshot, tree, verify } from './files'

export interface BuildBundle extends CompiledBundle {
  version: 1; buildId: string; captureId: string; toolchainId: string; runtimeId: string; recipe: string; source: BuildCapture['source']
}
export interface BuildReceipt { captureId: string; buildId: string; runtimeId: string; reused: boolean; directory: string; manifest: BuildBundle }
export type BuildApproval = (capture: BuildCapture, recipe: string) => Promise<boolean>
export class PreviewBuildStore {
  private readonly recipe: string
  constructor(readonly root: string, private readonly captures: PreviewCaptureStore, private readonly tools: PreviewBuildToolchains,
    private readonly approve: BuildApproval, private readonly compile = compileElectronBundle) {
    this.recipe = digest({ version: electronBuildRecipe, compile: compile.toString(), files: [snapshot.toString(), tree.toString(), physical.toString()] })
  }
  private async lock() {
    await mkdir(this.root, { recursive: true }); await physical(this.root)
    const lock = join(this.root, 'store.lock')
    try { await mkdir(lock) } catch { throw Error('BUILD_STORE_BUSY') }
    return () => removeOwned(this.root, lock)
  }
  private id(id: string) { if (!/^[a-f0-9]{64}$/.test(id)) throw Error('BUILD_ID_INVALID'); return id }
  private directory(id: string) { return join(this.root, 'bundle-' + this.id(id)) }
  async read(buildId: string): Promise<BuildBundle> {
    const directory = await physical(this.directory(buildId))
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as BuildBundle
    const { buildId: actualId, ...identity } = manifest
    if (manifest.version !== 1 || actualId !== buildId || digest(identity) !== buildId) throw Error('BUILD_INTEGRITY_FAILED')
    validateBundleFiles(manifest.files)
    await verify(join(directory, 'bundle'), manifest.files)
    return manifest
  }
  async prepare(captureId: string, guard: () => void = () => {}): Promise<BuildReceipt> {
    const release = await this.lock()
    let staging: string | undefined, publication: string | undefined, retainForRecovery = false
    try {
      const capture = await this.captures.get(captureId)
      const key = { captureId, toolchainId: capture.toolchainId, runtimeId: capture.runtimeId, recipe: this.recipe }, keyId = digest(key)
      guard()
      try {
        const { buildId } = JSON.parse(await readFile(join(this.root, 'keys', keyId + '.json'), 'utf8')) as { buildId: string }
        const manifest = await this.read(buildId)
        if (manifest.captureId !== captureId || manifest.toolchainId !== key.toolchainId || manifest.runtimeId !== key.runtimeId || manifest.recipe !== key.recipe) throw Error('BUILD_INTEGRITY_FAILED')
        await this.touch(buildId)
        return { ...key, buildId, reused: true, directory: join(this.directory(buildId), 'bundle'), manifest }
      } catch (error) { if (!absent(error)) throw error }
      const toolchain = await this.tools.get(capture.toolchainId)
      if (toolchain.runtime.runtimeId !== capture.runtimeId) throw Error('BUILD_RUNTIME_INCOMPATIBLE')
      guard()
      if (!await this.approve(capture, this.recipe)) throw Error('BUILD_APPROVAL_REQUIRED')
      guard()
      await this.captures.get(captureId)
      staging = await mkdtemp(join(this.root, 'partial-'))
      const output = await this.compile(capture, this.captures.source(captureId), toolchain, this.tools, staging)
      guard()
      validateBundleFiles(output.files)
      for (const key of ['electron', 'abi', 'platform', 'arch'] as const) if (output.compatibility[key] !== toolchain.runtime[key]) throw Error('BUILD_RUNTIME_INCOMPATIBLE')
      await verify(join(staging, 'bundle'), output.files)
      const identity = { version: 1 as const, ...key, source: capture.source, ...output }, buildId = digest(identity)
      const manifest: BuildBundle = { ...identity, buildId }
      publication = await mkdtemp(join(this.root, 'publish-'))
      await rename(join(staging, 'bundle'), join(publication, 'bundle'))
      await writeFile(join(publication, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
      const published = this.directory(buildId)
      // Only the complete bundle and manifest cross the publication boundary.
      await rename(publication, published); publication = undefined
      await mkdir(join(this.root, 'keys'), { recursive: true })
      const index = join(this.root, 'keys', keyId + '.json'), temporary = index + '.' + randomUUID()
      await writeFile(temporary, JSON.stringify({ buildId }), { flag: 'wx' }); await rename(temporary, index)
      await this.touch(buildId)
      return { ...key, buildId, reused: false, directory: join(published, 'bundle'), manifest }
    } catch (error) {
      retainForRecovery = error instanceof Error && error.message === 'BUILD_TIMEOUT'
      throw error
    } finally {
      if (!retainForRecovery) {
        if (staging) await removeOwned(this.root, staging)
        if (publication) await removeOwned(this.root, publication)
        await release()
      }
    }
  }
  private async touch(buildId: string) {
    await mkdir(join(this.root, 'usage'), { recursive: true })
    await writeFile(join(this.root, 'usage', this.id(buildId) + '.json'), JSON.stringify({ at: new Date().toISOString() }))
  }
  async retain(buildId: string, referenceId = randomUUID()) {
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(referenceId)) throw Error('BUILD_REFERENCE_INVALID')
    const release = await this.lock()
    try {
      await this.read(buildId)
      const directory = join(this.root, 'references', this.id(buildId)); await mkdir(directory, { recursive: true })
      await writeFile(join(directory, referenceId + '.json'), JSON.stringify({ buildId, referenceId }), { flag: 'wx' })
      return referenceId
    } finally { await release() }
  }
  async release(buildId: string, referenceId: string) {
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(referenceId)) throw Error('BUILD_REFERENCE_INVALID')
    const unlock = await this.lock()
    try { await unlink(join(this.root, 'references', this.id(buildId), referenceId + '.json')).catch(error => { if (!absent(error)) throw error }) } finally { await unlock() }
  }
  async prune(limit = 3) {
    if (!Number.isInteger(limit) || limit < 0 || limit > 100) throw Error('BUILD_RETENTION_INVALID')
    const release = await this.lock()
    try {
      const bundles = []
      for (const name of await readdir(this.root)) {
        if (!/^bundle-[a-f0-9]{64}$/.test(name)) continue
        const id = name.slice(7)
        let references: string[] = []
        try { references = await readdir(join(this.root, 'references', id)) } catch (error) { if (!absent(error)) throw error }
        const usage = JSON.parse(await readFile(join(this.root, 'usage', id + '.json'), 'utf8'))
        bundles.push({ id, referenced: references.length > 0, at: String(usage.at) })
      }
      bundles.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
      const removed: string[] = []
      let retained = bundles.length
      for (const bundle of [...bundles].reverse()) {
        if (retained <= limit) break
        if (bundle.referenced) continue
        const manifest = await this.read(bundle.id)
        await removeOwned(this.root, this.directory(bundle.id)); await unlink(join(this.root, 'usage', bundle.id + '.json'))
        await unlink(join(this.root, 'keys', digest({ captureId: manifest.captureId, toolchainId: manifest.toolchainId, runtimeId: manifest.runtimeId, recipe: manifest.recipe }) + '.json'))
        retained--; removed.push(bundle.id)
      }
      return { removed, retained }
    } finally { await release() }
  }
}
