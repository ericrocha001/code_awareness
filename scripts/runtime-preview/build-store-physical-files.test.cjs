const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { spawnSync } = require('node:child_process')
test('capture uses physical ASAR bytes inside a real Electron host', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvo-asar-regression-'))
  try {
    const helper = path.join(directory, 'files.cjs'), entry = path.join(directory, 'probe.cjs')
    require('esbuild').buildSync({ entryPoints: ['src/main/work-orchestration/preview-build/files.ts'], outfile: helper, platform: 'node', format: 'cjs', bundle: true, packages: 'external', logLevel: 'silent' })
    fs.writeFileSync(entry, `const {app}=require('electron'),assert=require('node:assert/strict'),fs=require('original-fs'),path=require('node:path');app.whenReady().then(async()=>{const {snapshot,verify}=require(${JSON.stringify(helper)});const root=${JSON.stringify(path.resolve('node_modules/electron/dist/resources'))},target=${JSON.stringify(path.join(directory, 'copy'))};const files=await snapshot(root,['default_app.asar'],target);assert.equal(files[0].bytes,fs.statSync(path.join(root,'default_app.asar')).size);await verify(target,files);assert.deepEqual(fs.readFileSync(path.join(target,'default_app.asar')),fs.readFileSync(path.join(root,'default_app.asar')));app.exit(0)}).catch(e=>{console.error(e);app.exit(1)});`)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(require('electron'), [entry], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
  } finally {
    const actual = fs.realpathSync(directory), relative = path.relative(fs.realpathSync(os.tmpdir()), actual)
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(actual).startsWith('pvo-asar-regression-'))
    fs.rmSync(actual, { recursive: true })
  }
})
