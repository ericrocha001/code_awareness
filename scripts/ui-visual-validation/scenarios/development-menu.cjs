const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')

exports.run = async ctx => {
  buildSync({
    entryPoints: [path.join(__dirname, 'development-menu-fixture.tsx')],
    bundle: true,
    outfile: path.join(ctx.temporary, 'fixture.js'),
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  const page = path.join(ctx.temporary, 'index.html')
  fs.writeFileSync(
    page,
    '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>'
  )
  await ctx.load(page)
  await ctx.viewport(1100, 720)
  await ctx.waitFor(() => Boolean(document.querySelector('[aria-label="Menu Development"]')))
  await ctx.click('[aria-label="Menu Development"]')
  await ctx.waitFor(() => Boolean(document.querySelector('.dev-menu-container')))
  ctx.check('Renders Restart to Update idle label', await ctx.evaluate(() => {
    const label = document.querySelector('.dev-menu-action-btn--primary .dev-menu-action-label')
    return label?.textContent?.trim() === 'Restart to Update'
  }))
  ctx.check('Displays branch and Chromium DevTools action', await ctx.evaluate(() => {
    const text = document.querySelector('.dev-menu-container')?.textContent || ''
    return text.includes('feat/dev-update') && text.includes('Chromium DevTools') && text.includes('fetch e fast-forward')
  }))
  await ctx.overflow()
  await ctx.capture('development-menu-dark')

  await ctx.evaluate(() => {
    document.body.dataset.theme = 'light'
  })
  await ctx.waitFor(() => document.body.dataset.theme === 'light')
  await ctx.overflow()
  await ctx.capture('development-menu-light')
}
