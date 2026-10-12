const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildSync } = require('esbuild')
exports.run = async (ctx) => {
  const waitForGit = async (condition) => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (await ctx.evaluate(condition)) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await ctx.capture('git-operation-timeout')
    throw new Error(
      'Git operation did not settle within 15 seconds: ' +
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
  fs.writeFileSync(path.join(root, 'file.txt'), 'prepared version\n')
  git('add', 'file.txt')
  fs.writeFileSync(path.join(root, 'file.txt'), 'later worktree version\n')
  fs.writeFileSync(path.join(root, 'new.txt'), 'new file\n')
  const before = git('status', '--porcelain'),
    head = git('rev-parse', 'HEAD')
  buildSync({
    entryPoints: [path.join(__dirname, 'git-management-backend.ts')],
    bundle: true,
    outfile: path.join(ctx.temporary, 'backend.cjs'),
    platform: 'node',
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
    ctx.projectRoot
  )
  buildSync({
    entryPoints: [path.join(ctx.projectRoot, 'src/main/preload.ts')],
    bundle: true,
    outfile: path.join(ctx.temporary, 'preload.cjs'),
    platform: 'node',
    external: ['electron']
  })
  ctx.window.webContents.session.setPreloads([
    path.join(ctx.temporary, 'preload.cjs')
  ])
  buildSync({
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
  await ctx.waitFor(() => document.querySelectorAll('.gm-commit').length === 11)
  await ctx.evaluate(() => {
    document.querySelector('.global-sidebar-logo-img').src = 'logo.svg'
  })
  await ctx.viewport(1440, 900)
  await ctx.click('.gm-commit')
  await ctx.waitFor(() =>
    document.querySelector('.gm-inspector').textContent.includes('Merge')
  )
  ctx.check(
    'Merge topology from real Git through IPC',
    await ctx.evaluate(() =>
      document.querySelector('.gm-inspector').textContent.includes('Merge')
    )
  )
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
  await ctx.click('.gm-toolbar button:nth-of-type(2)')
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
    await ctx.waitFor(() =>
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
  await ctx.click('[data-proof-project="b"]')
  await ctx.waitFor(() =>
    document
      .querySelector('.gm-header')
      ?.textContent.includes('Second Repository')
  )
  await ctx.waitFor(() =>
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
  await ctx.waitFor(() =>
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
      identity.sourceOrigin.worktree?.branch === 'codex/git-management-mvp'
  )
}
