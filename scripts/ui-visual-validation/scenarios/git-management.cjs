const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildSync } = require('esbuild')
exports.run = async (ctx) => {
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
    await ctx.waitFor(selector => { const bounds = document.querySelector(selector)?.getBoundingClientRect(); return bounds && bounds.width > 0 && bounds.height > 0 && !document.querySelector(selector).disabled }, selector)
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
  git('branch', 'feature/contextual-review-with-a-very-long-name-and-shared-tip-for-signal-validation', 'feature/inspector')
  }
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
  await waitForGit(() => document.querySelectorAll('.gm-commit').length > 0 && document.querySelector('.gm-history').getAttribute('aria-busy') === 'false')
  await ctx.evaluate(() => {
    document.querySelector('.global-sidebar-logo-img').src = 'logo.svg'
  })
  await require('./git-atlas-pure-signal-checks.cjs').run(ctx, { root, git, before, head, backend, waitForGit })
}
