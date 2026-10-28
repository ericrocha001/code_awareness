exports.run = async ctx => {
  const runtime = await require('./continuum-runtime.cjs').setup(ctx)
  const service = runtime.session.getActiveService()
  const definitions = [
    ['academy', 'Academy'], ['arquitetura', 'Arquitetura'], ['channel', 'Channel'], ['code-map', 'Code Map'],
    ['continuum', 'Continuum'], ['git-management', 'Git Management'], ['misc', 'Misc'], ['runtime-preview', 'Runtime Preview'], ['vazia', 'Vazia']
  ]
  for (const [slug, name] of definitions) service.mutateTags({ repositoryId: 'acceptance-A', intent: 'create', tag: { slug, name, description: `Decisões e planos relacionados a ${name}.` } })
  for (const [slug, name] of definitions.slice(0, -1)) {
    for (let i = 0; i < 4; i++) service.publishHuman(`---\nname: "${name} — ${['Plano aprovado de evolução e integração dos contratos existentes', 'Visual Foundations', 'Implementation Handoff', 'Decisões de interface'][i]}"\ndescription: Fixture isolada para aceitação do gerenciador\nkind: ${i === 0 ? 'EXECUTABLE_PLAN' : 'DOCUMENT'}\ntags: [${slug}]\n---\n# Evidência ${i}\n\nDescrição de contexto para o catálogo.\n`, true)
  }
  const press = keyCode => {
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  }
  const input = async (selector, text) => {
    await ctx.click(selector)
    await ctx.evaluate(selector => document.querySelector(selector).select(), selector)
    if (text) await ctx.window.webContents.insertText(text)
    else press('Backspace')
    await ctx.waitFor((selector, text) => document.querySelector(selector).value === text, selector, text)
  }
  const open = async () => {
    await ctx.click('.continuum-header .continuum-publish')
    await ctx.waitFor(() => !!document.querySelector('.continuum-tag-manager[open]'))
  }
  const button = async text => ctx.evaluate(text => [...document.querySelectorAll('.continuum-tag-manager button')].find(button => button.textContent.trim() === text).click(), text)
  try {
    await runtime.open(); await ctx.viewport(1536, 1024)
    await ctx.waitFor(() => document.querySelectorAll('.continuum-item').length > 0)
    await open()
    await ctx.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Buscar tags')
    await ctx.evaluate(() => document.querySelector('[aria-label="Fechar tags"]').focus())
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] })
    ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] })
    await ctx.waitFor(() => !!document.activeElement.closest('.continuum-tag-manager') && document.activeElement.getAttribute('aria-label') !== 'Fechar tags')
    press('Tab')
    await ctx.waitFor(() => document.activeElement.getAttribute('aria-label') === 'Fechar tags')
    ctx.check('Native Tab order wraps inside the modal', true)
    await input('[aria-label="Buscar tags"]', 'continuum')
    await ctx.waitFor(() => document.querySelectorAll('.tag-manager-row').length === 1)
    await ctx.click('.tag-manager-row')
    await input('[aria-label="Buscar tags"]', '')
    await ctx.waitFor(() => document.querySelectorAll('.tag-manager-preview li').length === 3 && document.querySelector('.tag-manager-metrics').textContent.includes('≈'))
    ctx.check('Selection shows three real preview members without navigating or building', await ctx.evaluate(() => document.querySelector('.tag-manager-identity h4').textContent === 'Continuum' && !document.querySelector('.continuum-builder') && document.querySelectorAll('.tag-manager-row').length === 9))
    ctx.check('No fabricated dates, colors, type counts or export controls', await ctx.evaluate(() => !document.querySelector('.tag-manager-summary input, .tag-manager-summary textarea, .continuum-tag-manager input[type=color]') && !/Tipos de Artifact|Criada em|Copiar contexto/.test(document.querySelector('.continuum-tag-manager').textContent)))
    for (const theme of ['dark', 'light']) {
      await ctx.evaluate(theme => { document.body.dataset.theme = theme }, theme)
      await ctx.capture(`manager-${theme}`)
    }
    await ctx.viewport(720, 860)
    await ctx.overflow()
    ctx.check('Narrow layout stacks catalog and detail without horizontal pane overflow', await ctx.evaluate(() => {
      const catalog = document.querySelector('.tag-manager-catalog'), detail = document.querySelector('.tag-manager-detail'), modal = document.querySelector('.continuum-tag-manager')
      return detail.getBoundingClientRect().top >= catalog.getBoundingClientRect().bottom && [catalog, detail, modal].every(item => item.scrollWidth <= item.clientWidth + 1)
    }))
    await ctx.capture('manager-narrow-light')
    await ctx.viewport(1536, 1024)
    await ctx.evaluate(() => { document.body.dataset.theme = 'dark' })
    await button('Editar')
    await ctx.waitFor(() => document.activeElement?.closest('label')?.textContent.includes('Nome da tag'))
    await input('.tag-manager-form textarea', 'Inclua decisões aprovadas; exclua propostas em discussão.')
    press('Escape')
    await ctx.waitFor(() => document.querySelector('.continuum-tag-manager [role=alert]')?.textContent.includes('não salvas'))
    ctx.check('Escape preserves the unsaved form and native dialog', await ctx.evaluate(() => document.querySelector('.continuum-tag-manager').open && document.querySelector('.tag-manager-form textarea').value.startsWith('Inclua decisões')))
    await button('Salvar tag')
    await ctx.waitFor(() => !document.querySelector('.tag-manager-form') && document.querySelector('.tag-manager-description')?.textContent.startsWith('Inclua decisões'))
    ctx.check('Real tag edit keeps stable slug and membership', service.tags().find(tag => tag.slug === 'continuum').count === 4 && service.tags().find(tag => tag.slug === 'continuum').description.startsWith('Inclua decisões'))
    await ctx.click('.tag-manager-options summary')
    ctx.check('Used tag cannot be deleted', await ctx.evaluate(() => document.querySelector('.tag-manager-options .tag-manager-danger').disabled))
    await ctx.click('.tag-manager-options summary')
    await ctx.click('[aria-label="Fechar tags"]')
    await ctx.waitFor(() => !document.querySelector('.continuum-tag-manager'))
    ctx.check('Close restores focus to the trigger', await ctx.evaluate(() => document.activeElement?.textContent.includes('Gerenciador de Tags')))
    await open(); press('Escape')
    await ctx.waitFor(() => !document.querySelector('.continuum-tag-manager'))
    ctx.check('Native Escape closes a clean dialog and restores focus', await ctx.evaluate(() => document.activeElement?.textContent.includes('Gerenciador de Tags')))
    await open()
    await input('[aria-label="Buscar tags"]', 'continuum'); await ctx.click('.tag-manager-row')
    await ctx.waitFor(() => document.querySelector('.tag-manager-identity h4')?.textContent === 'Continuum')
    await button('Montar no Context Builder')
    await ctx.waitFor(() => !!document.querySelector('.continuum-builder') && document.querySelectorAll('.continuum-builder-members li').length === 4)
    ctx.check('One existing Builder opens with the selected canonical tag and its members', await ctx.evaluate(() => document.querySelectorAll('.continuum-builder').length === 1 && !document.querySelector('.continuum-tag-manager') && document.querySelector('.continuum-builder-components').textContent.includes('Tag: continuum')))
    await ctx.capture('builder-from-tag-dark')
    await ctx.click('[aria-label="Fechar construtor"]')
    await open(); await input('[aria-label="Buscar tags"]', 'continuum'); await ctx.click('.tag-manager-row')
    await button('Ver todos (4)')
    await ctx.waitFor(() => !document.querySelector('.continuum-tag-manager') && document.querySelectorAll('.continuum-item').length === 4)
    ctx.check('Ver todos reuses Timeline tag filtering', await ctx.evaluate(() => [...document.querySelectorAll('.continuum-item')].every(item => item.textContent.includes('Continuum'))))
    await ctx.click('.continuum-item'); await ctx.click('[aria-label="Tags do Artifact"]')
    await ctx.waitFor(() => !!document.querySelector('.continuum-tag-popover'))
    ctx.check('ArtifactTagEditor remains contextual and carries the current membership criterion', await ctx.evaluate(() => [...document.querySelectorAll('.continuum-tag-results button')].some(button => button.title.startsWith('Inclua decisões'))))
    press('Escape')
    await ctx.waitFor(() => !document.querySelector('.continuum-tag-popover'))
  } finally { runtime.close() }
}
