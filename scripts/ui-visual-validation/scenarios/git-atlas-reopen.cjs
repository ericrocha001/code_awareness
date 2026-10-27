const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

exports.run = async ctx => {
  const baseline = process.env.ATLAS_REOPEN_BASELINE === '1'
  const commands = [], calls = [], metrics = { baseline, opens: [] }
  let loadedAt = 0, inPr = 0
  const load = ctx.load
  ctx.load = async file => { loadedAt = performance.now(); return load(file) }
  const write = () => fs.writeFileSync(path.join(ctx.evidenceDir, 'reopen-performance.json'), JSON.stringify({ ...metrics, commands, calls }, null, 2))
  const wait = async (condition, timeout = 30000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await ctx.evaluate(condition)) return true
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return false
  }
  const ready = () => document.querySelectorAll('.gm-commit').length > 0 && document.querySelector('.gm-history')?.getAttribute('aria-busy') === 'false'
  const markOpen = (name, start, from, callFrom) => {
    const selected = calls.slice(callFrom)
    const record = { name, firstHistoryMs: performance.now() - start, order: selected.filter(call => call.name === 'getAtlasHistoryOrder').length,
      metadataShas: selected.filter(call => call.name === 'getAtlasCommitMetadata').reduce((n, call) => n + call.count, 0), subprocesses: commands.length - from,
      coreFromPr: selected.filter(call => call.name === 'getAtlasCoreEvidence' && call.fromPr).length }
    metrics.opens.push(record); write(); return record
  }
  ctx.atlasObservationProof = {
    async build(options) {
      const changed = baseline ? new Set(execFileSync('git', ['diff', '--name-only', 'f770a2760a003c744532df94500954b3fc04d607', '--', 'src'], { cwd: ctx.projectRoot, encoding: 'utf8', windowsHide: true }).trim().split('\n')) : new Set()
      const plugins = [{ name: 'measured-source', setup(build) {
        build.onLoad({ filter: /\.[jt]sx?$/ }, args => {
          const relative = path.relative(ctx.projectRoot, args.path).replaceAll('\\', '/')
          const layout = relative === 'src/renderer/src/components/GitManagementView/atlas-layout.ts'
          if (!layout && !changed.has(relative)) return
          let contents = baseline && changed.has(relative) ? execFileSync('git', ['show', `f770a2760a003c744532df94500954b3fc04d607:${relative}`], { cwd: ctx.projectRoot, encoding: 'utf8', windowsHide: true }) : fs.readFileSync(args.path, 'utf8')
          if (layout) contents = contents.replace('): AtlasLayout {', '): AtlasLayout { (globalThis as any).__atlasLayoutCalls = ((globalThis as any).__atlasLayoutCalls ?? 0) + 1;')
          return { contents, loader: relative.endsWith('tsx') ? 'tsx' : 'ts' }
        })
      } }]
      return require('esbuild').build({ ...options, plugins })
    },
    seed(root) {
      const records = [], now = Math.floor(Date.now() / 1000) - 1000
      for (let i = 1; i <= 240; i++) records.push(`commit refs/heads/main\nmark :${i}\ncommitter Proof <proof@example.com> ${now + i} +0000\ndata 8\nmeasured\n\n`)
      for (let i = 0; i < 60; i++) records.push(`reset refs/heads/reference-${i}\nfrom :${240 - i * 4}\n\n`)
      const result = spawnSync('git', ['fast-import', '--quiet', '--force'], { cwd: root, input: records.join(''), encoding: 'utf8', windowsHide: true })
      if (result.status !== 0) throw new Error(result.stderr)
      const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
      const merged = git(['commit-tree', git(['rev-parse', 'main^{tree}']), '-p', 'main', '-p', 'feature/inspector', '-m', 'Measured real merge'])
      git(['update-ref', 'refs/heads/main', merged])
      execFileSync('git', ['reset', '--hard', 'main'], { cwd: root, windowsHide: true })
      metrics.fixture = { commits: Number(execFileSync('git', ['rev-list', '--all', '--count'], { cwd: root, encoding: 'utf8' })), refs: Number(execFileSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: root, encoding: 'utf8' }).trim().split('\n').length), merges: Number(execFileSync('git', ['rev-list', '--all', '--merges', '--count'], { cwd: root, encoding: 'utf8' })) }
    },
    prepare(backend) {
      const git = backend.git, run = git.runGit.bind(git)
      git.runGit = async (...args) => {
        const start = performance.now()
        try { return await run(...args) }
        finally { commands.push({ args: args[0], start, duration: performance.now() - start }) }
      }
      for (const name of ['getAtlasHistoryOrder', 'getAtlasCommitMetadata']) {
        const original = git[name].bind(git)
        git[name] = async (...args) => { calls.push({ name, at: performance.now(), count: args[1].length }); return original(...args) }
      }
      const prototype = Object.getPrototypeOf(backend.controller.active.service)
      for (const name of ['getAtlasCoreEvidence', 'getAtlasPrEvidence', 'getAtlasCatalog']) {
        const original = prototype[name]
        prototype[name] = async function (...args) {
          calls.push({ name, at: performance.now(), fromPr: inPr > 0 })
          if (name === 'getAtlasPrEvidence') inPr++
          try {
            const result = await original.apply(this, args)
            if (name === 'getAtlasCatalog') calls.push({ name: 'catalog-result', at: performance.now(), diagnostic: result.diagnostic, reason: result.reason })
            return result
          }
          catch (error) { calls.push({ name: `${name}-error`, at: performance.now(), code: error.code || error.message }); throw error }
          finally { if (name === 'getAtlasPrEvidence') inPr-- }
        }
      }
    },
    async verify(ctx, { git }) {
      ctx.window.show(); ctx.window.focus()
      markOpen('cold', loadedAt, 0, 0)
      ctx.check('fixture has hundreds of commits, dozens of refs and a real merge', metrics.fixture.commits >= 240 && metrics.fixture.refs >= 60 && metrics.fixture.merges > 0)
      ctx.check('cold first paint precedes COMPLETE collection', await ctx.evaluate(() => !document.querySelector('.gm-catalog-state.is-complete')))
      const complete = await wait(() => !!document.querySelector('.gm-catalog-state.is-complete'), 45000)
      if (!complete) {
        metrics.collectionFailure = await ctx.evaluate(() => ({ text: document.querySelector('.gm-view')?.textContent, catalog: document.querySelector('.gm-catalog-state')?.outerHTML }))
        write(); await ctx.capture('collection-incomplete')
      }
      ctx.check('collector completes after first paint', complete)
      await new Promise(resolve => setTimeout(resolve, 800))
      const before = await ctx.evaluate(() => [...document.querySelectorAll('.gm-commit')].map(element => element.dataset.sha).filter(Boolean))
      for (let i = 1; i <= 2; i++) {
        await ctx.click('[data-proof-project="none"]')
        await wait(() => !document.querySelector('.gm-history'))
        const start = performance.now(), from = commands.length, callFrom = calls.length
        await ctx.click('[data-proof-project="a"]')
        ctx.check(`reopen ${i} renders history`, await wait(ready))
        const record = markOpen(`warm-${i}`, start, from, callFrom)
        if (!baseline) ctx.check(`reopen ${i} reuses SQL order and metadata`, record.order === 0 && record.metadataShas === 0)
        ctx.check(`reopen ${i} finishes its independent expansion and collection`, await wait(() => document.querySelectorAll('select[aria-label="Referência em foco"] option').length >= 60 && !!document.querySelector('.gm-catalog-state.is-complete') && document.querySelector('.gm-history')?.getAttribute('aria-busy') === 'false'))
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
      if (!baseline) ctx.check('PR enrichment never reruns core', calls.every(call => call.name !== 'getAtlasCoreEvidence' || !call.fromPr))
      metrics.visibleShas = before.length
      const idleStart = commands.length, coreStart = calls.length, idleAt = performance.now()
      await new Promise(resolve => setTimeout(resolve, 10000))
      metrics.idle = { durationMs: performance.now() - idleAt, subprocesses: commands.length - idleStart,
        perMinute: (commands.length - idleStart) * 60000 / (performance.now() - idleAt), coreCalls: calls.slice(coreStart).filter(call => call.name === 'getAtlasCoreEvidence').length }
      write()
      ctx.check('idle does not rerun core', metrics.idle.coreCalls === 0)
      await ctx.evaluate(() => {
        const scroll = document.querySelector('.gm-atlas-scroll')
        scroll.scrollLeft = scroll.scrollWidth - scroll.clientWidth
      })
      await new Promise(resolve => setTimeout(resolve, 800))
      const selected = await ctx.evaluate(() => {
        const node = document.querySelector('.gm-commit')
        node?.click(); return node?.dataset.sha
      })
      await wait(() => document.querySelector('.gm-inspector')?.getAttribute('aria-busy') !== 'true')
      await new Promise(resolve => setTimeout(resolve, 800))
      const layoutBefore = await ctx.evaluate(() => globalThis.__atlasLayoutCalls)
      const focusCalls = calls.length
      ctx.window.blur(); ctx.window.focus()
      await new Promise(resolve => setTimeout(resolve, 2000))
      metrics.focus = { layoutCalls: await ctx.evaluate(previous => globalThis.__atlasLayoutCalls - previous, layoutBefore), coreCalls: calls.slice(focusCalls).filter(call => call.name === 'getAtlasCoreEvidence').length,
        selectionPreserved: await ctx.evaluate(sha => document.querySelector(`.gm-commit[data-sha="${sha}"]`)?.getAttribute('aria-pressed') === 'true', selected) }
      ctx.check('focus preserves selection without core or layout reconstruction', metrics.focus.selectionPreserved && metrics.focus.coreCalls === 0 && metrics.focus.layoutCalls === 0)
      await ctx.evaluate(() => {
        const result = globalThis.__atlasFrames = { intervals: [], previous: performance.now(), stop: false }
        const frame = now => {
          if (result.stop) return
          result.intervals.push(now - result.previous); result.previous = now
          const scroll = document.querySelector('.gm-atlas-scroll')
          if (scroll) { scroll.scrollLeft = (scroll.scrollLeft + 12) % Math.max(1, scroll.scrollWidth - scroll.clientWidth); scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: 12 })) }
          requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      })
      await new Promise(resolve => setTimeout(resolve, 2500))
      metrics.scroll = await ctx.evaluate(() => { const r = globalThis.__atlasFrames; r.stop = true; const sorted = r.intervals.sort((a, b) => a - b); return { frames: sorted.length, p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1) } })
      const branchAt = performance.now()
      git('branch', 'external-reopen-proof')
      const detected = await wait(() => [...document.querySelectorAll('select[aria-label="Referência em foco"] option')].some(option => option.value === 'refs/heads/external-reopen-proof'), 10000)
      metrics.externalBranchMs = detected ? performance.now() - branchAt : null
      ctx.check('external branch detected within five seconds', detected && metrics.externalBranchMs < 5000)
      metrics.externalCollectionComplete = await wait(() => !!document.querySelector('.gm-catalog-state.is-complete'), 15000)
      metrics.externalCatalog = await ctx.evaluate(() => document.querySelector('.gm-catalog-state')?.textContent)
      write()
      ctx.check('external ref reconciliation finishes collection using existing facts', metrics.externalCollectionComplete)
      metrics.source = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ctx.projectRoot, encoding: 'utf8' }).trim(), checkout: ctx.projectRoot }
      write()
      await ctx.evaluate(() => { const scroll = document.querySelector('.gm-atlas-scroll'); scroll.scrollLeft = scroll.scrollWidth - scroll.clientWidth })
      await new Promise(resolve => setTimeout(resolve, 400))
      await ctx.capture(baseline ? 'atlas-reopen-baseline' : 'atlas-reopen-updated')
    }
  }
  await require('./git-management.cjs').run(ctx)
}
