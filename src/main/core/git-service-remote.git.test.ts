import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { GitService } from './git-service'

const roots: string[] = []
const temp = () => { const value = mkdtempSync(join(tmpdir(), 'git-service-remote-')); roots.push(value); return value }
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }) })

it('clones and pushes with ephemeral credentials while keeping origin and Git config credential-free', async () => {
  const root = temp()
  const source = join(root, 'source')
  const bare = join(root, 'remote.git')
  const parent = join(root, 'checkouts')
  execFileSync('git', ['init', source])
  execFileSync('git', ['init', '--bare', bare])
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: source })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: source })
  writeFileSync(join(source, 'README.md'), 'first\n')
  execFileSync('git', ['add', 'README.md'], { cwd: source })
  execFileSync('git', ['commit', '-m', 'first'], { cwd: source })
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: source })
  execFileSync('git', ['push', 'origin', 'HEAD:main'], { cwd: source })
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: bare })
  mkdirSync(parent)

  const git = new GitService()
  const checkout = await git.cloneAuthenticated(bare, parent, 'clone', 'ephemeral-secret')
  expect(await git.getRemoteUrl(checkout)).toBe(bare)
  await git.pushUrlAuthenticated(checkout, bare, 'main', 'ephemeral-secret')
  expect(readFileSync(join(checkout, '.git', 'config'), 'utf8')).not.toContain('ephemeral-secret')
  expect(JSON.stringify(await git.getRemoteUrl(checkout))).not.toContain('ephemeral-secret')
  expect(existsSync(checkout)).toBe(true)
})
