import { readFile, realpath } from 'node:fs/promises'
import { dirname, join, delimiter } from 'node:path'
import { createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { bytesFingerprint, previewFingerprint, previewProfileSchema, type PreviewProfile } from '../preview-profile'
import { previewPath } from '../preview-preflight'
import type { PreviewProfileStore } from '../preview-profile-store'

const execute = promisify(execFile)
async function checkoutPath(root: string, file: string, reason: string) {
  try { return await previewPath(root, file) }
  catch (error) {
    if (error instanceof Error && error.message === 'PATH_OUTSIDE_WORKTREE') throw error
    throw new Error(reason)
  }
}
const launchInputs = ['scripts/runtime-preview/launch.cjs', 'scripts/runtime-preview/cooperation.cjs', 'scripts/runtime-preview/build-identity.cjs',
  'electron.vite.config.ts', 'src/main/bootstrap.ts', 'src/main/work-orchestration/runtime-preview/electron-mode.ts',
  'src/main/work-orchestration/runtime-preview/context-bootstrap.ts', 'src/main/work-orchestration/runtime-preview/context-contract.ts']
const components = ['main.ts', 'bootstrap.ts', 'work-orchestration/runtime-preview/electron-mode.ts', 'work-orchestration/runtime-preview/context-bootstrap.ts',
  'work-orchestration/runtime-preview/context-data.ts', 'core/active-project-service.ts', 'continuum/project-continuum-session.ts', 'ipc/workspace-handler.ts',
  'ipc/code-map-handler.ts', 'repository-catalog/repository-catalog-store.ts']
const modules = ['better-sqlite3', 'electron', 'esbuild', 'tree-sitter', 'tree-sitter-typescript', 'tree-sitter-javascript']
const availablePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer(); server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') return server.close(() => reject(new Error('APP_ENDPOINT_UNAVAILABLE'))); server.close(error => error ? reject(error) : resolve(address.port)) })
})

