const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')

exports.run = async ctx => {
  const backend = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({ stdin: { contents: "export { ArtifactStore } from './src/main/continuum/artifact-store'; export { ContinuumService } from './src/main/continuum/continuum-service'; export { registerWorkBoardHandler } from './src/main/ipc/work-board-handler'; export { registerContinuumHandlers } from './src/main/ipc/continuum-handler'", resolveDir: ctx.projectRoot },
    bundle: true, outfile: backend, platform: 'node', external: ['electron', 'better-sqlite3', 'sharp'] })
  const { ArtifactStore, ContinuumService, registerWorkBoardHandler, registerContinuumHandlers } = require(backend)
  const store = new ArtifactStore(path.join(ctx.temporary, 'continuum.db'), 'fixture')
  const service = new ContinuumService(store)
  const root = ctx.temporary
  const session = { repositoryId: 'fixture', repositoryPath: root }
  let available = true, live = false, branchReads = 0
  const projects = { getState: () => ({ project: { id: 'fixture', name: 'Work Board acceptance', path: root }, revision: 1, context: { repositoryId: 'fixture' } }) }
  const continuum = { getActiveSession: () => available ? session : null, getActiveService: () => available ? service : null, onChanged: () => () => {} }
  const unregisterContinuum = registerContinuumHandlers(continuum)
  const { ipcMain } = require('electron')
  ipcMain.handle('work-orchestration:branches', (_event, { context, operation }) => {
    branchReads++
    if (operation.action === 'INVENTORY') return { success: true, context, data: { kind: 'INVENTORY', inventory: { repositoryId: 'fixture',
      revision: 'inventory', branches: [{ key: 'main', ref: 'refs/heads/main', name: 'main', namespace: 'LOCAL', creation: { at: null }, worktrees: [] }],
      worktrees: [], unassignedWorktrees: [] } } }
    return { success: false, code: 'FIXTURE_REMOTE_UNAVAILABLE' }
  })
  const publish = (name, description, kind, extra = {}) => service.publish('---\n' + JSON.stringify({ name, description, kind, ...extra }) + '\n---\n\nCorpo do Artifact de aceitação.')
  const item = publish('Entrega auditável no Work Orchestration', 'Escopo de produto acompanhado no Continuum.', 'WORK_ITEM')
  for (let n = 0; n < 26; n++) publish('Aprimorar ' + [
    'a navegação por contexto de execução', 'a cobertura de Worktrees remotas', 'a descoberta de evidências de entrega',
    'a resolução de vínculos entre checkpoints e validações'
  ][n % 4] + ' · ' + (n + 1), 'Revisar o comportamento observado e preservar as fronteiras do repositório.', n % 2 ? 'WORK_ITEM' : 'EXECUTABLE_PLAN')
  for (const name of ['Catálogo de PRs por branch', 'Proveniência de commits', 'Seleção de Worktree por identidade', 'Validação de publicação local']) {
    store.create({ artifactId: 'done-' + name.length + '-' + name[0], rawMarkdown: '# ' + name,
      metadata: { name, description: 'Entrega concluída no Continuum.', kind: 'EXECUTABLE_PLAN', status: 'COMPLETED' } })
  }
  await new Promise(resolve => setTimeout(resolve, 10))
  const plan = publish('Preservar a rastreabilidade de execução quando uma branch é recriada e a Worktree é reaberta em outro checkout',
    'Projeta o vínculo entre o Plano e o Work Item, preserva a identidade da geração Git e apresenta a evidência de validação no contexto da unidade.',
    'EXECUTABLE_PLAN', { executionId: 'fixture-execution', relations: [{ artifactId: item.artifactId, kind: 'derived-from' }] })
  const handoff = publish('Validação dirigida de rastreabilidade', 'Testes dirigidos da unidade no checkout de implementação.', 'IMPLEMENTATION_HANDOFF',
    { status: 'VALIDATED', proofIds: ['fixture-proof'], relations: [{ artifactId: plan.artifactId, kind: 'implements' }] })
  const snapshot = { repositoryId: 'fixture', worktreeId: 'a'.repeat(64), worktreeGeneration: 'b'.repeat(64), branchRef: 'refs/heads/main',
    branchGeneration: 'c'.repeat(64), head: 'd'.repeat(40), branchRevision: 'branch', fingerprint: 'snapshot' }
  await service.bindExecutionBranch('fixture-execution', plan.artifactId, async () => snapshot)
  const unregister = registerWorkBoardHandler(projects, continuum, () => ({ git: { deliverySnapshot: async () => snapshot },
    sessions: live ? {
      readWorkAssociations: () => [{ repositoryId: 'fixture', artifactId: plan.artifactId, executionId: 'fixture-execution', worktreeId: snapshot.worktreeId,
        generation: snapshot.worktreeGeneration, provider: 'entire', evidence: 'HANDOFF_DECLARED', sourceArtifactId: handoff.artifactId, sourceRevision: handoff.revision,
        sourceHash: service.indexedArtifact(handoff.artifactId).contentHash, providerSessionId: 'session-fixture' }],
      call: async () => ({ content: [{ type: 'text', text: JSON.stringify({ source: 'ENTIRE_LIVE', providerSessionId: 'session-fixture',
        state: 'ACTIVE', lastActive: new Date().toISOString() }) }] })
    } : undefined,
    ledger: { getProof: id => id === 'fixture-proof' ? { status: 'PASSED', evidenceFor: [plan.artifactId] } : null } }))
  const preload = path.join(ctx.temporary, 'preload.cjs')
  buildSync({ entryPoints: [path.join(ctx.projectRoot, 'src/main/preload.ts')], bundle: true, outfile: preload, platform: 'node', external: ['electron'] })
  ctx.window.webContents.session.setPreloads([preload])
  buildSync({ entryPoints: [path.join(__dirname, 'branch-manager-fixture.tsx')], bundle: true, outfile: path.join(root, 'fixture.js'),
    platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' } })
  const page = path.join(root, 'index.html')
  fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}.fixture-nav{height:32px;display:flex;gap:16px;padding:4px 24px;box-sizing:border-box}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  try {
    await ctx.window.loadFile(page, { query: { repositoryPath: root, board: '1' } })
    await ctx.viewport(1440, 900)
    await ctx.waitFor(() => document.querySelectorAll('.wb-lane--queued .wb-card').length === 20)
    ctx.check('Default Board uses real IPC and defers branch inventory', branchReads === 0 && await ctx.evaluate(() => document.querySelectorAll('h1').length === 1))
    ctx.check('Dense queue has independent scrolling', await ctx.evaluate(() => {
      const lane = document.querySelector('.wb-lane--queued .wb-cards')
      return lane.scrollHeight > lane.clientHeight
    }))
    await ctx.capture('work-board-dense')
    await ctx.click('.wb-lane--queued .wb-card')
    await ctx.waitFor(() => document.querySelector('.wb-inspector')?.textContent.includes('Fonte de atividade indisponível.'))
    ctx.check('Partial Session Context retains the plan and proof sources', await ctx.evaluate(() => !!document.querySelector('.wb-lane--queued [aria-expanded="true"]') &&
      document.querySelector('.wb-inspector').textContent.includes('Possível divergência') && document.querySelector('.wb-inspector').textContent.includes('fixture-proof')))
    await ctx.capture('work-board-inspector')
    await ctx.click('.wb-actions button:first-child')
    await ctx.waitFor(() => document.querySelector('.continuum-inspector.open')?.textContent.includes('Preservar a rastreabilidade'))
    await ctx.click('.fixture-nav button:last-child')
    await ctx.waitFor(() => !!document.querySelector('.wb-inspector'))
    ctx.check('Continuum navigation preserves Board selection on return', await ctx.evaluate(() => document.querySelector('.wb-inspector h2').textContent.includes('Preservar a rastreabilidade')))
    await ctx.viewport(680, 740)
    ctx.check('Narrow board scroll stays inside workspace', await ctx.evaluate(() => {
      const lanes = document.querySelector('.wb-columns')
      return lanes.scrollWidth > lanes.clientWidth && document.documentElement.scrollWidth === innerWidth
    }))
    await ctx.capture('work-board-narrow')
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await ctx.waitFor(() => !document.querySelector('.wb-inspector'))
    ctx.check('Escape closes inspector and restores card focus', await ctx.evaluate(() => !document.querySelector('.wb-inspector') && document.activeElement.matches('.wb-card')))
    await ctx.viewport(1440, 900)
    live = true
    await ctx.click('.wb-lane--queued .wb-card')
    await ctx.waitFor(() => !!document.querySelector('.wb-lane--active [aria-expanded="true"]'))
    ctx.check('Direct current observation moves the selected plan while its status stays pending',
      service.indexedArtifact(plan.artifactId).metadata.status === 'PENDING' && await ctx.evaluate(() => document.querySelector('.wb-inspector').textContent.includes('Sessão ativa observada')))
    await ctx.capture('work-board-active')
    await ctx.click('.wb-inspector header button')
    await ctx.evaluate(() => document.querySelector('.wb-lane--queued .wb-cards > button:last-child').scrollIntoView({ block: 'nearest' }))
    await ctx.click('.wb-lane--queued .wb-cards > button:last-child')
    await ctx.waitFor(() => document.querySelectorAll('.wb-lane--queued .wb-card').length === 26)
    available = false
    await ctx.click('.wb-toolbar button')
    await ctx.waitFor(() => !!document.querySelector('.wb-toolbar [role="alert"]'))
    await ctx.capture('work-board-partial')
    await ctx.click('.wb-views button:nth-child(2)')
    await ctx.waitFor(() => !!document.querySelector('.bm-card'))
    ctx.check('Branches remains available during Continuum failure', branchReads > 0 && await ctx.evaluate(() => document.querySelectorAll('h1').length === 1))
  } finally {
    unregister()
    unregisterContinuum()
    ipcMain.removeHandler('work-orchestration:branches')
    store.close()
  }
}
