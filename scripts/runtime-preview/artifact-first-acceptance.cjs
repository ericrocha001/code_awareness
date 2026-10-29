const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { spawn } = require('node:child_process'), { randomUUID } = require('node:crypto'), assert = require('node:assert/strict')
const root = process.cwd(), output = path.join(root, '.code-awareness/pvo-artifact-first')
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  child.on('error', error => { console.error(error); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
} else {
  const { app } = require('electron'), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvo-artifact-first-'))
  for (const key of ['appData', 'userData', 'sessionData', 'home', 'temp']) { const file = path.join(directory, key); fs.mkdirSync(file); app.setPath(key, file) }
  app.setName('PVO Artifact First Acceptance Host'); app.enableSandbox()
  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true })
    const entries = ['work-orchestration/runtime-preview/runner', 'work-orchestration/runtime-preview/session-store', 'work-orchestration/runtime-preview/operations',
      'work-orchestration/runtime-preview/code-awareness-profile', 'work-orchestration/runtime-preview/context-data', 'work-orchestration/preview-profile-store', 'work-orchestration/preview-preflight',
      'work-orchestration/preview-repositories', 'core/git-service', 'git-operations/git-operations-service', 'github/github-git-transport', 'mcp/channel-mcp-adapter', 'mcp/mcp-http-server',
      'runtime-identity/runtime-identity-provider', 'continuum/artifact-store', 'continuum/continuum-service']
    const pkg = require(path.join(root, 'package.json')), external = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(name => !['mdast-util-from-markdown', 'micromark-extension-gfm', 'mdast-util-gfm', 'mdast-util-to-string'].includes(name))
    const bundle = path.join(output, 'bundle')
    require('esbuild').buildSync({ entryPoints: entries.map(file => 'src/main/' + file + '.ts'), outdir: bundle, platform: 'node', format: 'cjs', bundle: true, external, logLevel: 'silent' })
    const get = name => require(path.join(bundle, name + '.js'))
    const repositoryId = randomUUID(), git = new (get('core/git-service').GitService)()
    const record = { id: repositoryId, name: 'PVO controlled repository identity', status: 'ACTIVE', updatedAt: 'fixture', localCheckout: { path: root, availability: 'AVAILABLE', gitState: 'GIT' } }
    const catalog = { resolveAvailable: id => { assert.equal(id, repositoryId); return record } }
    const repositories = new (get('work-orchestration/preview-repositories').PreviewRepositories)(catalog, (checkout, identity) => new (get('git-operations/git-operations-service').GitOperationsService)(checkout, git, new (get('github/github-git-transport').GitHubGitTransport)(null, git), identity, true))
    const context = await repositories.open(repositoryId), selected = context.worktrees.find(w => path.resolve(w.path).toLowerCase() === root.toLowerCase())
    assert.ok(selected); assert.equal(selected.branch, 'feat/pvo-artifact-first')
    const profiles = new (get('work-orchestration/preview-profile-store').PreviewProfileStore)(path.join(directory, 'profiles'))
    const resolver = new (get('work-orchestration/runtime-preview/code-awareness-profile').CodeAwarenessProfileResolver)(profiles, { root, executable: process.execPath, electronVersion: process.versions.electron, abi: process.versions.modules })
    fs.mkdirSync(path.join(directory, 'profiles'))
    const profile = await resolver.resolve(repositoryId, selected.worktreeId, root)
    await profiles.approve(profile, async () => true)
    const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex')
    const selection = { repositoryId, worktreeId: selected.worktreeId, generation: selected.generation, profileId: profile.profileId, fingerprint: hash(JSON.stringify(profile)) }
    const native = require('./build.cjs').build(false)
    const sessions = new (get('work-orchestration/runtime-preview/session-store').PreviewSessionStore)(path.join(directory, 'sessions'))
    const provisioner = new (get('work-orchestration/runtime-preview/context-data').RepositoryPreviewContextProvisioner)(catalog, path.join(directory, 'absent-host-corpus'))
    const runner = new (get('work-orchestration/runtime-preview/runner').RuntimePreviewRunner)(sessions, new (get('work-orchestration/runtime-preview/runner').CatalogPreviewLaunchAuthority)(repositories, profiles, new (get('work-orchestration/preview-preflight').PreviewPreflightService)(profiles)),
      { executable: native.owner, fingerprint: native.fingerprint, sdkDirectory: path.join(root, 'scripts/runtime-preview') }, provisioner)
    const store = new (get('continuum/artifact-store').ArtifactStore)(path.join(directory, 'explicit-host-fixture.db'), repositoryId)
    const continuum = new (get('continuum/continuum-service').ContinuumService)(store)
    const artifact = continuum.publish('---\nname: "Canonical fixture"\ndescription: "Explicit isolated canonical knowledge for PVO routing acceptance"\nkind: OBSERVATION\n---\nHost canonical knowledge remains here.\n')
    let activeRepositoryId = repositoryId
    const service = new (get('work-orchestration/runtime-preview/operations').RuntimePreviewOperations)(repositories, profiles, sessions, runner, async () => true, undefined,
      { getActiveSession: () => ({ repositoryId: activeRepositoryId }), getActiveService: () => continuum }, resolver)
    const identity = new (get('runtime-identity/runtime-identity-provider').RuntimeIdentityProvider)({ root })
    const adapter = new (get('mcp/channel-mcp-adapter').ChannelMcpAdapter)({ navigation: {}, projectId: repositoryId, repoRoot: root, continuum, runtimePreview: { service, isCurrent: () => true } }, undefined, identity)
    const server = get('mcp/mcp-http-server').createMcpHttpServer(adapter)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const endpoint = `http://127.0.0.1:${server.address().port}/mcp`
    let requestId = 0, liveSession
    async function call(name, args = {}) {
      const response = await fetch(endpoint, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name, arguments: args } }) })
      assert.equal(response.status, 200)
      const message = await response.json(); assert.ok(message.result, JSON.stringify(message))
      return message.result
    }
    const evidence = { scope: 'PRODUCTION_HTTP_CHANNEL_RUNNER_JOB_AND_REAL_PREVIEW_MAIN_WITH_ISOLATED_AUTHORIZATION_AND_CANONICAL_FIXTURES', directory, selection, nativeBuild: native.buildId, scenarios: [] }
    try {
      const before = await call('get_runtime_identity'); assert.ok(!before.isError)
      for (const mode of ['STOP', 'CRASH']) {
        liveSession = await runner.start({ operationId: randomUUID(), selection })
        assert.equal(liveSession.state, 'RUNNING', JSON.stringify({ state: liveSession.state, failure: liveSession.failure, directory }))
        assert.equal(liveSession.readiness, 'READY'); assert.equal(liveSession.context.data.policy, 'ARTIFACT_FIRST')
        const scope = { sessionId: liveSession.sessionId, repositoryId, worktreeId: selected.worktreeId, generation: selected.generation }
        const invoke = (operation, input = {}) => call('invoke_runtime_preview_operation', { scope, operation, input })
        const discovery = await call('discover_runtime_preview_capabilities', { scope }); assert.ok(!discovery.isError, JSON.stringify(discovery))
        const preview = (await invoke('runtime.identity')).structuredContent
        assert.equal(preview.success, true); assert.notEqual(preview.data.identity.pid, process.pid)
        assert.equal(preview.data.identity.source.branch, 'feat/pvo-artifact-first')
        const previewDirectory = sessions.runtime(liveSession.sessionId)
        assert.equal(fs.existsSync(path.join(previewDirectory, 'userData', 'continuum')), false)
        assert.equal(fs.existsSync(path.join(directory, 'absent-host-corpus')), false)
        const navigation = await invoke('checkout.list', { path: 'src/main/work-orchestration/runtime-preview' }); assert.ok(!navigation.isError)
        const absent = await invoke('runtime.restart'); assert.equal(absent.structuredContent.code, 'CAPABILITY_UNAVAILABLE')
        const knowledge = await invoke('continuum.get', { artifactId: artifact.artifactId }); assert.equal(knowledge.structuredContent.data.target, 'HOST_CANONICAL')
        activeRepositoryId = 'other-repository'
        assert.equal((await invoke('continuum.get', { artifactId: artifact.artifactId })).structuredContent.code, 'PREVIEW_UNAVAILABLE')
        activeRepositoryId = repositoryId
        assert.ok(!(await call('get_runtime_identity')).isError)
        fs.writeFileSync(path.join(output, 'running.json'), JSON.stringify({ sessionId: scope.sessionId, preview: preview.data.identity, hostPid: process.pid }))
        if (mode === 'CRASH') {
          process.kill(preview.data.identity.pid)
          await new Promise(resolve => setTimeout(resolve, 200))
          assert.equal((await invoke('runtime.liveness')).isError, true)
        }
        const stopped = await runner.stop(scope.sessionId)
        assert.ok(['STOPPED', 'FAILED'].includes(stopped.state), JSON.stringify({ state: stopped.state, failure: stopped.failure }))
        assert.equal(stopped.resources, 'RELEASED'); assert.equal(stopped.process.activeProcesses, 0)
        assert.equal((await invoke('runtime.liveness')).isError, true)
        const after = await call('get_runtime_identity')
        assert.equal(JSON.parse(after.content[0].text).runtime.instanceId, JSON.parse(before.content[0].text).runtime.instanceId)
        assert.ok(!(await call('get_artifact', { artifactId: artifact.artifactId })).isError)
        evidence.scenarios.push({ mode, sessionId: scope.sessionId, preview: preview.data.identity, stopped: { state: stopped.state, resources: stopped.resources, processes: stopped.process.activeProcesses }, discovery: discovery.structuredContent })
        liveSession = null
      }
      fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2))
      console.log('PVO Artifact First: real Electron Main bridge, HTTP Channel, STOP/crash isolation and canonical scope PASS')
    } finally {
      if (liveSession) await runner.stop(liveSession.sessionId)
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close()
    }
    app.exit(0)
  }).catch(error => { console.error(error.stack); app.exit(1) })
}
