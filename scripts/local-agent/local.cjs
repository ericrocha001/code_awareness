const fs = require('node:fs')
const { connect } = require('./client.cjs')
const { readDescriptor, publicError } = require('./discovery.cjs')
const { main: continuum } = require('../continuum/local.cjs')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const channel = { directory: 'local-agent-channel', protocol: 'code-awareness-local/v1' }

async function main(args = process.argv.slice(2)) {
  const domain = args.shift()
  if (domain === 'continuum') return continuum(args, channel)
  if (domain !== 'academy' && domain !== 'status') fail('INVALID_ARGUMENT')
  const action = domain === 'status' ? 'status' : args.shift()
  const allowed = domain === 'status' ? ['--profile'] : { history: ['--profile', '--id', '--metadata-only', '--version'], change_impact: ['--profile', '--file'], verify_change_impact: ['--profile', '--file'], list: ['--profile', '--status'], get: ['--profile', '--id'], create: ['--profile', '--file', '--scope', '--projects'], update: ['--profile', '--file', '--id', '--version', '--scope', '--projects'], delivery_status: ['--profile', '--id', '--version'] }[action]
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
  if (['get', 'update', 'delivery_status', 'history'].includes(action)) {
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
  if (action === 'update') {
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
