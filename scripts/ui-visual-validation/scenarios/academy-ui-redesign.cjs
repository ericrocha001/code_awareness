const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')

exports.run = async ctx => {
  const source = () => {
    const git = args => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: ctx.projectRoot, windowsHide: true })
    const digest = data => createHash('sha256').update(data).digest('hex')
    const patch = git(['diff', '--binary', 'HEAD'])
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean)
    if (!fs.existsSync(path.join(ctx.evidenceDir, 'source.patch'))) fs.writeFileSync(path.join(ctx.evidenceDir, 'source.patch'), patch, { flag: 'wx' })
    return {
      checkout: ctx.projectRoot,
      head: git(['rev-parse', 'HEAD']).toString().trim(),
      branch: git(['branch', '--show-current']).toString().trim(),
      patchHash: digest(patch),
      untracked: untracked.map(file => ({ path: file, hash: digest(fs.readFileSync(path.join(ctx.projectRoot, file))) }))
    }
  }
  const before = source()
  const backend = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({
    stdin: {
      contents: "export { AcademyService } from './src/main/academy/academy-service'; export { registerAcademyHandlers } from './src/main/ipc/academy-handler'",
      resolveDir: ctx.projectRoot
    },
    bundle: true,
    outfile: backend,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'better-sqlite3']
  })
  const workerBundle = path.join(ctx.temporary, 'academy-plugin-worker.js')
  buildSync({
    entryPoints: [path.join(ctx.projectRoot, 'src/main/academy/publication/academy-plugin-worker.ts')],
    bundle: true,
    outfile: workerBundle,
    platform: 'node',
    format: 'cjs',
    external: ['electron']
  })
  const { AcademyService, registerAcademyHandlers } = require(backend)
  const { ipcMain } = require('electron')
  const service = new AcademyService(path.join(ctx.temporary, 'academy.db'), path.join(ctx.temporary, 'downloads'), 2000, workerBundle)
  try {
    const pkg = (name, description) => ({
      skillMd: `---\nname: ${name}\ndescription: ${description}\nx-fixture: preservado\n---\n\n# ${name}\n\nConteúdo sintético de validação. Ação, unicode e autoria integral.\n${'Orientação procedural com contexto verificável.\n'.repeat(50)}`,
      artifacts: {
        'references/guide.md': '# Orientações\nTexto sintético.',
        'scripts/example.ts': 'export const example = true\n'
      }
    })
    const selected = await service.create({
      package: pkg('architecture-map', 'Consulte o Architecture Map canônico de um repositório para compreender topologia, subsistemas, ownership, dependências e fronteiras de runtime.'),
      scope: 'GLOBAL',
      origin: 'UI'
    })
    const names = ['agent-context-interface-engineering', 'agent-session-context', 'apresentacao-visual-de-ui', 'architecture-challenge', 'architecture-map-authoring', 'blockage-handoff', 'capability-opportunity', 'capability-readiness-design', 'cli-execution']
    const batchApprove = [{ skillId: selected.id, expectedVersion: selected.currentVersion }]
    for (let i = 0; i < 53; i++) {
      const created = await service.create({
        package: pkg(names[i] ?? `skill-${String(i).padStart(2, '0')}${i === 14 ? '-with-a-very-long-name-that-must-stay-inside-the-catalog' : ''}`, 'Orientações sintéticas para uma tarefa com contratos preservados.'),
        scope: 'GLOBAL',
        origin: 'UI'
      })
      if (i < 51) batchApprove.push({ skillId: created.id, expectedVersion: created.currentVersion })
      if (i === 52) {
        await service.approvePublicSkill(created.id, created.currentVersion, true)
        await service.setEnabled(created.id, false, created.stateRevision)
      }
    }
    service.store.approvePublicSkills(batchApprove)
    const projDest = service.store.upsertDestination(path.join(ctx.temporary, 'proj-repo'), 'proj-repo')
    await service.create({
      package: pkg('project-only-helper', 'Skill restrita ao escopo de projeto para validar não-publicação.'),
      scope: 'PROJECT',
      projectIds: [projDest.id],
      origin: 'UI'
    })

    const pluginRoot = path.join(ctx.temporary, 'plugin-root')
    fs.mkdirSync(path.join(pluginRoot, 'assets'), { recursive: true })
    fs.mkdirSync(path.join(pluginRoot, 'skills'), { recursive: true })
    const pngLogo = Buffer.alloc(32)
    Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(pngLogo, 0)
    pngLogo.writeUInt32BE(64, 16)
    pngLogo.writeUInt32BE(64, 20)
    fs.writeFileSync(path.join(pluginRoot, 'assets', 'logo.png'), pngLogo)
    fs.writeFileSync(path.join(pluginRoot, 'plugin.json'), JSON.stringify({
      name: 'academy-skills',
      version: '0.1.0',
      description: 'Academy procedural skills for Codex.',
      author: { name: 'Synthetic Fixture' },
      extensions: {
        'com.openai': {
          interface: {
            displayName: 'Academy Skills',
            shortDescription: 'Academy procedural skills',
            logo: './assets/logo.png',
            composerIcon: './assets/logo.png'
          }
        }
      }
    }))
    await service.bootstrapOpenAiPlugin(pluginRoot, '0.1.0')
    service.initializePluginPackage()

    const snapshot = {
      schema: 1,
      repositoryId: 'isolated-fixture',
      remoteUrl: 'fixture://academy',
      branch: 'main',
      sourceCommitSha: 'a'.repeat(40),
      firstParentSha: null,
      managedTreeHash: 'fixture-tree',
      authoredFiles: {},
      observedAt: new Date().toISOString(),
      skills: [{ path: 'skills/architecture-map', name: selected.name, package: selected.current.package, packageHash: selected.current.packageHash }]
    }
    service.store.acceptGitSnapshots([snapshot], null, service.store.gitMigrationHash(snapshot))
    service.store.enableLocalAuthority(snapshot.sourceCommitSha)

    let mode = 'unverified'
    const projection = () => ({
      profile: { repositoryCatalogId: 'fixture', githubRepositoryId: 'fixture', branch: 'main' },
      repository: { id: 'fixture', name: 'Academy fixture', fullName: 'synthetic/Academy', visibility: 'PRIVATE', checkoutPath: ctx.temporary, branch: 'main' },
      syncState: mode === 'conflict' ? 'CONFLICT' : mode === 'pr' ? 'PR_PENDING' : 'SYNCED',
      lastSyncAt: null,
      lastCommitSha: 'a'.repeat(40),
      lastError: null,
      publication: { autoPublish: false, autoUpdate: false, conflictPaths: mode === 'conflict' ? ['skills/architecture-map/SKILL.md'] : [], migrationComplete: true, phase: mode === 'conflict' ? 'CONFLICT' : 'CONFIRMED' },
      convergence: { cutover: 'LOCAL', localRevision: service.store.catalogRevision(), lastConvergedRevision: null, pending: true, freshness: 'UNVERIFIED' },
      remoteCheck: { state: 'IDLE', generation: 1, requestId: null, error: null, completedAt: null }
    })
    service.gitSync = { getStatus: projection, verifyRemote: async () => projection(), scheduleLocalChange() {}, listEligibleRepositories: async () => [], close: async () => {} }
    registerAcademyHandlers(service)
    ipcMain.handle('repositories:list', () => [])

    const preload = path.join(ctx.temporary, 'preload.cjs')
    buildSync({ entryPoints: [path.join(ctx.projectRoot, 'src/main/preload.ts')], bundle: true, outfile: preload, platform: 'node', format: 'cjs', external: ['electron'] })
    ctx.window.webContents.session.setPreloads([preload])
    buildSync({ entryPoints: [path.join(__dirname, 'academy-ui-redesign-fixture.tsx')], bundle: true, outfile: path.join(ctx.temporary, 'fixture.js'), platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' } })
    const page = path.join(ctx.temporary, 'index.html')
    fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}body{background:var(--bg-primary);color:var(--text-primary)}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')

    await ctx.load(page)
    await ctx.viewport(1672, 941)
    try {
      await ctx.waitFor(() => {
        const el = document.querySelector('[data-testid="academy-coverage-summary"]')
        return Boolean(el && !el.textContent?.includes('Carregando catálogo') && el.textContent?.includes('52 Skills globais no plugin'))
      })
    } catch (waitErr) {
      const diag = await ctx.evaluate(() => ({
        summary: document.querySelector('[data-testid="academy-coverage-summary"]')?.textContent ?? null,
        body: document.body.innerText.slice(0, 600),
        feedback: document.querySelector('.academy-feedback')?.textContent ?? null
      }))
      console.error('[DIAGNOSTIC]', JSON.stringify(diag))
      throw waitErr
    }
    await ctx.overflow()

    ctx.check('Default landing opens directly on Plugin ChatGPT without OperationsRail', await ctx.evaluate(() =>
      !!document.querySelector('[aria-label="Plugin ChatGPT"]') &&
      !document.querySelector('.academy-operations') &&
      document.body.innerText.includes('2 Skills fora do plugin')
    ))
    await ctx.capture('plugin-overview-empty-dark')

    await ctx.click('.academy-excluded-notice button')
    await ctx.waitFor(() => !!document.querySelector('[role="dialog"][aria-label="Revisar Skills fora do plugin"]'))
    await ctx.capture('plugin-review-modal-dark')
    await ctx.click('[role="dialog"][aria-label="Revisar Skills fora do plugin"] .academy-drawer-header button')
    await ctx.waitFor(() => !document.querySelector('[role="dialog"][aria-label="Revisar Skills fora do plugin"]'))

    await ctx.click('.academy-plugin-cta-row button')
    const zipDeadline = Date.now() + 25000
    while (Date.now() < zipDeadline) {
      if (await ctx.evaluate(() => Boolean(document.querySelector('.academy-plugin-cta-row')?.textContent?.includes('Abrir ZIP')))) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    await ctx.waitFor(() => Boolean(document.querySelector('.academy-plugin-cta-row')?.textContent?.includes('Abrir ZIP')))
    await ctx.overflow()
    ctx.check('1-click Plugin ZIP generation updates Result zone cleanly without manual Skill selection', await ctx.evaluate(() =>
      !!document.querySelector('.academy-plugin-result') &&
      document.querySelector('.academy-plugin-cta-row')?.textContent?.includes('Abrir ZIP')
    ))
    await ctx.capture('plugin-overview-ready-dark')

    await ctx.evaluate(() => {
      const tabs = [...document.querySelectorAll('.academy-surface-tab')]
      tabs.find(tab => tab.textContent?.trim() === 'Skills')?.click()
    })
    await ctx.waitFor(() => document.querySelectorAll('.academy-skill-item').length === 55)
    await ctx.evaluate(() => {
      const items = [...document.querySelectorAll('.academy-skill-item')]
      items.find(item => item.textContent?.includes('architecture-map') && !item.textContent?.includes('authoring'))?.click()
    })
    await ctx.waitFor(() => Boolean(document.querySelector('.academy-workspace-header h3')?.textContent?.trim() === 'architecture-map' && document.querySelector('.academy-readonly-skill')))
    await ctx.overflow()

    ctx.check('Secondary Skills catalog and read-only view render independently with 55 Skills', await ctx.evaluate(() => {
      const list = document.querySelector('.academy-skill-list')
      return Boolean(list && list.scrollHeight > list.clientHeight && document.querySelector('.academy-readonly-skill'))
    }))
    await ctx.capture('skills-workspace-wide-dark')

    await ctx.click('.academy-actions button')
    await ctx.waitFor(() => !!document.querySelector('textarea[aria-label="Conteúdo do SKILL.md"]'))
    await ctx.click('textarea[aria-label="Conteúdo do SKILL.md"]')
    await ctx.evaluate(() => document.querySelector('textarea[aria-label="Conteúdo do SKILL.md"]').select())
    await ctx.window.webContents.insertText(selected.current.package.skillMd + '\nEdição real pelo IPC.')
    await ctx.click('.global-sidebar-nav button[aria-label="Home"]')
    await ctx.waitFor(() => !!document.querySelector('[role="alertdialog"]'))
    await ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    await ctx.waitFor(() => !document.querySelector('[role="alertdialog"]'))
    ctx.check('Navigation prompts for discard and Escape preserves the full dirty draft', await ctx.evaluate(() =>
      document.querySelector('textarea[aria-label="Conteúdo do SKILL.md"]')?.value.includes('Edição real pelo IPC.')
    ))

    await ctx.click('.academy-artifact-chip:first-child')
    await ctx.waitFor(() => !!document.querySelector('[role="dialog"] .academy-modal textarea'))
    await ctx.click('[role="dialog"] .academy-modal textarea')
    await ctx.evaluate(() => document.querySelector('[role="dialog"] .academy-modal textarea').select())
    await ctx.window.webContents.insertText('# Guide\nArquivo editado pela interface.')
    await ctx.click('[role="dialog"] .academy-modal-actions button:last-child')
    await ctx.capture('skills-editing-wide-dark')
    await ctx.click('.academy-actions button:first-child')
    await ctx.waitFor(() => !document.querySelector('textarea[aria-label="Conteúdo do SKILL.md"]'))
    ctx.check('Save uses real renderer, preload, IPC, Service and SQLite and retains unknown YAML and files',
      service.get(selected.id).currentVersion === 2 &&
      service.get(selected.id).current.package.skillMd.includes('x-fixture: preservado') &&
      service.get(selected.id).current.package.artifacts['references/guide.md'].includes('Arquivo editado')
    )

    mode = 'conflict'
    service.emitDistributionChange('git')
    await ctx.waitFor(() => Boolean(document.querySelector('.academy-settings-trigger.has-alert')))
    await ctx.viewport(1000, 800)
    await ctx.evaluate(() => { document.body.dataset.theme = 'light' })
    await ctx.click('.academy-settings-trigger')
    await ctx.waitFor(() => !!document.querySelector('[role="dialog"][aria-label="Configurações da Academy"]'))
    await ctx.overflow()
    ctx.check('Configurações drawer exposes consent policy, Git secondary controls and local destinations without blocking Plugin CTA', await ctx.evaluate(() =>
      !!document.querySelector('[aria-label="Política e pacote OpenAI"]') &&
      !!document.querySelector('[aria-label="Sincronização Git"]') &&
      !!document.querySelector('[aria-label="Destinos locais"]')
    ))
    await ctx.capture('settings-drawer-medium-light')
    await ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    await ctx.waitFor(() => !document.querySelector('[role="dialog"][aria-label="Configurações da Academy"]'))

    await ctx.viewport(640, 900)
    await ctx.evaluate(() => { document.body.dataset.theme = 'dark' })
    await ctx.evaluate(() => {
      const tabs = [...document.querySelectorAll('.academy-surface-tab')]
      tabs.find(tab => tab.textContent?.trim() === 'Plugin ChatGPT')?.click()
    })
    await ctx.waitFor(() => !!document.querySelector('[aria-label="Plugin ChatGPT"]'))
    await ctx.overflow()
    await ctx.capture('plugin-narrow-dark')

    await ctx.evaluate(() => {
      const tabs = [...document.querySelectorAll('.academy-surface-tab')]
      tabs.find(tab => tab.textContent?.trim() === 'Skills')?.click()
    })
    await ctx.waitFor(() => !!document.querySelector('.academy-compact-trigger'))
    await ctx.overflow()
    await ctx.capture('skills-narrow-dark')

    await ctx.click('.academy-compact-trigger')
    await ctx.waitFor(() => document.querySelector('.academy-catalog')?.classList.contains('open'))
    await ctx.capture('catalog-narrow-dark')
    await ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    await ctx.waitFor(() => !document.querySelector('.academy-catalog')?.classList.contains('open'))

    fs.writeFileSync(path.join(ctx.evidenceDir, 'integration.json'), JSON.stringify({
      renderer: 'production',
      ipc: 'real',
      store: 'isolated SQLite',
      git: 'synthetic adapter; no remote or personal profile',
      skills: 55,
      savedVersion: service.get(selected.id).currentVersion
    }, null, 2))
  } finally {
    await service.close()
    const after = source()
    fs.writeFileSync(path.join(ctx.evidenceDir, 'source.json'), JSON.stringify({ before, after }, null, 2))
    ctx.check('Source remains unchanged during capture', JSON.stringify(before) === JSON.stringify(after))
  }
}
