const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')
const { ipcMain } = require('electron')
const { createHash } = require('node:crypto')
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
exports.preload = path.join(config.temporary, 'preload.cjs')
buildSync({ entryPoints: [path.join(config.projectRoot, 'src/main/preload.ts')], outfile: exports.preload, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })

exports.run = async ctx => {
  const backend = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({ stdin: { contents: [
    "export { CodeMapService } from './src/main/core/code-map-service'",
    "export { WatcherService } from './src/main/core/watcher-service'",
    "export { registerCodeMapHandlers } from './src/main/ipc/code-map-handler'",
    "export { createSymbolReferenceId } from './src/main/core/symbol-reference-resolver'",
    "export { telemetryService } from './src/main/core/telemetry-service'"
  ].join('\n'), resolveDir: ctx.projectRoot }, outfile: backend, bundle: true, packages: 'external', platform: 'node', format: 'cjs' })
  const { CodeMapService, WatcherService, registerCodeMapHandlers, telemetryService, createSymbolReferenceId } = require(backend)
  const Database = require('better-sqlite3')
  const root = path.join(ctx.projectRoot, '.code-awareness', 'codemap-convergence-repository')
  const seeded = fs.existsSync(path.join(root, 'code_awareness', 'fixture-owner.json'))
  fs.mkdirSync(root, { recursive: true })
  if (!seeded) {
  fs.writeFileSync(path.join(root, 'target.ts'), 'export function execute() { return 1 }\n')
  for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(root, 'consumer' + i + '.ts'),
    "import { execute } from './target'\n" + Array.from({ length: 80 }, (_, n) => 'export function run' + n + '() { execute(); execute(); execute(); return execute() }').join('\n'))
  for (let i = 0; i < 995; i++) fs.writeFileSync(path.join(root, 'filler' + i + '.ts'), Array.from({ length: 15 }, (_, n) => 'export const value' + n + ' = ' + n).join('\n'))
  fs.mkdirSync(path.join(root, 'code_awareness'), { recursive: true })
  fs.writeFileSync(path.join(root, 'code_awareness', 'fixture-owner.json'), JSON.stringify({ purpose: 'codemap-convergence-acceptance' }))
  }
  const watcher = new WatcherService()
  const service = new CodeMapService(watcher, { async generateCompressionMarkdown() { throw new Error('unused') } })
  let sql, timer
  const records = []
  const originalLog = telemetryService.log.bind(telemetryService)
  telemetryService.log = (id, category, event, payload) => { if (category === 'CODE_MAP') records.push({ event, ...payload }); return originalLog(id, category, event, payload) }
  const rendererErrors = []
  ctx.window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message) })
  try {
    await service.openRepository(root)
    await service.ensureInstance(root).backgroundMaintenance
    await service.ensureInstance(root).synchronizer.waitForIdle(120000)
    const preparingModel = service.ensureInstance(root).model
    for (const [object, name] of [[preparingModel, 'resolveRelationships'], [preparingModel, 'persistableReferences'], [preparingModel.db, 'saveRelationships'], [preparingModel.db, 'replaceResolvedRelationships']]) {
      const original = object[name].bind(object)
      object[name] = (...args) => { console.log('LOAD_STAGE_START', name, Date.now()); const result = original(...args); console.log('LOAD_STAGE_RETURN', name, Date.now()); return result }
    }
    if (!service.getRepository(root)?.lastIndexedAt) await service.indexRepository(root)
    await service.ensureInstance(root).backgroundMaintenance
    await service.ensureInstance(root).synchronizer.waitForIdle(120000)
    const instance = service.ensureInstance(root)
    const model = instance.model
    registerCodeMapHandlers(service, { assertContextSelection(selection) { if (selection.path !== root) throw new Error('WRONG_FIXTURE') } })
    ipcMain.handle('tags:get', () => ({ success: true, data: [] }))
    ipcMain.handle('tag:getFileTags', () => ({ success: true, data: {} }))
    const files = model.getFiles(), elements = model.getElementsByRepository()
    ctx.check('Incident-scale SQLite fixture', files.length === 1146 && elements.length >= 53000)
    sql = new Database(path.join(root, 'code_awareness/repository_model.db'))
    let target = elements.find(e => e.name === 'execute' && e.kind === 'function')
    const before = model.getSymbolReferencesByTargetElement(target.id)
    ctx.check('48000 persisted references before incremental convergence', before.length === 48000)
    buildSync({ entryPoints: [path.join(__dirname, 'codemap-convergence-fixture.tsx')], bundle: true, outfile: path.join(ctx.temporary, 'fixture.js'), platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' } })
    const page = path.join(ctx.temporary, 'index.html')
    fs.writeFileSync(page, "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:\"><link rel=\"stylesheet\" href=\"fixture.css\"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id=\"root\"></div><script src=\"fixture.js\"></script></body></html>")
    await ctx.window.loadFile(page, { query: { repository: root } })
    ctx.window.showInactive()
    const initialDeadline = performance.now() + 30000
    while (!(await ctx.evaluate(() => document.querySelectorAll('.cmv-tree-node').length > 1000))) {
      if (performance.now() >= initialDeadline) { await ctx.capture('initial-render-timeout'); throw new Error('INITIAL_RENDER_TIMEOUT') }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    await ctx.evaluate(() => { const rows = [...document.querySelectorAll('.cmv-tree-node')]; rows.find(r => r.textContent.includes('consumer0.ts')).id = 'accept-source'; rows.find(r => r.textContent.includes('target.ts')).id = 'accept-target' })
    await ctx.click('#accept-source')
    await ctx.waitFor(() => document.querySelector('.cmcv-code') || document.querySelector('.cmcv-content') || document.querySelector('pre'))
    await ctx.capture('before-convergence')
    records.length = 0
    let begin, finish
    const started = new Promise(resolve => { begin = resolve })
    const completed = new Promise(resolve => { finish = resolve })
    const synchronousSections = []
    for (const name of ['replaceIndexedFileState', 'replaceSymbolReferencesForFile', 'replaceResolvedRelationships']) {
      const original = model.db[name].bind(model.db)
      model.db[name] = (...args) => {
        const started = performance.now()
        try { return original(...args) } finally { synchronousSections.push({ name, at: performance.now(), durationMs: performance.now() - started }) }
      }
    }
    const originalRefresh = model.refreshSymbolReferences.bind(model)
    let resolving = false, activeSources = 0
    model.refreshSymbolReferences = async (sources, ...args) => {
      resolving = true; activeSources = sources.size; ctx.check('No premature symbol readiness', !model.readiness.isReady('SYMBOL_REFERENCES')); begin()
      try { return await originalRefresh(sources, ...args) } finally { resolving = false; finish() }
    }
    let last = performance.now(), maxEventLoopMs = 0, pulses = 0
    timer = setInterval(() => { const now = performance.now(); maxEventLoopMs = Math.max(maxEventLoopMs, now - last); last = now; pulses++ }, 10)
    await ctx.evaluate(root => {
      window.acceptanceIpc = { samples: [], failures: 0, pending: 0 }
      window.acceptanceIpc.timer = setInterval(async () => {
        const start = performance.now()
        window.acceptanceIpc.pending++
        try {
          const result = await window.codeAwareness.getSyncStatus(root)
          if (!result.success) window.acceptanceIpc.failures++
          window.acceptanceIpc.samples.push(performance.now() - start)
        } catch { window.acceptanceIpc.failures++ }
        finally { window.acceptanceIpc.pending-- }
      }, 50)
    }, root)
    const convergenceStart = performance.now()
    fs.writeFileSync(path.join(root, 'target.ts'), 'export function execute(input' + Date.now() + '?: number) { return 2 }\n')
    await started
    let interactions = 0, maxIpcMs = 0, capturedDuring = false
    while (resolving) {
      const requestStart = performance.now()
      const response = await ctx.evaluate(async root => {
        const start = performance.now()
        const result = await window.codeAwareness.getSyncStatus(root)
        return { success: result.success, elapsed: performance.now() - start }
      }, root)
      maxIpcMs = Math.max(maxIpcMs, response.elapsed, performance.now() - requestStart)
      ctx.check('Essential production IPC responds during convergence', response.success)
      if (resolving) {
        await ctx.waitFor(() => [...document.querySelectorAll('.cmv-tree-name')].some(node => node.textContent === 'target.ts'))
        const point = await ctx.evaluate(() => {
          const target = [...document.querySelectorAll('.cmv-tree-node')].find(row => row.querySelector('.cmv-tree-name')?.textContent === 'target.ts')
          if (!target) throw new Error('Target missing from actual Code Map tree')
          target.scrollIntoView({ block: 'center' })
          const r = target.getBoundingClientRect()
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
        })
        ctx.window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
        ctx.window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
        await ctx.waitFor(() => [...document.querySelectorAll('.cmv-tree-node--selected .cmv-tree-name')].some(node => node.textContent === 'target.ts'))
        interactions++
        if (!capturedDuring && resolving) { await ctx.waitFor(() => document.querySelector('.cmcv-root')?.textContent.includes('function execute')); await ctx.capture('interactive-during-convergence'); capturedDuring = resolving }
      }
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    await completed
    await service.ensureInstance(root).backgroundMaintenance
    await service.ensureInstance(root).synchronizer.waitForIdle(120000)
    clearInterval(timer); timer = null
    const continuousIpc = await ctx.evaluate(async () => {
      clearInterval(window.acceptanceIpc.timer)
      while (window.acceptanceIpc.pending) await new Promise(resolve => setTimeout(resolve, 10))
      return { maximumMs: Math.max(0, ...window.acceptanceIpc.samples), samples: window.acceptanceIpc.samples.length, failures: window.acceptanceIpc.failures }
    })
    maxIpcMs = Math.max(maxIpcMs, continuousIpc.maximumMs)
    const convergenceMs = performance.now() - convergenceStart
    const sourceFiles = ['repository-model.ts', 'repository-database.ts', 'repository-synchronizer.ts', 'symbol-reference-resolver.ts', 'repository-change-readiness.ts', 'code-map-service.ts'].map(name => 'src/main/core/' + name).concat([
      'src/main/ipc/code-map-handler.ts', 'src/main/preload.ts',
      'src/renderer/src/components/CodeMapView/CodeMapView.tsx', 'src/renderer/src/components/CodeMapView/CodeMapTree.tsx'
    ]).map(file => {
      return { file, sha256: createHash('sha256').update(fs.readFileSync(path.join(ctx.projectRoot, file))).digest('hex') }
    })
    const result = { sourceFiles, tolerance: { mainMs: 750, ipcMs: 750, rationale: 'Keep all phases below one-second response while preserving the atomic high-fanout SQLite commit; 750ms includes host scheduling margin over its measured ~560ms cost.' }, files: files.length, elements: elements.length, references: before.length, activeSources, convergenceMs, maxEventLoopMs, maxIpcMs, continuousIpc, interactions, capturedDuring, rendererErrors, synchronousSections, phases: records.filter(r => ['SYMBOL_REFERENCE_RESOLUTION_COMPLETED', 'FILE_BATCH_COMPLETED'].includes(r.event)) }
    fs.writeFileSync(path.join(ctx.evidenceDir, 'convergence.json'), JSON.stringify(result, null, 2))
    ctx.check('Navigation and pixels observed while 150+ sources resolve', activeSources >= 150 && interactions > 0 && capturedDuring)
    ctx.check('Main and continuous production IPC stay below 750ms across all phases', maxEventLoopMs < 750 && maxIpcMs < 750 && continuousIpc.samples > 10 && continuousIpc.failures === 0 && pulses > 2)
    target = model.getElementsByRepository().find(element => element.name === 'execute' && element.kind === 'function')
    const expected = before.map(reference => {
      const updated = { ...reference, targetElementId: target.id }
      return { ...updated, id: createSymbolReferenceId(model.getRepositoryId(), updated) }
    })
    ctx.check('Reference source/kind/location and deterministic target identity preserved', JSON.stringify(model.getSymbolReferencesByTargetElement(target.id)) === JSON.stringify(expected))
    ctx.check('SQLite integrity and foreign keys', sql.prepare('PRAGMA integrity_check').get().integrity_check === 'ok' && sql.prepare('PRAGMA foreign_key_check').all().length === 0)
    ctx.check('Readiness only after durable convergence', model.readiness.getState() === 'READY' && model.getPendingFilePaths().length === 0)
    ctx.check('No renderer errors', rendererErrors.length === 0)
    await ctx.capture('converged')
    records.length = 0
    const bodyPath = path.join(root, 'target.ts')
    fs.writeFileSync(bodyPath, fs.readFileSync(bodyPath, 'utf8').replace('return 2', 'return 3'))
    await new Promise(resolve => setTimeout(resolve, 650))
    await instance.synchronizer.waitForIdle(120000)
    const body = records.filter(row => row.event === 'FILE_BATCH_COMPLETED')
    fs.writeFileSync(path.join(ctx.evidenceDir, 'body-only.json'), JSON.stringify(body, null, 2))
    ctx.check('Body-only change does not expand into its 150 importers', body.length === 1 && body[0].symbolSourcesResolved === 1 && body[0].symbolRowsWritten === 0)
    records.length = 0
    const burstStart = performance.now()
    await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise(resolve => setTimeout(() => {
      const file = path.join(root, 'consumer' + index + '.ts')
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/return execute\(\)(?: \+ \d+)?/g, 'return execute() + ' + Date.now()))
      resolve()
    }, index * 120))))
    await instance.synchronizer.waitForIdle(120000)
    const burst = records.filter(row => row.event === 'FILE_BATCH_COMPLETED')
    const burstSymbols = records.filter(row => row.event === 'SYMBOL_REFERENCE_RESOLUTION_COMPLETED')
    fs.writeFileSync(path.join(ctx.evidenceDir, 'burst.json'), JSON.stringify({ durationMs: performance.now() - burstStart, batches: burst, symbols: burstSymbols }, null, 2))
    ctx.check('Six real watcher edits share one symbol snapshot', burstSymbols.length === 1 && burst.length === 1 && burst[0].pathCount === 6 && burst[0].symbolSourcesResolved === 6)
    ctx.check('Burst preserves all references and durable integrity', model.getSymbolReferencesByTargetElement(target.id).length === 48000 && sql.prepare('PRAGMA foreign_key_check').all().length === 0 && model.readiness.getState() === 'READY')
    for (let reopen = 0; reopen < 2; reopen++) {
      records.length = 0
      service.closeRepository(root)
      await service.openRepository(root)
      await service.ensureInstance(root).backgroundMaintenance
      await service.ensureInstance(root).synchronizer.waitForIdle(120000)
      const reconcile = records.find(row => row.event === 'RECONCILE_COMPLETED')
      const symbols = records.filter(row => row.event === 'SYMBOL_REFERENCE_RESOLUTION_COMPLETED')
      ctx.check('Stable reopen ' + (reopen + 1) + ' does no content/hash/extraction/resolution/symbol writes', !!reconcile && ['contentReads', 'hashesCalculated', 'filesExtracted', 'relationshipResolutions', 'symbolSourcesResolved', 'symbolRowsWritten'].every(key => reconcile[key] === 0) && symbols.length === 0)
      fs.writeFileSync(path.join(ctx.evidenceDir, 'reopen-' + reopen + '.json'), JSON.stringify(records.filter(row => ['RECONCILE_COMPLETED', 'FILE_BATCH_COMPLETED', 'BACKFILL_SYMBOL_REFERENCES_COMPLETED'].includes(row.event)), null, 2))
    }
  } finally { fs.writeFileSync(path.join(ctx.evidenceDir, 'renderer-errors.json'), JSON.stringify(rendererErrors)); if (timer) clearInterval(timer); await service.closeAll(); watcher.stop(); sql?.close(); telemetryService.log = originalLog }
}
