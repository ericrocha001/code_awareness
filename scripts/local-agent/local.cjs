const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const { connect } = require('./client.cjs')
const { readDescriptor, publicError } = require('./discovery.cjs')
const { main: continuum } = require('../continuum/local.cjs')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const channel = { directory: 'local-agent-channel', protocol: 'code-awareness-local/v1' }

async function resolveWorktreeRequest(descriptor, domain, repositoryId) {
  const status = await connect(descriptor, { domain, action: 'status', args: {} })
  if (!repositoryId || status.repository?.repositoryId !== repositoryId) fail('REPOSITORY_MISMATCH')
  let root
  try { root = fs.realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim()) } catch { fail('WORKTREE_UNLINKED') }
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value
  const worktree = (status.worktrees || []).find(w => {
    try { return normalize(fs.realpathSync(w.path)) === normalize(root) } catch { return false }
  })
  if (!worktree) fail('WORKTREE_UNLINKED')
  return { repositoryId, worktreeId: worktree.worktreeId }
}

async function handleGit(args) {
  const action = args.shift()
  if (!['status', 'state', 'stage', 'commit', 'sync'].includes(action)) fail('INVALID_ARGUMENT')
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    if (!['--profile', '--repository', '--operation-id', '--message', '--expected-head', '--expected-index', '--expected-worktree', '--mode', '--paths', '--sync-action', '--remote', '--branch', '--delivery-context', '--file', '--lease-id', '--lease-credential'].includes(args[index]) || !args[index + 1] || options[args[index]] !== undefined) fail('INVALID_ARGUMENT')
    options[args[index]] = args[index + 1]
  }
  const descriptor = readDescriptor(options['--profile'], channel)
  if (action === 'status') return connect(descriptor, { domain: 'git', action: 'status', args: {} })
  const base = await resolveWorktreeRequest(descriptor, 'git', options['--repository'])
  if (action === 'state') return connect(descriptor, { domain: 'git', action: 'state', args: base })
  if (!options['--operation-id']) fail('INVALID_ARGUMENT')
  const payload = { ...base, operationId: options['--operation-id'] }
  if (options['--lease-id']) payload.leaseId = options['--lease-id']
  if (options['--lease-credential']) payload.leaseCredential = options['--lease-credential']
  if (options['--file']) {
    try { Object.assign(payload, JSON.parse(fs.readFileSync(options['--file'], 'utf8'))) } catch { fail('INVALID_ARGUMENT') }
  }
  if (action === 'stage') {
    if (options['--mode']) payload.mode = options['--mode']
    if (options['--paths']) { try { payload.paths = JSON.parse(options['--paths']) } catch { fail('INVALID_ARGUMENT') } }
    if (options['--expected-index']) payload.expectedIndexRevision = options['--expected-index']
    if (options['--expected-worktree']) payload.expectedWorktreeRevision = options['--expected-worktree']
    return connect(descriptor, { domain: 'git', action: 'stage', args: payload })
  }
  if (action === 'commit') {
    if (options['--message']) payload.message = options['--message']
    if (options['--expected-head'] !== undefined) payload.expectedHead = options['--expected-head'] === 'null' ? null : options['--expected-head']
    if (options['--expected-index']) payload.expectedIndexRevision = options['--expected-index']
    const rawDelivery = options['--delivery-context'] ?? process.env.CODE_AWARENESS_DELIVERY_CONTEXT
    if (rawDelivery && rawDelivery.trim()) { try { payload.deliveryContext = JSON.parse(rawDelivery) } catch { fail('DELIVERY_CONTEXT_INVALID') } }
    if (process.env.CODE_AWARENESS_SESSION_WITNESS?.trim()) { try { payload.sessionWitness = JSON.parse(process.env.CODE_AWARENESS_SESSION_WITNESS) } catch { fail('SESSION_WITNESS_INVALID') } }
    return connect(descriptor, { domain: 'git', action: 'commit', args: payload })
  }
  if (options['--sync-action']) payload.action = options['--sync-action']
  if (options['--remote']) payload.remote = options['--remote']
  if (options['--branch']) payload.branch = options['--branch']
  if (options['--expected-head']) payload.expectedHead = options['--expected-head']
  return connect(descriptor, { domain: 'git', action: 'sync', args: payload })
}

