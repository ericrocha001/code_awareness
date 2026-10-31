const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

exports.run = async ctx => {
  let repository, remote
  const commands = [], requests = []
  const git = (root, args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  ctx.atlasSynchronizationProof = {
    directPublication: true,
    seed(root) { repository = root },
    prepare(backend) {
      git(repository, ['restore', '--staged', '--worktree', 'file.txt']); fs.unlinkSync(path.join(repository, 'new.txt'))
      remote = path.join(ctx.temporary, 'remote.git'); fs.mkdirSync(remote); git(remote, ['init', '--bare'])
      git(repository, ['remote', 'add', 'origin', remote]); git(repository, ['switch', '-c', 'delivery/direct'])
      git(repository, ['push', '-u', 'origin', 'delivery/direct'])
      fs.writeFileSync(path.join(repository, 'publication.txt'), 'published through governed executor')
      git(repository, ['add', 'publication.txt']); git(repository, ['commit', '-m', 'Publish reviewed contribution'])
      const run = backend.git.runGit.bind(backend.git)
      backend.git.runGit = async (...args) => { commands.push(args[0]); return run(...args) }
      const mutate = backend.controller.mutate.bind(backend.controller)
      backend.controller.mutate = async request => { requests.push(request); return mutate(request) }
    },
    async verify(ctx) {
      ctx.window.show(); ctx.window.focus()
      const wait = async predicate => {
        const deadline = Date.now() + 60000
        while (Date.now() < deadline) { if (await ctx.evaluate(predicate)) return; await new Promise(resolve => setTimeout(resolve, 100)) }
        await ctx.capture('push-timeout'); throw new Error('Direct publication did not settle: ' + await ctx.evaluate(() => document.querySelector('.gm-view')?.textContent))
      }
      await ctx.click('.gm-close-details')
      await wait(() => { const button = document.querySelector('.gm-checkout-sync button'); return button && !button.disabled && button.textContent.includes('Publicar — Push') })
      ctx.check('destination and commit count are visible before intent', await ctx.evaluate(() => document.querySelector('.gm-checkout-sync')?.textContent.includes('Publicar 1 commit de delivery/direct em origin/delivery/direct, sem force.')))
      await ctx.capture('direct-push-destination')
      const head = git(repository, ['rev-parse', 'HEAD'])
      await ctx.click('.gm-checkout-sync button')
      ctx.check('direct push opens no confirmation or Inspector', await ctx.evaluate(() => !document.querySelector('.gm-confirm') && !document.querySelector('.gm-inspector.is-open')))
      await wait(() => document.querySelector('.gm-checkout-sync')?.textContent.includes('Atualizada com origin/delivery/direct'))
      const pushes = commands.filter(args => args[0] === 'push')
      ctx.check('one non-force push publishes exact inspected HEAD', pushes.length === 1 && pushes.every(args => !args.some(arg => arg.startsWith('--force') || arg.startsWith('+'))) && git(remote, ['rev-parse', 'refs/heads/delivery/direct']) === head)
      ctx.check('one contextual intention and receipted result', requests.length === 1 && requests[0].operation.action === 'PUSH' && requests[0].operation.contextual === true && !!requests[0].operationId)
      await ctx.capture('direct-push-completed')
      fs.writeFileSync(path.join(ctx.evidenceDir, 'direct-push.json'), JSON.stringify({ head, commands, requests }, null, 2))
    }
  }
  await require('./git-management.cjs').run(ctx)
}
