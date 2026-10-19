exports.run = async ctx => {
  ctx.gridProof = true
  await require('./git-management.cjs').run(ctx)
}

const ages = [1, 6, 8, 14, 16, 29, 31, 59, 61, 89, 91]
const branches = [...ages.map(age => ({ name: `atlas-proof-age-${age}`, age })), ...Array.from({ length: 20 }, (_, index) => ({ name: `atlas-proof-many-${index}`, age: 2 }))]

exports.seed = root => {
  const { execFileSync } = require('node:child_process')
  const git = (args, env = {}) => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', env: { ...process.env, ...env } }).trim()
  const tree = git(['rev-parse', 'HEAD^{tree}'])
  const oldDate = new Date(Date.now() - 110 * 86400000).toISOString()
  const parent = git(['commit-tree', tree, '-m', 'Prior boundary'], { GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate })
  for (const branch of branches) {
    const date = new Date(Date.now() - branch.age * 86400000).toISOString()
    const sha = git(['commit-tree', tree, '-p', parent, '-m', branch.name], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
    git(['update-ref', `refs/heads/${branch.name}`, sha])
  }
}

exports.verify = async ctx => {
  const fs = require('node:fs'), path = require('node:path'), geometry = []
  await ctx.viewport(2560, 1440)
  for (const [index, days] of [7, 15, 30, 60, 90, 'ALL'].entries()) {
    await ctx.click(`.gm-segmented[aria-label="Janela temporal"] button:nth-child(${index + 1})`)
    await ctx.evaluate(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
    const expected = branches.filter(branch => days === 'ALL' || branch.age < days).map(branch => `refs/heads/${branch.name}`).sort()
    const deadline = Date.now() + 30000
    let ready = false
    while (Date.now() < deadline) {
      ready = await ctx.evaluate((days, expected) => {
        const refs = [...document.querySelectorAll('.gm-atlas-lane-label')].map(element => element.dataset.track).filter(ref => ref.startsWith('refs/heads/atlas-proof-')).sort()
        return document.querySelector('.gm-history').getAttribute('aria-busy') === 'false' && document.querySelectorAll('.gm-commit').length > 0 && (days === 'ALL' || document.querySelectorAll('.gm-atlas-date').length === days) && JSON.stringify(refs) === JSON.stringify(expected)
      }, days, expected)
      if (ready) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    ctx.check(`${days}: only branches with commits in the window appear, including more than twelve active trajectories`, ready)
    ctx.check(`${days}: both noise controls remain absent`, await ctx.evaluate(() => !document.querySelector('.gm-secondary-toggle') && !document.querySelector('.gm-inactive')))
    const bounds = await ctx.evaluate(() => {
      const map = document.querySelector('.gm-atlas-scroll'), surface = document.querySelector('.gm-atlas-surface'), last = document.querySelector('.gm-atlas-date:last-child')
      return { viewport: map.clientWidth, surface: parseFloat(surface.style.width), scrollLeft: map.scrollLeft, mapRight: map.getBoundingClientRect().right, lastDayRight: last.getBoundingClientRect().right, plotWidth: Number(document.querySelector('.gm-atlas-lines').getAttribute('width')) }
    })
    geometry.push({ days, expectedBranches: expected.length, ...bounds })
    if (days === 7 || days === 15) {
      ctx.check(`${days}: populated daily grid reaches the panel edge`, Math.abs(bounds.lastDayRight - bounds.mapRight) < 20 && bounds.scrollLeft === 0)
      await ctx.capture(`grid-${days}-days-dark`)
    }
  }
  fs.writeFileSync(path.join(ctx.evidenceDir, 'grid-geometry.json'), JSON.stringify(geometry, null, 2))
  await ctx.evaluate(() => { document.body.dataset.theme = 'light' })
  await ctx.capture('grid-all-days-light')
  await ctx.viewport(1000, 800)
  await ctx.overflow()
  await ctx.capture('grid-medium-light')
}
