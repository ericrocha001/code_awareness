import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RepositoryFileIngress } from './repository-file-ingress'
import { RepositoryFileEditing } from './repository-file-editing'
import { REPOSITORY_FILE_EDITING_TOOLS } from './repository-file-editing-mcp'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import { bindProjectNavigation } from '../core/context/project-context-navigation'
import type { ContextNavigationPort } from '../core/context/context-navigation-port'
import { CodeMapService } from '../core/code-map-service'
import { WatcherService } from '../core/watcher-service'
import type { CompressionPort } from '../core/compression-port'
import { McpLifecycle } from '../mcp/mcp-lifecycle'

describe('Repository writing through Electron Main MCP on a real checkout', () => {
  it('creates, inspects, edits and replaces through HTTP; protects revision/context/kernels and preserves Git index, ACL and other dirty files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'repository-writing-e2e-'))
    const watcher = new WatcherService()
    const codeMap = new CodeMapService(watcher, {} as CompressionPort)
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], { encoding: 'utf8', windowsHide: true })
    const powershell = (program: string, input: unknown) => execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', program], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true }).trim()
    let active = true
    let opened = false
    const initial = '\ufeffexport function first() { return "ação" }\r\nexport function second() { return "two" }\r\nexport function third() { return "three" }\r\n'
    let uploaded = Buffer.from(initial)
    const ingress = new RepositoryFileIngress(root, { fetch: vi.fn(async () => new Response(uploaded)) as typeof fetch, validateDestination: relative => editing.assertCreationAllowed(relative) })
    const editing = new RepositoryFileEditing(root, { ingress, isActive: () => active })
    const navigation = bindProjectNavigation({} as ContextNavigationPort, root)
    const context = { projectId: 'discardable', repoRoot: root, navigation, repositoryFileIngress: ingress, repositoryFileEditing: editing }
    const adapter = new ChannelMcpAdapter(context)
    const server = createMcpHttpServer(adapter, () => {})
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server port')
    const rpc = async (method: string, params: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      return (await response.json() as { result: any }).result
    }
    const call = (name: string, args: unknown) => rpc('tools/call', { name, arguments: args })
    const read = (result: { isError?: boolean; content: Array<{ text: string }> }) => { expect(result.isError).toBeUndefined(); return JSON.parse(result.content[0].text) }
    const intent = { description: 'Explicitly update disposable fixture' }
    const file = { file_id: 'fixture', download_url: 'https://files.example/authorized' }
    try {
      expect(process.versions.electron).toBeTruthy()
      git('init')
      await writeFile(path.join(root, 'untouched.md'), 'baseline')
      git('add', 'untouched.md'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture')
      await writeFile(path.join(root, 'untouched.md'), 'preexisting staged')
      git('add', 'untouched.md')
      await writeFile(path.join(root, 'untouched.md'), 'preexisting unstaged')
      let head = git('rev-parse', 'HEAD')
      let index = await readFile(path.join(root, '.git/index'))
      const catalog = await rpc('tools/list', {})
      for (const tool of REPOSITORY_FILE_EDITING_TOOLS) expect(catalog.tools).toContainEqual(tool)
      const created = read(await call('import_repository_file', { file, destinationPath: 'source.ts' }))
      expect(await readFile(path.join(root, 'source.ts'))).toEqual(uploaded)
      expect(await readFile(path.join(root, '.git/index'))).toEqual(index)
      expect(git('rev-parse', 'HEAD')).toBe(head)
      git('add', 'source.ts'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--only', 'source.ts', '-m', 'fixture source')
      head = git('rev-parse', 'HEAD')
      index = await readFile(path.join(root, '.git/index'))
      await codeMap.openRepository(root)
      opened = true
      await codeMap.awaitMaintenance(root)
      await codeMap.indexRepository(root)
      const before = read(await call('inspect_repository_file', { path: 'source.ts' }))
      expect(before).toEqual({ path: 'source.ts', size: uploaded.length, sha256: created.sha256 })
      let acl: string | undefined
      if (process.platform === 'win32') {
        acl = powershell('$v = [Console]::In.ReadToEnd() | ConvertFrom-Json; $acl = [IO.File]::GetAccessControl($v.path); $acl.SetAccessRuleProtection($true, $true); [IO.File]::SetAccessControl($v.path, $acl); [IO.File]::GetAccessControl($v.path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)', { path: path.join(root, 'source.ts') })
      }
      const patches = [{ oldText: '"ação"', newText: '"revisão"' }, { oldText: '"two"', newText: '"second"' }, { oldText: '"three"', newText: '"third"' }]
      const edited = read(await call('edit_repository_text', { destinationPath: 'source.ts', expectedSha256: before.sha256, intent, replacements: patches }))
      let reconstructed = (await readFile(path.join(root, 'source.ts'))).toString('utf8')
      for (const patch of patches) reconstructed = reconstructed.replace(patch.newText, patch.oldText)
      expect(reconstructed).toBe(initial)
      await vi.waitFor(async () => {
        expect(codeMap.getFiles(root).find(file => file.relativePath === 'source.ts')?.contentHash).toBe(edited.afterSha256)
        const element = codeMap.getElements(root).find(element => element.name === 'first' && element.retrievable)
        expect(element).toBeDefined()
        expect((await codeMap.getElementExactSource(root, element!.id))?.content).toContain('revisão')
      }, { timeout: 15_000 })
      const replaced = read(await call('replace_repository_file', { destinationPath: 'source.ts', expectedSha256: edited.afterSha256, intent, text: 'export const final = "new"\r\n' }))
      if (acl !== undefined) expect(powershell('$v = [Console]::In.ReadToEnd() | ConvertFrom-Json; [IO.File]::GetAccessControl($v.path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)', { path: path.join(root, 'source.ts') })).toBe(acl)
      const stale = await call('replace_repository_file', { destinationPath: 'source.ts', expectedSha256: before.sha256, intent, text: 'stale' })
      expect(stale).toMatchObject({ isError: true, content: [{ text: 'FILE_REVISION_CONFLICT' }] })
      const races = await Promise.all(['A', 'B'].map(text => call('replace_repository_file', { destinationPath: 'source.ts', expectedSha256: replaced.afterSha256, intent, text })))
      expect(races.filter((result: { isError?: boolean }) => !result.isError)).toHaveLength(1)
      await writeFile(path.join(root, 'AGENTS.md'), 'fictional')
      const kernel = read(await call('inspect_repository_file', { path: 'AGENTS.md' }))
      expect(await call('replace_repository_file', { destinationPath: 'AGENTS.md', expectedSha256: kernel.sha256, intent, text: 'new' })).toMatchObject({ isError: true, content: [{ text: 'PROTECTED_PATH' }] })
      read(await call('replace_repository_file', { destinationPath: 'AGENTS.md', expectedSha256: kernel.sha256, intent: { ...intent, explicitUserAuthorization: true }, text: 'new' }))
      uploaded = Buffer.from([0, 255, 1, 128, 42])
      const current = read(await call('inspect_repository_file', { path: 'source.ts' }))
      const binary = read(await call('replace_repository_file', { destinationPath: 'source.ts', expectedSha256: current.sha256, intent, file }))
      expect(await readFile(path.join(root, 'source.ts'))).toEqual(uploaded)
      expect(read(await call('inspect_repository_file', { path: 'source.ts' })).sha256).toBe(binary.afterSha256)
      expect(await call('import_repository_file', { file, destinationPath: 'source.ts' })).toMatchObject({ isError: true, content: [{ text: 'DESTINATION_CONFLICT' }] })
      for (const protectedPath of ['.skills/f/SKILL.md', '.git/config', '../outside', '.env']) expect((await call('inspect_repository_file', { path: protectedPath })).isError).toBe(true)
      active = false
      expect(await call('replace_repository_file', { destinationPath: 'source.ts', expectedSha256: binary.afterSha256, intent, text: 'wrong checkout' })).toMatchObject({ isError: true, content: [{ text: 'REPOSITORY_CONTEXT_CHANGED' }] })
      expect(await readFile(path.join(root, '.git/index'))).toEqual(index)
      expect(git('rev-parse', 'HEAD')).toBe(head)
      expect(await readFile(path.join(root, 'untouched.md'), 'utf8')).toBe('preexisting unstaged')
      expect(git('status', '--porcelain')).toContain(' M source.ts')
      expect((await readdir(root)).some(name => name.startsWith('.repository-') || name.startsWith('.file-ingress-'))).toBe(false)
      const lifecycle = new McpLifecycle({ log: () => {} })
      try {
        await lifecycle.activateContext({ ...context, repositoryFileEditing: undefined })
        const disabled = lifecycle.getCatalogProbe()!.getToolCatalogHash()
        await lifecycle.activateContext(context)
        expect(lifecycle.getCatalogProbe()!.getToolCatalogHash()).not.toBe(disabled)
      } finally { await lifecycle.dispose() }
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      watcher.stop()
      if (opened) await codeMap.awaitSnapshot(root)
      codeMap.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
