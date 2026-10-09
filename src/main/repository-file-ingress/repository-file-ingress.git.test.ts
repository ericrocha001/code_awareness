import { textContent } from '../mcp/mcp-test-content'
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { GitService } from '../core/git-service'
import { createTempGitRepo, cleanupTempRepo, gitExec } from '../core/git-test-helpers'
import { GitHubGitTransport } from '../github/github-git-transport'
import { GitOperationsService } from '../git-operations/git-operations-service'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { RepositoryFileIngress } from './repository-file-ingress'

let root: string | undefined
afterEach(async () => { if (root) await cleanupTempRepo(root) })

it('imports binary bytes visible through get_git_changes without changing the Git index', async () => {
  root = await createTempGitRepo()
  const bytes = Buffer.from([0, 255, 137, 42, 0, 12])
  const git = new GitService()
  const operations = new GitOperationsService(root, git, new GitHubGitTransport(null, git))
  const stage = vi.spyOn(operations, 'stage')
  const navigation: ProjectContextNavigation = {
    discoverRepository: async () => ({ directories: [] }),
    getRelationships: async () => ({ files: [] }),
    inspectFiles: async () => ({ files: [] }),
    readCode: async () => [],
    getReferences: async () => ({ targets: [] }),
    getSymbolDependencies: async () => ({ sources: [] }),
    getSymbolHierarchy: async () => ({ targets: [] })
  }
  const ingress = new RepositoryFileIngress(root, { fetch: vi.fn(async () => new Response(bytes)) as typeof fetch })
  const adapter = new ChannelMcpAdapter({ projectId: 'fixture', repoRoot: root, navigation, gitOperations: operations, repositoryFileIngress: ingress })
  const args = { file: { download_url: 'https://local-fixture.example/binary', file_id: 'fixture-only' }, destinationPath: 'docs/mockups/acceptance/test.bin' }
  const result = await adapter.callTool('import_repository_file', args)
  expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify({ path: args.destinationPath, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) }] })
  expect(await readFile(path.join(root, args.destinationPath))).toEqual(bytes)
  const changes = await adapter.callTool('get_git_changes', {})
  expect(changes.isError).toBeUndefined()
  expect(JSON.parse(textContent(changes.content[0]))).toEqual([expect.objectContaining({ path: args.destinationPath, untracked: true, stagedState: null })])
  expect(await gitExec(root, ['diff', '--cached', '--name-only'])).toBe('')
  expect(stage).not.toHaveBeenCalled()
  expect(await adapter.callTool('import_repository_file', args)).toEqual({ isError: true, content: [{ type: 'text', text: 'DESTINATION_CONFLICT' }] })
  expect(await readFile(path.join(root, args.destinationPath))).toEqual(bytes)
})
