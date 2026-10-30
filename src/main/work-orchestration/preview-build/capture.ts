import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { join, relative, isAbsolute, resolve } from 'node:path'
import type { PreviewProfile } from '../preview-profile'
import type { PreviewSelection, PreviewPreflight } from '../../../shared/types/runtime-preview-types'
import { absent, digest, physical, removeOwned, snapshot, tree, verify, type BuildFile } from './files'

export interface CaptureBasis { selection: PreviewSelection; profile: PreviewProfile; source: NonNullable<PreviewPreflight['snapshot']> }
export interface BuildCapture extends CaptureBasis { version: 1; captureId: string; toolchainId: string; runtimeId: string; files: BuildFile[] }
const roots = new Set(['src', 'assets', 'scripts'])
export function captureInput(path: string, directory: boolean) {
  const parts = path.split('/')
  if (parts.some(p => p.startsWith('.') || ['node_modules', 'out', 'dist', 'coverage'].includes(p)) || /\.(db|sqlite|sqlite3|log|pem|key)$/i.test(path)) return false
  if (parts[0] === 'scripts') return parts.length === 1 || ['local-mcp', 'local-agent', 'runtime-preview', 'native-bundle-guard.cjs'].includes(parts[1])
  return roots.has(parts[0]) || !directory && /^(package(-lock)?\.json|electron\.vite\.config\.ts|tsconfig(\.[a-z]+)?\.json)$/.test(path)
}
export class PreviewCaptureStore {
  constructor(readonly root: string) {}
  async capture(worktree: string, observe: () => Promise<CaptureBasis>, toolchain: { toolchainId: string; runtimeId: string }, allowDirty: boolean) {
    const sourceRoot = await physical(worktree)
    const requested = relative(sourceRoot, resolve(this.root))
    if (!requested || !requested.startsWith('..') && !isAbsolute(requested)) throw Error('CAPTURE_STORE_INSIDE_WORKTREE')
    await mkdir(this.root, { recursive: true }); const root = await physical(this.root)
    const scope = relative(sourceRoot, root)
    if (!scope || !scope.startsWith('..') && !isAbsolute(scope)) throw Error('CAPTURE_STORE_INSIDE_WORKTREE')
    const before = await observe()
    if (!before.source.head || !before.source.branch) throw Error('CAPTURE_HEAD_REJECTED')
    if (before.source.dirty && !allowDirty) throw Error('CAPTURE_DIRTY_REJECTED')
    const staging = await mkdtemp(join(root, 'partial-')), inputs = join(staging, 'source')
    await mkdir(inputs)
    try {
      const paths = await tree(sourceRoot, captureInput), files = await snapshot(sourceRoot, paths, inputs)
      const after = await observe()
      if (digest(before) !== digest(after) || digest(paths) !== digest(await tree(sourceRoot, captureInput)) || digest(files) !== digest(await snapshot(sourceRoot, paths))) throw Error('CAPTURE_SOURCE_CHANGED')
      for (const required of ['package.json', 'package-lock.json', 'electron.vite.config.ts', 'scripts/native-bundle-guard.cjs', 'src/main/bootstrap.ts', 'src/main/preload.ts', 'src/renderer/index.html']) if (!paths.includes(required)) throw Error('CAPTURE_INPUT_MISSING')
      const identity = { version: 1 as const, ...before, ...toolchain, files }, captureId = digest(identity), capture: BuildCapture = { ...identity, captureId }
      await writeFile(join(staging, 'capture.json'), JSON.stringify(capture), { flag: 'wx' })
      const destination = join(root, captureId)
      try { await rename(staging, destination) } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code!)) throw error
        const existing = await this.get(captureId)
        if (digest(existing) !== digest(capture)) throw Error('CAPTURE_CONFLICT')
      }
      return capture
    } finally { try { await removeOwned(root, staging) } catch (error) { if (!absent(error)) throw error } }
  }
  async get(captureId: string): Promise<BuildCapture> {
    if (!/^[a-f0-9]{64}$/.test(captureId)) throw Error('CAPTURE_INVALID')
    const directory = join(await physical(this.root), captureId); await physical(directory)
    const capture = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as BuildCapture
    const { captureId: id, ...identity } = capture
    if (id !== captureId || digest(identity) !== captureId || capture.version !== 1) throw Error('CAPTURE_INTEGRITY_FAILED')
    await verify(join(directory, 'source'), capture.files)
    return capture
  }
  source(captureId: string) { if (!/^[a-f0-9]{64}$/.test(captureId)) throw Error('CAPTURE_INVALID'); return join(this.root, captureId, 'source') }
}
