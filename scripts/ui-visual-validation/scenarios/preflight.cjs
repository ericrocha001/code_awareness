exports.run = async ctx => {
  await ctx.window.loadURL('data:text/html,<html><body style="margin:0;background:%2318181b;color:white"><h1>Electron visual preflight</h1><button id="action" onclick="this.textContent=\'Confirmed\'">Click</button></body></html>')
  await ctx.click('#action')
  await ctx.waitFor(() => document.querySelector('#action').textContent === 'Confirmed')
  ctx.check('Native interaction', true)
  await ctx.overflow()
  const before = await ctx.capture('preflight')
  await ctx.evaluate(() => { document.body.style.background = '#ffffff' })
  const after = await ctx.capture('preflight-updated')
  ctx.check('Capture reflects updated Chromium paint', !before.toBitmap().equals(after.toBitmap()))
}
