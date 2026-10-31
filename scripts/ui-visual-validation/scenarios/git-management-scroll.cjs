const fs = require('node:fs')
const path = require('node:path')

exports.run = async ctx => {
  const commands = []
  ctx.atlasObservationProof = {
    seed() {},
    prepare(backend) {
      const run = backend.git.runGit.bind(backend.git)
      backend.git.runGit = async (...args) => { commands.push(args[0]); return run(...args) }
      const state = backend.projects.getState()
      void backend.controller.read({ projectId: state.project.id, revision: state.revision }, async service => {
        service.bindAtlasPullRequests(async inventory => {
          const observedAt = new Date().toISOString(), repository = 'proof/repository', providerRepositoryId = 'provider-proof'
          const base = { repositoryId: providerRepositoryId, repository, ref: 'main', sha: inventory.branches.find(branch => branch.name === 'main').head }
          const items = Array.from({ length: 40 }, (_, index) => {
            const number = index + 1, at = Date.now() + 60000 + index * 1000
            return { id: String(number), number, title: `Remote delivery ${number}`, url: `https://github.com/${repository}/pull/${number}`, state: 'closed', draft: false, merged: true,
              createdAt: new Date(at).toISOString(), updatedAt: new Date(at + 500).toISOString(), mergedAt: new Date(at + 500).toISOString(), mergeCommit: 'b'.repeat(40),
              base, head: { ...base, ref: `remote/topic-${number}`, sha: 'c'.repeat(40) } }
          })
          return { repositoryId: inventory.repositoryId, catalog: { repositoryId: inventory.repositoryId, repository, providerRepositoryId, defaultBranch: 'main', source: 'GITHUB_REST', coverage: 'COMPLETE', revision: 'controlled-pr-catalog', observedAt, reason: null, items }, relations: [], received: [], orphaned: [] }
        })
      })
    },
    async verify(ctx) {
      ctx.window.show(); ctx.window.focus()
      await ctx.click('.gm-close-details')
      const deadline = Date.now() + 20000
      while (Date.now() < deadline && !await ctx.evaluate(() => document.querySelector('.gm-catalog-state')?.textContent.includes('Catálogo indexado') && document.querySelector('[aria-label="Eventos remotos fora do histórico local"] > button')?.textContent.includes('PR #40'))) await new Promise(resolve => setTimeout(resolve, 100))
      ctx.check('remote PR after the last local commit stays visible without a fictitious DAG node', await ctx.evaluate(() => document.querySelector('.gm-header p')?.textContent.includes('11 commits no trecho carregado') && document.querySelector('[aria-label="Eventos remotos fora do histórico local"] > button')?.textContent.includes('PR #40')))
      ctx.check('larger remote catalog remains collapsed and bounded', await ctx.evaluate(() => {
        const activity = document.querySelector('[aria-label="Eventos remotos fora do histórico local"]')
        return activity.querySelector('summary')?.textContent.includes('Mais 79 eventos') && !activity.querySelector('details').open && getComputedStyle(activity.querySelector('.gm-remote-events-list')).maxHeight === '180px'
      }))
      const start = commands.length
      const frames = await ctx.evaluate(async () => {
        const map = document.querySelector('.gm-atlas-scroll'), samples = []
        let previous = performance.now()
        for (let index = 0; index < 180; index++) {
          const now = await new Promise(resolve => requestAnimationFrame(resolve))
          samples.push(now - previous); previous = now
          map.scrollLeft = Math.max(0, map.scrollLeft + (index % 40 < 20 ? -8 : 8))
          map.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: 8 }))
        }
        samples.sort((a, b) => a - b)
        return { frames: samples.length, p95: samples[Math.floor(samples.length * .95)], max: samples.at(-1), visible: !document.hidden }
      })
      const during = commands.slice(start)
      fs.writeFileSync(path.join(ctx.evidenceDir, 'scroll.json'), JSON.stringify({ ...frames, commands: during }))
      ctx.check('focused scroll presents 180 frames with p95 below 50 ms', frames.visible && frames.p95 < 50)
      ctx.check('scroll does not fetch or reread history', !during.some(args => ['fetch', 'log', 'cat-file', 'rev-list'].includes(args[0])))
      await ctx.capture('direct-actions-scroll')
    }
  }
  await require('./git-management.cjs').run(ctx)
}
