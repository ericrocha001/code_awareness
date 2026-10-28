const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { ensureDependencyReadiness, npmCommand, snapshot } = require('./dependency-readiness.cjs')

const root = fs.realpathSync(path.join(__dirname, '..'))
const directory = path.join(root, '.code-awareness', 'dependency-readiness-proof')
fs.mkdirSync(directory, { recursive: true })
const proof = fs.mkdtempSync(path.join(directory, 'run-'))
const owned = target => { const relative = path.relative(root, path.resolve(target)); if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('PROOF_PATH_OUTSIDE_CHECKOUT'); return target }
const archiver = owned(path.join(root, 'node_modules', 'archiver')), backup = owned(path.join(proof, 'archiver-backup'))
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const manifests = () => ['package.json', 'package-lock.json'].map(file => hash(path.join(root, file)))
const killTree = child => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
}
async function development(label, ignoreScripts = false) {
  const profile = owned(path.join(proof, label)); fs.mkdirSync(profile)
  const cli = npmCommand(snapshot(root), process.env).args[0]
  const hook = path.join(__dirname, 'dependency-readiness-electron-proof.cjs').replace(/\\/g, '/')
  const env = { ...process.env, npm_config_ignore_scripts: String(ignoreScripts), CODE_AWARENESS_DEPENDENCY_PROOF: profile, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require="${hook}"` }
  delete env.ELECTRON_RUN_AS_NODE
  const log = fs.openSync(path.join(profile, 'development.log'), 'w')
  const child = spawn(process.execPath, [cli, '--ignore-scripts=' + ignoreScripts, 'run', 'dev'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
  let text = '', timer
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { text += bytes; fs.writeSync(log, bytes) })
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolve() : reject(Error(`Development ${label} exited ${code}; see ${profile}`)))
      timer = setTimeout(() => { killTree(child); reject(Error(`Development ${label} timed out; see ${profile}`)) }, 180000)
    })
    const electron = JSON.parse(fs.readFileSync(path.join(profile, 'electron.json')))
    if (!electron.archiverLoaded || !electron.userData.startsWith(profile + path.sep)) throw Error('ELECTRON_PROOF_INVALID')
    return { label, electron, installations: (text.match(/\[Dependency Readiness\] SYNC_REQUIRED/g) ?? []).length, gates: (text.match(/\[Dependency Readiness\] (READY|REPAIRED)/g) ?? []).length, nativeHealthy: text.includes('Native Runtime    HEALTHY'), repairBeforeElectron: text.indexOf('[Dependency Readiness] REPAIRED') >= 0 && text.indexOf('[Dependency Readiness] REPAIRED') < text.indexOf('start electron app...') }
  } finally { clearTimeout(timer); if (child.exitCode === null && !child.signalCode) killTree(child); fs.closeSync(log) }
}
async function main() {
  await ensureDependencyReadiness({ root, install: () => { throw Error('Acceptance requires an initially prepared checkout') } })
  const before = manifests()
  if (process.argv.includes('--healthy-only')) {
    const ignored = await development('ignored-hooks', true)
    if (ignored.installations !== 0 || ignored.gates !== 1 || !ignored.nativeHealthy || JSON.stringify(before) !== JSON.stringify(manifests())) throw Error('IGNORED_HOOKS_ACCEPTANCE_FAILED')
    const result = { status: 'PASS', checkout: root, manifestHashes: before, runs: [ignored], proof }
    fs.writeFileSync(path.join(proof, 'receipt.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); return
  }
  fs.renameSync(archiver, backup)
  try {
    const repaired = await development('missing-archiver')
    const healthy = await development('healthy-repeat')
    const ignored = await development('ignored-hooks', true)
    if (repaired.installations !== 1 || repaired.gates !== 1 || !repaired.repairBeforeElectron || healthy.installations !== 0 || healthy.gates !== 1 || !repaired.nativeHealthy || !healthy.nativeHealthy || JSON.stringify(before) !== JSON.stringify(manifests())) throw Error('DEPENDENCY_ACCEPTANCE_FAILED')
    if (ignored.installations !== 0 || ignored.gates !== 1 || !ignored.nativeHealthy) throw Error('IGNORED_HOOKS_ACCEPTANCE_FAILED')
    const result = { status: 'PASS', checkout: root, manifestHashes: before, runs: [repaired, healthy, ignored], proof }
    fs.writeFileSync(path.join(proof, 'receipt.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
  } finally {
    if (!fs.existsSync(archiver)) fs.renameSync(backup, archiver)
    else if (fs.existsSync(backup)) fs.rmSync(owned(backup), { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
