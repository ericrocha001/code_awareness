const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')

exports.run = async ctx => {
  buildSync({ entryPoints: [path.join(__dirname, 'continuum-fixture.tsx')], bundle: true, outfile: path.join(ctx.temporary, 'fixture.js'), platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' } })
  const page = path.join(ctx.temporary, 'index.html')
  fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}body{background:var(--bg-primary);color:var(--text-primary)}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  await ctx.load(page)
  await ctx.viewport(1440, 900)
  await ctx.waitFor(() => document.querySelectorAll('.continuum-item').length === 18)
  ctx.check('Creation default and matching timestamp', await ctx.evaluate(() => document.querySelector('.continuum-timeline-order select').value === 'createdAt' && document.querySelector('.continuum-item time').dateTime === '2026-10-01T18:00:00Z' && document.querySelector('.continuum-item time').textContent.startsWith('Criado')))
  ctx.check('Canonical tag name, slug fallback and accessible overflow', await ctx.evaluate(() => {
    const tags = document.querySelector('.continuum-item-tags')
    return tags.textContent.includes('Fixture') && tags.textContent.includes('fallback') && tags.querySelector('[aria-label="Outras tags: remaining"]').textContent === '+1'
  }))
  await ctx.click('.continuum-item')
  await ctx.waitFor(() => !!document.querySelector('.continuum-markdown h1'))
  await ctx.evaluate(() => document.querySelector('.continuum-timeline-order select').focus())
  await ctx.overflow()
  await ctx.capture('creation-dark')
  await ctx.evaluate(() => {
    const select = document.querySelector('.continuum-timeline-order select')
    select.value = 'updatedAt'; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await ctx.waitFor(() => document.querySelector('.continuum-item time')?.textContent.startsWith('Atualizado'))
  ctx.check('Update mode keeps Inspector and uses update timestamp', await ctx.evaluate(() => document.querySelector('.continuum-item time').dateTime === '2026-10-06T18:00:00Z' && !!document.querySelector('.continuum-markdown h1')))
  await ctx.viewport(1000, 760)
  await ctx.evaluate(() => { document.body.dataset.theme = 'light' })
  await ctx.click('[aria-label="Fechar inspector"]')
  await ctx.overflow()
  await ctx.capture('update-light-compact')
}
