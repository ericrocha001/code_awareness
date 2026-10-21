const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { app } = require('electron')

exports.run = async ctx => {
  const commands = []
  const baseline = process.env.ATLAS_OBSERVATION_BASELINE === '1'
  ctx.atlasObservationProof = {
    async build(options) {
      const plugins = baseline ? [{ name: 'observed-baseline', setup(build) {
        const paths = execFileSync('git', ['-c', 'core.fsmonitor=false', 'diff', '--name-only', 'HEAD', '--', 'src'], { cwd: ctx.projectRoot, encoding: 'utf8', windowsHide: true }).trim().split('\n')
        build.onLoad({ filter: /\.[jt]sx?$/ }, args => {
          const relative = path.relative(ctx.projectRoot, args.path).replaceAll('\\', '/')
          if (!paths.includes(relative)) return
          return { contents: execFileSync('git', ['show', `HEAD:${relative}`], { cwd: ctx.projectRoot, encoding: 'utf8', windowsHide: true }), loader: relative.endsWith('tsx') ? 'tsx' : 'ts' }
        })
      } }] : []
      return require('esbuild').build({ ...options, plugins })
    },
    seed(root) {
      const records = [], now = Math.floor(Date.now() / 1000)
      for (let index = 1; index <= 240; index++) records.push(`commit refs/heads/main\nmark :${index}\ncommitter Proof <proof@example.com> ${now - (240 - index) * 120} +0000\ndata 8\nmeasured\n\n`)
      for (let index = 0; index < 80; index++) records.push(`reset refs/heads/observed-${index}\nfrom :${240 - index * 3}\n\n`)
      const result = spawnSync('git', ['fast-import', '--quiet', '--force'], { cwd: root, input: records.join(''), encoding: 'utf8', windowsHide: true })
      if (result.status !== 0) throw new Error(result.stderr)
      execFileSync('git', ['reset', '--hard', 'main'], { cwd: root, windowsHide: true })
    },
    prepare(backend) {
      const run = backend.git.runGit.bind(backend.git)
      backend.git.runGit = async (...args) => {
        const start = performance.now()
        try { return await run(...args) }
        finally { commands.push({ args: args[0], start, duration: performance.now() - start }) }
      }
    },
    async verify(ctx, { root, git }) {
      ctx.window.show(); ctx.window.focus()
      const wait = async (condition, timeout = 30000) => {
        const end = Date.now() + timeout
        while (Date.now() < end) { if (await ctx.evaluate(condition)) return true; await new Promise(resolve => setTimeout(resolve, 100)) }
        return false
      }
      const complete = await wait(() => document.querySelector('.gm-catalog-state')?.textContent?.includes('Catálogo indexado'), 90000)
      if (!complete) {
        fs.writeFileSync(path.join(ctx.evidenceDir, 'collection-diagnostic.json'), JSON.stringify({ text: await ctx.evaluate(() => document.querySelector('.gm-view')?.textContent), commands }, null, 2))
        await ctx.capture('collection-incomplete')
      }
      ctx.check('SQLite collection completes', complete)
      const metrics = { baseline, fixture: { commits: 251, branches: 82 }, scenarios: [] }
      const cpu = () => app.getAppMetrics().map(item => ({ pid: item.pid, type: item.type, seconds: item.cpu.cumulativeCPUUsage }))
      const measure = async (name, duration, scroll = false) => {
        await ctx.evaluate(scroll => {
          const measurement = globalThis.__atlasMeasurement = { frames: [], longTasks: [], mutations: 0, start: performance.now(), stop: false }
          new MutationObserver(records => { measurement.mutations += records.length }).observe(document.querySelector('.gm-atlas-surface'), { childList: true, subtree: true, attributes: true })
          const observer = new PerformanceObserver(list => measurement.longTasks.push(...list.getEntries().map(entry => entry.duration)))
          observer.observe({ type: 'longtask', buffered: false })
          let previous
          const frame = now => { if (measurement.stop) { observer.disconnect(); return }; if (previous) measurement.frames.push(now - previous); previous = now; requestAnimationFrame(frame) }
          requestAnimationFrame(frame)
          if (scroll) measurement.scroll = setInterval(() => {
            const element = document.querySelector('.gm-atlas-scroll')
            element.scrollLeft = (element.scrollLeft + 13) % Math.max(1, element.scrollWidth - element.clientWidth)
            element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: 13 }))
          }, 16)
        }, scroll)
        const start = performance.now(), count = commands.length, before = cpu()
        await new Promise(resolve => setTimeout(resolve, duration))
        const after = cpu(), elapsed = performance.now() - start
        const renderer = await ctx.evaluate(() => {
          const m = globalThis.__atlasMeasurement; m.stop = true; clearInterval(m.scroll)
          const frames = m.frames.sort((a, b) => a - b)
          return { frameP95: frames[Math.floor(frames.length * .95)] ?? null, frames: frames.length, longTasks: m.longTasks, mutations: m.mutations, visible: !document.hidden, focused: document.hasFocus() }
        })
        const calls = commands.slice(count)
        const result = { name, start, elapsed, subprocesses: calls.length, perMinute: calls.length * 60000 / elapsed, gitWallMs: calls.reduce((sum, call) => sum + call.duration, 0), historyCalls: calls.filter(call => call.args.includes('log') || call.args.includes('cat-file')).length, cpuSeconds: after.map(item => ({ type: item.type, seconds: item.seconds - (before.find(value => value.pid === item.pid)?.seconds ?? item.seconds) })), ...renderer }
        metrics.scenarios.push(result)
        fs.writeFileSync(path.join(ctx.evidenceDir, 'observation-performance.json'), JSON.stringify({ ...metrics, commands }, null, 2))
        return result
      }
      const idle = await measure('visible-complete-idle', 60000)
      ctx.check('idle performs no history or commit metadata reads', idle.historyCalls === 0)
      await measure('active-scroll', 15000, true)
      ctx.window.webContents.setBackgroundThrottling(true)
      ctx.window.hide()
      ctx.check('Chromium reports hidden document', await wait(() => document.hidden))
      const drainDeadline = Date.now() + 20000
      let quietSince = Date.now(), priorCalls = commands.length
      while (Date.now() < drainDeadline && Date.now() - quietSince < 2000) {
        await new Promise(resolve => setTimeout(resolve, 100))
        if (commands.length !== priorCalls) { quietSince = Date.now(); priorCalls = commands.length }
      }
      const hidden = await measure('hidden', 15000)
      ctx.check('hidden performs no Git reads', hidden.subprocesses === 0)
      ctx.window.show(); ctx.window.focus()
      ctx.window.webContents.setBackgroundThrottling(false)
      ctx.check('collection is complete again before external mutation', await wait(() => !!document.querySelector('.gm-catalog-state.is-complete') && document.querySelector('.gm-history')?.getAttribute('aria-busy') === 'false'))
      const settleDeadline = Date.now() + 30000
      let settledSince = Date.now(), settledCalls = commands.length
      while (Date.now() < settleDeadline && Date.now() - settledSince < 500) {
        await new Promise(resolve => setTimeout(resolve, 100))
        if (commands.length !== settledCalls) { settledSince = Date.now(); settledCalls = commands.length }
      }
      const start = performance.now()
      git('branch', 'external-observation-a'); git('branch', 'external-observation-b')
      const appeared = await wait(() => [...document.querySelectorAll('select[aria-label="Referência em foco"] option')].some(item => item.value === 'refs/heads/external-observation-b'), baseline ? 7000 : 12000)
      metrics.branchLatencyMs = appeared ? performance.now() - start : null
      metrics.externalBranchDetected = appeared
      fs.writeFileSync(path.join(ctx.evidenceDir, 'observation-performance.json'), JSON.stringify({ ...metrics, commands }, null, 2))
      if (!baseline) ctx.check('external branches appear while focused within five seconds', appeared && metrics.branchLatencyMs < 5000)
      if (!baseline) {
        metrics.catalogReused = await wait(() => !!document.querySelector('.gm-catalog-state.is-complete'))
        metrics.newMetadataReads = commands.filter(command => command.start >= start && command.args.some(arg => arg.includes('%B'))).length
        ctx.check('new ref round reuses the completed SQLite catalog', metrics.catalogReused && metrics.newMetadataReads === 0)
      }
      if (!baseline && process.platform === 'win32') {
        const workload = path.join(ctx.temporary, 'idle-commands.json'), calibration = path.join(ctx.temporary, 'git-cpu.ps1')
        fs.writeFileSync(workload, JSON.stringify({ commands: commands.filter(command => command.start >= idle.start && command.start < idle.start + idle.elapsed) }))
        fs.writeFileSync(calibration, `param([string] $CommandsPath, [string] $Root)
$entries = (Get-Content -LiteralPath $CommandsPath -Raw | ConvertFrom-Json).commands
$cpuMs = 0; $wall = [System.Diagnostics.Stopwatch]::StartNew()
foreach ($entry in $entries) {
  $child = [System.Diagnostics.Process]::new()
  $child.StartInfo.FileName = 'git'; $child.StartInfo.WorkingDirectory = $Root
  $child.StartInfo.UseShellExecute = $false; $child.StartInfo.CreateNoWindow = $true
  $child.StartInfo.RedirectStandardOutput = $true; $child.StartInfo.RedirectStandardError = $true
  foreach ($argument in $entry.args) { $child.StartInfo.ArgumentList.Add([string] $argument) }
  $null = $child.Start(); $null = $child.StandardOutput.ReadToEnd(); $errorText = $child.StandardError.ReadToEnd(); $child.WaitForExit()
  if ($child.ExitCode -ne 0) { throw $errorText }
  $cpuMs += $child.TotalProcessorTime.TotalMilliseconds; $child.Dispose()
}
@{ commandCount = $entries.Count; gitCpuMs = $cpuMs; wallMs = $wall.Elapsed.TotalMilliseconds } | ConvertTo-Json -Compress
`)
        metrics.gitCpuCalibration = { method: 'WINDOWS_CPU_REPLAY_OF_OBSERVED_IDLE_COMMANDS', observedIdleDurationMs: idle.elapsed, ...JSON.parse(execFileSync(process.env.ATLAS_POWERSHELL || 'pwsh', ['-NoProfile', '-File', calibration, workload, root], { encoding: 'utf8', windowsHide: true, timeout: 30000 })) }
      }
      metrics.source = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ctx.projectRoot, encoding: 'utf8', windowsHide: true }).trim(), checkout: ctx.projectRoot }
      fs.writeFileSync(path.join(ctx.evidenceDir, 'observation-performance.json'), JSON.stringify({ ...metrics, commands }, null, 2))
      await ctx.capture(baseline ? 'observation-baseline' : 'observation-updated')
    }
  }
  await require('./git-management.cjs').run(ctx)
}