export interface CodeAwarenessEnvironment { root: string; executable: string; electronVersion: string; abi: string }
export class CodeAwarenessProfileResolver {
  constructor(private readonly store: PreviewProfileStore, private readonly environment: CodeAwarenessEnvironment) {}
  async resolve(repositoryId: string, worktreeId: string, worktree: string): Promise<PreviewProfile> {
    if (process.platform !== 'win32' || process.arch !== 'x64' || !process.env.SystemRoot) throw new Error('APP_HOST_UNSUPPORTED')
    let targetPackage: { name?: string; packageManager?: string }
    try { targetPackage = JSON.parse(await readFile(await checkoutPath(worktree, 'package.json', 'APP_CHECKOUT_UNSUPPORTED'), 'utf8')) }
    catch { throw new Error('APP_CHECKOUT_UNSUPPORTED') }
    if (targetPackage.name !== 'code-awareness' || targetPackage.packageManager !== 'npm@10.9.4') throw new Error('APP_CHECKOUT_UNSUPPORTED')
    const inputs: Array<{ path: string; fingerprint: string }> = []
    for (const file of launchInputs) {
      const trusted = await readFile(join(this.environment.root, file)).catch(() => { throw new Error('APP_HOST_PROFILE_UNAVAILABLE') })
      const target = await readFile(await checkoutPath(worktree, file, 'APP_COOPERATION_MISSING')).catch(() => { throw new Error('APP_COOPERATION_MISSING') })
      if (!trusted.equals(target)) throw new Error('APP_COOPERATION_INCOMPATIBLE')
      inputs.push({ path: file, fingerprint: bytesFingerprint(trusted) })
    }
    for (const file of [...components.map(file => 'src/main/' + file), 'src/main/preload.ts', 'src/renderer/src/App.tsx']) await checkoutPath(worktree, file, 'APP_COOPERATION_MISSING')
    const runtimeExecutable = 'node_modules/electron/dist/electron.exe'
    const runtimeBytes = await readFile(await checkoutPath(worktree, runtimeExecutable, 'APP_RUNTIME_UNAVAILABLE')).catch(() => { throw new Error('APP_RUNTIME_UNAVAILABLE') })
    const runtimeFingerprint = bytesFingerprint(runtimeBytes)
    if (runtimeFingerprint !== bytesFingerprint(await readFile(this.environment.executable))) throw new Error('APP_RUNTIME_INCOMPATIBLE')
    const locate = async (name: string) => {
      const found = await execute('where.exe', [name], { windowsHide: true, timeout: 10000, maxBuffer: 16384 })
      return realpath(found.stdout.trim().split(/\r?\n/)[0])
    }
    const node = await locate('node.exe').catch(() => { throw new Error('APP_NODE_UNAVAILABLE') }), git = await locate('git.exe').catch(() => { throw new Error('APP_GIT_UNAVAILABLE') })
    const nodeVersion = JSON.parse((await execute(node, ['-p', 'JSON.stringify({node:process.versions.node,electron:process.versions.electron})'], { windowsHide: true, timeout: 10000 })).stdout)
    if (!nodeVersion.node || nodeVersion.electron) throw new Error('APP_NODE_UNAVAILABLE')
    await this.store.assertExternal(worktree)
    return this.store.provideDefault('code-awareness-' + worktreeId, async current => {
      if (current && (previewFingerprint(current.security) !== previewFingerprint({ mode: 'profile_only', requirements: [] }) || previewFingerprint(current.bootstrap) !== previewFingerprint({ kind: 'CODE_AWARENESS', dataPolicy: 'REPOSITORY_SNAPSHOT', maxBytes: 67108864, maxArtifacts: 10000 }))) throw new Error('APP_PROFILE_POLICY_CHANGED')
      const port = current?.adapter?.port ?? await availablePort()
      return previewProfileSchema.parse({ schemaVersion: 1, profileId: 'code-awareness-' + worktreeId, revision: current?.revision ?? 1, repositoryId,
        runtime: 'ELECTRON_DEV', runtimeVersion: this.environment.electronVersion,
        command: { executable: node, executableHash: bytesFingerprint(await readFile(node)), args: ['scripts/runtime-preview/launch.cjs'], cwd: '.', inputs },
        env: { PATH: dirname(git) + delimiter + join(process.env.SystemRoot!, 'System32') },
        resources: [{ name: 'runtime', strategy: 'SESSION_DIRECTORY' }, { name: 'http-hmr', strategy: 'SESSION_ENDPOINT' }],
        dependencies: { packageManager: 'npm', packageManagerVersion: '10.9.4', manifest: 'package.json', lockfile: 'package-lock.json',
          manifestHash: bytesFingerprint(await readFile(await previewPath(worktree, 'package.json'))), lockfileHash: bytesFingerprint(await readFile(await previewPath(worktree, 'package-lock.json'))),
          abi: this.environment.abi, materialization: '.code-awareness/runtime-preview/materialization.json' },
        cooperation: { manifest: 'scripts/runtime-preview/cooperation.cjs', fingerprint: inputs[1].fingerprint },
        bootstrap: { kind: 'CODE_AWARENESS', dataPolicy: 'REPOSITORY_SNAPSHOT', maxBytes: 67108864, maxArtifacts: 10000 },
        adapter: { version: 1, kind: 'ELECTRON', port, configFile: 'electron.vite.config.ts', runtimeExecutable, runtimeExecutableHash: runtimeFingerprint, nativeModules: modules,
          artifacts: [...components.map(file => ({ component: 'ELECTRON_MAIN', path: 'src/main/' + file })), { component: 'ELECTRON_PRELOAD', path: 'src/main/preload.ts' }, { component: 'ELECTRON_RENDERER', path: 'src/renderer/src/App.tsx' }] },
        security: { mode: 'profile_only', requirements: [] }, network: { destinations: ['http://127.0.0.1:' + port], openNetworkConsent: false, credentials: 'TARGET_OWN_TEST_PROFILE' },
        probes: { readiness: { kind: 'HTTP', address: 'http://127.0.0.1:' + port + '/', timeoutMs: 120000 }, liveness: 'READINESS', attestation: 'COOPERATIVE_LOADED_ARTIFACT' },
        shutdown: { spawn: 'JOB_LIST_AT_CREATE', breakaway: false, killOnJobClose: true, graceMs: 0, forceMs: 10000 } })
    })
  }
}
