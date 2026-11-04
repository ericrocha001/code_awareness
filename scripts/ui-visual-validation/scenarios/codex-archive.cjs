const fs = require('node:fs'), path = require('node:path')
const { buildSync } = require('esbuild')
exports.preload = path.join(__dirname, 'codex-archive-preload.cjs')

exports.run = async ctx => {
  const script = path.join(ctx.evidenceDir, 'fixture.js'), page = path.join(ctx.evidenceDir, 'index.html')
  const native = path.join(ctx.evidenceDir, 'native.cjs')
  buildSync({ stdin: { contents: `export { CodexArchiveBridge } from './src/main/session-context/codex-archive-bridge'; export { registerCodexArchiveHandlers } from './src/main/ipc/codex-archive-handler'; export { discoverCodexArchive } from './src/main/session-context/codex-discovery'; export { queryCodexArchive } from './src/main/session-context/codex-archive'`, resolveDir: process.cwd(), loader: 'ts' }, outfile: native, bundle: true, platform: 'node', packages: 'external', external: ['electron'], logLevel: 'silent' })
  const { CodexArchiveBridge, registerCodexArchiveHandlers, discoverCodexArchive, queryCodexArchive } = require(native)
  const profile = path.join(ctx.temporary, 'codex-fixture'), local = path.join(profile, 'local'), executable = path.join(local, 'OpenAI/Codex/bin/fixture/codex.exe')
  fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.mkdirSync(path.join(profile, '.codex')); fs.writeFileSync(executable, 'synthetic fixture, never executed')
  let probes = 0, dialogs = 0, connection
  const methods = [], electronDialog = require('electron').dialog, originals = [electronDialog.showOpenDialog, electronDialog.showMessageBox]
  electronDialog.showOpenDialog = electronDialog.showMessageBox = async () => { dialogs++; throw new Error('UNEXPECTED_DIALOG') }
  const bridge = new CodexArchiveBridge({ repositoryId: 'fixture', root: profile, isCurrent: () => true,
    changed: (value, readiness) => { connection = value; ctx.window.webContents.send('codex-archive:changed', readiness) },
    probe: async () => { probes++; return { version: '0.155.0', supports: { archived: true, cwd: true, stateDbOnly: true } } },
    connect: () => ({ initialized: () => {}, close: () => {}, request: async (method, params) => { methods.push({ method, params }); return method === 'initialize' ? { userAgent: 'codex/0.155.0' } : method === 'account/read' ? { account: { type: 'chatgpt', email: 'fixture@example.invalid' } } : { data: [{ id: 'fixture-session', cwd: profile, preview: 'PRIVATE' }], nextCursor: null } } }) })
  registerCodexArchiveHandlers(() => bridge, () => ctx.window, require('node:url').pathToFileURL(page).href, () => discoverCodexArchive({ LOCALAPPDATA: local }, profile))
  try {
  buildSync({ entryPoints: [path.join(__dirname, 'codex-archive-fixture.tsx')], outfile: script, bundle: true, platform: 'browser', jsx: 'automatic', logLevel: 'silent' })
  fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  await ctx.load(page); await ctx.viewport(1024, 780)
  await ctx.waitFor(() => document.querySelector('.settings-codex button')?.textContent === 'Conectar ao Codex' && !document.querySelector('.settings-codex button').disabled)
  await ctx.evaluate(() => document.querySelector('.settings-codex').scrollIntoView({ block: 'center' }))
  ctx.check('Existing Git control remains visible in the single settings scroll region', await ctx.evaluate(() => {
    const row = document.querySelector('[aria-label="Fetch automático condicionado ao remoto"]').closest('.settings-row').getBoundingClientRect()
    const body = document.querySelector('.settings-body').getBoundingClientRect()
    return row.height >= 40 && row.top >= body.top && row.bottom <= body.bottom
  }))
  ctx.check('Discovery is passive and requires a click', probes === 0 && methods.length === 0 && dialogs === 0)
  await ctx.capture('codex-archive-disconnected-dark-desktop')
  await ctx.click('.settings-codex button')
  await ctx.waitFor(() => document.querySelector('.settings-codex button')?.textContent === 'Desconectar')
  ctx.check('One native click through UI, IPC and bridge; zero pickers and confirmations', probes === 1 && dialogs === 0 && methods.map(call => call.method).join() === 'initialize,account/read')
  const observation = await queryCodexArchive(connection, 'fixture', profile, new AbortController().signal)
  ctx.check('Only archived metadata in the verified cwd', observation.code === 'ARCHIVE_OBSERVED' && !JSON.stringify(observation).includes('PRIVATE') && methods.find(call => call.method === 'thread/list')?.params.useStateDbOnly === true)
  ctx.check('Connected fixture offers disconnect', await ctx.evaluate(() => document.querySelector('.settings-codex [role="status"]').textContent.includes('Codex 0.155.0')))
  await ctx.capture('codex-archive-connected-dark-desktop')
  bridge.disable('ACCOUNT_IDENTITY_UNAVAILABLE')
  await ctx.waitFor(() => document.querySelector('.settings-codex [role="status"]')?.textContent === 'Não foi possível confirmar a conta')
  await ctx.viewport(400, 720)
  await ctx.evaluate(() => document.querySelector('.settings-codex button').scrollIntoView({ block: 'center' }))
  await ctx.capture('codex-archive-account-unavailable-dark-narrow')
  ctx.check('Codex section stays inside dialog width', await ctx.evaluate(() => {
    const section = document.querySelector('.settings-codex'), dialog = document.querySelector('.settings-modal')
    return section.getBoundingClientRect().right <= dialog.getBoundingClientRect().right + 1 && section.scrollWidth <= section.clientWidth + 1
  }))
  await ctx.click('.settings-codex button')
  await ctx.waitFor(() => document.querySelector('.settings-codex button')?.textContent === 'Desconectar')
  await ctx.evaluate(() => document.querySelector('.settings-codex button').scrollIntoView({ block: 'center' }))
  await ctx.click('.settings-codex button')
  await ctx.waitFor(() => document.querySelector('.settings-codex [role="status"]')?.textContent === 'Pronto para conectar')
  ctx.check('Disconnect returns to metadata-disabled state', true)
  } finally { bridge.disable(); electronDialog.showOpenDialog = originals[0]; electronDialog.showMessageBox = originals[1] }
}
