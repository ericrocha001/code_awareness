const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')

exports.run = async ctx => {
  const backend = path.join(ctx.temporary, 'backend.cjs')
  buildSync({ stdin: { contents: "export { GitService } from './src/main/core/git-service'; export { GitOperationsService } from './src/main/git-operations/git-operations-service'; export { GitWorktreeLifecycle } from './src/main/git-operations/git-worktree-lifecycle'; export { GitHubGitTransport } from './src/main/github/github-git-transport'; export { GitHubApiClient } from './src/main/github/github-api-client'; export { WorkOrchestrationController, registerWorkOrchestrationHandlers } from './src/main/ipc/work-orchestration-handler'", resolveDir: ctx.projectRoot }, bundle: true, outfile: backend, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'] })
  const { GitService, GitOperationsService, GitWorktreeLifecycle, GitHubApiClient, GitHubGitTransport, WorkOrchestrationController, registerWorkOrchestrationHandlers } = require(backend)
  const root = path.join(ctx.temporary, 'repository'), target = path.join(ctx.temporary, 'external-work')
  fs.mkdirSync(root)
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Acceptance']); git(['config', 'user.email', 'acceptance@example.test'])
  fs.writeFileSync(path.join(root, 'source.txt'), 'retained source\n'); git(['add', '.']); git(['commit', '-m', 'baseline'])
  const head = git(['rev-parse', 'HEAD'])
  git(['worktree', 'add', '-b', 'abandoned-attempt', target])
  fs.writeFileSync(path.join(target, 'scratch.txt'), 'reviewed discard')
  const lifecycle = new GitWorktreeLifecycle(fs.realpathSync(path.join(root, '.git'))), managedPath = lifecycle.destination()
  git(['worktree', 'add', '-b', 'managed-delivery', managedPath])
  const state = { project: { id: 'acceptance-a', path: root, name: 'Removal acceptance' }, revision: 1 }
  const engine = new GitService(), service = new GitOperationsService(root, engine, new GitHubGitTransport(null, engine), { repositoryId: 'fixture', isActive: () => true })
  const managed = (await service.worktrees.discover()).worktrees.find(record => record.path === managedPath)
  lifecycle.save({ ...managed, repositoryId: 'fixture', startPoint: head, createdAt: new Date().toISOString() })
  let approvals = 0, effects = 0, policyApprovals = 0, releaseApprovals = 0, merged = false
  const mergedAt = new Date().toISOString()
  const provider = new GitHubApiClient(async () => 'isolated-fixture-token', async () => new Response(JSON.stringify({ id: 100, number: 1, state: merged ? 'closed' : 'open', merged, merged_at: merged ? mergedAt : null, merge_commit_sha: merged ? 'a'.repeat(40) : null,
    base: { ref: 'main', sha: head, repo: { id: 1, full_name: 'fixture/repository' } }, head: { ref: 'managed-delivery', sha: head, repo: { id: 1 } } })))
  service.configureRemoval({ sourceRoot: ctx.projectRoot, isActive: () => true, delivery: number => provider.inspectPullRequestDelivery('fixture/repository', number),
    approvePolicy: async () => { policyApprovals++; return true }, approveAutomatic: async preview => { releaseApprovals++; return preview.path === managedPath },
    approve: async (preview, consent) => { approvals++; return preview.path === target && consent.ownerReleased && consent.operatorIsOwner && consent.noKnownWriter } })
  const remove = engine.removeReviewedWorktree.bind(engine)
  engine.removeReviewedWorktree = async (...args) => { effects++; return remove(...args) }
  const controller = new WorkOrchestrationController({ getState: () => state }, undefined, revision => ctx.window.webContents.send('work-orchestration:removed', revision))
  controller.bind(service); controller.bindRemoval(service); registerWorkOrchestrationHandlers(controller)
  const preload = path.join(ctx.temporary, 'preload.cjs')
  buildSync({ entryPoints: [path.join(ctx.projectRoot, 'src/main/preload.ts')], bundle: true, outfile: preload, platform: 'node', format: 'cjs', external: ['electron'] })
  ctx.window.webContents.session.setPreloads([preload])
  buildSync({ entryPoints: [path.join(__dirname, 'work-orchestration-fixture.tsx')], bundle: true, outfile: path.join(ctx.temporary, 'fixture.js'), platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
  const page = path.join(ctx.temporary, 'index.html')
  fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  const button = async text => {
    await ctx.evaluate(text => { document.querySelector('[data-removal-target]')?.removeAttribute('data-removal-target'); const node = [...document.querySelectorAll('button,summary')].find(node => node.textContent.trim() === text); if (!node) throw new Error(text); node.setAttribute('data-removal-target', ''); node.scrollIntoView({ block: 'center' }) }, text)
    await ctx.click('[data-removal-target]')
  }
  const wait = async fn => {
    const end = Date.now() + 45000
    while (Date.now() < end) { if (await ctx.evaluate(fn)) return; await new Promise(resolve => setTimeout(resolve, 80)) }
    const diagnostic = await ctx.evaluate(() => ({ text: document.querySelector('.wo-removal')?.textContent, mode: document.querySelector('.wo-removal select')?.value, pr: document.querySelector('.wo-removal input[type="number"]')?.value }))
    fs.writeFileSync(path.join(ctx.evidenceDir, 'ui-failure.json'), JSON.stringify(diagnostic))
    throw new Error('UI condition timeout: ' + JSON.stringify(diagnostic))
  }
  try {
    await ctx.window.loadFile(page, { query: { repositoryPath: root } }); await ctx.viewport(1440, 900)
    await button('Work Orchestration'); await wait(() => document.querySelectorAll('.wo-tree').length === 3)
    await ctx.evaluate(() => { const row = [...document.querySelectorAll('.wo-tree')].find(node => node.textContent.includes('abandoned-attempt')); row.setAttribute('data-external', '') })
    await ctx.click('[data-external]'); await wait(() => !!document.querySelector('.wo-inspector') && !document.querySelector('.wo-inspector').textContent.includes('Lendo a worktree'))
    await button('Encerramento e remoção')
    await ctx.evaluate(() => { const textarea = document.querySelector('.wo-inspector textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Tentativa abandonada; contexto preservado'); textarea.dispatchEvent(new Event('input', { bubbles: true })); const check = [...document.querySelectorAll('label')].find(node => node.textContent.includes('não tem Pull Request')).querySelector('input'); check.click() })
    await button('Preparar para remoção'); await wait(() => document.querySelector('.wo-inspector').textContent.includes('Prévia disponível'))
    ctx.check('Preparation does not delete', effects === 0 && fs.existsSync(target))
    ctx.check('Consent gates destructive action', await ctx.evaluate(() => [...document.querySelectorAll('button')].find(node => node.textContent === 'Remover WorkTree').disabled))
    await ctx.capture('manual-preview')
    await button('Cancelar preparação'); await wait(() => [...document.querySelectorAll('button')].some(node => node.textContent === 'Preparar para remoção'))
    ctx.check('Cancellation retains checkout', effects === 0 && fs.existsSync(target))
    await button('Preparar para remoção'); await wait(() => document.querySelector('.wo-inspector').textContent.includes('Prévia disponível'))
    await ctx.evaluate(() => { for (const text of ['Sou o proprietário', 'Revisei todos']) [...document.querySelectorAll('label')].find(node => node.textContent.includes(text)).querySelector('input').click() })
    await button('Remover WorkTree'); await wait(() => document.querySelectorAll('.wo-tree').length === 2)
    ctx.check('Real IPC, ownership approval and one Git removal', approvals === 1 && effects === 1 && !fs.existsSync(target))
    ctx.check('Branch retained at submitted head', git(['rev-parse', 'refs/heads/abandoned-attempt']) === head)
    ctx.check('Selection and inventory reconciled', await ctx.evaluate(() => !document.querySelector('.wo-inspector')))
    await ctx.evaluate(() => { document.querySelector('[data-external]')?.removeAttribute('data-external'); [...document.querySelectorAll('.wo-tree')].find(node => node.textContent.includes('managed-delivery')).setAttribute('data-managed', '') })
    await ctx.click('[data-managed]'); await wait(() => !!document.querySelector('.wo-inspector') && !document.querySelector('.wo-inspector').textContent.includes('Lendo a worktree'))
    await button('Encerramento e remoção'); await button('Limpeza automática do repositório'); await button('Consultar política')
    await wait(() => [...document.querySelectorAll('button')].some(node => node.textContent === 'Habilitar limpeza automática' && !node.disabled))
    await button('Habilitar limpeza automática'); await wait(() => document.querySelector('.wo-removal').textContent.includes('Habilitada'))
    await ctx.evaluate(() => { const select = document.querySelector('.wo-removal select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'INTEGRATED'); select.dispatchEvent(new Event('change', { bubbles: true })) })
    await ctx.evaluate(() => document.querySelector('.wo-removal input[type="number"]').scrollIntoView({ block: 'center' }))
    await ctx.input('.wo-removal input[type="number"]', '1')
    await button('Preparar para remoção'); await wait(() => document.querySelector('.wo-removal').textContent.includes('Remoção bloqueada'))
    ctx.check('Open PR cannot trigger automatic cleanup', effects === 1 && fs.existsSync(managedPath))
    await button('Inscrever após liberar sessão gerenciada'); await wait(() => document.querySelector('.wo-removal').textContent.includes('Inscrição confirmada'))
    merged = true
    await controller.reconcileRemoval(); await wait(() => document.querySelectorAll('.wo-tree').length === 1)
    ctx.check('Opt-in and explicit owner release are separate approvals', policyApprovals === 1 && releaseApprovals === 1)
    ctx.check('Automatic merge receipt removes only enrolled managed tree and updates UI', effects === 2 && !fs.existsSync(managedPath) && await ctx.evaluate(() => !document.querySelector('.wo-inspector')))
    ctx.check('Squash-like merge preserves own submitted branch', git(['rev-parse', 'refs/heads/managed-delivery']) === head)
    await ctx.capture('closed-inventory'); await ctx.overflow()
  } finally { controller.deactivate() }
}
