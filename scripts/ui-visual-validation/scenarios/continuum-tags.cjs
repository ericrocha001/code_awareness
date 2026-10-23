const { clipboard } = require('electron')
exports.run = async ctx => {
  const runtime = await require('./continuum-runtime.cjs').setup(ctx)
  const service = runtime.session.getActiveService(), prior = clipboard.readText()
  const raw = '---\nname: Plano de contexto\ndescription: Fixture isolada de aceitação\nkind: DOCUMENT\n---\n# Leitura protegida\n\n' + 'Conteúdo literal com contexto suficiente para exercitar scroll local.\n\n'.repeat(60)
  const artifact = service.publish(raw)
  try {
    await runtime.open(); await ctx.viewport(1440, 900)
    await ctx.waitFor(() => !!document.querySelector('.continuum-item'))
    await ctx.click('.continuum-item')
    await ctx.waitFor(() => !!document.querySelector('[aria-label="Tags do Artifact"]'))
    ctx.check('Timeline has no batch controls; Inspector actions stay outside reading pane', await ctx.evaluate(() => !document.querySelector('.continuum-timeline input[type=checkbox]') && !!document.querySelector('.continuum-inspector > .continuum-pane-heading [aria-label="Copiar"]') && !document.querySelector('.continuum-inspector .continuum-pane-scroll button')))
    await ctx.click('[aria-label="Tags do Artifact"]')
    await ctx.waitFor(() => document.activeElement.getAttribute('aria-label') === 'Buscar ou criar tag')
    for (const theme of ['dark', 'light']) {
      await ctx.evaluate(theme => { document.body.dataset.theme = theme }, theme)
      for (const size of [[1440, 900], [1000, 760]]) { await ctx.viewport(...size); await ctx.overflow(); await ctx.capture(`inspector-${theme}-${size[0]}`) }
    }
    await ctx.input('[aria-label="Buscar ou criar tag"]', 'Contexto rápido')
    await ctx.waitFor(() => document.querySelector('[aria-label="Buscar ou criar tag"]').value === 'Contexto rápido')
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    ctx.window.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' })
    ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await ctx.waitFor(() => !document.querySelector('.continuum-tag-popover'))
    ctx.check('First tag created and assigned by name and native Enter', service.tags().length === 1 && service.tags()[0].slug === 'contexto-rapido' && service.get(artifact.artifactId).revision === 2 && service.tags()[0].count === 1)
    await ctx.click('.continuum-header button')
    await ctx.waitFor(() => !!document.querySelector('[aria-label="Copiar contexto Contexto rápido"]'))
    await ctx.click('[aria-label="Copiar contexto Contexto rápido"]')
    await ctx.waitFor(() => document.querySelector('.continuum-tag-manager [role=status]')?.textContent.includes('Copiado'))
    ctx.check('Quick copy reads current raw Markdown', clipboard.readText().includes(service.get(artifact.artifactId).rawMarkdown))
    service.update(artifact.artifactId, 2, service.get(artifact.artifactId).rawMarkdown + '\nRevisão atualizada\n')
    await ctx.click('[aria-label="Copiar contexto Contexto rápido"]')
    await ctx.waitFor(() => document.querySelector('.continuum-tag-manager [role=status]')?.textContent.includes('Copiado'))
    ctx.check('Next one-click copy includes updated revision', clipboard.readText().includes('Revisão atualizada') && clipboard.readText().includes('revisão 3'))
  } catch (error) { console.log(JSON.stringify({ tags: service.tags(), alert: await ctx.evaluate(() => document.querySelector('[role=alert]')?.textContent), picker: await ctx.evaluate(() => document.querySelector('.continuum-tag-popover')?.textContent) })); throw error } finally { clipboard.writeText(prior); runtime.close() }
}
