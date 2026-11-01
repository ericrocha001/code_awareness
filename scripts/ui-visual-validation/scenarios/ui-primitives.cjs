const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')

exports.run = async ctx => {
  buildSync({ entryPoints: [path.join(__dirname, 'ui-primitives-fixture.tsx')], bundle: true,
    outfile: path.join(ctx.temporary, 'fixture.js'), platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' } })
  const page = path.join(ctx.temporary, 'index.html')
  fs.writeFileSync(page, '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  await ctx.load(page)
  await ctx.viewport(1100, 880)
  await ctx.waitFor(() => !!document.querySelector('#destino'))
  ctx.check('Synthetic fixture, production primitives, no backend', true)
  await ctx.overflow()
  await ctx.capture('primitives-dark-base')
  await ctx.click('[aria-pressed]')
  await ctx.waitFor(() => document.querySelector('[aria-pressed]').getAttribute('aria-pressed') === 'true')
  ctx.check('Opt-in controls are comfortable and icon-only action is named', await ctx.evaluate(() =>
    [...document.querySelectorAll('.ui-button')].every(button => button.getBoundingClientRect().height >= 40) &&
    document.querySelector('.ui-button--icon').getAttribute('aria-label') === 'Adicionar arquivo'))
  await ctx.click('[aria-label="Ajuda sobre o destino"]')
  await ctx.waitFor(() => document.activeElement?.getAttribute('role') === 'dialog')
  ctx.check('Help is named, linked and receives focus', await ctx.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    return dialog.getAttribute('aria-label') === 'Ajuda sobre o destino' && document.querySelector('[aria-haspopup="dialog"]').getAttribute('aria-controls') === dialog.id
  }))
  await ctx.capture('primitives-dark-help')
  ctx.window.webContents.focus()
  const key = code => {
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: code })
    ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: code })
  }
  key('Tab')
  await ctx.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Buscar na ajuda')
  key('Escape')
  await ctx.waitFor(() => !document.querySelector('[role="dialog"]'))
  ctx.check('Escape restores trigger focus', await ctx.evaluate(() => document.activeElement?.getAttribute('aria-haspopup') === 'dialog'))
  key('Tab')
  await ctx.waitFor(() => document.activeElement?.id === 'destino')
  ctx.check('Native select shows keyboard focus', await ctx.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== 'none'))
  key('Down')
  key('Return')
  await ctx.waitFor(() => document.querySelector('#destino').value === 'temporary')
  ctx.check('Native keyboard selection updates the React consumer', await ctx.evaluate(() => document.querySelector('output').textContent === 'Temporário selecionado'))
  await ctx.capture('primitives-dark-select-focus')
  await ctx.evaluate(() => document.body.dataset.theme = 'light')
  await ctx.capture('primitives-light-base')
  await ctx.viewport(480, 880)
  await ctx.overflow()
  await ctx.capture('primitives-light-narrow')
}
