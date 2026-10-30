const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

exports.run = async ctx => {
  let repository, remote, writer
  const git = (root, args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  ctx.atlasSynchronizationProof = {
    seed(root) { repository = root },
    prepare() {
      git(repository, ['restore', '--staged', '--worktree', 'file.txt'])
      fs.unlinkSync(path.join(repository, 'new.txt'))
      remote = path.join(ctx.temporary, 'remote.git'); fs.mkdirSync(remote)
      git(remote, ['init', '--bare'])
      git(repository, ['remote', 'add', 'origin', remote])
      git(repository, ['push', '-u', 'origin', 'main'])
      writer = path.join(ctx.temporary, 'writer')
      git(ctx.temporary, ['clone', '--branch', 'main', remote, writer])
      git(writer, ['config', 'user.name', 'Remote Proof']); git(writer, ['config', 'user.email', 'remote@example.com'])
      fs.writeFileSync(path.join(writer, 'remote.txt'), 'remote advancement')
      git(writer, ['add', 'remote.txt']); git(writer, ['commit', '-m', 'Remote advancement']); git(writer, ['push', 'origin', 'main'])
    },
    async verify(ctx) {
      ctx.window.show(); ctx.window.focus()
      const wait = async predicate => {
        const deadline = Date.now() + 40000
        while (Date.now() < deadline) { if (await ctx.evaluate(predicate)) return; await new Promise(resolve => setTimeout(resolve, 100)) }
        await ctx.capture('synchronization-timeout')
        throw new Error('Contextual synchronization did not settle: ' + await ctx.evaluate(() => document.querySelector('.gm-view')?.textContent))
      }
      const head = git(repository, ['rev-parse', 'HEAD'])
      await wait(() => document.querySelector('.gm-checkout-sync')?.textContent.includes('contagem ainda não verificada'))
      await wait(() => { const button = document.querySelector('.gm-checkout-sync button'); return button && !button.disabled })
      ctx.check('live remote evidence does not invent a behind count or fetch implicitly', git(repository, ['rev-parse', 'HEAD']) === head && git(repository, ['rev-parse', 'origin/main']) === head)
      await ctx.capture('remote-unknown')
      await wait(() => { const button = document.querySelector('.gm-checkout-sync button'); return button && !button.disabled })
      await ctx.click('.gm-checkout-sync button')
      await wait(() => !!document.querySelector('.gm-confirm'))
      ctx.check('fetch waits for explicit confirmation', git(repository, ['rev-parse', 'origin/main']) === head)
      await ctx.click('.gm-confirm button')
      await wait(() => document.querySelector('.gm-checkout-sync')?.textContent.includes('1 commit atrás'))
      ctx.check('fetch leaves local HEAD unchanged', git(repository, ['rev-parse', 'HEAD']) === head)
      await ctx.capture('behind-confirmed')
      await wait(() => { const button = document.querySelector('.gm-checkout-sync button'); return button && !button.disabled })
      const viewport = await ctx.evaluate(() => { const map = document.querySelector('.gm-atlas-scroll'); return { left: map.scrollLeft, zoom: document.querySelector('.gm-atlas-surface')?.style.width } })
      await ctx.click('.gm-checkout-sync button')
      await wait(() => !!document.querySelector('.gm-confirm'))
      ctx.check('pull waits for explicit confirmation', git(repository, ['rev-parse', 'HEAD']) === head)
      await ctx.capture('pull-confirmation')
      await ctx.click('.gm-confirm button')
      await wait(() => document.querySelector('.gm-checkout-sync')?.textContent.includes('Atualizada com origin/main'))
      ctx.check('confirmed pull fast-forwards through GitActions', git(repository, ['rev-parse', 'HEAD']) === git(writer, ['rev-parse', 'HEAD']))
      await ctx.capture('up-to-date')
      await ctx.evaluate(() => {
        const map = document.querySelector('.gm-atlas-scroll')
        map.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: 60 }))
        map.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -30, ctrlKey: true }))
      })
      ctx.check('Atlas remains interactive after synchronization', await ctx.evaluate(() => document.querySelectorAll('.gm-atlas-node').length > 0 && !!document.querySelector('.gm-checkout-marker')))
      fs.writeFileSync(path.join(ctx.evidenceDir, 'synchronization.json'), JSON.stringify({ sourceRoot: ctx.projectRoot, initialHead: head, finalHead: git(repository, ['rev-parse', 'HEAD']), viewport }, null, 2))
      await ctx.viewport(1100, 800)
      await ctx.capture('synchronization-medium')
    }
  }
  await require('./git-management.cjs').run(ctx)
}