async function handleGithub(args) {
  const action = args.shift()
  if (!['pr_access', 'pr_status', 'create_pr'].includes(action)) fail('INVALID_ARGUMENT')
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    if (!['--profile', '--repository', '--operation-id', '--head', '--base', '--expected-head', '--title', '--body', '--file', '--delivery-context'].includes(args[index]) || !args[index + 1] || options[args[index]] !== undefined) fail('INVALID_ARGUMENT')
    options[args[index]] = args[index + 1]
  }
  const descriptor = readDescriptor(options['--profile'], channel)
  const base = await resolveWorktreeRequest(descriptor, 'git', options['--repository'])
  if (action === 'pr_access') return connect(descriptor, { domain: 'github', action: 'pr_access', args: base })
  if (!options['--operation-id']) fail('INVALID_ARGUMENT')
  if (action === 'pr_status') return connect(descriptor, { domain: 'github', action: 'pr_status', args: { ...base, operationId: options['--operation-id'] } })
  const payload = { ...base, operationId: options['--operation-id'] }
  if (options['--file']) {
    try { Object.assign(payload, JSON.parse(fs.readFileSync(options['--file'], 'utf8'))) } catch { fail('INVALID_ARGUMENT') }
  }
  if (options['--head']) payload.headBranch = options['--head']
  if (options['--base']) payload.baseBranch = options['--base']
  if (options['--expected-head']) payload.expectedHeadSha = options['--expected-head']
  if (options['--title']) payload.title = options['--title']
  if (options['--body']) payload.body = options['--body']
  const rawDelivery = options['--delivery-context'] ?? process.env.CODE_AWARENESS_DELIVERY_CONTEXT
  if (rawDelivery && rawDelivery.trim()) { try { payload.deliveryContext = JSON.parse(rawDelivery) } catch { fail('DELIVERY_CONTEXT_INVALID') } }
  if (process.env.CODE_AWARENESS_SESSION_WITNESS?.trim()) { try { payload.sessionWitness = JSON.parse(process.env.CODE_AWARENESS_SESSION_WITNESS) } catch { fail('SESSION_WITNESS_INVALID') } }
  return connect(descriptor, { domain: 'github', action: 'create_pr', args: payload })
}

const WEB_ACTIVATION_ALLOWED = {
  status: ['--profile'],
  revoke: ['--profile'],
  enroll: [
    '--profile',
    '--file',
    '--installation-id',
    '--extension-id',
    '--install-type',
    '--profile-id',
    '--profile-label',
    '--unpacked-path',
    '--host-install-dir',
    '--host-script-path',
    '--source-repo',
    '--native-host',
    '--replace'
  ]
}

async function handleWebActivation(args) {
  const action = args.shift()
  const allowed = WEB_ACTIVATION_ALLOWED[action]
  if (!allowed) fail('INVALID_ARGUMENT')
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.includes(args[index]) || !args[index + 1] || options[args[index]] !== undefined) fail('INVALID_ARGUMENT')
    options[args[index]] = args[index + 1]
  }
  const descriptor = readDescriptor(options['--profile'], channel)
  if (action === 'status' || action === 'revoke') {
    return connect(descriptor, { domain: 'web_activation', action, args: {} })
  }
  let request = {}
  if (options['--file']) {
    try {
      if (fs.statSync(options['--file']).size > 1024 * 1024) fail('REQUEST_TOO_LARGE')
      request = JSON.parse(fs.readFileSync(options['--file'], 'utf8'))
    } catch (error) {
      fail(error.code === 'REQUEST_TOO_LARGE' ? error.code : 'INVALID_ARGUMENT')
    }
  } else {
    if (
      !options['--extension-id'] ||
      !options['--profile-id'] ||
      !options['--unpacked-path'] ||
      !options['--host-install-dir'] ||
      !options['--host-script-path'] ||
      !options['--source-repo']
    ) {
      fail('INVALID_ARGUMENT')
    }
    request = {
      ...(options['--installation-id'] ? { installationId: options['--installation-id'] } : {}),
      extensionId: options['--extension-id'],
      ...(options['--install-type'] ? { installType: options['--install-type'] } : {}),
      profileId: options['--profile-id'],
      ...(options['--profile-label'] ? { profileLabel: options['--profile-label'] } : {}),
      unpackedPath: options['--unpacked-path'],
      hostInstallDir: options['--host-install-dir'],
      hostScriptPath: options['--host-script-path'],
      sourceRepoPath: options['--source-repo'],
      ...(options['--native-host'] ? { nativeHostApplication: options['--native-host'] } : {}),
      ...(options['--replace'] ? { replace: options['--replace'] === 'true' } : {})
    }
  }
  return connect(descriptor, { domain: 'web_activation', action: 'enroll', args: request })
}

