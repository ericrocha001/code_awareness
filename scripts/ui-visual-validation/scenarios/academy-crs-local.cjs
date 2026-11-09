const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')

exports.run = async ctx => {
  const source = () => {
    const git = args => execFileSync('git', args, { cwd: ctx.projectRoot, windowsHide: true })
    const digest = data => createHash('sha256').update(data).digest('hex')
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean)
    const patch = git(['diff', '--binary', 'HEAD'])
    if (!fs.existsSync(path.join(ctx.evidenceDir, 'source.patch'))) fs.writeFileSync(path.join(ctx.evidenceDir, 'source.patch'), patch, { flag: 'wx' })
    return { checkout: ctx.projectRoot, head: git(['rev-parse', 'HEAD']).toString().trim(), branch: git(['branch', '--show-current']).toString().trim(),
      trackedPatchHash: digest(patch), untracked: untracked.map(file => ({ path: file, hash: digest(fs.readFileSync(path.join(ctx.projectRoot, file))) })) }
  }
  const before = source()
  const backend = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({ stdin: { contents: "export { AcademyService } from './src/main/academy/academy-service'; export { registerAcademyHandlers } from './src/main/ipc/academy-handler'", resolveDir: ctx.projectRoot }, bundle: true, outfile: backend, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'] })
  const { AcademyService, registerAcademyHandlers } = require(backend)
  const service = new AcademyService(path.join(ctx.temporary, 'academy.db'))
  try {
    const pkg = name => ({ skillMd: `---\nname: ${name}\ndescription: Isolated CRS visual acceptance\n---\nLocal SQLite content.\n`, artifacts: {} })
    const privateSkill = await service.create({ package: pkg('crs-private'), scope: 'GLOBAL', origin: 'UI' })
    const published = await service.create({ package: pkg('crs-published'), scope: 'GLOBAL', origin: 'UI' })
    const snapshot = { schema: 1, repositoryId: 'isolated-fixture', remoteUrl: 'fixture://academy', branch: 'main', sourceCommitSha: 'a'.repeat(40), firstParentSha: null,
      managedTreeHash: 'fixture-tree', authoredFiles: {}, observedAt: new Date().toISOString(),
      skills: [{ path: 'skills/crs-published', name: published.name, package: published.current.package, packageHash: published.current.packageHash }] }
    service.store.acceptGitSnapshots([snapshot], null, service.store.gitMigrationHash(snapshot))
    service.store.enableLocalAuthority(snapshot.sourceCommitSha)
    registerAcademyHandlers(service)
    const preload = path.join(ctx.temporary, 'preload.cjs')
    buildSync({ entryPoints: [path.join(ctx.projectRoot, 'src/main/preload.ts')], bundle: true, outfile: preload, platform: 'node', format: 'cjs', external: ['electron'] })
    ctx.window.webContents.session.setPreloads([preload])
    buildSync({ entryPoints: [path.join(__dirname, 'academy-conflicts-fixture.tsx')], bundle: true, outfile: path.join(ctx.temporary, 'fixture.js'), platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' } })
    const page = path.join(ctx.temporary, 'index.html')
    fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}body{background:var(--bg-primary);color:var(--text-primary)}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
    await ctx.load(page)
    await ctx.viewport(1440, 900)
    await ctx.waitFor(() => !!document.querySelector('.academy-skill-item'))
    await ctx.click('.academy-skill-item')
    await ctx.waitFor(() => !!document.querySelector('.academy-tabs'))
    await ctx.click('.academy-tabs button:nth-child(2)')
    await ctx.waitFor(() => document.querySelector('.academy-overview')?.textContent.includes('Privada'))
    await ctx.capture('private-publication-gate')
    await ctx.click('.academy-overview .academy-secondary-button')
    await ctx.waitFor(() => !!document.querySelector('[role="alertdialog"]'))
    await ctx.evaluate(() => [...document.querySelectorAll('[role="alertdialog"] button')].find(button => button.textContent === 'Aprovar publicação').click())
    await ctx.waitFor(() => document.querySelector('.academy-overview')?.textContent.includes('Elegível'))
    ctx.check('Public eligibility uses real IPC and SQLite without changing the content version', service.store.publicationEligibility(privateSkill.id) === 'APPROVED' && service.get(privateSkill.id).currentVersion === 1)
    await ctx.capture('approved-publication')
    await ctx.click('.academy-skill-actions .academy-secondary-button')
    await ctx.click('.academy-tabs button:nth-child(1)')
    await ctx.waitFor(() => !!document.querySelector('textarea[aria-label="Editar SKILL.md"]'))
    ctx.check('Local editor opens without a Git draft provider', await ctx.evaluate(() => document.querySelector('textarea[aria-label="Editar SKILL.md"]').value.includes('Local SQLite content.')))
  } finally {
    await service.close()
    const after = source()
    fs.writeFileSync(path.join(ctx.evidenceDir, 'source.json'), JSON.stringify({ before, after }, null, 2))
    ctx.check('Source and dirty patch remain unchanged during visual acceptance', JSON.stringify(before) === JSON.stringify(after))
  }
}
