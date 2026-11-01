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
  await ctx.capture('primitives-dark-help-input-focus')
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
  await ctx.click('[aria-label="Ajuda sobre o destino"]')
  await ctx.waitFor(() => document.activeElement?.getAttribute('role') === 'dialog')
  await ctx.capture('primitives-light-help')
  key('Escape')
  await ctx.waitFor(() => !document.querySelector('[role="dialog"]'))
  ctx.check('Light help Escape restores trigger focus', await ctx.evaluate(() => document.activeElement?.getAttribute('aria-haspopup') === 'dialog'))
  ctx.window.webContents.focus()
  key('Space')
  await ctx.waitFor(() => document.activeElement?.getAttribute('role') === 'dialog')
  ctx.check('Help opens through the native keyboard button contract', true)
  await ctx.click('[aria-label="Adicionar arquivo"]')
  await ctx.waitFor(() => !document.querySelector('[role="dialog"]'))
  ctx.check('Outside click closes help without taking focus back', await ctx.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Adicionar arquivo'))
  for (const theme of ['light', 'dark']) {
    await ctx.evaluate(value => document.body.dataset.theme = value, theme)
    const dangerColor = await ctx.evaluate(() => getComputedStyle(document.querySelector('.ui-button--danger')).color)
    const point = await ctx.evaluate(() => {
      const rect = document.querySelector('.ui-button--danger').getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    })
    ctx.window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    ctx.check(`${theme}: danger meaning survives hover`, await ctx.evaluate(color => getComputedStyle(document.querySelector('.ui-button--danger')).color === color, dangerColor))
    ctx.check(`${theme}: text contrast and independent brand/state tokens`, await ctx.evaluate(() => {
      const rgb = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
        const channel = value / 255
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
      const ratio = (a, b) => (Math.max(rgb(a), rgb(b)) + 0.05) / (Math.min(rgb(a), rgb(b)) + 0.05)
      const primary = getComputedStyle(document.querySelector('.ui-button--primary'))
      const select = getComputedStyle(document.querySelector('select'))
      const danger = getComputedStyle(document.querySelector('.ui-button--danger'))
      const root = getComputedStyle(document.body)
      return ratio(primary.color, primary.backgroundColor) >= 4.5 && ratio(select.color, select.backgroundColor) >= 4.5 &&
        ratio(danger.color, danger.backgroundColor) >= 4.5 && root.getPropertyValue('--ui-danger') !== root.getPropertyValue('--brand-violet') &&
        root.getPropertyValue('--accent').trim().toLowerCase() === '#7852ee'
    }))
    await ctx.capture(`primitives-${theme}-danger-hover`)
  }
  await ctx.viewport(480, 880)
  await ctx.evaluate(() => document.body.dataset.theme = 'light')
  await ctx.overflow()
  await ctx.capture('primitives-light-narrow')
  await ctx.evaluate(() => document.body.dataset.theme = 'dark')
  await ctx.capture('primitives-dark-narrow')
  await ctx.click('[aria-label="Ajuda sobre o destino"]')
  await ctx.waitFor(() => document.activeElement?.getAttribute('role') === 'dialog')
  await ctx.capture('primitives-dark-narrow-help')
  ctx.check('Narrow help fits inside viewport', await ctx.evaluate(() => {
    const rect = document.querySelector('[role="dialog"]').getBoundingClientRect()
    return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
  }))
}
