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
  fs.writeFileSync(path.join(human, 'plugin.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'academy-skills', version: '0.2.0', description: 'Academy Skills proof', author: { name: 'Academy' }, extensions: { 'com.openai': { interface: { displayName: 'Academy Skills' } } } }))
  fs.writeFileSync(path.join(human, 'README.md'), 'documentation')
  gitCommand(human, 'add', '.'); gitCommand(human, 'commit', '-m', 'baseline'); gitCommand(human, 'push', '-u', 'origin', 'main')
  gitCommand(ctx.temporary, 'clone', '--branch', 'main', remote, external)
  gitCommand(external, 'config', 'user.name', 'Writer'); gitCommand(external, 'config', 'user.email', 'writer@example.com')
  const workerPath = path.join(ctx.evidenceDir, 'academy-plugin-worker.cjs')
  buildSync({ entryPoints: [path.join(ctx.projectRoot, 'src/main/academy/publication/academy-plugin-worker.ts')], bundle: true, outfile: workerPath, platform: 'node', format: 'cjs' })
  const databasePath = path.join(ctx.temporary, 'data', 'academy.db')
  let service = new AcademyService(databasePath, undefined, 2000, workerPath)
  const skill = service.store.create({ package: pkg('baseline'), scope: 'GLOBAL', origin: 'UI' })
  await service.bootstrapOpenAiPlugin(human, '0.1.0')
  const git = new GitService()
  const transport = { authorizationIdentity: () => 'isolated-harness-policy', fetch: (root, origin) => git.fetchRemote(root, origin), readRemoteHead: (root, origin, ref) => git.readRemoteHead(root, origin, ref), push: (root, branch, origin, head) => git.push(root, origin, branch, head) }
  const record = { id: 'proof', name: 'Academy', status: 'ACTIVE', localCheckout: { path: human, availability: 'AVAILABLE', gitState: 'GIT' }, github: { repositoryId: 'proof-github', fullName: 'proof/academy', visibility: 'PRIVATE', cloneUrl: remote } }
  const createSync = () => new AcademyGitSyncService(service.store, new AcademyGitMaterializer(), git, transport, { resolveRepository: () => record, findByGitHubId: () => record, listEligibleRepositories: () => [record] }, service)
  let sync = createSync()
  service.initializeGitSync(sync)
  const settle = async fn => {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) { if (await ctx.evaluate(fn)) return; await new Promise(resolve => setTimeout(resolve, 100)) }
    throw new Error('Academy Git UI did not settle')
  }
  const update = text => sync.saveDraft({ skillId: skill.id, expectedVersion: service.store.get(skill.id).currentVersion, package: pkg(text), origin: 'UI' })
  const externalCommit = (file, content) => { fs.writeFileSync(path.join(external, file), content); gitCommand(external, 'add', '.'); gitCommand(external, 'commit', '-m', file); gitCommand(external, 'push') }
  try {
    const bound = await sync.bindRepository('proof')
    ctx.check('Real backend confirms initial convergence', bound.syncState === 'SYNCED')
    await sync.configureAutomation({ autoPublish: true, autoUpdate: true, confirmed: true, expectedRepositoryId: 'proof-github', expectedBranch: 'main' })
    const known = sync.getStatus().lastKnown
    await service.close()
    service = new AcademyService(databasePath, undefined, 2000, workerPath)
    sync = createSync(); service.initializeGitSync(sync)
    ctx.check('Restart retains last known identity and flags without resetting SQLite', JSON.stringify(sync.getStatus().lastKnown) === JSON.stringify(known) && sync.getStatus().remoteCheck.state === 'IDLE')
    const persisted = JSON.stringify(service.store.getGitPublication(bound.publication.destinationKey))
    const realFetch = transport.fetch
    let rejectOffline
    transport.fetch = () => new Promise((_resolve, reject) => { rejectOffline = reject })
    const milestones = []
    ctx.window.webContents.on('console-message', (_event, _level, message) => {
      const prefix = '[Academy hydration] '
      if (message.startsWith(prefix)) milestones.push(JSON.parse(message.slice(prefix.length)))
    })
    const humanHead = gitCommand(human, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(human, 'third-party.txt'), 'staged human work'); gitCommand(human, 'add', 'third-party.txt')
    const humanIndex = await git.getIndexRevision(human)
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
    await ctx.waitFor(() => document.body.textContent.includes('Verificando atualização'))
    await ctx.waitFor(() => document.querySelector('.academy-git-summary')?.textContent.includes('proof/academy'))
    ctx.check('First useful paint exposes persisted flags and upload without ZIP preparation', await ctx.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('label'))
      return labels.filter(label => /Publicação automática|Atualização automática/.test(label.textContent)).every(label => label.querySelector('input')?.checked) &&
        document.querySelector('.academy-fallback-card')?.textContent.includes('UPLOADED_UNVERIFIED') && !document.querySelector('.academy-git-summary')?.textContent.includes('UNCONFIGURED')
    }))
    ctx.check('Checking does not rewrite the last successful SQLite snapshot', JSON.stringify(service.store.getGitPublication(bound.publication.destinationKey)) === persisted)
    await ctx.click('input[aria-label="Buscar Skills"]')
    ctx.window.webContents.insertText('alpha')
    await ctx.waitFor(() => document.querySelector('input[aria-label="Buscar Skills"]').value === 'alpha')
    await ctx.evaluate(() => window.codeAwareness.getAcademyGitStatus())
    await ctx.capture('hydration-checking-dark')
    const fetchDeadline = Date.now() + 5000
    while (!rejectOffline && Date.now() < fetchDeadline) await new Promise(resolve => setTimeout(resolve, 5))
    if (!rejectOffline) throw new Error('Remote verification did not start')
    rejectOffline(new Error('simulated offline initial verification'))
    await ctx.waitFor(() => document.body.textContent.includes('Falha ao verificar GitHub'))
    ctx.check('Offline retains last known confirmation and automation flags', JSON.stringify(sync.getStatus().lastKnown) === JSON.stringify(known) && sync.getStatus().remoteCheck.state === 'FAILED' && JSON.stringify(service.store.getGitPublication(bound.publication.destinationKey)) === persisted)
    await ctx.capture('hydration-offline-dark')
    const firstInitialization = milestones[0]?.initializationId
    const opening = milestones.filter(mark => mark.initializationId === firstInitialization)
    ctx.check('Opening correlates Store then stable useful paint then remote failure', opening.map(mark => mark.milestone).join(',') === 'STORE_RESPONSE,FIRST_USEFUL_PAINT,REMOTE_CHECK_COMPLETE' && opening[2].elapsedMs >= opening[1].elapsedMs && opening[1].elapsedMs >= opening[0].elapsedMs)
    fs.writeFileSync(path.join(ctx.evidenceDir, 'hydration.json'), JSON.stringify({ milestones: opening, persisted: known, remote: sync.getStatus().remoteCheck, sourceHead: gitCommand(ctx.projectRoot, 'rev-parse', 'HEAD') }))
    transport.fetch = realFetch
    await sync.configureAutomation({ autoPublish: false, autoUpdate: false, confirmed: true, expectedRepositoryId: 'proof-github', expectedBranch: 'main' })
    externalCommit('README.md', 'external documentation')
    await sync.syncNow(); await update('local draft update')
    await ctx.waitFor(() => document.querySelector('[data-academy-action="sync-git"]')?.textContent.includes('Publicar'))
    await ctx.waitFor(() => !!document.querySelector('[data-academy-action="sync-git"]'))
    await ctx.click('[data-academy-action="sync-git"]')
    const operationDeadline = Date.now() + 3000
    while (!sync.active && Date.now() < operationDeadline) await new Promise(resolve => setTimeout(resolve, 25))
    ctx.check('Publication is in progress during interaction sampling', Boolean(sync.active))
    const latencies = []
    for (let sample = 0; sample < 3; sample++) {
      const started = Date.now()
      await ctx.evaluate(() => window.codeAwareness.getAcademyGitStatus())
      await ctx.click('input[aria-label="Buscar Skills"]')
      await ctx.evaluate(() => document.querySelector('input[aria-label="Buscar Skills"]').select())
      ctx.window.webContents.insertText(`alpha${sample}`)
      await ctx.waitFor(sample => document.querySelector('input[aria-label="Buscar Skills"]').value === `alpha${sample}`, sample)
      const responsive = await ctx.evaluate(sample => document.querySelector('input[aria-label="Buscar Skills"]').value === `alpha${sample}`, sample)
      latencies.push(Date.now() - started)
      fs.writeFileSync(path.join(ctx.evidenceDir, 'responsiveness.json'), JSON.stringify({ required: true, budgetMs: 1000, latencies, responsive }))
      ctx.check(`Input and IPC remain available during publication ${sample}`, responsive && latencies[sample] < 1000)
    }
    fs.writeFileSync(path.join(ctx.evidenceDir, 'responsiveness.json'), JSON.stringify({ required: true, budgetMs: 1000, latencies, sourceHead: gitCommand(ctx.projectRoot, 'rev-parse', 'HEAD') }))
    await ctx.input('input[aria-label="Buscar Skills"]', '')
    await settle(() => !!document.querySelector('.academy-toast.success'))
    ctx.check('Normal UI reconciles real Git and shows remote confirmation', sync.getStatus().publication.phase === 'CONFIRMED' && await ctx.evaluate(() => document.body.textContent.includes('Última confirmação remota:')))
    await ctx.capture('confirmed-dark')
    await ctx.click('.academy-fallback-card .academy-inline-actions button')
    const packageDeadline = Date.now() + 10000
    while (!service.openAiPublication.physicalFlights.size && Date.now() < packageDeadline) await new Promise(resolve => setTimeout(resolve, 5))
    ctx.check('Physical packaging runs asynchronously during real UI interaction', service.openAiPublication.physicalFlights.size > 0)
    await ctx.evaluate(() => window.codeAwareness.getAcademyGitStatus())
    await ctx.click('input[aria-label="Buscar Skills"]')
    await ctx.evaluate(() => document.querySelector('input[aria-label="Buscar Skills"]').select())
    ctx.window.webContents.insertText('alpha')
    await ctx.waitFor(() => document.querySelector('input[aria-label="Buscar Skills"]').value === 'alpha')
    ctx.check('Input and IPC remain available while ZIP work completes', await ctx.evaluate(() => document.querySelector('input[aria-label="Buscar Skills"]').value === 'alpha'))
    await settle(() => document.querySelector('.academy-fallback-card')?.textContent.includes('READY_TO_UPLOAD'))
    const release = service.getOpenAiPublicationState().selectedRelease
    ctx.check('Normal publication UI prepares ZIP from the verified source commit', release.source.sourceCommitSha === service.store.getGitAuthority().processedCommitSha && release.status === 'READY_TO_UPLOAD' && release.artifactHash === release.source.zipSha256)
    await ctx.click('.academy-fallback-card details summary')
    ctx.check('Publication UI exposes source SHA, ZIP hash, version and separate upload state', await ctx.evaluate(({ commit, hash }) => { const card = document.querySelector('.academy-fallback-card'); return card.textContent.includes(commit) && card.textContent.includes(hash) && card.textContent.includes('v0.2.0') && card.textContent.includes('READY_TO_UPLOAD') }, { commit: release.source.sourceCommitSha, hash: release.artifactHash }))
    await ctx.capture('release-source-dark')
    ctx.check('Human index and HEAD remain unchanged', humanHead === gitCommand(human, 'rev-parse', 'HEAD') && humanIndex === await git.getIndexRevision(human))
    await ctx.click('input[aria-label="Buscar Skills"]')
    await ctx.evaluate(() => document.querySelector('input[aria-label="Buscar Skills"]').select())
    ctx.window.webContents.insertText('alpha')
    await ctx.waitFor(() => !!document.querySelector('.academy-skill-item'))
    await ctx.click('.academy-skill-item')
    gitCommand(external, 'pull', '--ff-only')
    externalCommit('skills/alpha/SKILL.md', pkg('automatic remote update').skillMd)
    await sync.configureAutomation({ autoPublish: false, autoUpdate: true, confirmed: true, expectedRepositoryId: 'proof-github', expectedBranch: 'main' })
    await sync.refreshAutomatically()
    await settle(() => document.querySelector('.academy-code-surface pre')?.textContent.includes('automatic remote update'))
    ctx.check('External main update reaches the normal UI without the Update action', service.store.get(skill.id).currentVersion === 3)
    await ctx.capture('automatic-inbound-dark')
    externalCommit('skills/alpha/SKILL.md', pkg('incompatible writer').skillMd)
    await update('conflicting local draft')
    await ctx.waitFor(head => document.body.textContent.includes(`Commit local pendente: ${head.slice(0, 8)}`), sync.getStatus().publication.localHead)
    await ctx.click('[data-academy-action="sync-git"]')
    try { await settle(() => !!document.querySelector('[data-academy-action="resolve-git"]') && !!document.querySelector('.academy-toast.error')) }
    catch (error) {
      fs.writeFileSync(path.join(ctx.evidenceDir, 'conflict-state.json'), JSON.stringify({ git: sync.getStatus(), text: await ctx.evaluate(() => document.body.textContent) }))
      throw error
    }
    ctx.check('Conflict produces error presentation, never a success toast', await ctx.evaluate(() => !!document.querySelector('.academy-toast.error') && !document.querySelector('.academy-toast.success')))
    const remoteBefore = gitCommand(external, 'rev-parse', 'HEAD')
    ctx.check('Inbound main becomes official while local conflicting content remains private', service.store.get(skill.id).current.package.skillMd === pkg('incompatible writer').skillMd && (await sync.getDraft('alpha')).package.skillMd === pkg('conflicting local draft').skillMd)
    ctx.check('Conflict never changes the remote commit', sync.getStatus().publication.remoteHead === remoteBefore)
    await ctx.capture('protected-conflict-dark')
  } finally { await service.close(); ctx.window.webContents.session.setPreloads([]) }
}
