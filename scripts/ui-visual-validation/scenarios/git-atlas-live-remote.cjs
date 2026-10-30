const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

exports.run = async ctx => {
  let repository, writer
  const commands = [], observations = []
  const git = (root, args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  ctx.atlasSynchronizationProof = {
    automaticFetch: true,
    seed(root) { repository = root },
    prepare(backend) {
      git(repository, ['restore', '--staged', '--worktree', 'file.txt']); fs.unlinkSync(path.join(repository, 'new.txt'))
      const remote = path.join(ctx.temporary, 'remote.git'); fs.mkdirSync(remote); git(remote, ['init', '--bare'])
      git(repository, ['remote', 'add', 'origin', remote]); git(repository, ['push', '-u', 'origin', 'main'])
      writer = path.join(ctx.temporary, 'writer'); git(ctx.temporary, ['clone', '--branch', 'main', remote, writer])
      git(writer, ['config', 'user.name', 'Remote Proof']); git(writer, ['config', 'user.email', 'remote@example.com'])
      const run = backend.git.runGit.bind(backend.git)
      backend.git.runGit = async (...args) => { commands.push(args[0]); return run(...args) }
      const read = backend.controller.read.bind(backend.controller)
      backend.controller.read = async (...args) => {
        const started = Date.now(), result = await read(...args)
        observations.push({ started, finished: Date.now(), action: String(args[1]), result: result.success ? { action: result.data?.action, automaticFetch: result.data?.automaticFetch, snapshot: result.data?.gitSnapshot } : result })
        fs.writeFileSync(path.join(ctx.evidenceDir, 'live-remote-observations.json'), JSON.stringify(observations))
        fs.writeFileSync(path.join(ctx.evidenceDir, 'live-remote-commands.json'), JSON.stringify(commands))
        return result
      }
    },
    async verify(ctx) {
      ctx.window.show(); ctx.window.focus()
      const wait = async predicate => {
        const deadline = Date.now() + 75000
        while (Date.now() < deadline) { if (await ctx.evaluate(predicate)) return; await new Promise(resolve => setTimeout(resolve, 100)) }
        fs.writeFileSync(path.join(ctx.evidenceDir, 'live-remote-commands.json'), JSON.stringify(commands))
        fs.writeFileSync(path.join(ctx.evidenceDir, 'live-remote-observations.json'), JSON.stringify(observations))
        fs.writeFileSync(path.join(ctx.evidenceDir, 'live-remote-state.json'), JSON.stringify({ head: git(repository, ['rev-parse', 'HEAD']), tracking: git(repository, ['rev-parse', 'origin/main']), remote: git(writer, ['rev-parse', 'HEAD']), renderer: await ctx.evaluate(() => ({ hidden: document.hidden, focused: document.hasFocus(), text: document.querySelector('.gm-view')?.textContent })) }))
        await ctx.capture('live-remote-timeout'); throw new Error('Live remote did not converge: ' + await ctx.evaluate(() => document.querySelector('.gm-checkout-sync')?.textContent))
      }
      await wait(() => document.querySelector('.gm-checkout-sync')?.textContent.includes('Atualizada com origin/main'))
      await ctx.click('.gm-close-details')
      ctx.check('cold bootstrap contains real branch references', await ctx.evaluate(() => [...document.querySelectorAll('[aria-label="Referência em foco"] option')].some(option => option.textContent === 'feature/inspector')))
      await ctx.capture('live-opening')
      const head = git(repository, ['rev-parse', 'HEAD'])
      const fetches = () => commands.filter(args => args[0] === 'fetch').length
      ctx.check('unchanged entry does not fetch', fetches() === 0)
      git(writer, ['switch', '-c', 'external/topic']); fs.writeFileSync(path.join(writer, 'external.txt'), 'external contribution')
      git(writer, ['add', 'external.txt']); git(writer, ['commit', '-m', 'External contribution'])
      git(writer, ['switch', 'main']); git(writer, ['merge', '--no-ff', 'external/topic', '-m', 'External merge']); git(writer, ['push', 'origin', 'main'])
      await wait(() => document.querySelector('.gm-checkout-sync')?.textContent.includes('2 commits atrás'))
      await wait(() => !![...document.querySelectorAll('.gm-atlas-node')].find(node => node.getAttribute('aria-label')?.includes('External merge')))
      await wait(() => document.querySelector('.gm-checkout-sync')?.textContent.includes('2 commits atrás'))
      ctx.check('one conditional fetch with checkout untouched', fetches() === 1 && git(repository, ['rev-parse', 'HEAD']) === head)
      ctx.check('fetched tracking converges to external merge', git(repository, ['rev-parse', 'origin/main']) === git(writer, ['rev-parse', 'HEAD']))
      ctx.check('checkout marker remains visible', await ctx.evaluate(() => !!document.querySelector('.gm-checkout-marker')))
      await ctx.capture('live-external-merge')
      await ctx.evaluate(() => document.querySelector('.gm-atlas-scroll').dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: 60 })))
      ctx.check('scroll does not cause another fetch', fetches() === 1)
      fs.writeFileSync(path.join(ctx.evidenceDir, 'live-remote-commands.json'), JSON.stringify(commands))
      fs.writeFileSync(path.join(ctx.evidenceDir, 'live-remote-observations.json'), JSON.stringify(observations))
    }
  }
  await require('./git-management.cjs').run(ctx)
}
