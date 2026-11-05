const { spawn, execFileSync } = require('node:child_process')
const { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { randomUUID } = require('node:crypto')
const { buildSync } = require('esbuild')
const assert = require('node:assert/strict')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

async function main() {
  if (!process.argv.includes('--authorized-test-hooks')) throw new Error('ISOLATED_TEST_HOOK_AUTHORIZATION_REQUIRED')
  const codex = process.argv[process.argv.indexOf('--codex') + 1]
  const version = execFileSync(codex, ['--version'], { encoding: 'utf8', windowsHide: true }).trim()
  assert.equal(version, 'codex-cli 0.166.0-alpha.6', 'QUALIFY_CODEX_PROTOCOL_FIRST')
  const source = resolve(__dirname, '../..'), evidence = join(source, '.code-awareness/publication-pilot', randomUUID()), root = join(evidence, 'repo')
  mkdirSync(root, { recursive: true })
  execFileSync('git', ['init', '-b', 'pilot', root], { windowsHide: true, stdio: 'pipe' })
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Isolated publication fixture'], { windowsHide: true, stdio: 'pipe' })
  const server = join(evidence, 'server.cjs'), worker = join(evidence, 'worker.cjs')
  buildSync({ entryPoints: [join(__dirname, 'publication-pilot-server.ts')], outfile: server, bundle: true, platform: 'node', format: 'cjs',
    alias: { 'better-sqlite3': require.resolve('better-sqlite3'), sharp: require.resolve('sharp') }, external: [require.resolve('better-sqlite3'), require.resolve('sharp')], logLevel: 'silent' })
  const code = buildSync({ entryPoints: [join(source, 'src/main/session-context/worker.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
  writeFileSync(worker, 'require = require("node:module").createRequire(' + JSON.stringify(join(source, 'package.json')) + ');\n' + code)
  const electron = require('electron'), repositoryId = 'pilot-' + randomUUID(), env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  const prepared = JSON.parse(execFileSync(electron, [server, 'prepare', root, repositoryId, worker, process.execPath, join(source, 'out/session-context/native-hook.cjs')], { env, windowsHide: true, encoding: 'utf8' }))
  assert.equal(prepared.hookEvents, 7)
  const configuredHooks = JSON.parse(readFileSync(join(root, '.codex/hooks.json'), 'utf8')).hooks
  const args = ['--enable', 'hooks', '--disable', 'apps', 'app-server', '--stdio',
    '-c', 'mcp_servers.code_awareness_local.command=' + JSON.stringify(electron),
    '-c', 'mcp_servers.code_awareness_local.args=' + JSON.stringify([server, 'serve', root, repositoryId, worker]),
    '-c', 'mcp_servers.code_awareness_local.env.ELECTRON_RUN_AS_NODE="1"']
  for (const [event, groups] of Object.entries(configuredHooks)) {
    const hook = groups[0].hooks[0]
    args.push('-c', `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(hook.command)},command_windows=${JSON.stringify(hook.commandWindows)},timeout=3}]}]`)
  }
  const exerciseUpdate = process.argv.includes('--exercise-update')
  const prompt = 'Isolated publication acceptance test. Call code_awareness_local.publish_artifact exactly once with rawMarkdown "# Publicação real de proveniência\\n\\nEsta observação comprova uma publicação real e recuperável pelo MCP.\\n" and kind "OBSERVATION". ' +
    (exerciseUpdate ? 'Then call code_awareness_local.update_artifact exactly once using the returned artifactId, expectedRevision 1, rawMarkdown "# Atualização causal real\\n\\nRevisão dois comprovada.\\n", kind "OBSERVATION". ' : '') + 'No other tools or file inspection. Then stop.'
  const runtimeEvents = [], diagnostics = new Set()
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(codex, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const send = value => child.stdin.write(JSON.stringify(value) + '\n')
    let threadId
    let pending = '', completed = false
    const timer = setTimeout(() => { diagnostics.add('CODEX_TIMEOUT'); child.kill() }, 180000)
    child.stdout.on('data', chunk => {
      pending += chunk.toString('utf8')
      const lines = pending.split('\n'); pending = lines.pop()
      for (const line of lines) {
        let event
        try { event = JSON.parse(line) } catch { continue }
        if (event.id !== undefined && event.method) {
          if (event.method === 'mcpServer/elicitation/request' && event.params.serverName === 'code_awareness_local' && event.params.mode === 'form') {
            send({ id: event.id, result: { action: 'accept', content: {} } })
          } else send({ id: event.id, error: { code: -32601, message: 'UNEXPECTED_PILOT_REQUEST' } })
          continue
        }
        if (event.error) { diagnostics.add('CODEX_PROTOCOL_ERROR'); child.kill(); continue }
        if (event.id === 1) {
          send({ method: 'initialized' })
          send({ id: 2, method: 'hooks/list', params: { cwds: [root] } })
        } else if (event.id === 2) {
          const hooks = event.result.data.flatMap(entry => entry.hooks)
          if (hooks.length !== 7 || hooks.some(hook => hook.source !== 'sessionFlags' || !hook.enabled)) {
            diagnostics.add('HOOK_PREFLIGHT_FAILED'); child.kill(); continue
          }
          const state = Object.fromEntries(hooks.map(hook => [hook.key, { trusted_hash: hook.currentHash, enabled: true }]))
          send({ id: 3, method: 'thread/start', params: { cwd: root, ephemeral: true, approvalPolicy: 'on-request', config: { hooks: { ...configuredHooks, state } } } })
        } else if (event.id === 3) {
          threadId = event.result.thread.id
          send({ id: 4, method: 'hooks/list', params: { threadId } })
        } else if (event.id === 4) {
          const hooks = event.result.data.flatMap(entry => entry.hooks)
          if (hooks.length !== 7 || hooks.some(hook => hook.trustStatus !== 'trusted')) {
            diagnostics.add('HOOK_TRUST_NOT_APPLIED'); child.kill(); continue
          }
          send({ id: 5, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: prompt }] } })
        } else if (event.method === 'hook/completed') {
          const run = event.params.run
          runtimeEvents.push({ type: 'hook/completed', eventName: run.eventName, status: run.status })
          if (run.status !== 'completed') diagnostics.add('HOOK_EXECUTION_FAILED')
        } else if (event.method === 'turn/completed') {
          completed = event.params.turn.status === 'completed'
          setTimeout(() => child.kill(), 1500)
        }
      }
    })
    child.stderr.on('data', () => {})
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); resolveExit(completed ? 0 : 1) })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'continuum-publication-pilot', version: '1' }, capabilities: { experimentalApi: true } } })
  })

  const files = readdirSync(join(root, '.code-awareness/native-hooks/spool')).filter(name => /^\d+\.json$/.test(name))
  const observed = files.map(name => JSON.parse(readFileSync(join(root, '.code-awareness/native-hooks/spool', name), 'utf8')))
  const names = [...new Set(observed.flatMap(event => event.artifact ? [event.artifact.tool] : []))]
  writeFileSync(join(evidence, 'runtime.json'), JSON.stringify({ version, exitCode, hookEvents: observed.map(e => e.event), recognizedToolNames: names, runtimeEvents, diagnostics: [...diagnostics] }))
  assert.equal(exitCode, 0, 'CODEX_ACCEPTANCE_PROCESS_FAILED: ' + evidence)
  if (!existsSync(join(root, 'publication.json'))) throw new Error('REAL_PUBLICATION_NOT_OBSERVED: ' + evidence)
  const published = JSON.parse(readFileSync(join(root, 'publication.json'), 'utf8'))
  const receipt = exerciseUpdate ? JSON.parse(readFileSync(join(root, 'update.json'), 'utf8')) : published
  const query = async () => {
    const transport = new StdioClientTransport({ command: electron, args: [server, 'serve', root, repositoryId, worker], env })
    const client = new Client({ name: 'publication-pilot-verifier', version: '1' })
    try {
      await client.connect(transport)
      const discover = async selector => {
        let cursor
        const edges = []
        for (let page = 0; page < 32; page++) {
          const response = await client.callTool({ name: 'discover_execution_context', arguments: { selector, mode: 'RELATION_DETAIL', limit: 24, ...(cursor ? { cursor } : {}) } })
          assert.notEqual(response.isError, true)
          const result = JSON.parse(response.content[0].text)
          edges.push(...result.edges)
          if (!result.nextCursor) return { ...result, edges }
          cursor = result.nextCursor
        }
        throw new Error('PILOT_GRAPH_PAGE_LIMIT')
      }
      const graph = await discover({ type: 'ARTIFACT', id: receipt.artifactId, revision: receipt.revision })
      const read = await client.callTool({ name: 'get_artifact', arguments: { artifactId: receipt.artifactId } })
      const artifact = JSON.parse(read.content[0].text)
      assert.equal(artifact.provenance?.nativeArtifact?.state, 'VERIFIED', 'REAL_CHAIN_NOT_VERIFIED')
      assert.equal(artifact.provenance.nativeArtifact.revision, receipt.revision)
      assert.equal(graph.edges.filter(edge => edge.evidenceKind === 'NATIVE_ARTIFACT_CAUSAL' && edge.evidenceRef === receipt.publicationReceipt.receiptId && edge.state === 'VERIFIED').length, 3)
      for (const selector of [
        { type: 'SESSION', provider: 'codex-native', id: artifact.provenance.nativeArtifact.sessionId },
        { type: 'EXECUTION', id: 'native-invocation:' + artifact.provenance.nativeArtifact.invocationId }
      ]) {
        const selected = await discover(selector)
        assert.equal(selected.edges.filter(edge => edge.evidenceKind === 'NATIVE_ARTIFACT_CAUSAL' && edge.evidenceRef === receipt.publicationReceipt.receiptId && edge.state === 'VERIFIED').length, 3, 'SELECTOR_CHAIN_MISMATCH:' + selector.type)
      }
      if (exerciseUpdate) {
        const historical = await discover({ type: 'ARTIFACT', id: published.artifactId, revision: 1 })
        assert.equal(historical.edges.filter(edge => edge.evidenceKind === 'NATIVE_ARTIFACT_CAUSAL' && edge.evidenceRef === published.publicationReceipt.receiptId && edge.state === 'VERIFIED').length, 3)
      }
      return { graph, nativeArtifact: artifact.provenance.nativeArtifact }
    } finally { await client.close() }
  }
  const first = await query(), restarted = await query()
  assert.deepEqual(restarted.nativeArtifact, first.nativeArtifact)
  assert.deepEqual(names.sort(), ['mcp__code_awareness_local__publish_artifact', ...(exerciseUpdate ? ['mcp__code_awareness_local__update_artifact'] : [])])
  const result = { state: 'VERIFIED', version, evidence, repositoryId, receiptId: receipt.publicationReceipt.receiptId, artifactId: receipt.artifactId, revision: receipt.revision,
    recognizedToolNames: names, nativeArtifact: restarted.nativeArtifact, edges: restarted.graph.edges.filter(edge => edge.evidenceKind === 'NATIVE_ARTIFACT_CAUSAL') }
  writeFileSync(join(evidence, 'proof.json'), JSON.stringify(result, null, 2))
  process.stdout.write(JSON.stringify(result) + '\n')
}
main().catch(error => { process.stderr.write(String(error.message).slice(0, 1000) + '\n'); process.exitCode = 1 })
