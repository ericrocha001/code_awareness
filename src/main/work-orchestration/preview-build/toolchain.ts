import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PreviewProfile } from '../preview-profile'
import { absent, digest, hash, physical, removeOwned, snapshot, tree, verify, type BuildFile } from './files'
import { dependencyClosure, packageInput } from './dependencies'

export interface BuildRuntime { runtimeId: string; electron: string; abi: string; platform: string; arch: string; files: BuildFile[] }
export interface BuildToolchain { toolchainId: string; runtime: BuildRuntime; node: { path: string; sha256: string }; compiler: { root: string; files: BuildFile[] }; files: BuildFile[] }
export class PreviewBuildToolchains {
  constructor(readonly root: string) {}
  private async publish(staging: string, target: string, existing: () => Promise<void>) {
    try { await rename(staging, target) } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code!)) throw error
      await existing()
    } finally { try { await removeOwned(this.root, staging) } catch (error) { if (!absent(error)) throw error } }
  }
  async freeze(worktree: string, profile: PreviewProfile): Promise<BuildToolchain> {
    if (process.platform !== 'win32' || process.arch !== 'x64' || !process.env.SystemRoot) throw Error('BUILD_TOOLCHAIN_UNAVAILABLE')
    await mkdir(this.root, { recursive: true }); await physical(this.root)
    const modules = join(await physical(worktree), 'node_modules')
    try {
      const lock = JSON.parse(await readFile(join(worktree, 'package-lock.json'), 'utf8'))
      const electron = JSON.parse(await readFile(join(modules, 'electron/package.json'), 'utf8'))
      if (electron.version !== profile.runtimeVersion) throw Error('BUILD_RUNTIME_INCOMPATIBLE')
      for (const name of ['electron-vite', 'vite', 'esbuild', 'typescript', ...profile.adapter!.nativeModules]) {
        const installed = JSON.parse(await readFile(join(modules, name, 'package.json'), 'utf8'))
        if (installed.version !== lock.packages['node_modules/' + name]?.version) throw Error('BUILD_DEPENDENCY_INCOMPATIBLE')
      }
      const node = { path: await physical(profile.command.executable), sha256: hash(await readFile(profile.command.executable)) }
      if (node.sha256 !== profile.command.executableHash) throw Error('BUILD_TOOLCHAIN_CHANGED')
      const compilerRoot = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319')
      const compiler = { root: compilerRoot, files: await snapshot(compilerRoot, ['csc.exe', 'csc.exe.config', 'clr.dll', 'mscorlib.dll', 'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll']) }
      for (const path of ['electron/dist/electron.exe', 'electron-vite/bin/electron-vite.js']) await physical(join(modules, path))
      const runtimeStage = await mkdtemp(join(this.root, 'partial-runtime-')), dist = join(runtimeStage, 'dist')
      await mkdir(dist)
      const runtimeSource = join(modules, 'electron/dist'), runtimeFiles = await snapshot(runtimeSource, await tree(runtimeSource), dist)
      const runtimeBasis = { electron: profile.runtimeVersion, abi: profile.dependencies.abi, platform: process.platform, arch: process.arch, files: runtimeFiles }
      const runtime: BuildRuntime = { runtimeId: digest(runtimeBasis), ...runtimeBasis }
      await writeFile(join(runtimeStage, 'runtime.json'), JSON.stringify(runtime), { flag: 'wx' })
      await this.publish(runtimeStage, this.runtimeRoot(runtime.runtimeId), async () => verify(join(this.runtimeRoot(runtime.runtimeId), 'dist'), runtime.files))
      const staging = await mkdtemp(join(this.root, 'partial-toolchain-')), frozen = join(staging, 'node_modules'); await mkdir(frozen)
      try {
        const manifest = JSON.parse(await readFile(join(worktree, 'package.json'), 'utf8'))
        const packages = await dependencyClosure(modules, [...Object.keys(manifest.dependencies ?? {}), 'electron', 'electron-vite', '@vitejs/plugin-react', 'esbuild', 'typescript'])
        const select = (path: string) => packageInput(path, packages)
        const paths = await tree(modules, select), files = await snapshot(modules, paths, frozen)
        if (digest(paths) !== digest(await tree(modules, select)) || digest(files) !== digest(await snapshot(modules, paths))) throw Error('BUILD_TOOLCHAIN_CHANGED')
        const basis = { runtime, node, compiler, files }, toolchain = { toolchainId: digest(basis), ...basis }
        await writeFile(join(staging, 'toolchain.json'), JSON.stringify(toolchain), { flag: 'wx' })
        await this.publish(staging, this.toolchainRoot(toolchain.toolchainId), async () => { await this.get(toolchain.toolchainId) })
        return toolchain
      } finally { try { await removeOwned(this.root, staging) } catch (error) { if (!absent(error)) throw error } }
    } catch (error) {
      if (error instanceof Error && /^BUILD_/.test(error.message)) throw error
      throw Error('BUILD_TOOLCHAIN_UNAVAILABLE')
    }
  }
  runtimeRoot(id: string) { if (!/^[a-f0-9]{64}$/.test(id)) throw Error('BUILD_RUNTIME_INCOMPATIBLE'); return join(this.root, 'runtime-' + id) }
  toolchainRoot(id: string) { if (!/^[a-f0-9]{64}$/.test(id)) throw Error('BUILD_TOOLCHAIN_UNAVAILABLE'); return join(this.root, 'toolchain-' + id) }
  async get(id: string): Promise<BuildToolchain> {
    const directory = this.toolchainRoot(id); await physical(directory)
    const toolchain = JSON.parse(await readFile(join(directory, 'toolchain.json'), 'utf8')) as BuildToolchain
    const { toolchainId, ...basis } = toolchain
    const { runtimeId, ...runtimeBasis } = toolchain.runtime
    if (toolchainId !== id || digest(basis) !== id || digest(runtimeBasis) !== runtimeId) throw Error('BUILD_INTEGRITY_FAILED')
    await verify(join(directory, 'node_modules'), toolchain.files)
    await verify(join(this.runtimeRoot(runtimeId), 'dist'), toolchain.runtime.files)
    return toolchain
  }
}
