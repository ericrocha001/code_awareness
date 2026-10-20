const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { protectDirectory } = require('../test-output.cjs')

const projectRoot = path.resolve(__dirname, '../..')
const evidenceRoot = path.join(projectRoot, '.code-awareness/visual-validation')
const runId = () => `${Date.now()}-${randomUUID()}`
const isStem = value => typeof value === 'string' && /^[a-z0-9-]+$/i.test(value)

function localPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || /^(?:[a-z]+:\/\/|\\\\|\/\/)/i.test(value)) {
    throw Object.assign(new Error('Select an explicit local file path'), { code: 'PATH_UNAUTHORIZED' })
  }
  const absolute = path.resolve(value)
  if (process.platform === 'win32' && absolute.slice(2).includes(':')) throw Object.assign(new Error('Alternate streams are not supported'), { code: 'PATH_UNAUTHORIZED' })
  let current = path.parse(absolute).root
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw Object.assign(new Error('Linked paths are not authorized'), { code: 'PATH_UNAUTHORIZED' })
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return absolute
}

function comparisonDirectory(parent = evidenceRoot) {
  parent = localPath(parent)
  const relative = path.relative(evidenceRoot, parent)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Object.assign(new Error('Comparison output must stay in harness evidence'), { code: 'OUTPUT_UNAUTHORIZED' })
  protectDirectory(parent)
  const directory = path.join(parent, `comparison-${runId()}`)
  fs.mkdirSync(directory, { mode: 0o700 })
  protectDirectory(directory)
  return directory
}

module.exports = { projectRoot, evidenceRoot, runId, isStem, localPath, comparisonDirectory }
