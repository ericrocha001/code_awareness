import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from '../core/git-service'
import { cleanupTempRepo, commit, createTempGitRepo, stageAll, writeFile } from '../core/git-test-helpers'
import { GitHubGitTransport } from '../github/github-git-transport'
import { GitOperationsService } from './git-operations-service'
import { executeGitOperationsTool } from './git-operations-mcp'
import { isReceiptedGitMutation } from './git-operation-receipts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await cleanupTempRepo(root) })

async function fixture() {
  const root = await createTempGitRepo(); roots.push(root)
  await stageAll(root); await commit(root, 'base')
  const git = new GitService()
  return { root, service: new GitOperationsService(root, git, new GitHubGitTransport(null, git)) }
}

const call = (service: GitOperationsService, name: string, args: Record<string, unknown>) =>
  executeGitOperationsTool(service, name, isReceiptedGitMutation(name, args) ? { ...args, operationId: randomUUID() } : args)

describe('Git Operations worktree hygiene', () => {
  it('groups generated residue and applies previewed .gitignore rules without deleting files', async () => {
    const { root, service } = await fixture()
    writeFile(root, '.code-awareness/codemap-ui-runtime/screenshot.png', 'runtime')
    writeFile(root, '.claude/skills/continuum/SKILL.md', 'projection')
    writeFile(root, 'keep.txt', 'keep')

    const analysis = await service.analyzeHygiene()
    expect(analysis.untrackedCount).toBe(3)
    expect(analysis.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: 'GENERATED_RUNTIME', group: '.code-awareness/codemap-ui-runtime', count: 1 }),
      expect.objectContaining({ classification: 'GENERATED_PROJECTION', group: '.claude/skills', count: 1 })
    ]))

    const preview = await service.manageGitignore({ action: 'PREVIEW_ADD', rules: ['.code-awareness/codemap-ui-runtime/', '.claude/skills/'] })
    if (preview.newlyIgnoredCount !== 2 || preview.remainingUntrackedCount !== 1) throw new Error('PREVIEW_MISMATCH ' + JSON.stringify(preview))
    expect(existsSync(join(root, '.gitignore'))).toBe(false)

    const applied = await service.manageGitignore({
      action: 'ADD', rules: preview.rules, expectedWorktreeRevision: preview.worktreeRevision, expectedPreviewId: preview.previewId
    })
    expect(applied).toMatchObject({ result: 'UPDATED', newlyIgnoredCount: 2 })
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.code-awareness/codemap-ui-runtime/')
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.claude/skills/')
    expect(existsSync(join(root, '.code-awareness/codemap-ui-runtime/screenshot.png'))).toBe(true)
    expect(existsSync(join(root, '.claude/skills/continuum/SKILL.md'))).toBe(true)
    const remaining = await service.getChanges('UNTRACKED')
    expect(remaining.map((change) => change.path)).toEqual(expect.arrayContaining(['.gitignore', 'keep.txt']))
    expect(remaining).toHaveLength(2)

    const repeated = await service.manageGitignore({ action: 'PREVIEW_ADD', rules: preview.rules })
    expect(repeated.candidateRules).toEqual([])
    expect(repeated.alreadyPresent).toEqual(preview.rules)
    expect(repeated.newlyIgnoredCount).toBe(0)
  }, 30000)

  it('rejects ADD when preview evidence is stale through the receipted MCP path', async () => {
    const { root, service } = await fixture()
    writeFile(root, '.code-awareness/health-trigger-runtime/a.log', 'runtime')
    const previewReply = await call(service, 'manage_gitignore', { action: 'PREVIEW_ADD', rules: ['.code-awareness/health-trigger-runtime/'] })
    const preview = JSON.parse(previewReply.content[0].text)
    writeFile(root, 'concurrent.txt', 'changed after preview')
    const stale = await call(service, 'manage_gitignore', {
      action: 'ADD', rules: preview.rules, expectedWorktreeRevision: preview.worktreeRevision, expectedPreviewId: preview.previewId
    })
    expect(stale.isError).toBe(true)
    const payload = JSON.parse(stale.content[0].text)
    if (payload.code !== 'GIT_STATE_CHANGED') throw new Error('STALE_MISMATCH ' + JSON.stringify(payload))
    expect(existsSync(join(root, '.gitignore'))).toBe(false)
  }, 30000)
})
