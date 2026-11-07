const { execFileSync } = require('node:child_process')
const { IDENTITY_PATH, validateAcademyIdentities } = require('../../src/shared/academy-identity.cjs')

function validateCommit(root, ref = 'HEAD', base) {
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, windowsHide: true })
  const read = (commit, path) => git(['show', `${commit}:${path}`])
  const entries = git(['ls-tree', '-r', '-z', ref, '--', 'skills', 'assets', 'plugin.json', IDENTITY_PATH]).split('\0').filter(Boolean)
  const paths = new Set()
  let totalBytes = 0
  for (const entry of entries) {
    const match = /^(100644|100755) blob [a-f0-9]+\t(.+)$/.exec(entry)
    if (!match) throw new Error('GIT_SOURCE_UNSUPPORTED_ENTRY')
    const path = match[2]
    if (path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..' || /[:\0]|[. ]$/.test(part)) || paths.has(path.toLowerCase())) throw new Error('GIT_SOURCE_UNSAFE_PATH')
    paths.add(path.toLowerCase())
    const raw = execFileSync('git', ['-C', root, 'show', `${ref}:${path}`], { maxBuffer: 8 * 1024 * 1024, windowsHide: true })
    totalBytes += raw.length
    if (totalBytes > 16 * 1024 * 1024) throw new Error('GIT_SOURCE_TOO_LARGE')
    if (path !== 'assets/logo.png') {
      const text = raw.toString('utf8')
      if (raw.includes(0) || !Buffer.from(text).equals(raw)) throw new Error('GIT_SOURCE_INVALID_TEXT')
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b/.test(text)) throw new Error('KNOWN_SECRET_DETECTED')
      if (path.endsWith('/SKILL.md') && !new RegExp(`^name:\\s*["']?${path.split('/')[1]}["']?\\s*$`, 'm').test(text)) throw new Error('SKILL_NAME_MISMATCH')
    }
    if (path.startsWith('assets/') && path !== 'assets/logo.png') throw new Error('GIT_SOURCE_UNAUTHORIZED_ASSET')
  }
  let previous
  if (base && git(['ls-tree', base, '--', IDENTITY_PATH]).trim()) previous = JSON.parse(read(base, IDENTITY_PATH))
  const catalog = validateAcademyIdentities(JSON.parse(read(ref, IDENTITY_PATH)), [...paths].filter(path => /^skills\/[^/]+\/skill.md$/.test(path)).map(path => path.slice(0, -9)), previous)
  if ([...paths].filter(path => path.startsWith('skills/')).some(path => !catalog.skills.some(entry => entry.state === 'PRESENT' && path.startsWith(entry.path + '/')))) throw new Error('ACADEMY_IDENTITY_TREE_MISMATCH')
  if (paths.has('plugin.json')) {
    const manifest = JSON.parse(read(ref, 'plugin.json'))
    if (manifest.name !== 'academy-skills' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version) || !manifest.extensions?.['com.openai']?.interface?.displayName) throw new Error('OPENAI_PLUGIN_MANIFEST_UNAUTHORIZED')
    if (base && git(['ls-tree', base, '--', 'plugin.json']).trim()) {
      const old = JSON.parse(read(base, 'plugin.json'))
      if (manifest.name !== old.name || manifest.$schema !== old.$schema) throw new Error('OPENAI_PLUGIN_IDENTITY_IMMUTABLE')
    }
  }
  return catalog
}

if (require.main === module) {
  try { validateCommit(process.cwd(), process.argv[2] || 'HEAD', process.argv[3]); process.stdout.write('Academy governance PASS\n') }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
module.exports = { validateCommit }
