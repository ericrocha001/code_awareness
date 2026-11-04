const fs = require('node:fs'), path = require('node:path')
const { buildSync } = require('esbuild')

exports.run = async ctx => {
  const script = path.join(ctx.evidenceDir, 'fixture.js'), page = path.join(ctx.evidenceDir, 'index.html')
  buildSync({ entryPoints: [path.join(__dirname, 'codex-archive-fixture.tsx')], outfile: script, bundle: true, platform: 'browser', jsx: 'automatic', logLevel: 'silent' })
  fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  await ctx.load(page); await ctx.viewport(1024, 780)
  await ctx.waitFor(() => document.querySelector('.settings-codex button')?.textContent === 'Conectar ao Codex…')
  await ctx.evaluate(() => document.querySelector('.settings-codex').scrollIntoView({ block: 'center' }))
  ctx.check('Existing Git control remains visible in the single settings scroll region', await ctx.evaluate(() => {
    const row = document.querySelector('[aria-label="Fetch automático condicionado ao remoto"]').closest('.settings-row').getBoundingClientRect()
    const body = document.querySelector('.settings-body').getBoundingClientRect()
    return row.height >= 40 && row.top >= body.top && row.bottom <= body.bottom
  }))
  ctx.check('Initial read is disconnected and does not imply capture', await ctx.evaluate(() => document.querySelector('.settings-codex [role="status"]').textContent === 'Desconectado'))
  await ctx.capture('codex-archive-disconnected-dark-desktop')
  await ctx.click('.settings-codex button')
  await ctx.waitFor(() => document.querySelector('.settings-codex button')?.textContent === 'Desconectar')
  ctx.check('Connected fixture offers disconnect', await ctx.evaluate(() => document.querySelector('.settings-codex [role="status"]').textContent.includes('Codex 0.155.0')))
  await ctx.capture('codex-archive-connected-dark-desktop')
  await ctx.evaluate(() => window.codexArchiveFixture.emit({ state: 'ACCOUNT_IDENTITY_UNAVAILABLE' }))
  await ctx.waitFor(() => document.querySelector('.settings-codex [role="status"]')?.textContent === 'Não foi possível confirmar a conta')
  await ctx.viewport(400, 720)
  await ctx.evaluate(() => document.querySelector('.settings-codex button').scrollIntoView({ block: 'center' }))
  await ctx.capture('codex-archive-account-unavailable-dark-narrow')
  ctx.check('Codex section stays inside dialog width', await ctx.evaluate(() => {
    const section = document.querySelector('.settings-codex'), dialog = document.querySelector('.settings-modal')
    return section.getBoundingClientRect().right <= dialog.getBoundingClientRect().right + 1 && section.scrollWidth <= section.clientWidth + 1
  }))
  await ctx.click('.settings-codex button')
  await ctx.waitFor(() => document.querySelector('.settings-codex button')?.textContent === 'Desconectar')
  await ctx.evaluate(() => document.querySelector('.settings-codex button').scrollIntoView({ block: 'center' }))
  await ctx.click('.settings-codex button')
  await ctx.waitFor(() => document.querySelector('.settings-codex [role="status"]')?.textContent === 'Desconectado')
  ctx.check('Disconnect returns to metadata-disabled state', true)
}
