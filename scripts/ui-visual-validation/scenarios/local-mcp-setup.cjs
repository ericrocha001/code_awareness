const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url')
const { buildSync } = require('esbuild')
exports.run = async ctx => {
  const { ipcMain } = require('electron')
  const backend = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({ stdin: { contents: "export {LocalMcpClientService} from './src/main/local-mcp-clients/local-mcp-client-service'; export {registerLocalMcpClientHandlers} from './src/main/ipc/local-mcp-client-handler'", resolveDir: ctx.projectRoot }, outfile: backend, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
  const api = require(backend)
  const home = path.join(ctx.temporary, 'home')
  for (const folder of ['.codex', '.gemini/config', '.cline/data/settings', 'AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/settings']) fs.mkdirSync(path.join(home, folder), { recursive: true })
  const cline = path.join(home, '.cline/data/settings/cline_mcp_settings.json')
  const vscode = path.join(home, 'AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json')
  const codex = path.join(home, '.codex/config.toml')
  const antigravity = path.join(home, '.gemini/config/mcp_config.json')
  fs.writeFileSync(codex, '# preserved user comment\n[mcp_servers.other]\ncommand="existing"\nargs=[]\n')
  for (const file of [cline, vscode, antigravity]) fs.writeFileSync(file, '{"mcpServers":{"existing":{"command":"keep","env":{"TOKEN":"fixture-private"}}}}')
  const service = new api.LocalMcpClientService({ home, appData: path.join(home, 'AppData/Roaming'), localAppData: path.join(home, 'AppData/Local'), sourceBundle: path.join(ctx.projectRoot, 'out/local-mcp/launcher.cjs'), command: path.join(process.env.ProgramFiles, 'nodejs/node.exe'), profile: path.join(home, 'desktop'), packaged: false, env: {}, probe: async () => { throw new Error('MCP_SESSION_INVALIDATED') } })
  let detections = 0
  const detect = service.detect.bind(service)
  service.detect = () => { detections++; return detect() }
  const page = path.join(ctx.temporary, 'index.html'), preload = path.join(ctx.temporary, 'preload.cjs')
  buildSync({ entryPoints: [path.join(ctx.projectRoot, 'src/main/preload.ts')], outfile: preload, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  ctx.window.webContents.session.setPreloads([preload])
  api.registerLocalMcpClientHandlers(service, pathToFileURL(page).href)
  const counters = { activeRequests: 0, peakConcurrentRequests: 0, totalRequests: 0, succeededRequests: 0, failedRequests: 0, timedOutRequests: 0, latency: { completedRequests: 0, totalDurationMs: 0, lastDurationMs: null, maxDurationMs: null } }
  ipcMain.handle('channel:get-state', () => ({ revision: 1, availability: 'DISABLED', remoteAccessEnabled: false, transport: 'relay', connectionStatus: 'STOPPED', mcpStatus: 'STOPPED', activeProject: null, installationConfigured: false, lastError: null, functionalHealth: { status: 'UNKNOWN' }, activity: { ...counters, byTool: {}, byCapability: {} } }))
  buildSync({ entryPoints: [path.join(__dirname, 'local-mcp-setup-fixture.tsx')], outfile: path.join(ctx.temporary, 'fixture.js'), bundle: true, platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'silent' })
  fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  await ctx.load(page)
  ctx.check('Startup does not mount Channel', await ctx.evaluate(() => !document.querySelector('.channel-view')))
  await ctx.evaluate(() => [...document.querySelectorAll('nav button')].find(button => button.textContent === 'Channel').click())
  await ctx.waitFor(() => document.querySelectorAll('.local-mcp-client').length === 3)
  ctx.check('First paint leaves all three clients unverified', await ctx.evaluate(() => [...document.querySelectorAll('.local-mcp-client .channel-badge')].every(badge => badge.textContent === 'Não verificado')))
  await ctx.evaluate(() => {
    document.querySelector('.channel-view').dataset.retained = 'yes'
    const selector = document.querySelector('select[aria-label="Destino Cline"]')
    selector.value = 'cline-vscode'; selector.dispatchEvent(new Event('change', { bubbles: true })); selector.focus()
    ;[...document.querySelectorAll('nav button')].find(button => button.textContent === 'Home').click()
  })
  ctx.check('Hidden Channel is outside layout and cannot receive focus', await ctx.evaluate(() => {
    const panel = document.querySelector('.channel-tab'), selector = panel.querySelector('select')
    selector.focus()
    return panel.hidden && panel.hasAttribute('inert') && getComputedStyle(panel).display === 'none' && document.activeElement !== selector
  }))
  await ctx.evaluate(() => [...document.querySelectorAll('nav button')].find(button => button.textContent === 'Channel').click())
  ctx.check('Returning retains the same view and variant', await ctx.evaluate(() => document.querySelector('.channel-view').dataset.retained === 'yes' && document.querySelector('select[aria-label="Destino Cline"]').value === 'cline-vscode'))
  ctx.check('Navigation never scans client profiles', detections === 0)
  ctx.check('Remote access disabled does not hide local setup', await ctx.evaluate(() => document.body.textContent.includes('Configurar MCP Local') && document.body.textContent.includes('Acesso remoto desativado')))
  for (const id of ['codex', 'antigravity', 'cline', 'cline-vscode']) {
    const receipt = await ctx.evaluate(async client => {
      const api = window.codeAwareness.localMcpClients
      const first = await api.preview(client, 'connect')
      let denied = false
      try { await api.apply(first.token, false, false) } catch { denied = true }
      const connected = await api.apply(first.token, true, false)
      const again = await api.preview(client, 'connect')
      await api.apply(again.token, true, false)
      const checked = await api.verify(client)
      return { denied, connected, duplicate: again.changes, checked }
    }, id)
    ctx.check(`${id}: real preload IPC, explicit consent, idempotent install`, receipt.denied && receipt.connected.configuration === 'INSTALLED' && !receipt.duplicate)
    ctx.check(`${id}: session error is separate from config and native acceptance`, receipt.checked.configuration === 'INSTALLED' && receipt.checked.bootstrap === 'ERROR' && receipt.checked.clientUse === 'NOT_CONFIRMED')
  }
  ctx.check('TOML comments and existing MCP preserved', fs.readFileSync(codex, 'utf8').startsWith('# preserved user comment\n[mcp_servers.other]\ncommand="existing"\nargs=[]\n'))
  ctx.check('All JSON clients preserve other MCP credentials', [cline, vscode, antigravity].every(file => JSON.parse(fs.readFileSync(file)).mcpServers.existing.env.TOKEN === 'fixture-private'))
  await ctx.load(page)
  await ctx.evaluate(() => [...document.querySelectorAll('nav button')].find(button => button.textContent === 'Channel').click())
  await ctx.waitFor(() => document.querySelectorAll('.local-mcp-client').length === 3)
  await ctx.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.includes('Detectar')).click())
  await ctx.waitFor(() => [...document.querySelectorAll('.local-mcp-client .channel-badge')].every(badge => badge.textContent === 'Configurado'))
  ctx.check('Renderer contains no other MCP secrets', await ctx.evaluate(() => !document.body.textContent.includes('fixture-private')))
  await ctx.capture('local-mcp-desktop')
  await ctx.overflow()
  await ctx.evaluate(() => document.querySelectorAll('.local-mcp-client button')[1].click())
  await ctx.waitFor(() => !!document.querySelector('.local-mcp-preview'))
  ctx.check('Preview confirmation starts disabled', await ctx.evaluate(() => document.querySelector('.local-mcp-preview button').disabled))
  await ctx.evaluate(() => {
    document.querySelector('.local-mcp-preview input').click()
    ;[...document.querySelectorAll('nav button')].find(button => button.textContent === 'Home').click()
  })
  await ctx.evaluate(() => [...document.querySelectorAll('nav button')].find(button => button.textContent === 'Channel').click())
  ctx.check('Returning discards abandoned preview and consent without redetecting', detections === 1 && await ctx.evaluate(() => !document.querySelector('.local-mcp-preview')))
  await ctx.evaluate(() => document.querySelectorAll('.local-mcp-client button')[1].click())
  await ctx.waitFor(() => !!document.querySelector('.local-mcp-preview'))
  ctx.check('A new preview requires new consent', await ctx.evaluate(() => document.querySelector('.local-mcp-preview button').disabled && !document.querySelector('.local-mcp-preview input').checked))
  await ctx.evaluate(() => document.querySelector('.local-mcp-preview').scrollIntoView({ block: 'center' }))
  await ctx.capture('local-mcp-preview')
  await ctx.evaluate(() => document.querySelectorAll('.local-mcp-preview button')[1].click())
  await ctx.viewport(460, 900)
  await ctx.evaluate(() => document.querySelector('.channel-content').scrollTop = 0)
  await ctx.capture('local-mcp-narrow')
  await ctx.overflow()
  for (const id of ['codex', 'antigravity', 'cline', 'cline-vscode']) {
    const removed = await ctx.evaluate(async client => { const api = window.codeAwareness.localMcpClients; const p = await api.preview(client, 'disconnect'); return api.apply(p.token, true, false) }, id)
    ctx.check(`${id}: remove only managed entry`, removed.configuration === 'ABSENT')
  }
  ctx.check('Other MCPs survive disconnect', [cline, vscode, antigravity].every(file => Object.keys(JSON.parse(fs.readFileSync(file)).mcpServers).join() === 'existing'))
}
