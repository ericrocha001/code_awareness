const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')

exports.run = async ctx => {
  const sourceRef = '9c3a8f1d08a104f9a25c08de60f0bed2ac4f49f1'
  const baseline = process.env.ATLAS_COLLECTOR_BASELINE === '1'
  const commands = [], checkpoints = [], metadata = [], probes = []
  const metrics = { baseline, sourceRef, sources: {}, opens: [] }
  const sourceFiles = ['src/main/git-operations/git-atlas-collector.ts', 'src/main/core/git-service.ts']
  const write = () => fs.writeFileSync(path.join(ctx.evidenceDir, 'collector-performance.json'), JSON.stringify({ ...metrics, commands, checkpoints, metadata, probes }, null, 2))
  const wait = async (condition, timeout = 20000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await ctx.evaluate(condition)) return true
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return false
  }
  const ready = () => document.querySelectorAll('.gm-commit').length > 0 && document.querySelector('.gm-history')?.getAttribute('aria-busy') === 'false'
  const complete = () => !!document.querySelector('.gm-catalog-state.is-complete') && document.querySelector('.gm-history')?.getAttribute('aria-busy') === 'false'
  let loadedAt = 0
  const load = ctx.load
  ctx.load = async file => { loadedAt = performance.now(); return load(file) }
  ctx.atlasObservationProof = {
    async build(options) {
      return require('esbuild').build({ ...options, plugins: [{ name: 'collector-provenance', setup(build) {
        build.onLoad({ filter: /\.ts$/ }, args => {
          const relative = path.relative(ctx.projectRoot, args.path).replaceAll('\\', '/')
          if (!sourceFiles.includes(relative)) return
          const contents = baseline ? execFileSync('git', ['show', `${sourceRef}:${relative}`], { cwd: ctx.projectRoot, encoding: 'utf8', windowsHide: true }) : fs.readFileSync(args.path, 'utf8')
          metrics.sources[relative] = createHash('sha256').update(contents).digest('hex')
          return { contents, loader: 'ts' }
        })
      } }] })
    },
    seed(root) {
      const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
      const rows = [], now = Math.floor(Date.now() / 1000) - 1000
      for (let i = 1; i <= 32; i++) rows.push(`commit refs/heads/main\nmark :${i}\ncommitter Proof <proof@example.com> ${now + i} +0000\ndata 8\nmeasured\n\n`)
      for (let i = 0; i < 60; i++) rows.push(`reset refs/heads/concentrated-${i}\nfrom :32\n\n`)
      const imported = spawnSync('git', ['fast-import', '--quiet', '--force'], { cwd: root, input: rows.join(''), encoding: 'utf8', windowsHide: true })
      if (imported.status !== 0) throw new Error(imported.stderr)
      const merge = git(['commit-tree', git(['rev-parse', 'main^{tree}']), '-p', 'main', '-p', 'feature/inspector', '-m', 'Measured merge'])
      git(['update-ref', 'refs/heads/main', merge]); git(['reset', '--hard', 'main'])
      metrics.fixture = { commits: Number(git(['rev-list', '--all', '--count'])), refs: git(['for-each-ref', '--format=%(refname)']).split('\n').length, merges: Number(git(['rev-list', '--all', '--merges', '--count'])) }
    },
    prepare(backend) {
      const git = backend.git, run = git.runGit.bind(git), fingerprint = git.getAtlasSourceFingerprint.bind(git), full = git.getAtlasFullCommitMetadata.bind(git)
      git.runGit = async (...args) => { const at = performance.now(); try { return await run(...args) } finally { commands.push({ args: args[0], at, ms: performance.now() - at }) } }
      git.getAtlasSourceFingerprint = async (...args) => { probes.push({ at: performance.now() }); return fingerprint(...args) }
      git.getAtlasFullCommitMetadata = async (...args) => { metadata.push({ at: performance.now(), shas: args[1] }); return full(...args) }
      const instrument = () => {
        const service = backend.controller.active?.service
        if (!service?.atlasPersistence) return
        const open = service.atlasPersistence
        service.atlasPersistence = async common => {
          const store = await open(common), checkpoint = store.checkpoint
          store.checkpoint = (...args) => {
            const at = performance.now(), accepted = checkpoint(...args)
            checkpoints.push({ at, round: args[0], shas: args[2], accepted, ms: performance.now() - at })
            return accepted
          }
          return store
        }
      }
      instrument(); backend.projects.onChanged(instrument)
    },
    async verify(ctx, { root, git, backend }) {
      ctx.window.show(); ctx.window.focus()
      metrics.opens.push({ name: 'cold', firstHistoryMs: performance.now() - loadedAt })
      ctx.check('first history precedes full collection', !await ctx.evaluate(complete))
      await ctx.evaluate(() => {
        const result = globalThis.__collectorFrames = { frames: [], stop: false, previous: performance.now() }
        const frame = now => {
          if (result.stop) return
          result.frames.push(now - result.previous); result.previous = now
          const scroll = document.querySelector('.gm-atlas-scroll')
          scroll.scrollLeft = scroll.scrollWidth - scroll.clientWidth - (result.frames.length % 2) * 8
          scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: 8 }))
          requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      })
      await new Promise(resolve => setTimeout(resolve, 2500))
      metrics.scroll = await ctx.evaluate(() => { const r = globalThis.__collectorFrames; r.stop = true; const values = r.frames.sort((a, b) => a - b); return { frames: values.length, p95: values[Math.floor(values.length * .95)], max: values.at(-1) } })
      const collected = await wait(complete, 80000)
      metrics.collection = { complete: collected, completeMs: performance.now() - loadedAt, partialMs: checkpoints.find(item => item.accepted)?.at - loadedAt,
        commands: commands.length, fullProbes: probes.length, checkpoints: checkpoints.filter(item => item.accepted).length,
        commits: new Set(checkpoints.filter(item => item.accepted).flatMap(item => item.shas)).size,
        metadataShas: metadata.reduce((sum, item) => sum + item.shas.length, 0) }
      metrics.collection.commandsPerCommit = metrics.collection.commands / metrics.collection.commits
      metrics.collection.probesPerCommit = metrics.collection.fullProbes / metrics.collection.commits
      write()
      if (!collected) { await ctx.capture('collector-incomplete'); ctx.check('collector reaches current COMPLETE', false) }
      ctx.check('every expected immutable commit is durably checkpointed', metrics.collection.commits === metrics.fixture.commits)
      ctx.check('metadata and checkpoint units remain bounded', metadata.every(item => item.shas.length <= 32) && checkpoints.every(item => item.shas.length <= 32))
      if (!baseline) ctx.check('full probes are amortized across persisted commits', metrics.collection.fullProbes < metrics.collection.commits)
      for (let i = 1; i <= 2; i++) {
        await ctx.click('[data-proof-project="none"]'); await wait(() => !document.querySelector('.gm-history'))
        const start = performance.now(), from = metadata.length
        await ctx.click('[data-proof-project="a"]'); ctx.check(`warm ${i} renders history`, await wait(ready))
        metrics.opens.push({ name: `warm-${i}`, firstHistoryMs: performance.now() - start })
        write()
        ctx.check(`warm ${i} reuses the completed ledger`, await wait(complete))
        ctx.check(`warm ${i} performs no full metadata recapture`, metadata.slice(from).every(item => item.shas.length === 0))
        write()
      }
      const from = metadata.length, changedAt = performance.now()
      const old = git('rev-parse', 'HEAD'), next = git('commit-tree', git('rev-parse', 'HEAD^{tree}'), '-p', old, '-m', 'External movement')
      git('update-ref', 'refs/heads/main', next, old); git('branch', 'external-epoch', old)
      ctx.check('external ref is discovered', await wait(() => [...document.querySelectorAll('select[aria-label="Referência em foco"] option')].some(option => option.value === 'refs/heads/external-epoch')))
      metrics.externalRefMs = performance.now() - changedAt
      write()
      ctx.check('moved refs converge to COMPLETE', await wait(complete))
      const selected = backend.controller.active.service.atlasReader.manifest
      ctx.check('COMPLETE authenticates the new tips and current source', selected.tips.includes(next) && selected.sourceFingerprint === await backend.git.getAtlasSourceFingerprint(root))
      metrics.movedMetadata = [...new Set(metadata.slice(from).flatMap(item => item.shas))]
      ctx.check('moving refs reuses every previous full fact', metrics.movedMetadata.every(sha => sha === next))
      metrics.source = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ctx.projectRoot, encoding: 'utf8', windowsHide: true }).trim(), checkout: ctx.projectRoot }
      write()
      await ctx.evaluate(() => { const scroll = document.querySelector('.gm-atlas-scroll'); scroll.scrollLeft = scroll.scrollWidth - scroll.clientWidth })
      await ctx.capture(baseline ? 'collector-baseline' : 'collector-amortized')
    }
  }
  await require('./git-management.cjs').run(ctx)
}
