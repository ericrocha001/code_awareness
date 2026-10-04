const fs = require('fs')
const path = require('path')
const { nativeTestFiles } = require('./test-runtime-lanes.cjs')

const projectRoot = path.resolve(__dirname, '..')
const nativePackages = [
  'better-sqlite3',
  'tree-sitter',
  'tree-sitter-typescript',
  'tree-sitter-javascript'
]

function listTestFiles(directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...listTestFiles(absolutePath))
    } else if (/\.test\.(ts|tsx)$/.test(entry.name)) {
      files.push(path.relative(projectRoot, absolutePath).replace(/\\/g, '/'))
    }
  }
  return files
}

function validateTestRuntimeLanes(options = {}) {
  const declaredNativeFiles = options.nativeTestFiles || nativeTestFiles
  const testFiles = options.testFiles || listTestFiles(path.join(projectRoot, 'src'))
  const readFile = options.readFile || ((relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'))
  const errors = []
  const nativeSet = new Set(declaredNativeFiles)

  if (nativeSet.size !== declaredNativeFiles.length) {
    errors.push('A lista da pista Electron contem caminhos duplicados.')
  }

  for (const relativePath of declaredNativeFiles) {
    if (!testFiles.includes(relativePath)) {
      errors.push(`Suite nativa ausente ou fora da descoberta: ${relativePath}`)
    }
  }

  const packageAlternation = nativePackages.join('|')
  const staticImportPattern = new RegExp(
    `^\\s*import(?:[^'\"\\n]*?from\\s+|\\s*)['\"](${packageAlternation})['\"]`,
    'm'
  )
  const requirePattern = new RegExp(
    `^\\s*(?:const|let|var)\\s+[^\\n=]+?=\\s*require\\(\\s*['\"](${packageAlternation})['\"]\\s*\\)`,
    'm'
  )
  const dynamicImportPattern = new RegExp(
    `^\\s*(?:const|let|var)\\s+[^\\n=]+?=.*?import\\(\\s*['\"](${packageAlternation})['\"]\\s*\\)`,
    'm'
  )

  for (const relativePath of testFiles) {
    const source = readFile(relativePath)
    const belongsToNodeLane = !nativeSet.has(relativePath) && !relativePath.endsWith('.e2e.test.ts') && !relativePath.includes('.git.test.ts')
    if (belongsToNodeLane && (
      staticImportPattern.test(source) || requirePattern.test(source) || dynamicImportPattern.test(source)
    )) {
      errors.push(`Suite Node importa addon nativo diretamente: ${relativePath}`)
    }

    if (
      relativePath.endsWith('codemap-system-acceptance.e2e.test.ts') &&
      /\.\s*synchronizeModified\s*\(/.test(source)
    ) {
      errors.push(`Aceitacao sistemica usa sincronizacao manual: ${relativePath}`)
    }
  }

  return errors
}

function run() {
  const errors = validateTestRuntimeLanes()
  if (errors.length > 0) {
    console.error('TEST_RUNTIME_POLICY_INVALID')
    for (const error of errors) console.error(`- ${error}`)
    process.exit(1)
  }
  console.log(`Test Runtime Policy PASS (${nativeTestFiles.length} native suites)`)
}

if (require.main === module) run()

module.exports = { validateTestRuntimeLanes }
