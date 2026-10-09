const fs = require('node:fs')
const path = require('node:path')
const { connect } = require('../local-agent/client.cjs')
const { execFileSync } = require('node:child_process')
const MAX_BYTES = 8 * 1024 * 1024
const fail = code => { throw Object.assign(new Error(code), { code }) }

async function main(args = process.argv.slice(2), channel = { directory: 'continuum-local', protocol: 'continuum-local/v1' }) {
  const operation = args.shift()
  if (!['status', 'list', 'get', 'publish', 'update'].includes(operation)) fail('INVALID_ARGUMENT')
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!['--profile', '--repository', '--id', '--file', '--revision', '--filter', '--format'].includes(args[i]) || !args[i + 1] || options[args[i]] !== undefined) fail('INVALID_ARGUMENT')
    options[args[i]] = args[i + 1]
  }
  const profile = options['--profile'] || (process.platform === 'win32' && process.env.APPDATA ? path.join(process.env.APPDATA, 'code-awareness') : fail('PROFILE_REQUIRED'))
  let descriptor
  try { descriptor = JSON.parse(fs.readFileSync(path.join(profile, channel.directory, 'endpoint.json'), 'utf8')) } catch { fail('APP_UNAVAILABLE') }
  if (descriptor.protocol !== channel.protocol || typeof descriptor.endpoint !== 'string' || typeof descriptor.token !== 'string') fail('APP_UNAVAILABLE')
  if (process.platform === 'win32' && !/^\\\\\.\\pipe\\code-awareness-continuum-[a-f0-9]{48}$/.test(descriptor.endpoint)) fail('APP_UNAVAILABLE')
  if (options['--format'] && !['json', 'markdown'].includes(options['--format'])) fail('INVALID_ARGUMENT')
  if (options['--format'] === 'markdown' && operation !== 'get') fail('INVALID_ARGUMENT')
  const send = payload => connect(descriptor, channel.protocol === 'continuum-local/v1' ? payload : { domain: 'continuum', action: payload.operation, args: Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'operation')) })
  if (operation === 'status') return send({ operation })
  if (!options['--repository']) fail('INVALID_ARGUMENT')
  const status = await send({ operation: 'status' })
  if (status.repository?.repositoryId !== options['--repository']) fail('REPOSITORY_MISMATCH')
  let root
  try { root = fs.realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim()) } catch { fail('WORKTREE_UNLINKED') }
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value
  const worktree = status.worktrees.find(w => normalize(fs.realpathSync(w.path)) === normalize(root))
  if (!worktree) fail('WORKTREE_UNLINKED')
  const request = { operation, repositoryId: options['--repository'], worktreeId: worktree.worktreeId }
  if (operation === 'list') {
    try { request.filter = options['--filter'] ? JSON.parse(options['--filter']) : {} } catch { fail('INVALID_ARGUMENT') }
  }
  if (['get', 'update'].includes(operation)) {
    if (!options['--id']) fail('INVALID_ARGUMENT')
    request.artifactId = options['--id']
  }
  if (['publish', 'update'].includes(operation)) {
    if (!options['--file']) fail('INVALID_ARGUMENT')
    try {
      if (fs.statSync(options['--file']).size > MAX_BYTES) fail('REQUEST_TOO_LARGE')
      request.rawMarkdown = fs.readFileSync(options['--file'], 'utf8')
    } catch (error) { fail(error.code === 'REQUEST_TOO_LARGE' ? error.code : 'INVALID_ARGUMENT') }
  }
  if (operation === 'update') {
    request.expectedRevision = Number(options['--revision'])
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) fail('INVALID_ARGUMENT')
  }
  const result = await send(request)
  return options['--format'] === 'markdown' ? result.rawMarkdown : result
}

if (require.main === module) main().then(result => process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result) + '\n')).catch(error => {
  process.stderr.write(JSON.stringify({ error: { code: error.code || 'INVALID_ARGUMENT' } }) + '\n'); process.exitCode = 1
})
module.exports = { main, connect }
