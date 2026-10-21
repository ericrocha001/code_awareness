const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildSync } = require('esbuild')
exports.run = async (ctx) => {
  const build = ctx.atlasObservationProof?.build ?? buildSync
  const waitForGit = async (condition) => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (await ctx.evaluate(condition)) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await ctx.capture('git-operation-timeout')
    throw new Error(
      'Git operation did not settle within 30 seconds: ' +
        (await ctx.evaluate(
          () => document.querySelector('.gm-actions')?.textContent
        ))
    )
  }
  const nativeClick = ctx.click
  ctx.click = async (selector) => {
    await ctx.evaluate(
      (selector) =>
        document
          .querySelector(selector)
          ?.scrollIntoView({ block: 'center', inline: 'nearest' }),
      selector
    )
    await nativeClick(selector)
  }
  ctx.input = async (selector, text) => {
    await waitForGit(() => document.querySelector('.gm-inspector')?.getAttribute('aria-busy') !== 'true')
    await ctx.waitFor(selector => { const element = document.querySelector(selector); const bounds = element?.getBoundingClientRect(); return element && !element.disabled && bounds && bounds.width > 0 && bounds.height > 0 }, selector)
    await ctx.click(selector)
    await ctx.waitFor(selector => document.activeElement === document.querySelector(selector), selector)
    ctx.window.webContents.insertText(text)
    await ctx.waitFor((selector, text) => document.querySelector(selector)?.value === text, selector, text)
  }
  const root = path.join(ctx.temporary, 'repository-a')
  fs.mkdirSync(root)
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8'
    }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Proof Author')
  git('config', 'user.email', 'proof@example.com')
  git('config', 'code-awareness.primaryBranch', 'main')
  if (ctx.mockup) require('./git-atlas-mockup-history.cjs').create(root)
  else {
  for (let index = 0; index < 8; index++) {
    fs.writeFileSync(path.join(root, 'file.txt'), `version ${index}\n`)
    git('add', 'file.txt')
    git('commit', '-m', `Build useful history ${index}`)
  }
  git('switch', '-c', 'feature/inspector')
  fs.writeFileSync(path.join(root, 'topic.txt'), 'topic\n')
  git('add', 'topic.txt')
  git('commit', '-m', 'Add contextual inspector')
  git('switch', 'main')
  fs.writeFileSync(path.join(root, 'main.txt'), 'main\n')
  git('add', 'main.txt')
  git('commit', '-m', 'Preserve independent main history')
  git(
    'merge',
    '--no-ff',
    'feature/inspector',
    '-m',
    'Integrate contextual inspector'
  )
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD~1'))
  }
  if (ctx.gridProof) require('./git-atlas-grid.cjs').seed(root)
  if (ctx.atlasObservationProof) ctx.atlasObservationProof.seed(root)
  fs.writeFileSync(path.join(root, 'file.txt'), 'prepared version\n')
  git('add', 'file.txt')
  fs.writeFileSync(path.join(root, 'file.txt'), 'later worktree version\n')
  fs.writeFileSync(path.join(root, 'new.txt'), 'new file\n')
  const before = git('status', '--porcelain'),
    head = git('rev-parse', 'HEAD')
  await build({
    entryPoints: [path.join(__dirname, 'git-management-backend.ts')],
    bundle: true,
    outfile: path.join(ctx.temporary, 'backend.cjs'),
    platform: 'node',
    banner: { js: `require = require('node:module').createRequire(${JSON.stringify(path.join(ctx.projectRoot, 'package.json'))})` },
    external: ['electron', 'better-sqlite3', 'sharp']
  })
  const secondRoot = path.join(ctx.temporary, 'repository-b')
  fs.mkdirSync(secondRoot)
  execFileSync('git', ['init', '-b', 'main'], {
    cwd: secondRoot,
    windowsHide: true
  })
  const nonGitRoot = path.join(ctx.temporary, 'non-git')
  fs.mkdirSync(nonGitRoot)
  const backend = await require(path.join(ctx.temporary, 'backend.cjs')).setup(
    root,
    secondRoot,
    nonGitRoot,
    ctx.projectRoot,
    ctx.atlasObservationProof ? path.join(ctx.temporary, 'atlas-cache') : undefined
  )
  if (ctx.atlasObservationProof) ctx.atlasObservationProof.prepare(backend)
  await build({
    entryPoints: [path.join(ctx.projectRoot, 'src/main/preload.ts')],
    bundle: true,
    outfile: path.join(ctx.temporary, 'preload.cjs'),
    platform: 'node',
    external: ['electron']
  })
  ctx.window.webContents.session.setPreloads([
    path.join(ctx.temporary, 'preload.cjs')
  ])
  await build({
    entryPoints: [path.join(__dirname, 'git-management-fixture.tsx')],
    bundle: true,
    outfile: path.join(ctx.temporary, 'fixture.js'),
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }
  })
  const page = path.join(ctx.temporary, 'index.html')
  fs.copyFileSync(
    path.join(ctx.projectRoot, 'src/renderer/public/logo.svg'),
    path.join(ctx.temporary, 'logo.svg')
  )
  const product = fs.readFileSync(
    path.join(ctx.projectRoot, 'src/renderer/index.html'),
    'utf8'
  )
  const csp =
    product.match(
      /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>/i
    )?.[0] || ''
  fs.writeFileSync(
    page,
    `<!doctype html><html><head>${csp}<meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`
  )
  await ctx.load(page)
  await waitForGit(() => document.querySelectorAll('.gm-commit').length > 0 && document.querySelector('.gm-history').getAttribute('aria-busy') === 'false')
  if (ctx.atlasObservationProof) return ctx.atlasObservationProof.verify(ctx, { root, git, backend })
  await ctx.evaluate(() => {
    document.querySelector('.global-sidebar-logo-img').src = 'logo.svg'
  })
  if (ctx.gridProof) { await require('./git-atlas-grid.cjs').verify(ctx); return }
  if (ctx.mockup) {
    await ctx.evaluate(() => {
      globalThis.__harnessCaptureBecameVisible = false
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) globalThis.__harnessCaptureBecameVisible = true
      })
    })
    await ctx.viewport(1672, 941)
    await ctx.waitFor(() => !!document.querySelector('.gm-commit.is-checkout'))
    ctx.check('Single event timeline with checkout context', await ctx.evaluate(() => !!document.querySelector('.gm-context-strip') && document.querySelectorAll('.gm-atlas-date-axis').length === 1 && !document.querySelector('[aria-label="Janela temporal"]')))
    await ctx.click('[aria-label="Fechar detalhes"]')
    await ctx.waitFor(() => !document.querySelector('.gm-inspector').classList.contains('is-open'))
    ctx.window.webContents.sendInputEvent({ type: 'mouseMove', x: 10, y: 10 })
    await ctx.overflow()
    await ctx.capture('mockup-checkout-dark')
    await ctx.click('.gm-commit.is-checkout')
    await ctx.waitFor(sha => document.querySelector('.gm-inspector [aria-label="Copiar SHA"]')?.getAttribute('title') === sha, head)
    ctx.window.webContents.sendInputEvent({ type: 'mouseMove', x: 10, y: 10 })
    await ctx.capture('mockup-wide-dark')
    ctx.check('Selected inspector identifies the fixture checkout HEAD', await ctx.evaluate(sha => document.querySelector('.gm-inspector [aria-label="Copiar SHA"]')?.getAttribute('title') === sha && !!document.querySelector('.gm-inspector.is-open .gm-commit-author'), head))
    await ctx.viewport(800, 760)
    await ctx.overflow()
    await ctx.capture('mockup-drawer-dark')
    ctx.check('Captures do not activate visibility-driven product work', await ctx.evaluate(() => !globalThis.__harnessCaptureBecameVisible))
    ctx.check('Visual reads preserve fixture HEAD and index', git('status', '--porcelain') === before && git('rev-parse', 'HEAD') === head)
    return
  }
  await ctx.viewport(1440, 900)
  await ctx.click('.gm-commit.is-merge')
  await ctx.waitFor(() =>
    document.querySelector('.gm-inspector').textContent.includes('Merge')
  )
  ctx.check(
    'Merge topology from real Git through IPC',
    await ctx.evaluate(() =>
      document.querySelector('.gm-inspector').textContent.includes('Merge')
    )
  )
  await waitForGit(() => !!document.querySelector('.gm-commit-author') && !!document.querySelector('.gm-files button'))
  await ctx.click('.gm-files button')
  await ctx.waitFor(() => !!document.querySelector('.gm-patch pre'))
  ctx.check(
    'Merge patch on demand',
    await ctx.evaluate(() =>
      document.querySelector('.gm-patch pre').textContent.includes('+topic')
    )
  )
  await ctx.overflow()
  await ctx.capture('wide-dark-selected')
  ctx.check('Origin remains unknown despite current worktree containment', await ctx.evaluate(() => document.querySelector('.gm-inspector').textContent.includes('Origem: Não registrada') && !document.querySelector('.gm-inspector').textContent.includes('Worktrees atuais')))
  for (const label of ['7d', '15d', '30d', '60d', '90d', 'Tudo']) {
    await ctx.click(`.gm-segmented[aria-label="Janela temporal"] button:nth-child(${['7d','15d','30d','60d','90d','Tudo'].indexOf(label)+1})`)
    await ctx.evaluate(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
    {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline && !await ctx.evaluate(count => document.querySelectorAll('.gm-atlas-date').length === count, label === 'Tudo' ? 1 : parseInt(label))) await new Promise(resolve => setTimeout(resolve, 50))
    }
    await waitForGit(() => document.querySelector('.gm-history').getAttribute('aria-busy') === 'false' && document.querySelectorAll('.gm-commit').length > 0)
    if (label !== 'Tudo') ctx.check(`${label}: every daily period is represented`, await ctx.evaluate(count => document.querySelectorAll('.gm-atlas-date').length === count, parseInt(label)))
    if (label === '7d' || label === '15d') {
      await ctx.viewport(2560, 1440)
      await waitForGit(() => {
        const map = document.querySelector('.gm-atlas-scroll'), surface = document.querySelector('.gm-atlas-surface')
        return map && Math.abs(parseFloat(surface.style.width) - map.clientWidth) < 1
      })
      ctx.check(`${label}: daily grid fills the available width without hidden trajectories`, await ctx.evaluate(() => !document.querySelector('.gm-secondary-toggle') && !document.querySelector('.gm-inactive') && document.querySelector('.gm-atlas-scroll').scrollLeft === 0))
      await ctx.capture(`wide-dark-${label}-filled`)
      await ctx.viewport(1440, 900)
    }
  }
  await ctx.click('.gm-segmented[aria-label="Modo do Atlas"] button:nth-child(2)')
  await ctx.waitFor(() => document.querySelector('.gm-segmented[aria-label="Modo do Atlas"] button:nth-child(2)').getAttribute('aria-pressed') === 'true')
  await waitForGit(() => [...document.querySelectorAll('[aria-label="Referência em foco"] option')].some(option => option.value === 'refs/heads/feature/inspector'))
  await ctx.evaluate(() => { const select = document.querySelector('[aria-label="Referência em foco"]'); select.value = 'refs/heads/feature/inspector'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await waitForGit(() => document.querySelector('.gm-comparison')?.textContent.includes('exclusivos da base'))
  await ctx.capture('wide-dark-focus')
  await ctx.click('.gm-segmented[aria-label="Modo do Atlas"] button:nth-child(3)')
  await waitForGit(() => document.querySelector('.gm-comparison')?.textContent.includes('0 exclusivos do alvo'))
  ctx.check('Comparison uses real merge-base and reachable sets', await ctx.evaluate(() => document.querySelector('.gm-comparison').textContent.includes('0 exclusivos do alvo')))
  await ctx.capture('wide-dark-comparison')
  await ctx.click('.gm-segmented[aria-label="Modo do Atlas"] button:first-child')
  await ctx.evaluate(() => {
    document.body.dataset.theme = 'light'
  })
  await ctx.capture('wide-light-selected')
  await ctx.viewport(800, 760)
  await ctx.overflow()
  await ctx.capture('medium-light-drawer')
  await ctx.evaluate(() => document.querySelector('.gm-commit').focus())
  ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESCAPE' })
  ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESCAPE' })
  await ctx.waitFor(
    () => !document.querySelector('.gm-inspector').classList.contains('is-open')
  )
  ctx.check(
    'Escape closes drawer and restores keyboard focus',
    await ctx.evaluate(() =>
      document.activeElement.classList.contains('gm-commit')
    )
  )
  await ctx.evaluate(() => {
    document.body.dataset.theme = 'dark'
  })
  await ctx.capture('medium-dark-history')
  await ctx.viewport(1440, 900)
  await ctx.click('.gm-toolbar-actions button:nth-of-type(2)')
  await ctx.waitFor(
    () => document.querySelectorAll('.gm-change-group').length === 4
  )
  ctx.check(
    'Staged and unstaged are separate versions',
    await ctx.evaluate(
      () =>
        Array.from(document.querySelectorAll('.gm-change-group')).filter(
          (group) => group.textContent.includes('file.txt')
        ).length === 2
    )
  )
  await ctx.click('.gm-change-group:nth-of-type(2) .gm-files button')
  await ctx.waitFor(() =>
    document
      .querySelector('.gm-patch pre')
      ?.textContent.includes('+prepared version')
  )
  await ctx.capture('wide-dark-index-patch')
  await ctx.click('[aria-label="Recolher sidebar"]')
  await ctx.waitFor(
    () => parseFloat(getComputedStyle(document.querySelector('.global-sidebar')).width) === 64
  )
  await ctx.waitFor(() => parseFloat(getComputedStyle(document.querySelector('.app-main')).marginLeft) === 64)
  await ctx.capture('wide-dark-sidebar-closed')
  await ctx.click('[aria-label="Expandir sidebar"]')
  await ctx.waitFor(
    () => parseFloat(getComputedStyle(document.querySelector('.global-sidebar')).width) === 224
  )
  await ctx.waitFor(() => parseFloat(getComputedStyle(document.querySelector('.app-main')).marginLeft) === 224)
  ctx.check(
    'Reading leaves index, worktree and HEAD unchanged',
    git('status', '--porcelain') === before && git('rev-parse', 'HEAD') === head
  )
  fs.writeFileSync(
    path.join(root, 'new.txt'),
    'external update after inspection\n'
  )
  await ctx.click('.gm-path-selection label:nth-child(2) input')
  await ctx.waitFor(() => document.querySelector('.gm-path-selection label:nth-child(2) input').checked && !document.querySelector('.gm-action-row button:first-child').disabled)
  await ctx.click('.gm-action-row button:first-child')
  await waitForGit(() =>
    document
      .querySelector('.gm-actions [role="status"]')
      ?.textContent.includes('estado Git mudou')
  )
  await waitForGit(
    () =>
      document.querySelector('.gm-path-selection input')?.disabled === false &&
      document.querySelector('.gm-history').getAttribute('aria-busy') ===
        'false'
  )
  ctx.check(
    'External edit rejects stale stage without altering index',
    git('diff', '--cached', '--name-only') === 'file.txt'
  )
  await ctx.capture('wide-dark-stale-error')
  await ctx.click('.gm-path-selection label:nth-child(2) input')
  await ctx.waitFor(
    () =>
      document.querySelector('.gm-path-selection label:nth-child(2) input')
        .checked &&
      !document.querySelector('.gm-action-row button:first-child').disabled
  )
  await ctx.click('.gm-action-row button:first-child')
  await waitForGit(() =>
    document
      .querySelector('.gm-actions [role="status"]')
      ?.textContent.includes('Operação Git confirmada')
  )
  await waitForGit(
    () =>
      document.querySelector('.gm-history').getAttribute('aria-busy') ===
      'false'
  )
  try {
    await waitForGit(() =>
      document
        .querySelector('.gm-commit-review h3')
        ?.textContent.includes('2 arquivos')
    )
  } catch (error) {
    await ctx.capture('stage-diagnostic')
    error.message +=
      '\n' +
      JSON.stringify(
        await ctx.evaluate(() => ({
          text: document.querySelector('.gm-actions').textContent,
          checked: [
            ...document.querySelectorAll('.gm-path-selection input')
          ].map((input) => ({
            checked: input.checked,
            disabled: input.disabled
          })),
          busy: document.querySelector('.gm-history').getAttribute('aria-busy')
        }))
      )
    throw error
  }
  await ctx.input(
    '[aria-label="Mensagem do commit"]',
    'Record exactly the inspected index'
  )
  await ctx.click('.gm-commit-review button')
  await ctx.click('.gm-confirm button:first-child')
  await waitForGit(() =>
    document
      .querySelector('.gm-actions [role="status"]')
      ?.textContent.includes('Commit registrado')
  )
  await waitForGit(
    () =>
      document.querySelector('.gm-history').getAttribute('aria-busy') ===
      'false'
  )
  await ctx.waitFor(() => document.querySelectorAll('.gm-commit').length === 12)
  ctx.check(
    'Real selective commit and HEAD reflected',
    git('show', 'HEAD:file.txt') === 'prepared version' &&
      git('show', 'HEAD:new.txt') === 'external update after inspection' &&
      git('diff', '--name-only') === 'file.txt'
  )
  await ctx.capture('wide-dark-committed')
  await ctx.click('.gm-actions details summary')
  await ctx.input('[aria-label="Nova branch"]', 'atlas-created-through-ui')
  await ctx.click('.gm-actions details > button')
  await ctx.click('.gm-confirm button:first-child')
  await waitForGit(() => document.querySelector('.gm-history').getAttribute('aria-busy') === 'false' && [...document.querySelectorAll('[aria-label="Trocar branch"] option')].some(option => option.value === 'atlas-created-through-ui'))
  ctx.check('Branch creation stays on the canonical mutation path and preserves checkout', git('rev-parse', 'atlas-created-through-ui') === git('rev-parse', 'HEAD') && git('branch', '--show-current') === 'main')
  await ctx.click('.gm-actions details summary')
  const exec = require('node:child_process').spawnSync
  const tree = git('rev-parse', 'HEAD^{tree}')
  const oldDate = new Date(Date.now() - 110 * 86400000).toISOString()
  const oldRoot = exec('git', ['commit-tree', tree, '-m', 'Archived root'], { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate } }).stdout.trim()
  git('update-ref', 'refs/heads/quiet', oldRoot)
  const baseDate = new Date(Date.now() - 25 * 86400000).toISOString()
  const denseBase = exec('git', ['commit-tree', tree, '-p', oldRoot, '-m', 'Shared parallel base'], { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_AUTHOR_DATE: baseDate, GIT_COMMITTER_DATE: baseDate } }).stdout.trim()
  git('update-ref', 'refs/heads/dense-base', denseBase)
  const records = []
  for (let index = 0; index < 105; index++) {
    const message = `Parallel work ${index}\n`
    const date = Math.floor(Date.now() / 1000) - (2 + index % 20) * 86400
    records.push(`commit refs/heads/parallel-${String(index).padStart(3,'0')}\ncommitter Proof Author <proof@example.com> ${date} +0000\ndata ${Buffer.byteLength(message)}\n${message}from ${denseBase}\n\n`)
  }
  const imported = exec('git', ['fast-import', '--quiet'], { cwd: root, input: records.join(''), encoding: 'utf8', windowsHide: true })
  if (imported.status !== 0) throw new Error(imported.stderr)
  const detachedDate = new Date(Date.now() - 3 * 86400000).toISOString()
  const detachedSha = exec('git', ['commit-tree', tree, '-p', denseBase, '-m', 'Detached work'], { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_AUTHOR_DATE: detachedDate, GIT_COMMITTER_DATE: detachedDate } }).stdout.trim()
  git('worktree', 'add', '--detach', path.join(ctx.temporary, 'detached-work'), detachedSha)
  git('tag', 'atlas-proof')
  await ctx.click('.gm-segmented[aria-label="Janela temporal"] button:nth-child(5)')
  await waitForGit(() => document.querySelector('.gm-history').getAttribute('aria-busy') === 'false' && !!document.querySelector('.gm-load-more'))
  await ctx.click('.gm-load-more')
  await waitForGit(() => document.querySelector('.gm-history').getAttribute('aria-busy') === 'false' && !document.querySelector('.gm-load-more'))
  ctx.check('All active trajectories are available without secondary or inactive controls', await ctx.evaluate(() => !document.querySelector('.gm-secondary-toggle') && !document.querySelector('.gm-inactive')))
  await ctx.waitFor(() => document.querySelectorAll('.gm-atlas-lane-label').length > 100)
  const summary = await ctx.evaluate(() => ({ nodes: document.querySelectorAll('.gm-commit').length, labels: document.querySelectorAll('.gm-atlas-lane-label').length, width: document.querySelector('.gm-atlas-scroll').scrollWidth }))
  ctx.check('Dense timeline virtualizes nodes rather than mounting every commit', summary.nodes < 118 && summary.labels > 100)
  await ctx.capture('wide-dark-dense-expanded')
  await ctx.evaluate(() => { const map = document.querySelector('.gm-atlas-scroll'); map.scrollTop = map.scrollHeight; map.scrollLeft = map.scrollWidth; map.dispatchEvent(new Event('scroll')) })
  await ctx.capture('wide-dark-dense-scrolled')
  await ctx.evaluate(() => { const map = document.querySelector('.gm-atlas-scroll'); map.scrollTop = 0; map.scrollLeft = 0; map.dispatchEvent(new Event('scroll')) })
  await ctx.click('.gm-sha-lookup summary')
  await ctx.input('[aria-label="SHA completo"]', detachedSha)
  await ctx.click('.gm-sha-lookup button')
  await waitForGit(() => document.querySelector('.gm-inspector h2')?.textContent === 'Detached work')
  ctx.check('Detached work is inspectable with unknown origin', await ctx.evaluate(() => document.querySelector('.gm-inspector').textContent.includes('Origem: Não registrada')))
  await ctx.capture('wide-dark-detached')
  await ctx.evaluate(() => document.querySelector('[aria-label="SHA completo"]').select())
  ctx.window.webContents.insertText(oldRoot)
  await ctx.waitFor(sha => document.querySelector('[aria-label="SHA completo"]').value === sha, oldRoot)
  await ctx.click('.gm-sha-lookup button')
  await waitForGit(() => document.querySelector('.gm-inspector h2')?.textContent === 'Archived root')
  ctx.check('SHA outside the temporal window opens the canonical inspector', await ctx.evaluate(() => document.querySelector('.gm-inspector').textContent.includes('Commit raiz')))
  await ctx.capture('wide-dark-outside-window')
  await ctx.click('.gm-segmented[aria-label="Janela temporal"] button:nth-child(3)')
  await waitForGit(() => document.querySelector('.gm-history').getAttribute('aria-busy') === 'false' && !!document.querySelector('.gm-load-more'))
  ctx.check('Changing windows keeps recent visible commits in view', await ctx.evaluate(() => document.querySelectorAll('.gm-commit').length > 0))
  git('branch', 'snapshot-changed')
  await ctx.click('.gm-load-more')
  await waitForGit(() => document.querySelector('.gm-history').getAttribute('aria-busy') === 'false' && [...document.querySelectorAll('[aria-label="Referência em foco"] option')].some(option => option.value === 'refs/heads/snapshot-changed'))
  ctx.check('Actual ref changes restart temporal pagination on the current revision', await ctx.evaluate(() => !document.querySelector('.gm-error')))
  await ctx.capture('wide-dark-stale-history')
  await ctx.click('[data-proof-project="b"]')
  await ctx.waitFor(() =>
    document
      .querySelector('.gm-header')
      ?.textContent.includes('Second Repository')
  )
  await waitForGit(() =>
    document
      .querySelector('.gm-placeholder')
      ?.textContent.includes('Nenhum commit')
  )
  ctx.check(
    'Project B receives no history or selection from A',
    await ctx.evaluate(
      () =>
        document.querySelectorAll('.gm-commit').length === 0 &&
        !document
          .querySelector('.gm-inspector')
          .textContent.includes('prepared version')
    )
  )
  await ctx.capture('wide-dark-empty')
  await ctx.click('[data-proof-project="none"]')
  await ctx.waitFor(() => !!document.querySelector('.gm-empty'))
  await ctx.capture('wide-dark-no-repository')
  await ctx.click('[data-proof-project="non-git"]')
  await waitForGit(() =>
    document
      .querySelector('[role="alert"]')
      ?.textContent.includes('não é um repositório Git')
  )
  await ctx.capture('wide-dark-non-git')
  ctx.check(
    'Non Git failure stops loading',
    await ctx.evaluate(
      () =>
        !document
          .querySelector('.gm-inspector')
          .textContent.includes('Carregando') &&
        document.querySelector('.gm-history').getAttribute('aria-busy') ===
          'false'
    )
  )
  ctx.check(
    'Document has no competing vertical scroll',
    await ctx.evaluate(
      () => document.documentElement.scrollHeight <= innerHeight
    )
  )
  const identity = backend.runtime.getIdentityPayload()
  fs.writeFileSync(
    path.join(ctx.evidenceDir, 'runtime-identity.json'),
    JSON.stringify(identity, null, 2)
  )
  ctx.check(
    'Fresh Electron source and expected worktree',
    identity.freshness.state === 'MATCH' &&
      identity.sourceOrigin.worktree?.rootPath.replace(/\\/g, '/').toLowerCase() === ctx.projectRoot.replace(/\\/g, '/').toLowerCase()
  )
}
