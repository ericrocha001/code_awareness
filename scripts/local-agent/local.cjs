const fs = require('node:fs')
const path = require('node:path')
const { connect } = require('./client.cjs')
const { main: continuum } = require('../continuum/local.cjs')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const channel = { directory: 'local-agent-channel', protocol: 'code-awareness-local/v1' }

async function main(args = process.argv.slice(2)) {
  const domain = args.shift()
  if (domain === 'continuum') return continuum(args, channel)
  if (domain !== 'academy' && domain !== 'status') fail('INVALID_ARGUMENT')
  const action = domain === 'status' ? 'status' : args.shift()
  const allowed = domain === 'status' ? ['--profile'] : { list: ['--profile', '--status'], get: ['--profile', '--id'], create: ['--profile', '--file', '--scope', '--projects'], update: ['--profile', '--file', '--id', '--version', '--scope', '--projects'] }[action]
  if (!allowed) fail('INVALID_ARGUMENT')
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.includes(args[index]) || !args[index + 1] || options[args[index]] !== undefined) fail('INVALID_ARGUMENT')
    options[args[index]] = args[index + 1]
  }
  const profile = options['--profile'] || (process.platform === 'win32' && process.env.APPDATA ? path.join(process.env.APPDATA, 'code-awareness') : fail('PROFILE_REQUIRED'))
  let descriptor
  try { descriptor = JSON.parse(fs.readFileSync(path.join(profile, channel.directory, 'endpoint.json'), 'utf8')) } catch { fail('APP_UNAVAILABLE') }
  if (descriptor.protocol !== channel.protocol || typeof descriptor.endpoint !== 'string' || typeof descriptor.token !== 'string') fail('APP_UNAVAILABLE')
  if (process.platform === 'win32' && !/^\\\\\.\\pipe\\code-awareness-continuum-[a-f0-9]{48}$/.test(descriptor.endpoint)) fail('APP_UNAVAILABLE')
  const request = {}
  if (domain === 'status') return connect(descriptor, { domain: 'channel', action, args: request })
  if (options['--status']) request.status = options['--status']
  if (['get', 'update'].includes(action)) {
    if (!options['--id']) fail('INVALID_ARGUMENT')
    request.skillId = options['--id']
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
  return connect(descriptor, { domain: 'academy', action, args: request })
}
if (require.main === module) main().then(result => process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result) + '\n')).catch(error => {
  process.stderr.write(JSON.stringify({ error: { code: error.code || 'INVALID_ARGUMENT' } }) + '\n'); process.exitCode = 1
})
module.exports = { main }
