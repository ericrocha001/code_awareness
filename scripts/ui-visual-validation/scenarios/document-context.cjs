const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')
exports.run = async ctx => {
  const proof = JSON.parse(fs.readFileSync(path.join(ctx.projectRoot, '.code-awareness/document-context-integration.json'), 'utf8'))
  const backend = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({ stdin: { contents: "export {GitService} from './src/main/core/git-service'; export {GitOperationsService} from './src/main/git-operations/git-operations-service'; export {GitHubGitTransport} from './src/main/github/github-git-transport'; export {WorkOrchestrationController,registerWorkOrchestrationHandlers} from './src/main/ipc/work-orchestration-handler'; export {RepositoryContinuumSession} from './src/main/continuum/project-continuum-session'; export {orchestrationContinuumReader} from './src/main/ipc/orchestration-continuum-reader'; export {RuntimeIdentityProvider} from './src/main/runtime-identity/runtime-identity-provider'", resolveDir: ctx.projectRoot }, bundle: true, outfile: backend, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3', 'sharp'] })
  const api = require(backend), identity = new api.RuntimeIdentityProvider({ rootDir: ctx.projectRoot, includedDirectories: ['src/main', 'src/shared', 'src/renderer/src'] })
  await identity.sourceOriginReady
  ctx.check('Runtime uses the implementation worktree and fresh source', identity.getIdentityPayload().sourceOrigin.worktree.rootPath.toLowerCase() === proof.path.toLowerCase() && identity.getIdentityPayload().freshness.state === 'MATCH')
  const Database = require('better-sqlite3'), encoded = Buffer.from(proof.repositoryId).toString('base64url')
  const sourcePath = path.join(process.env.APPDATA, 'code-awareness', 'continuum', 'repositories', encoded, 'continuum.db')
  const storage = path.join(ctx.temporary, 'canonical-snapshot'), target = path.join(storage, 'repositories', encoded, 'continuum.db')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
  try {
    const declaration = source.prepare('SELECT raw_markdown FROM artifacts WHERE artifact_id = ?').get(proof.declarationId)
    ctx.check('Canonical publication readback matches the persisted receipt', declaration?.raw_markdown === proof.expectedDeclaration)
    await source.backup(target)
  } finally { source.close() }
  const session = new api.RepositoryContinuumSession(storage, { findByPath: requested => requested.toLowerCase() === ctx.projectRoot.toLowerCase() ? { id: proof.repositoryId, localCheckout: { path: ctx.projectRoot } } : null })
  session.activate(ctx.projectRoot)
  const git = new api.GitService(), reader = new api.GitOperationsService(ctx.projectRoot, git, new api.GitHubGitTransport(null, git), { repositoryId: proof.repositoryId, isActive: () => true })
  const project = { revision: 1, project: { id: 'acceptance-a', path: ctx.projectRoot, name: 'Contexto documentado — integração canônica' } }
  const controller = new api.WorkOrchestrationController({ getState: () => project }), port = api.orchestrationContinuumReader(session)
  let failReads = false, inventoryRecords = [], emptySession
  const calls = { list: 0, declaration: 0, graph: 0 }, reads = []
  for (const method of Object.keys(calls)) { const original = port[method].bind(port); port[method] = (...args) => { calls[method]++; if (failReads) throw new Error('CONTINUUM_UNAVAILABLE'); return original(...args) } }
  controller.bind(reader, port)
  const { ipcMain } = require('electron'), original = ipcMain.handle
  ipcMain.handle = function(channel, handler) { original.call(this, channel, async (...args) => { if (channel === 'work-orchestration:read') reads.push(args[1]); const result = await handler(...args); if (result.success && result.data?.worktrees) inventoryRecords = result.data.worktrees; return result }) }
  api.registerWorkOrchestrationHandlers(controller); ipcMain.handle = original
  const wait = async (fn, ...args) => { const deadline = Date.now() + 60000; while (Date.now() < deadline) { if (await ctx.evaluate(fn, ...args)) return; await new Promise(resolve => setTimeout(resolve, 80)) }
    fs.writeFileSync(path.join(ctx.evidenceDir,'failure-state.json'),JSON.stringify({calls,reads,context:await ctx.evaluate(() => ({open:document.querySelector('.wo-document-context')?.open,text:document.querySelector('.wo-document-context')?.textContent}))},null,2)); await ctx.capture('failure-state'); throw new Error('Document context acceptance timed out') }
  const navigate = async name => { await ctx.evaluate(name => { document.querySelector('[data-nav-target]')?.removeAttribute('data-nav-target'); [...document.querySelectorAll('.global-sidebar-nav-item')].find(button => button.textContent.trim() === name).setAttribute('data-nav-target','') }, name); await ctx.click('[data-nav-target]'); await wait(name => document.querySelector('.wo-tab').hidden === (name !== 'Work Orchestration'), name) }
  try {
    const preload = path.join(ctx.temporary, 'preload.cjs')
    buildSync({ entryPoints: [path.join(ctx.projectRoot, 'src/main/preload.ts')], bundle: true, outfile: preload, platform: 'node', format: 'cjs', external: ['electron'] }); ctx.window.webContents.session.setPreloads([preload])
    buildSync({ entryPoints: [path.join(__dirname, 'work-orchestration-fixture.tsx')], bundle: true, outfile: path.join(ctx.temporary, 'fixture.js'), platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' } })
    const csp = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(fs.readFileSync(path.join(ctx.projectRoot, 'src/renderer/index.html'), 'utf8'))[1]
    const page = path.join(ctx.temporary,'index.html'); fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
    const before = await git.captureWorktreeReadSnapshot(ctx.projectRoot), started = performance.now()
    await ctx.window.loadFile(page, { query: { repositoryPath: ctx.projectRoot } }); await ctx.viewport(1440,900)
    await navigate('Work Orchestration'); await wait(() => document.querySelectorAll('.wo-tree').length > 0 && !document.querySelector('.wo-header button').disabled)
    const inventoryMs = performance.now() - started
    ctx.check('Inventory has zero Continuum calls', Object.values(calls).every(count => count === 0))
    await ctx.evaluate(() => { const input = document.querySelector('[aria-label="Filtrar worktrees"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input, 'codex/work-orchestration-mvp'); input.dispatchEvent(new Event('input',{bubbles:true})) })
    await wait(() => document.querySelectorAll('.wo-tree').length === 1)
    await ctx.click('.wo-tree'); await wait(() => !document.querySelector('.wo-inspector').textContent.includes('Lendo a worktree selecionada') && !!document.querySelector('.wo-document-context'))
    ctx.check('Git observation and selected files do not query Continuum', Object.values(calls).every(count => count === 0))
    const selected = await reader.getCoordinationIdentity(proof.worktreeId)
    ctx.check('Actual registry identity matches published provenance', selected.record.generation === proof.generation && selected.repositoryId === proof.repositoryId)
    await ctx.evaluate(() => { document.querySelector('.wo-document-context > summary').scrollIntoView({block:'center'}) }); await ctx.click('.wo-document-context > summary')
    await wait(id => [...document.querySelectorAll('.wo-document-context input')].some(input => input.value === id) && !document.querySelector('.wo-document-context').textContent.includes('Consultando o Continuum'), proof.declarationId)
    ctx.check('Persisted real declaration is retrieved through production IPC/service/registry', calls.list === 1 && calls.graph === 0 && calls.declaration === 0 && await ctx.evaluate(() => document.querySelector('.wo-document-context').textContent.includes('Associação declarada')))
    await ctx.evaluate(() => document.querySelector('.wo-document-context').scrollIntoView({block:'start'})); await ctx.capture('canonical-association-dark'); await ctx.overflow()
    await ctx.evaluate(() => { const button = [...document.querySelectorAll('.wo-document-context button')].find(button => button.textContent === 'Ver Plano e handoff relacionados'); button.setAttribute('data-related',''); button.scrollIntoView({block:'center'}) }); await ctx.click('[data-related]')
    await wait(id => document.querySelector('.wo-document-context').textContent.includes(id) && !document.querySelector('.wo-document-context').textContent.includes('Consultando o Continuum'), proof.planId)
    ctx.check('Related plan comes from declared edge anchored to the selected artifact', calls.graph === 1 && calls.declaration === 1 && await ctx.evaluate(id => document.querySelector('.wo-document-context').textContent.includes(`Origem da relação: ${id}`) && document.querySelector('.wo-document-context').textContent.includes('derived-from'), proof.declarationId))
    await ctx.evaluate(() => [...document.querySelectorAll('.wo-document-context section')].at(-1).scrollIntoView({block:'start'})); await ctx.capture('canonical-related-plan-dark')
    const prior = JSON.stringify(calls), navigationStart = performance.now()
    await navigate('Home'); await navigate('Work Orchestration'); const navigationMs = performance.now() - navigationStart
    await new Promise(resolve => setTimeout(resolve,1000))
    ctx.check('Tab return and idle have no extra Continuum calls', JSON.stringify(calls) === prior)
    const canonicalCalls = { ...calls }
    await ctx.evaluate(() => { document.body.dataset.theme = 'light' }); await ctx.viewport(1120,800)
    await ctx.evaluate(() => document.querySelector('.wo-document-context').scrollIntoView({block:'start'})); await ctx.capture('canonical-context-medium-light'); await ctx.overflow()
    const clickText = async text => { await ctx.evaluate(text => { document.querySelector('[data-document-action]')?.removeAttribute('data-document-action'); const button = [...document.querySelectorAll('.wo-document-context button')].find(button => button.textContent === text); button.setAttribute('data-document-action',''); button.scrollIntoView({block:'center'}) }, text); await ctx.click('[data-document-action]') }
    const fixturePublish = (name, metadata) => session.getActiveService().publish(`---\nname: ${JSON.stringify(name)}\ndescription: "Fixture isolada de validação visual; não pertence ao Continuum canônico."\nkind: OBSERVATION\ndate: 2026-10-13T18:25:00Z\n${Object.entries(metadata).map(([key,value])=>`${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\nDocumento fictício somente neste perfil temporário de validação.\n`)
    fixturePublish('Segundo vínculo — fixture isolada', { worktreeId: proof.worktreeId, worktreeGeneration: proof.generation, executionId: 'work-orchestration-context-evolution1-20261013' })
    const foreign = inventoryRecords.find(record => record.worktreeId !== proof.worktreeId && !record.missing)
    fixturePublish('Outra worktree da mesma execução — fixture isolada', { worktreeId: foreign.worktreeId, worktreeGeneration: foreign.generation, executionId: 'work-orchestration-context-evolution1-20261013' })
    fixturePublish('Referência legada — fixture isolada', { worktreePath: proof.path })
    await clickText('Atualizar vínculos'); await wait(() => document.querySelector('.wo-document-context').textContent.includes('Segundo vínculo — fixture isolada') && !document.querySelector('.wo-document-context').textContent.includes('Consultando o Continuum'))
    ctx.check('Multiple declarations are shown without assigning a single owner or execution peers', await ctx.evaluate(() => document.querySelector('.wo-document-list').children.length === 2 && !document.querySelector('.wo-document-context').textContent.includes('Outra worktree da mesma execução')))
    await ctx.evaluate(() => document.querySelector('.wo-document-context').scrollIntoView({block:'start'})); await ctx.capture('multiple-documents-medium-light')
    await clickText('Consultar referências históricas por caminho'); await wait(() => document.querySelector('.wo-document-context').textContent.includes('Referência legada — fixture isolada') && !document.querySelector('.wo-document-context').textContent.includes('Consultando o Continuum'))
    ctx.check('Path reference is separate and explicitly unproven', await ctx.evaluate(() => document.querySelector('.wo-document-context').textContent.includes('Referência histórica por caminho — não comprovada') && !document.querySelector('.wo-document-context').textContent.includes('Segundo vínculo — fixture isolada')))
    await ctx.evaluate(() => document.querySelector('.wo-document-context').scrollIntoView({block:'start'})); await ctx.capture('historical-reference-medium-light')
    failReads = true; await clickText('Atualizar vínculos'); await wait(() => document.querySelector('.wo-document-context').textContent.includes('Consulta indisponível ou obsoleta'))
    ctx.check('Failure retains an honestly labeled previous query, never invents an empty result', await ctx.evaluate(() => document.querySelector('.wo-document-context').textContent.includes('não revalidada') && !document.querySelector('.wo-document-context').textContent.includes('Sem vínculo explícito encontrado')))
    await ctx.capture('unavailable-context-medium-light'); failReads = false
    emptySession = new api.RepositoryContinuumSession(path.join(ctx.temporary,'empty-fixture'), { findByPath: () => ({ id: proof.repositoryId, localCheckout: { path: ctx.projectRoot } }) }); emptySession.activate(ctx.projectRoot)
    controller.bind(reader, api.orchestrationContinuumReader(emptySession))
    await clickText('Atualizar vínculos'); await wait(() => document.querySelector('.wo-document-context').textContent.includes('Sem vínculo explícito encontrado. Isso não significa ausência de trabalho.'))
    await ctx.capture('no-association-medium-light')
    controller.bind(reader, port); await clickText('Atualizar vínculos'); await wait(() => !!document.querySelector('.wo-document-context input') && !document.querySelector('.wo-document-context').textContent.includes('Consultando o Continuum'))
    ctx.window.focus()
    await ctx.evaluate(() => { const input = document.querySelector('.wo-document-context input'); input.focus() })
    ctx.window.webContents.sendInputEvent({type:'keyDown',keyCode:'a',modifiers:['control']}); ctx.window.webContents.sendInputEvent({type:'keyUp',keyCode:'a',modifiers:['control']})
    await wait(() => document.activeElement?.tagName === 'INPUT' && document.activeElement.selectionEnd - document.activeElement.selectionStart === document.activeElement.value.length)
    ctx.check('Artifact ID can be selected for copying', await ctx.evaluate(() => document.activeElement.selectionEnd - document.activeElement.selectionStart === document.activeElement.value.length))
    ctx.window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); ctx.window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'}); await wait(() => !document.querySelector('.wo-inspector'))
    ctx.check('Inspector closes and restores row focus', await ctx.evaluate(() => document.activeElement.classList.contains('wo-tree')))
    ctx.check('Real worktree reads preserve Git state', JSON.stringify(before) === JSON.stringify(await git.captureWorktreeReadSnapshot(ctx.projectRoot)))
    ctx.check('Final source freshness MATCH', identity.getIdentityPayload().freshness.state === 'MATCH')
    fs.writeFileSync(path.join(ctx.evidenceDir,'composition.json'), JSON.stringify({origin:'canonical publication and actual implementation worktree proven before isolated fixtures for supplementary UI states',declarationId:proof.declarationId,planId:proof.planId,repositoryId:proof.repositoryId,worktreeId:proof.worktreeId,generation:proof.generation,inventoryMs,navigationMs,canonicalCalls,calls,reads},null,2))
  } finally { controller.deactivate(); session.dispose(); emptySession?.dispose(); ipcMain.removeHandler('work-orchestration:read') }
}
