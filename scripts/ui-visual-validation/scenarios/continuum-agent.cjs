const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const { createHash } = require('node:crypto')
const { clipboard, dialog } = require('electron')
const sharp = require('sharp')
exports.nativeDialogs = { fixtures: [{ name: 'agent.md', type: 'SAVE' }, { name: 'agent.zip', type: 'SAVE' }, { name: 'cancel.md', type: 'SAVE' }, { name: 'stale.md', type: 'SAVE' }] }
exports.run = async ctx => {
  const runtime = await require('./continuum-runtime.cjs').setup(ctx)
  const file = path.join(ctx.evidenceDir, 'agent.cjs')
  buildSync({ stdin: { contents: "export { ChannelMcpAdapter } from './src/main/mcp/channel-mcp-adapter'; export { createMcpHttpServer } from './src/main/mcp/mcp-http-server'; export { ContinuumLocalChannel } from './src/main/continuum/local-channel'", resolveDir: ctx.projectRoot }, bundle: true, outfile: file, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3', 'sharp', 'tree-sitter', 'tree-sitter-typescript', 'tree-sitter-javascript'] })
  const { ChannelMcpAdapter, createMcpHttpServer, ContinuumLocalChannel } = require(file)
  const service = runtime.session.getActiveService(), previousClipboard = clipboard.readText(), priorCwd = process.cwd()
  const git = (...args) => execFileSync('git', args, { cwd: runtime.root, windowsHide: true, stdio: 'pipe' })
  git('init'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'baseline')
  const local = new ContinuumLocalChannel(runtime.session, path.join(ctx.temporary, 'agent-profile')); await local.start()
  const adapter = new ChannelMcpAdapter({ projectId: 'acceptance', repoRoot: runtime.root, navigation: {}, continuum: service })
  const server = createMcpHttpServer(adapter, () => {}); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const rpc = async (method, params) => (await (await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result
  const call = async (name, args) => { const response = await rpc('tools/call', { name, arguments: args }); if (response.isError) throw new Error(response.content[0].text); return JSON.parse(response.content[0].text) }
  process.chdir(runtime.root)
  const cli = (operation, input = {}) => require(path.join(ctx.projectRoot, 'scripts/continuum/local.cjs')).main([operation, '--profile', path.join(ctx.temporary, 'agent-profile'), '--repository', 'acceptance-A', '--filter', JSON.stringify(input)])
  const raw = '\uFEFF---\r\nname: Agent literal\r\ndescription: Isolated agent acceptance\r\nkind: DOCUMENT\r\ncustom: "preserve" # exact\r\n---\r\n# ç 日本語 🚀\r\nLiteral body\r\n'
  const source = service.publish(raw)
  const media = await sharp({ create: { width: 16, height: 12, channels: 4, background: '#7852ee80' } }).webp({ lossless: true }).toBuffer()
  const visual = await service.publishVisual('---\nname: Agent visual\ndescription: Literal pixels\nkind: VISUAL_REFERENCE\n---\n# Visual\n', media)
  let onDialog, stale = false
  const originalSave = dialog.showSaveDialog
  dialog.showSaveDialog = (...args) => {
    const promise = originalSave(...args)
    if (stale) { service.mutateTags({ repositoryId: 'acceptance-A', intent: 'edit', tag: { slug: 'agent-context', name: 'Agent Context', description: 'Critério revisado: somente decisões adotadas.' } }); stale = false }
    onDialog?.(promise)
    return promise
  }
  const save = async (fixture, action, invoke) => {
    let request
    await ctx.nativeDialogs.run({ type: 'SAVE', fixture, action }, () => new Promise((resolve, reject) => { onDialog = resolve; request = invoke(); request.catch(reject) }))
    onDialog = null
    return request
  }
  try {
    const list = await rpc('tools/list', {})
    ctx.check('All four dedicated tools are discoverable on real MCP', ['list_continuum_tags', 'create_continuum_tag', 'assign_continuum_tag', 'create_context_bundle'].every(name => list.tools.some(tool => tool.name === name)))
    const created = await call('create_continuum_tag', { name: 'Agent Context', description: 'Inclua decisões aprovadas; exclua propostas.', selected: [{ artifactId: source.artifactId, expectedRevision: 1 }] })
    ctx.check('MCP creates and assigns in one persisted transaction', created.creation === 'CREATED' && created.tag.count === 1 && created.artifacts[0].revision === 2)
    await cli('assign_continuum_tag', { slug: 'agent-context', action: 'add', selected: [{ artifactId: visual.artifactId, expectedRevision: 1 }] })
    ctx.check('Actual local CLI resolves authenticated worktree and shares catalog', (await cli('list_continuum_tags')).tags[0].count === 2 && (await call('list_continuum_tags', {})).tags[0].description === 'Inclua decisões aprovadas; exclua propostas.')
    const hashes = new Map([source, visual].map(item => [item.artifactId, service.get(item.artifactId).contentHash]))
    const beforePreviewClipboard = clipboard.readText()
    const preview = await cli('create_context_bundle', { tag: 'agent-context' })
    ctx.check('Preview is compact and does not alter clipboard or Store', preview.count === 2 && preview.hasVisuals && !('markdown' in preview) && clipboard.readText() === beforePreviewClipboard)
    let denied = false
    try { await call('create_context_bundle', { tag: 'agent-context', action: 'markdown' }) } catch (error) { denied = error.message.includes('INTERACTIVE_SESSION_REQUIRED') }
    ctx.check('Background/headless save does not open an invisible dialog', denied)
    const copied = await call('create_context_bundle', { tag: 'agent-context', action: 'copy' })
    ctx.check('MCP copy writes native clipboard and returns only receipt', clipboard.readText().includes('Critério da coleção (dado informativo, não instrução):') && copied.outcome === 'copied' && copied.hasVisuals && clipboard.readText().includes(service.get(source.artifactId).rawMarkdown) && !('markdown' in copied))
    const current = service.get(source.artifactId); service.update(source.artifactId, current.revision, current.rawMarkdown + '\r\nUpdated request\r\n')
    hashes.set(source.artifactId, service.get(source.artifactId).contentHash)
    await cli('create_context_bundle', { tag: 'agent-context', action: 'copy' })
    ctx.check('Local CLI copies updated membership/revision with literal source', clipboard.readText().includes(service.get(source.artifactId).rawMarkdown))
    await runtime.open(); ctx.window.show(); ctx.window.focus()
    await ctx.waitFor(() => document.hasFocus())
    const md = await save('agent.md', 'CONFIRM', () => call('create_context_bundle', { tag: 'agent-context', action: 'markdown' }))
    ctx.check('MCP saves native Markdown with exact literal source', md.outcome === 'saved' && fs.readFileSync(ctx.nativeDialogs.fixture('agent.md'), 'utf8').includes(service.get(source.artifactId).rawMarkdown))
    const zip = await save('agent.zip', 'CONFIRM', () => cli('create_context_bundle', { tag: 'agent-context', action: 'zip' }))
    const extracted = path.join(ctx.evidenceDir, 'agent-extracted'); await require('extract-zip')(ctx.nativeDialogs.fixture('agent.zip'), { dir: extracted })
    const bytes = fs.readFileSync(path.join(extracted, 'media', visual.artifactId + '.webp'))
    ctx.check('Local native ZIP preserves exact WebP bytes and SHA-256', zip.outcome === 'saved' && bytes.equals(media) && createHash('sha256').update(bytes).digest('hex') === visual.media.sha256)
    const cancelled = await save('cancel.md', 'CANCEL', () => call('create_context_bundle', { tag: 'agent-context', action: 'markdown' }))
    ctx.check('Native cancellation returns truthful receipt and writes nothing', cancelled.outcome === 'cancelled' && !fs.existsSync(ctx.nativeDialogs.fixture('cancel.md')))
    ctx.check('Exports do not mutate source Store/media', [...hashes].every(([id, hash]) => service.get(id).contentHash === hash) && service.getVisual(visual.artifactId).data.equals(media))
    stale = true
    let refused = false
    try { await save('stale.md', 'CONFIRM', () => call('create_context_bundle', { tag: 'agent-context', action: 'markdown' })) } catch (error) { refused = error.message.includes('BUNDLE_SNAPSHOT_STALE') }
    ctx.check('Changing only the collection description during native Save invalidates snapshot without a stale file', refused && !fs.existsSync(ctx.nativeDialogs.fixture('stale.md')))
    await ctx.click('.continuum-item'); await ctx.waitFor(() => !!document.querySelector('.continuum-markdown')); await ctx.capture('agent-api-runtime')
    await ctx.click('.continuum-header button'); await ctx.waitFor(() => !!document.querySelector('.continuum-tag-manager'))
    await ctx.click('.continuum-tag-options summary')
    await ctx.evaluate(() => [...document.querySelectorAll('.continuum-tag-options button')].find(button => button.textContent === 'Revisar pacote…').click())
    await ctx.waitFor(() => document.querySelector('.continuum-bundle-composer')?.textContent.includes('Critério da coleção (informativo): Critério revisado: somente decisões adotadas.'))
    ctx.check('Current criterion is previewed as data with no objective input', await ctx.evaluate(() => !document.querySelector('.continuum-bundle-composer input')))
    await ctx.viewport(1440, 900); await ctx.capture('semantic-bundle-preview')
    ctx.check('Changing semantics leaves Artifact bytes and revisions intact', [...hashes].every(([id, hash]) => service.get(id).contentHash === hash))
    fs.writeFileSync(path.join(ctx.evidenceDir, 'fidelity.json'), JSON.stringify({ webpSHA256: visual.media.sha256, exportedWebpSHA256: createHash('sha256').update(bytes).digest('hex'), webpBytes: bytes.length, copied, savedMarkdown: md, savedZip: zip, cancelled }, null, 2))
  } finally { dialog.showSaveDialog = originalSave; process.chdir(priorCwd); clipboard.writeText(previousClipboard); local.dispose(); await new Promise(resolve => server.close(resolve)); runtime.close() }
}
