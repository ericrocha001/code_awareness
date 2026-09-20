const { createHarness } = require('./desktop-runtime/harness.cjs')

async function main() {
  let harness
  try {
    const [command, ...args] = process.argv.slice(2)
    if (!['doctor', 'migrate'].includes(command)) throw Object.assign(new Error(), { code: 'INVALID_COMMAND' })
    harness = await createHarness()
    const profile = await harness.resolve()
    let result
    if (command === 'doctor') {
      if (args.length) throw Object.assign(new Error(), { code: 'INVALID_ARGUMENTS' })
      result = await harness.doctor(profile)
      console.log('Canonical Desktop Runtime Doctor')
      console.log(`appName: ${profile.appName}\nuserData: ${profile.userData}\nProbe: isolated canonical snapshot`)
      for (const [name, status] of Object.entries(result.checks || {})) console.log(`${name.padEnd(20)} ${status}`)
      if (result.enabled !== undefined) console.log(`Remote Access: ${result.enabled ? 'enabled' : 'disabled'}\nTransport: ${result.transport}`)
      if (result.id) console.log(`Installation: ${result.id}`)
      if (result.code) console.log(JSON.stringify({ stage: result.stage, code: result.code, expected: result.expected, actual: result.actual }))
      for (const [stage, code] of Object.entries(result.checks || {})) if (code !== 'PASS') console.log(JSON.stringify({ stage: `${stage.toLowerCase()}_validation`, code }))
      if (result.checks?.Credential === 'CREDENTIAL_NOT_DECRYPTABLE') console.log('Credential exists but cannot be decrypted in the canonical Desktop profile.')
      console.log(`Overall: ${result.healthy ? 'HEALTHY' : 'UNHEALTHY'}`)
    } else {
      const sourceIndex = args.indexOf('--source-profile')
      const source = sourceIndex >= 0 ? args[sourceIndex + 1] : undefined
      const known = new Set(['--source-profile', source, '--apply', '--dry-run'])
      if (!source || args.some((arg) => !known.has(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) throw Object.assign(new Error(), { code: 'SOURCE_PROFILE_REQUIRED_OR_INVALID_ARGUMENTS' })
      result = await harness.migrate(profile, source, args.includes('--apply'))
      console.log(JSON.stringify(result))
    }
    process.exitCode = result.healthy ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({ healthy: false, stage: error.stage || 'harness', code: error.code || 'HARNESS_FAILED' }))
    process.exitCode = 1
  } finally { harness?.close() }
}

void main()
