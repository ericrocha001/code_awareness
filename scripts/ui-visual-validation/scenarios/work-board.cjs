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
  let available = true, live = false, implementedRead = 'normal', branchReads = 0, inspectionReads = 0, ideasReads = 0
  const list = service.listIndexedArtifacts.bind(service)
  service.listIndexedArtifacts = (filter, kinds) => {
    if (kinds.includes('FEATURE_IDEA')) ideasReads++
    if (filter.status === 'IMPLEMENTED') {
      if (implementedRead === 'unavailable') throw new Error('FIXTURE_COLUMN_UNAVAILABLE')
      if (implementedRead === 'empty') return { artifacts: [] }
    }
    return list(filter, kinds)
  }
  let repositoryId = 'fixture'
  const projects = { getState: () => ({ project: { id: 'fixture', name: 'Work Board acceptance', path: root }, revision: 1, context: { repositoryId } }) }
  const continuum = { getActiveSession: () => available ? session : null, getActiveService: () => available ? service : null, onChanged: () => () => {} }
  const unregisterContinuum = registerContinuumHandlers(continuum)
  const { ipcMain } = require('electron')
  ipcMain.handle('work-orchestration:branches', () => {
    branchReads++
    throw new Error('UNEXPECTED_BRANCH_INVENTORY')
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
  const idea = publish('Consultar evidências de execução a partir de checkpoints e navegar até o Plano relacionado',
    'Explorar uma forma de abrir o contexto de execução diretamente a partir de checkpoints.', 'FEATURE_IDEA',
    { status: 'NOT_IMPLEMENTED', relations: [{ artifactId: plan.artifactId, kind: 'related-to' }] })
  publish('Busca de contexto por Artifact', 'A capacidade está disponível no produto.', 'FEATURE_IDEA', { status: 'IMPLEMENTED' })
  const snapshot = { repositoryId: 'fixture', worktreeId: 'a'.repeat(64), worktreeGeneration: 'b'.repeat(64), branchRef: 'refs/heads/main',
    branchGeneration: 'c'.repeat(64), head: 'd'.repeat(40), branchRevision: 'branch', fingerprint: 'snapshot' }
  await service.bindExecutionBranch('fixture-execution', plan.artifactId, async () => snapshot)
  const unregister = registerWorkBoardHandler(projects, continuum, () => {
    inspectionReads++
    return { git: { deliverySnapshot: async () => snapshot },
    sessions: live ? {
      readWorkAssociations: () => [{ repositoryId: 'fixture', artifactId: plan.artifactId, executionId: 'fixture-execution', worktreeId: snapshot.worktreeId,
        generation: snapshot.worktreeGeneration, provider: 'entire', evidence: 'HANDOFF_DECLARED', sourceArtifactId: handoff.artifactId, sourceRevision: handoff.revision,
        sourceHash: service.indexedArtifact(handoff.artifactId).contentHash, providerSessionId: 'session-fixture' }],
      call: async () => ({ content: [{ type: 'text', text: JSON.stringify({ source: 'ENTIRE_LIVE', providerSessionId: 'session-fixture',
        state: 'ACTIVE', lastActive: new Date().toISOString() }) }] })
    } : undefined,
    ledger: { getProof: id => id === 'fixture-proof' ? { status: 'PASSED', evidenceFor: [plan.artifactId] } : null } }
  })
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
    await ctx.waitFor(() => document.querySelectorAll('.wb-lane--pending .wb-card').length === 20)
    ctx.check('Only two work lanes load, without Ideas, activity or a route for ACTIVE', ideasReads === 0 && inspectionReads === 0 &&
      await ctx.evaluate(async () => {
        const invalid = await window.codeAwareness.getWorkBoard({ context: { repositoryId: 'fixture', projectId: 'fixture', revision: 1 }, perspective: 'WORK', column: 'ACTIVE' })
        return invalid.code === 'INVALID_ARGUMENT' && [...document.querySelectorAll('.wb-lane h2')].map(node => node.textContent).join('|') === 'Pendentes|Concluídos'
      }))
    ctx.check('Work Orchestration opens directly on the Work Board', branchReads === 0 && await ctx.evaluate(() =>
      document.querySelectorAll('h1').length === 1 && document.querySelector('h1').textContent === 'Work Board' &&
      !document.querySelector('.wb-views, .bm-view')))
    ctx.check('Dense queue has independent scrolling', await ctx.evaluate(() => {
      const lane = document.querySelector('.wb-lane--pending .wb-cards')
      return lane.scrollHeight > lane.clientHeight
    }))
    await ctx.capture('work-board-dense')
    await ctx.click('.wb-lane--pending .wb-card')
    await ctx.waitFor(() => document.querySelector('.wb-inspector')?.textContent.includes('Fonte de atividade indisponível.'))
    ctx.check('Partial Session Context retains the plan and proof sources', await ctx.evaluate(() => !!document.querySelector('.wb-lane--pending [aria-expanded="true"]') &&
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
      return lanes.clientWidth > 0 && document.documentElement.scrollWidth === innerWidth
    }))
    await ctx.capture('work-board-narrow')
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await ctx.waitFor(() => !document.querySelector('.wb-inspector'))
    ctx.check('Escape closes inspector and restores card focus', await ctx.evaluate(() => !document.querySelector('.wb-inspector') && document.activeElement.matches('.wb-card')))
    await ctx.viewport(1440, 900)
    live = true
    await ctx.click('.wb-lane--pending .wb-card')
    await ctx.waitFor(() => document.querySelector('.wb-inspector')?.textContent.includes('Sessão ativa observada'))
    ctx.check('Direct activity remains contextual and the plan stays pending',
      service.indexedArtifact(plan.artifactId).metadata.status === 'PENDING' && await ctx.evaluate(() => !!document.querySelector('.wb-lane--pending [aria-expanded="true"]') &&
        document.querySelectorAll('.wb-perspective:not([hidden]) .wb-lane').length === 2 && !!document.querySelector('.wb-lane--completed .wb-card')))
    await ctx.capture('work-board-pending-inspector')
    const beforeIdeas = inspectionReads
    await ctx.click('.wb-perspectives button:nth-child(2)')
    await ctx.waitFor(() => !!document.querySelector('.wb-lane--implemented .wb-card'))
    ctx.check('Ideas loads both lifecycle columns on demand', ideasReads === 2 && await ctx.evaluate(() =>
      [...document.querySelectorAll('.wb-perspective:not([hidden]) .wb-lane h2')].map(node => node.textContent).join('|') === 'Não implementadas|Implementadas'))
    await ctx.capture('work-board-ideas')
    await ctx.click('.wb-lane--not_implemented .wb-card')
    const visibleInspector = '.wb-perspective:not([hidden]) .wb-inspector'
    await ctx.waitFor(() => document.querySelector('.wb-perspective:not([hidden]) .wb-inspector')?.textContent.includes('related-to'))
    ctx.check('Idea inspector shows its own lifecycle and linked work without activity lookup', inspectionReads === beforeIdeas && await ctx.evaluate(id => {
      const inspector = document.querySelector('.wb-perspective:not([hidden]) .wb-inspector')
      return inspector.textContent.includes(id) && inspector.textContent.includes('Não implementada no Continuum') &&
        inspector.textContent.includes('Pendente') && !inspector.textContent.includes('Atividade e validação')
    }, idea.artifactId))
    await ctx.click(visibleInspector + ' .wb-actions button')
    await ctx.waitFor(() => document.querySelector('.continuum-inspector.open')?.textContent.includes('Consultar evidências de execução'))
    await ctx.click('.fixture-nav button:last-child')
    await ctx.waitFor(() => !!document.querySelector('.wb-perspective:not([hidden]) .wb-inspector'))
    await ctx.viewport(510, 740)
    await ctx.overflow()
    await ctx.capture('work-board-ideas-narrow')
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await ctx.waitFor(() => !document.querySelector('.wb-perspective:not([hidden]) .wb-inspector'))
    ctx.check('Idea Escape restores the focus to its card', await ctx.evaluate(() => document.activeElement.matches('.wb-lane--not_implemented .wb-card')))
    await ctx.viewport(1440, 900)
    implementedRead = 'unavailable'
    await ctx.click('.wb-perspective:not([hidden]) .wb-toolbar button')
    await ctx.waitFor(() => !!document.querySelector('.wb-perspective:not([hidden]) .wb-toolbar [role="alert"]'))
    ctx.check('One unavailable Ideas lane preserves both last observations', await ctx.evaluate(() =>
      !!document.querySelector('.wb-lane--not_implemented .wb-card') && !!document.querySelector('.wb-lane--implemented .wb-card')))
    implementedRead = 'empty'
    await ctx.click('.wb-perspective:not([hidden]) .wb-toolbar button')
    await ctx.waitFor(() => document.querySelector('.wb-lane--implemented').textContent.includes('Nenhum cartão nesta coluna.'))
    ctx.check('An empty lane leaves the other Ideas lane available', await ctx.evaluate(() => !!document.querySelector('.wb-lane--not_implemented .wb-card')))
    const indexedList = service.listIndexedArtifacts
    service.listIndexedArtifacts = (...args) => {
      const result = indexedList(...args)
      repositoryId = 'another-repository'
      return result
    }
    const late = await ctx.evaluate(() => window.codeAwareness.getWorkBoard({ context: { repositoryId: 'fixture', projectId: 'fixture', revision: 1 },
      perspective: 'IDEAS', column: 'NOT_IMPLEMENTED' }))
    service.listIndexedArtifacts = indexedList
    repositoryId = 'fixture'
    ctx.check('Main rejects a result after the active repository changes', !late.success && late.code === 'PROJECT_CONTEXT_CHANGED')
    await ctx.click('.wb-perspectives button:first-child')
    ctx.check('Returning to work retains the selected plan', await ctx.evaluate(() => !!document.querySelector('.wb-lane--pending [aria-expanded="true"]')))
    await ctx.click(visibleInspector + ' header button')
    await ctx.evaluate(() => document.querySelector('.wb-lane--pending .wb-cards > button:last-child').scrollIntoView({ block: 'nearest' }))
    await ctx.click('.wb-lane--pending .wb-cards > button:last-child')
    await ctx.waitFor(() => document.querySelectorAll('.wb-lane--pending .wb-card').length === 27)
    available = false
    await ctx.click('.wb-toolbar button')
    await ctx.waitFor(() => !!document.querySelector('.wb-toolbar [role="alert"]'))
    await ctx.capture('work-board-partial')
    ctx.check('The Work Board stays visible through failure without loading branch inventory', branchReads === 0 &&
      await ctx.evaluate(() => !!document.querySelector('.wb-board') && !document.querySelector('.bm-view')))
  } finally {
    unregister()
    unregisterContinuum()
    ipcMain.removeHandler('work-orchestration:branches')
    store.close()
  }
}
