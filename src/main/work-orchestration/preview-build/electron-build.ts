import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BuildCapture } from './capture'
import type { BuildToolchain, PreviewBuildToolchains } from './toolchain'
import { digest, hash, inside, physical, snapshot, tree, type BuildFile } from './files'
import { dependencyClosure, packageInput } from './dependencies'

export const electronBuildRecipe = 'code-awareness-electron-production-bundle-v1'
export interface BundleCompatibility { electron: string; node: string; abi: string; platform: string; arch: string; buildNode: string; nativeModules: string[] }
export interface CompiledBundle { files: BuildFile[]; compatibility: BundleCompatibility }
export function validateBundleFiles(files: BuildFile[]) {
  for (const required of ['app/package.json', 'app/out/main/main.js', 'app/out/preload/preload.js', 'app/out/renderer/index.html', 'resources/runtime-preview/preview-owner.exe', 'resources/local-mcp/launcher.cjs']) if (!files.some(f => f.path === required && f.bytes > 0)) throw Error('BUILD_BUNDLE_INCOMPLETE')
  if (!files.some(f => f.path.startsWith('app/out/renderer/assets/') && f.bytes > 0) || !files.some(f => /better-sqlite3\/.*\.node$/.test(f.path))) throw Error('BUILD_BUNDLE_INCOMPLETE')
}
export async function compileElectronBundle(capture: BuildCapture, source: string, toolchain: BuildToolchain, tools: PreviewBuildToolchains, work: string): Promise<CompiledBundle> {
  if (hash(await readFile(toolchain.node.path)) !== toolchain.node.sha256 || digest(await snapshot(toolchain.compiler.root, toolchain.compiler.files.map(f => f.path))) !== digest(toolchain.compiler.files)) throw Error('BUILD_TOOLCHAIN_CHANGED')
  const cwd = join(work, 'compile'), bundle = join(work, 'bundle'), app = join(bundle, 'app'), resources = join(bundle, 'resources')
  await mkdir(cwd); await mkdir(app, { recursive: true }); await mkdir(resources)
  await snapshot(source, capture.files.map(f => f.path), cwd)
  const modules = join(cwd, 'node_modules'), dependencies = join(tools.toolchainRoot(toolchain.toolchainId), 'node_modules')
  await mkdir(modules); await snapshot(dependencies, toolchain.files.map(f => f.path), modules)
  await symlink(join(tools.runtimeRoot(toolchain.runtime.runtimeId), 'dist'), join(modules, 'electron/dist'), 'junction')
  const paths: Record<string, string> = {}
  for (const name of ['home', 'temp', 'appData']) { paths[name] = join(work, name); await mkdir(paths[name]) }
  const environment: NodeJS.ProcessEnv = { SystemRoot: process.env.SystemRoot, PATH: dirname(toolchain.node.path) + ';' + join(process.env.SystemRoot!, 'System32'),
    HOME: paths.home, USERPROFILE: paths.home, APPDATA: paths.appData, LOCALAPPDATA: paths.appData, TEMP: paths.temp, TMP: paths.temp, NODE_ENV: 'production' }
  const log = createWriteStream(join(work, 'build.log'), { flags: 'wx', mode: 0o600 })
  async function execute(executable: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
    await physical(executable)
    return new Promise<string>((accept, reject) => {
      const child = spawn(executable, args, { cwd, env: { ...environment, ...extra }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = '', size = 0, timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill() }, 300000)
      const record = (chunk: Buffer) => { size += chunk.length; if (size <= 16 * 1024 * 1024) log.write(chunk); if (output.length < 65536) output += chunk.toString('utf8') }
      child.stdout.on('data', record); child.stderr.on('data', record)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => { clearTimeout(timer); if (timedOut || code !== 0) reject(Error(timedOut ? 'BUILD_TIMEOUT' : 'BUILD_SOURCE_FAILED')); else accept(output.trim()) })
    })
  }
  try {
    const node = JSON.parse(await execute(toolchain.node.path, ['-p', 'JSON.stringify({node:process.versions.node,electron:process.versions.electron})']))
    if (!node.node || node.electron) throw Error('BUILD_TOOLCHAIN_UNAVAILABLE')
    await execute(toolchain.node.path, [join(modules, 'electron-vite/bin/electron-vite.js'), 'build'])
    await execute(toolchain.node.path, [join(cwd, 'scripts/native-bundle-guard.cjs')])
    await execute(toolchain.node.path, [join(cwd, 'scripts/local-mcp/build.cjs')])
    const native = JSON.parse(await execute(toolchain.node.path, [join(cwd, 'scripts/runtime-preview/build.cjs')]))
    inside(cwd, await physical(native.owner)); inside(cwd, await physical(native.receipt))
    await snapshot(join(cwd, 'out'), await tree(join(cwd, 'out'), path => path !== 'runtime-preview' && !path.startsWith('runtime-preview/')), join(app, 'out'))
    const manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
    if (manifest.main !== './out/main/main.js') throw Error('BUILD_ENTRYPOINT_INVALID')
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, main: manifest.main, dependencies: manifest.dependencies }), { flag: 'wx' })
    const selected = await dependencyClosure(modules, Object.keys(manifest.dependencies ?? {}))
    const productionFiles = toolchain.files.filter(f => packageInput(f.path, selected))
    await snapshot(modules, productionFiles.map(f => f.path), join(app, 'node_modules'))
    const assetPaths = capture.files.filter(f => f.path.startsWith('assets/')).map(f => f.path.slice(7))
    if (assetPaths.length) await snapshot(join(cwd, 'assets'), assetPaths, join(resources, 'assets'))
    const helper = join(resources, 'runtime-preview'); await mkdir(join(helper, 'sdk'), { recursive: true })
    await writeFile(join(helper, 'preview-owner.exe'), await readFile(native.owner), { flag: 'wx' })
    await writeFile(join(helper, 'build-receipt.json'), await readFile(native.receipt), { flag: 'wx' })
    await snapshot(join(cwd, 'scripts/runtime-preview'), ['launch.cjs', 'cooperation.cjs', 'build-identity.cjs'], join(helper, 'sdk'))
    const local = join(resources, 'local-mcp'); await mkdir(local)
    await writeFile(join(local, 'launcher.cjs'), await readFile(join(cwd, 'out/local-mcp/launcher.cjs')), { flag: 'wx' })
    const nativeModules = ['better-sqlite3', 'tree-sitter', 'tree-sitter-typescript', 'tree-sitter-javascript', 'sharp']
    const probeFile = join(work, 'compatibility.json')
    const probe = `const fs=require('node:fs'),{createRequire}=require('node:module');const req=createRequire(${JSON.stringify(join(app, 'package.json'))});for(const name of ${JSON.stringify(nativeModules)}){const m=req(name);if(name==='better-sqlite3'){const db=new m(':memory:');db.prepare('select 1').get();db.close()}}fs.writeFileSync(${JSON.stringify(probeFile)},JSON.stringify({electron:process.versions.electron,node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch}));`
    try { await execute(join(tools.runtimeRoot(toolchain.runtime.runtimeId), 'dist/electron.exe'), ['-e', probe], { ELECTRON_RUN_AS_NODE: '1' }) }
    catch (error) { if (error instanceof Error && error.message === 'BUILD_TIMEOUT') throw error; throw Error('BUILD_RUNTIME_INCOMPATIBLE') }
    const actual = JSON.parse(await readFile(probeFile, 'utf8'))
    for (const key of ['electron', 'abi', 'platform', 'arch'] as const) if (actual[key] !== toolchain.runtime[key]) throw Error('BUILD_RUNTIME_INCOMPATIBLE')
    if (digest(await snapshot(cwd, capture.files.map(f => f.path))) !== digest(capture.files) || digest(await snapshot(modules, toolchain.files.map(f => f.path))) !== digest(toolchain.files)) throw Error('BUILD_INPUT_CHANGED')
    await tools.get(toolchain.toolchainId)
    const files = await snapshot(bundle, await tree(bundle))
    validateBundleFiles(files)
    return { files, compatibility: { ...actual, buildNode: node.node, nativeModules } }
  } finally { await new Promise<void>(accept => log.end(accept)) }
}
