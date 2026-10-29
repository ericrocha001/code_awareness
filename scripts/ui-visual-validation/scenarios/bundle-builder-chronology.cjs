const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')

exports.preload = path.join(__dirname, 'bundle-builder-preload.cjs')
exports.run = async ctx => {
  buildSync({ entryPoints: [path.join(__dirname, 'bundle-builder-backend.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3', 'sharp', 'archiver', 'js-tiktoken'], outfile: path.join(ctx.evidenceDir, 'backend.cjs') })
  const backend = require(path.join(ctx.evidenceDir, 'backend.cjs')).start(path.join(ctx.temporary, 'continuum.db'))
  try {
    const oldest = backend.store.list({ query: 'Architecture 00' }).artifacts[0]
    backend.store.assignTag('git-atlas', [{ artifactId: oldest.artifactId, expectedRevision: oldest.revision }], false)
    buildSync({ entryPoints: [path.join(__dirname, 'bundle-builder-fixture.tsx')], bundle: true, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, outfile: path.join(ctx.temporary, 'fixture.js'), loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' } })
    const page = path.join(ctx.temporary, 'index.html')
    fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}body{background:var(--bg-primary);color:var(--text-primary)}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
    await ctx.load(page); await ctx.viewport(1672, 941)
    await ctx.waitFor(() => document.querySelectorAll('.continuum-builder-source').length === 30)
    ctx.check('Creation default keeps the tagged old Artifact behind newer creations', await ctx.evaluate(() => document.querySelector('.continuum-builder-catalog-order select').value === 'createdAt' && document.querySelector('.continuum-builder-source').textContent.includes('Architecture 66') && document.querySelector('.continuum-builder-source time').textContent.startsWith('Criado')))
    await ctx.click('.continuum-builder-source')
    await ctx.waitFor(() => document.querySelectorAll('.continuum-builder-members li').length === 1)
    ctx.check('Day separator exists', await ctx.evaluate(() => !!document.querySelector('.continuum-builder-catalog-date')?.textContent))
    await ctx.overflow(); await ctx.capture('builder-creation-dark')
    await ctx.evaluate(() => { const select = document.querySelector('.continuum-builder-catalog-order select'); select.value = 'updatedAt'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await ctx.waitFor(() => document.querySelector('.continuum-builder-source')?.textContent.includes('Architecture 00'))
    ctx.check('Update order promotes the tag mutation and keeps the selected composition', await ctx.evaluate(() => document.querySelector('.continuum-builder-source time').textContent.startsWith('Atualizado') && document.querySelector('.continuum-builder-members li').textContent.includes('Architecture 66')))
    await ctx.viewport(1000, 760); await ctx.evaluate(() => { document.body.dataset.theme = 'light' })
    await ctx.overflow(); await ctx.capture('builder-update-light')
  } finally { backend.close() }
}