async function main(args = process.argv.slice(2)) {
  const domain = args.shift()
  if (domain === 'continuum') return continuum(args, channel)
  if (domain === 'git') return handleGit(args)
  if (domain === 'github') return handleGithub(args)
  if (domain === 'web_activation') return handleWebActivation(args)
  if (domain !== 'academy' && domain !== 'status') fail('INVALID_ARGUMENT')
  const action = domain === 'status' ? 'status' : args.shift()
  const allowed = domain === 'status' ? ['--profile'] : { set_academy_skill_enabled: ['--profile', '--id', '--enabled', '--state-revision'], archive: ['--profile', '--id', '--version'], restore: ['--profile', '--id', '--version'], history: ['--profile', '--id', '--metadata-only', '--version'], change_impact: ['--profile', '--file'], verify_change_impact: ['--profile', '--file'], list: ['--profile', '--status'], get: ['--profile', '--id'], create: ['--profile', '--file', '--scope', '--projects'], update: ['--profile', '--file', '--id', '--version', '--scope', '--projects'], delivery_status: ['--profile', '--id', '--version'] }[action]
  if (!allowed) fail('INVALID_ARGUMENT')
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.includes(args[index]) || !args[index + 1] || options[args[index]] !== undefined) fail('INVALID_ARGUMENT')
    options[args[index]] = args[index + 1]
  }
  const descriptor = readDescriptor(options['--profile'], channel)
  const request = {}
  if (domain === 'status') return connect(descriptor, { domain: 'channel', action, args: request })
  if (action === 'change_impact' || action === 'verify_change_impact') {
    if (!options['--file']) fail('INVALID_ARGUMENT')
    let input
    try {
      if (fs.statSync(options['--file']).size > 8 * 1024 * 1024) fail('REQUEST_TOO_LARGE')
      input = JSON.parse(fs.readFileSync(options['--file'], 'utf8'))
    } catch (error) { fail(error.code === 'REQUEST_TOO_LARGE' ? error.code : 'INVALID_ARGUMENT') }
    return connect(descriptor, { domain: 'academy', action, args: input })
  }
  if (options['--status']) request.status = options['--status']
  if (['get', 'update', 'delivery_status', 'history', 'set_academy_skill_enabled', 'archive', 'restore'].includes(action)) {
    if (!options['--id']) fail('INVALID_ARGUMENT')
    request.skillId = options['--id']
  }
  if (action === 'history') {
    if (options['--metadata-only'] !== undefined) {
      if (!['true', 'false'].includes(options['--metadata-only'])) fail('INVALID_ARGUMENT')
      request.metadataOnly = options['--metadata-only'] === 'true'
    }
    if (options['--version'] !== undefined) {
      if (!/^[1-9][0-9]*$/.test(options['--version'])) fail('INVALID_ARGUMENT')
      request.version = Number(options['--version'])
      if (!Number.isSafeInteger(request.version)) fail('INVALID_ARGUMENT')
    }
  }
  if (['create', 'update'].includes(action)) {
    if (!options['--file'] || action === 'create' && !options['--scope']) fail('INVALID_ARGUMENT')
    try {
      if (fs.statSync(options['--file']).size > 8 * 1024 * 1024) fail('REQUEST_TOO_LARGE')
      request.package = JSON.parse(fs.readFileSync(options['--file'], 'utf8'))
    } catch (error) { fail(error.code === 'REQUEST_TOO_LARGE' ? error.code : 'INVALID_ARGUMENT') }
    if (options['--scope']) request.scope = options['--scope']
    if (options['--projects']) { try { request.projectIds = JSON.parse(options['--projects']) } catch { fail('INVALID_ARGUMENT') } }
  }
  if (action === 'set_academy_skill_enabled') {
    if (!['true', 'false'].includes(options['--enabled']) || !/^[1-9][0-9]*$/.test(options['--state-revision'])) fail('INVALID_ARGUMENT')
    request.enabled = options['--enabled'] === 'true'
    request.expectedStateRevision = Number(options['--state-revision'])
    if (!Number.isSafeInteger(request.expectedStateRevision)) fail('INVALID_ARGUMENT')
  }
  if (['update', 'archive', 'restore'].includes(action)) {
    request.expectedVersion = Number(options['--version'])
    if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 1) fail('INVALID_ARGUMENT')
  }
  if (action === 'delivery_status' && options['--version']) {
    request.expectedVersion = Number(options['--version'])
    if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 1) fail('INVALID_ARGUMENT')
  }
  return connect(descriptor, { domain: 'academy', action, args: request })
}
if (require.main === module) main().then(result => process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result) + '\n')).catch(error => {
  process.stderr.write(JSON.stringify({ error: publicError(error) }) + '\n'); process.exitCode = 1
})
module.exports = { main }
