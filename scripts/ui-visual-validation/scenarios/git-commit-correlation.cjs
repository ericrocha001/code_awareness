const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
exports.run = async ctx => {
  const backend = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({ stdin: { contents: "export {GitService} from './src/main/core/git-service'; export {GitOperationsService} from './src/main/git-operations/git-operations-service'; export {GitHubGitTransport} from './src/main/github/github-git-transport'; export {GitManagementController,registerGitManagementHandlers} from './src/main/ipc/git-management-handler'; export {RuntimeIdentityProvider} from './src/main/runtime-identity/runtime-identity-provider'", resolveDir: ctx.projectRoot }, bundle: true, outfile: backend, platform: 'node', format: 'cjs', external: ['electron','better-sqlite3'] })
  const api = require(backend), identity = new api.RuntimeIdentityProvider({ rootDir: ctx.projectRoot, includedDirectories: ['src/main','src/shared','src/renderer/src'] })
  await identity.sourceOriginReady
  const runtime = identity.getIdentityPayload()
  ctx.check('Current implementation worktree and source MATCH', runtime.sourceOrigin.worktree.rootPath.toLowerCase() === ctx.projectRoot.toLowerCase() && runtime.freshness.state === 'MATCH')
  const root = path.join(ctx.temporary, 'repository'), linked = path.join(ctx.temporary, 'linked'), detached = path.join(ctx.temporary, 'detached')
  fs.mkdirSync(root)
  const git = (cwd, args) => { const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); if (result.status) throw new Error(result.stderr); return result.stdout.trim() }
  git(root, ['init', '-b', 'reference']); git(root, ['config', 'user.name', 'Acceptance']); git(root, ['config', 'user.email', 'acceptance@example.test'])
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n'); git(root, ['add', '.']); git(root, ['commit', '-m', 'base']); const base = git(root, ['rev-parse', 'HEAD'])
  git(root, ['worktree', 'add', '-b', 'linked', linked]); git(root, ['worktree', 'add', '--detach', detached])
  fs.writeFileSync(path.join(linked, 'a.txt'), 'a\n'); git(linked, ['add', '.']); git(linked, ['commit', '-m', 'a'])
  fs.writeFileSync(path.join(detached, 'b.txt'), 'b\n'); git(detached, ['add', '.']); git(detached, ['commit', '-m', 'detached b'])
  const detachedHead = git(detached, ['rev-parse', 'HEAD']), serviceGit = new api.GitService(), commands = [], original = serviceGit.runGitBytes.bind(serviceGit)
  serviceGit.runGitBytes = async (...args) => { commands.push(args[0]); return original(...args) }
  const state = { project: { id: 'correlation-acceptance', path: root, name: 'Correlation' }, revision: 1 }
  const service = new api.GitOperationsService(root, serviceGit, new api.GitHubGitTransport(null, serviceGit), { repositoryId: 'correlation', isActive: () => state.project?.id === 'correlation-acceptance' && state.revision === 1 })
  const records = (await service.discoverCoordinationWorktrees()).worktrees, record = records.find(r => r.path === detached), controller = new api.GitManagementController({ getState: () => state })
  controller.bind(service); api.registerGitManagementHandlers(controller)
  const before = await Promise.all([root, linked, detached].map(p => serviceGit.captureWorktreeReadSnapshot(p))), context = { projectId: state.project.id, revision: state.revision }
  const preload = path.join(ctx.temporary, 'preload.cjs'); buildSync({ entryPoints: [path.join(ctx.projectRoot, 'src/main/preload.ts')], bundle: true, outfile: preload, platform: 'node', format: 'cjs', external: ['electron'] }); ctx.window.webContents.session.setPreloads([preload])
  const page = path.join(ctx.temporary, 'index.html'); fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>Backend contract validation</title><p>Backend contract validation</p>')
  try {
    const idle = commands.length; await ctx.load(page); await new Promise(resolve => setTimeout(resolve, 50))
    ctx.check('Loading the typed bridge triggers zero correlation Git calls', commands.length === idle)
    const invoke = request => ctx.evaluate(request => window.codeAwareness.getGitCommitCorrelation(request), request)
    const forward = await invoke({ context, direction: 'WORKTREE_COMMITS', worktreeId: record.worktreeId, generation: record.generation, limit: 1 })
    ctx.check('Forward read travels through actual preload/IPC and starts with detached HEAD', forward.success && forward.data.worktree.detached && forward.data.items[0].sha === detachedHead && forward.data.items[0].relation === 'HEAD_EXACT')
    const next = await invoke({ context, direction: 'WORKTREE_COMMITS', worktreeId: record.worktreeId, generation: record.generation, limit: 1, cursor: forward.data.nextCursor })
    ctx.check('Continuation is exact and returns inherited ancestry', next.success && next.data.items[0].sha === base && next.data.coverage === 'COMPLETE')
    const inverse = await invoke({ context, direction: 'COMMIT_WORKTREES', sha: base, limit: 100 })
    ctx.check('Inverse read returns multiple current worktrees without creation ownership', inverse.success && inverse.data.items.length === 3 && inverse.data.items.some(i => i.detached && i.relation === 'REACHABLE_FROM_HEAD') && !JSON.stringify(inverse.data).includes('createdInWorktree'))
    const exclusive = await invoke({ context, direction: 'WORKTREE_COMMITS', worktreeId: record.worktreeId, generation: record.generation, mode: 'EXCLUSIVE', reference: 'refs/heads/reference' })
    ctx.check('Explicit reference is fixed and exclusive is separately qualified', exclusive.success && exclusive.data.reference.sha === base && exclusive.data.items.length === 1 && exclusive.data.items[0].referenceRelation === 'EXCLUSIVE_RELATIVE_TO_REFERENCE')
    const mark = commands.length, invalid = await invoke({ context, direction: 'COMMIT_WORKTREES', sha: base, path: 'outside' })
    ctx.check('Unknown fields are rejected without Git reads', !invalid.success && invalid.code === 'INVALID_ARGUMENT' && commands.length === mark)
    const graph = await ctx.evaluate(context => window.codeAwareness.getGitManagementHistory({ context }), context)
    ctx.check('Existing Git Management history contract stays available', graph.success && graph.data.nodes.some(node => node.sha === base) && !('items' in graph.data))
    ctx.check('Correlation produces no mutations and preserves snapshots', JSON.stringify(before) === JSON.stringify(await Promise.all([root, linked, detached].map(p => serviceGit.captureWorktreeReadSnapshot(p)))) && commands.every(args => !['fetch','merge','add','commit','checkout','reset','update-ref','push'].includes(args[0])))
    state.revision++
    const old = await invoke({ context, direction: 'COMMIT_WORKTREES', sha: base })
    ctx.check('Obsolete project context cannot consume associations', !old.success && old.code === 'PROJECT_CONTEXT_CHANGED')
    ctx.check('Runtime source remains MATCH', identity.getIdentityPayload().freshness.state === 'MATCH')
    await ctx.capture('backend-transport-proof')
    fs.writeFileSync(path.join(ctx.evidenceDir, 'correlation-proof.json'), JSON.stringify({ scope: 'Production Git Operations, registry, controller, preload and real isolated Git; blank page, no product UI modifications', runtime, forward, next, inverse, exclusive, invalid, old, commands }, null, 2))
  } finally {
    await controller.deactivate()
    const { ipcMain } = require('electron'); for (const channel of ['git-operations:correlation','git-management:mutate','git-management:history','git-management:overview','git-management:commit-detail','git-management:patch']) ipcMain.removeHandler(channel)
  }
}
