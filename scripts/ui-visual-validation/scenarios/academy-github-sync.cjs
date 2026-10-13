const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildSync } = require('esbuild')

exports.run = async ctx => {
  const nativeClick = ctx.click
  ctx.click = async selector => {
    if (await ctx.evaluate(() => !!document.querySelector('.academy-toast button'))) await nativeClick('.academy-toast button')
    await ctx.evaluate(selector => document.querySelector(selector)?.scrollIntoView({ block: 'center', inline: 'nearest' }), selector)
    await nativeClick(selector)
  }
  const backend = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({ stdin: { contents: "export { AcademyService } from './src/main/academy/academy-service'; export { registerAcademyHandlers } from './src/main/ipc/academy-handler'; export { AcademyGitSyncService } from './src/main/academy/git/academy-git-sync-service'; export { AcademyGitMaterializer } from './src/main/academy/git/academy-git-materializer'; export { GitService } from './src/main/core/git-service'", resolveDir: ctx.projectRoot }, bundle: true, outfile: backend, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'] })
  const { AcademyService, registerAcademyHandlers, AcademyGitSyncService, AcademyGitMaterializer, GitService } = require(backend)
  const gitCommand = (root, ...args) => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' }).trim()
  const remote = path.join(ctx.temporary, 'remote.git')
  const human = path.join(ctx.temporary, 'human')
  const external = path.join(ctx.temporary, 'external')
  gitCommand(ctx.temporary, 'init', '--bare', remote)
  gitCommand(ctx.temporary, 'clone', remote, human)
  gitCommand(human, 'switch', '-c', 'main')
  gitCommand(human, 'config', 'user.name', 'Proof'); gitCommand(human, 'config', 'user.email', 'proof@example.com')
  const pkg = text => ({ skillMd: `---\nname: alpha\ndescription: GitHub reconciliation proof\n---\n${text}\n`, artifacts: {} })
  fs.mkdirSync(path.join(human, 'skills', 'alpha'), { recursive: true })
  fs.writeFileSync(path.join(human, 'skills', 'alpha', 'SKILL.md'), pkg('baseline').skillMd)
  fs.writeFileSync(path.join(human, 'README.md'), 'documentation')
  gitCommand(human, 'add', '.'); gitCommand(human, 'commit', '-m', 'baseline'); gitCommand(human, 'push', '-u', 'origin', 'main')
  gitCommand(ctx.temporary, 'clone', '--branch', 'main', remote, external)
  gitCommand(external, 'config', 'user.name', 'Writer'); gitCommand(external, 'config', 'user.email', 'writer@example.com')
  const service = new AcademyService(path.join(ctx.temporary, 'data', 'academy.db'))
  const skill = service.store.create({ package: pkg('baseline'), scope: 'GLOBAL', origin: 'UI' })
  const git = new GitService()
  const transport = { fetch: (root, origin) => git.fetchRemote(root, origin), readRemoteHead: (root, origin, ref) => git.readRemoteHead(root, origin, ref), push: (root, branch, origin, head) => git.push(root, origin, branch, head) }
  const record = { id: 'proof', name: 'Academy', status: 'ACTIVE', localCheckout: { path: human, availability: 'AVAILABLE', gitState: 'GIT' }, github: { repositoryId: 'proof-github', fullName: 'proof/academy', visibility: 'PRIVATE', cloneUrl: remote } }
  const sync = new AcademyGitSyncService(service.store, new AcademyGitMaterializer(), git, transport, { resolveRepository: () => record, findByGitHubId: () => record, listEligibleRepositories: () => [record] }, service)
  service.gitSync = sync
  const settle = async fn => {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) { if (await ctx.evaluate(fn)) return; await new Promise(resolve => setTimeout(resolve, 100)) }
    throw new Error('Academy Git UI did not settle')
  }
  const update = text => service.store.update({ skillId: skill.id, expectedVersion: service.store.get(skill.id).currentVersion, package: pkg(text), origin: 'UI' })
  const externalCommit = (file, content) => { fs.writeFileSync(path.join(external, file), content); gitCommand(external, 'add', '.'); gitCommand(external, 'commit', '-m', file); gitCommand(external, 'push') }
  try {
    const bound = await sync.bindRepository('proof')
    ctx.check('Real backend confirms initial convergence', bound.syncState === 'SYNCED')
    const humanHead = gitCommand(human, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(human, 'third-party.txt'), 'staged human work'); gitCommand(human, 'add', 'third-party.txt')
    const humanIndex = await git.getIndexRevision(human)
    externalCommit('README.md', 'external documentation')
    update('canonical update'); service.store.updateGitSyncState({ syncState: 'DIRTY' })
    registerAcademyHandlers(service)
    const preload = path.join(ctx.temporary, 'preload.cjs')
    buildSync({ entryPoints: [path.join(ctx.projectRoot, 'src/main/preload.ts')], bundle: true, outfile: preload, platform: 'node', format: 'cjs', external: ['electron'] })
    ctx.window.webContents.session.setPreloads([preload])
    buildSync({ entryPoints: [path.join(__dirname, 'academy-conflicts-fixture.tsx')], bundle: true, outfile: path.join(ctx.temporary, 'fixture.js'), platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' } })
    const product = fs.readFileSync(path.join(ctx.projectRoot, 'src/renderer/index.html'), 'utf8')
    const csp = product.match(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]*>/i)?.[0]
    if (!csp) throw new Error('Production CSP missing')
    const page = path.join(ctx.temporary, 'index.html')
    fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8">${csp}<link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}body{background:var(--bg-primary);color:var(--text-primary)}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
    await ctx.load(page); await ctx.viewport(1440, 900)
    await ctx.waitFor(() => !!document.querySelector('[data-academy-action="sync-git"]'))
    await ctx.click('[data-academy-action="sync-git"]')
    await settle(() => !!document.querySelector('.academy-toast.success'))
    ctx.check('Normal UI reconciles real Git and shows remote confirmation', sync.getStatus().publication.phase === 'CONFIRMED' && await ctx.evaluate(() => document.body.textContent.includes('Última confirmação remota:')))
    await ctx.capture('confirmed-dark')
    ctx.check('Human index and HEAD remain unchanged', humanHead === gitCommand(human, 'rev-parse', 'HEAD') && humanIndex === await git.getIndexRevision(human))
    gitCommand(external, 'pull', '--ff-only')
    externalCommit('skills/alpha/SKILL.md', pkg('incompatible writer').skillMd)
    update('canonical resolution')
    await ctx.click('[data-academy-action="sync-git"]')
    await settle(() => !!document.querySelector('[data-academy-action="resolve-git"]'))
    ctx.check('Conflict produces error presentation, never a success toast', await ctx.evaluate(() => !!document.querySelector('.academy-toast.error') && !document.querySelector('.academy-toast.success')))
    await ctx.capture('protected-conflict-dark')
    const remoteBefore = gitCommand(external, 'rev-parse', 'HEAD')
    await ctx.click('[data-academy-action="resolve-git"]')
    await ctx.waitFor(() => !!document.querySelector('[role="alertdialog"]'))
    ctx.check('Protected resolution requires explicit user confirmation', sync.getStatus().publication.remoteHead === remoteBefore)
    await ctx.capture('resolution-confirmation-dark')
    await ctx.click('[role="alertdialog"] .academy-danger-button')
    await settle(() => !!document.querySelector('.academy-toast.success'))
    ctx.check('Confirmed resolution preserves external commit and canonical content', await git.isAncestor(sync.getStatus().repository.checkoutPath, remoteBefore, sync.getStatus().publication.remoteHead) && service.store.get(skill.id).current.package.skillMd === pkg('canonical resolution').skillMd)
    const fetch = transport.fetch
    transport.fetch = async () => { throw new Error('Proof network unavailable') }
    await ctx.click('[data-academy-action="sync-git"]')
    await settle(() => !!document.querySelector('.academy-toast.error'))
    ctx.check('Network failure remains explicit in normal UI', sync.getStatus().publication.phase === 'REMOTE_UNAVAILABLE')
    await ctx.capture('remote-unavailable-dark')
    transport.fetch = fetch
    await ctx.click('[data-academy-action="sync-git"]')
    await settle(() => !!document.querySelector('.academy-toast.success'))
    await ctx.capture('recovered-dark')
  } finally { service.close(); ctx.window.webContents.session.setPreloads([]) }
}
