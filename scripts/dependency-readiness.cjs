const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const { validateNpmVersion } = require('./native-runtime-policy.cjs')
const { validateLockfileCompatibility } = require('./native-bootstrap-preflight.cjs')

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (root, target) => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
function failure(code, cause, action) { return Object.assign(new Error(`${code}: ${cause}\nAção: ${action}`), { code }) }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')) }
function snapshot(root) {
  const manifestBytes = fs.readFileSync(path.join(root, 'package.json'))
  const lockBytes = fs.readFileSync(path.join(root, 'package-lock.json'))
  const manifest = JSON.parse(manifestBytes), lock = JSON.parse(lockBytes)
  const compatibility = validateLockfileCompatibility(manifest, lock)
  const fields = ['dependencies', 'devDependencies', 'optionalDependencies']
  const mismatch = fields.some(field => {
    const declared = manifest[field] ?? {}, locked = lock.packages?.['']?.[field] ?? {}
    return [...new Set([...Object.keys(declared), ...Object.keys(locked)])].some(name => declared[name] !== locked[name])
  })
  if (!compatibility.ok || mismatch || lock.lockfileVersion < 2) throw failure('DEPENDENCY_LOCK_MISMATCH', 'package.json e package-lock.json não concordam; reparação automática bloqueada.', 'Reconcilie os manifests deliberadamente com npm 10 e tente novamente.')
  if (!/^npm@10\.\d+\.\d+$/.test(manifest.packageManager ?? '')) throw failure('DEPENDENCY_NPM_POLICY', 'O projeto deve declarar uma versão npm 10 exata.', 'Confira packageManager e a política npm do projeto.')
  const direct = { ...manifest.devDependencies, ...manifest.dependencies, ...manifest.optionalDependencies }
  for (const name of Object.keys(direct)) {
    const entry = lock.packages['node_modules/' + name]
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || !entry?.version || entry.link) throw failure('DEPENDENCY_LOCK_UNSUPPORTED', `Resolução direta inválida no lockfile: ${name}.`, 'Revise o lockfile e o formato da dependência antes de instalar.')
  }
  return { manifest, lock, direct, manifestHash: digest(manifestBytes), lockHash: digest(lockBytes) }
}
function platformMatches(entry) {
  return [['os', process.platform], ['cpu', process.arch]].every(([key, value]) => {
    const values = entry[key]
    return !Array.isArray(values) || (!values.includes('!' + value) && (!values.some(item => !item.startsWith('!')) || values.includes(value)))
  })
}
function entryFiles(name, pkg) {
  const entries = new Set()
  const collect = value => {
    if (typeof value === 'string' && value.startsWith('./') && !value.includes('*')) entries.add(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') Object.values(value).forEach(collect)
  }
  // These published packages expose metadata-only root entries; the app consumes server/CSS subpaths.
  if (name === '@vscode/codicons') { entries.add('dist/codicon.css'); entries.add('dist/codicon.ttf') }
  else if (typeof pkg.main === 'string' && pkg.main) entries.add(pkg.main)
  if (typeof pkg.types === 'string') entries.add(pkg.types)
  if (typeof pkg.typings === 'string') entries.add(pkg.typings)
  if (pkg.exports) collect(pkg.exports[name === '@modelcontextprotocol/sdk' ? './server' : '.'] ?? (Object.keys(pkg.exports).some(key => key.startsWith('.')) ? null : pkg.exports))
  return entries
}
function inspectInstallation(root, state) {
  const modules = path.join(root, 'node_modules'), problems = [], identities = []
  if (!fs.existsSync(modules)) return { problems: ['node_modules ausente'], installationHash: null }
  if (fs.realpathSync(modules) !== modules) throw failure('DEPENDENCY_CHECKOUT_ESCAPE', 'node_modules é um link para outra instalação.', 'Prepare dependências próprias neste checkout; não compartilhe node_modules entre Worktrees.')
  let installedLock
  try {
    const bytes = fs.readFileSync(path.join(modules, '.package-lock.json'))
    installedLock = JSON.parse(bytes); identities.push(digest(bytes))
  } catch { problems.push('Índice npm da instalação ausente ou incompleto') }
  for (const [location, expected] of Object.entries(state.lock.packages)) {
    if (!location || expected.optional || !platformMatches(expected)) continue
    const actual = installedLock?.packages?.[location]
    if (!actual || actual.version !== expected.version || actual.integrity !== expected.integrity) problems.push(`Instalação divergente do lockfile: ${location}`)
  }
  for (const name of Object.keys(state.direct)) {
    const expected = state.lock.packages['node_modules/' + name]
    if (expected.optional && !platformMatches(expected)) continue
    const directory = path.join(modules, name)
    try {
      if (!inside(modules, fs.realpathSync(directory))) throw failure('DEPENDENCY_CHECKOUT_ESCAPE', `${name} aponta para fora deste node_modules.`, 'Remova o vínculo externo e prepare este checkout isoladamente.')
      const raw = fs.readFileSync(path.join(directory, 'package.json')), pkg = JSON.parse(raw)
      identities.push([name, digest(raw)])
      if (pkg.version !== expected.version) problems.push(`${name}: esperado ${expected.version}, instalado ${pkg.version ?? 'sem versão'}`)
      const bin = typeof pkg.bin === 'string' ? { [name.split('/').at(-1)]: pkg.bin } : pkg.bin ?? {}
      const files = [...entryFiles(name, pkg), ...Object.values(bin)]
      for (const entry of files) {
        const target = path.resolve(directory, entry)
        if (!inside(directory, target)) throw failure('DEPENDENCY_CHECKOUT_ESCAPE', `Entrada inválida em ${name}: ${entry}`, 'Revise a instalação do pacote.')
        if (!inside(directory, fs.realpathSync(target))) throw failure('DEPENDENCY_CHECKOUT_ESCAPE', `Entrada de ${name} aponta para outra instalação: ${entry}`, 'Prepare os arquivos deste pacote no checkout atual.')
        const stat = fs.statSync(target)
        if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Entrada inválida: ${entry}`)
        identities.push([name, entry, stat.size, stat.mtimeMs, stat.ino])
      }
      for (const command of Object.keys(bin)) {
        if (!/^[a-z0-9._-]+$/i.test(command)) throw new Error('Nome de binário inválido')
        if (!fs.existsSync(path.join(modules, '.bin', command + (process.platform === 'win32' ? '.cmd' : '')))) problems.push(`Shim npm ausente: ${command}`)
      }
    } catch (error) {
      if (error.code === 'DEPENDENCY_CHECKOUT_ESCAPE') throw error
      problems.push(`${name}: pacote ausente ou incompleto (${error.path ?? error.code ?? error.message})`)
    }
  }
  return { problems, installationHash: digest(JSON.stringify(identities)) }
}
async function acquire(root, timeoutMs) {
  const directory = path.join(root, '.code-awareness')
  fs.mkdirSync(directory, { recursive: true })
  if (!inside(root, fs.realpathSync(directory))) throw failure('DEPENDENCY_CHECKOUT_ESCAPE', 'O diretório de lock aponta para fora do checkout.', 'Use um diretório .code-awareness local a esta Worktree.')
  const file = path.join(directory, 'dependency-readiness.lock'), token = randomUUID(), deadline = Date.now() + timeoutMs
  while (true) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600)
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })) } finally { fs.closeSync(fd) }
      return () => { if (readJson(file).token === token) fs.unlinkSync(file) }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner
      try { owner = readJson(file) } catch { }
      if (Number.isInteger(owner?.pid)) {
        try { process.kill(owner.pid, 0) } catch (error) {
          if (error.code === 'ESRCH') throw failure('DEPENDENCY_LOCK_ABANDONED', `Gate anterior terminou sem liberar o lock (PID ${owner.pid}).`, `Confirme que não há instalação em andamento e remova ${file}.`)
        }
      }
      if (Date.now() >= deadline) throw failure('DEPENDENCY_LOCK_TIMEOUT', 'Outra inicialização ainda possui o lock deste checkout.', `Aguarde a instalação; se ela terminou, confira o proprietário em ${file}.`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}
function npmCommand(state, environment) {
  const candidates = [environment.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]
  const cli = candidates.find(file => file && path.isAbsolute(file) && fs.existsSync(file))
  if (!cli) throw failure('DEPENDENCY_NPM_UNAVAILABLE', 'Não foi possível localizar a CLI npm.', `Execute com ${state.manifest.packageManager}: npx --yes --package ${state.manifest.packageManager} npm run dev`)
  const version = readJson(path.resolve(path.dirname(cli), '../package.json')).version
  const install = ['install', '--no-save', '--package-lock=true', '--prefer-offline', '--no-audit', '--no-fund', '--include=dev', '--include=optional', '--ignore-scripts=false']
  return { executable: process.execPath, args: [cli, ...(validateNpmVersion(version).ok ? install : ['exec', '--yes', '--prefer-offline', '--package=' + state.manifest.packageManager, '--', 'npm', ...install])] }
}
function installIncrementally(root, state, environment = process.env) {
  const command = npmCommand(state, environment)
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, { cwd: root, env: environment, stdio: 'inherit', shell: false, windowsHide: true })
    child.once('error', reject)
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`npm terminou com ${signal ?? code}`)))
  })
}
async function ensureDependencyReadiness({ root = process.cwd(), install = installIncrementally, log = console.log, lockTimeoutMs = 180000 } = {}) {
  root = fs.realpathSync(root)
  const release = await acquire(root, lockTimeoutMs)
  try {
    const initial = snapshot(root)
    let observed = inspectInstallation(root, initial), repaired = false
    if (observed.problems.length) {
      log(`[Dependency Readiness] SYNC_REQUIRED: ${observed.problems.slice(0, 5).join('; ')}`)
      try { await install(root, initial) } catch (error) { throw failure('DEPENDENCY_SYNC_FAILED', error.message, 'Confira acesso ao cache/registro e execute novamente com npm 10. O runtime não foi iniciado.') }
      const current = snapshot(root)
      if (current.manifestHash !== initial.manifestHash || current.lockHash !== initial.lockHash) throw failure('DEPENDENCY_MANIFEST_CHANGED', 'Os manifests mudaram durante a sincronização.', 'Revise as alterações e tente novamente; o runtime não foi iniciado.')
      observed = inspectInstallation(root, current)
      if (observed.problems.length) throw failure('DEPENDENCY_INSTALL_INCOMPLETE', observed.problems.slice(0, 5).join('; '), 'Confira a instalação local e repare com npm 10 antes de iniciar o runtime.')
      repaired = true
    }
    const marker = path.join(root, 'node_modules', '.code-awareness-readiness.json')
    const readiness = { schema: 1, checkout: root, manifestHash: initial.manifestHash, lockHash: initial.lockHash, installationHash: observed.installationHash }
    let prior
    try { prior = readJson(marker) } catch { }
    if (JSON.stringify(prior) !== JSON.stringify(readiness)) {
      const temporary = marker + '.' + randomUUID() + '.tmp'
      try { fs.writeFileSync(temporary, JSON.stringify(readiness), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, marker) }
      finally { fs.rmSync(temporary, { force: true }) }
    }
    const status = repaired ? 'REPAIRED' : 'READY'
    log(`[Dependency Readiness] ${status}`)
    return { ...readiness, status }
  } finally { release() }
}
async function main() {
  const buildFallback = process.argv.includes('--build-fallback')
  if (buildFallback && process.env.npm_lifecycle_event === 'build' && process.env.npm_config_ignore_scripts !== 'true') return
  await ensureDependencyReadiness()
  if (buildFallback) {
    const doctor = spawnSync(process.execPath, [path.join(__dirname, 'native-runtime-doctor.cjs')], { cwd: process.cwd(), env: process.env, stdio: 'inherit', windowsHide: true, shell: false })
    if (doctor.error || doctor.status !== 0) throw failure('DEPENDENCY_NATIVE_VALIDATION_FAILED', doctor.error?.message ?? `native:doctor terminou com ${doctor.signal ?? doctor.status}`, 'Corrija o diagnóstico nativo antes do build.')
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); if (!error.code?.startsWith('DEPENDENCY_')) console.error('Ação: confira acesso ao checkout, package.json, package-lock.json e node_modules; o runtime não foi iniciado.'); process.exitCode = 1 })
module.exports = { ensureDependencyReadiness, inspectInstallation, snapshot, npmCommand }
