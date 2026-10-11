const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')

const GIT_HEAVY_SUITES = Object.freeze([
  'src/main/git-operations/git-worktree-operations.git.test.ts'
])

function findGitTestFiles(directory = path.join(projectRoot, 'src')) {
  const files = []
  if (!fs.existsSync(directory)) return files
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git', '.idea', '.cache', 'temp', 'output'].includes(entry.name)) continue
      files.push(...findGitTestFiles(fullPath))
    } else if (entry.name.endsWith('.git.test.ts')) {
      files.push(path.relative(projectRoot, fullPath).replace(/\\/g, '/'))
    }
  }
  return files.sort()
}

function partitionGitSuites(allFiles, heavyFiles = GIT_HEAVY_SUITES) {
  const normalizedAll = allFiles.map(f => f.replace(/\\/g, '/'))
  const normalizedHeavy = heavyFiles.map(f => f.replace(/\\/g, '/'))
  const heavySet = new Set(normalizedHeavy)

  const heavy = normalizedAll.filter(f => heavySet.has(f)).sort()
  const rest = normalizedAll.filter(f => !heavySet.has(f)).sort()

  return { heavy, rest }
}

function validateGitPartition(options = {}) {
  const allFiles = (options.allFiles || findGitTestFiles()).map(f => f.replace(/\\/g, '/'))
  const heavyFiles = (options.heavyFiles || GIT_HEAVY_SUITES).map(f => f.replace(/\\/g, '/'))
  const errors = []

  if (allFiles.length === 0) {
    errors.push('Nenhuma suite de teste Git foi encontrada.')
  }

  const allSet = new Set(allFiles)
  if (allSet.size !== allFiles.length) {
    errors.push('A lista de suites Git contem caminhos duplicados.')
  }

  for (const heavyFile of heavyFiles) {
    if (!allSet.has(heavyFile)) {
      errors.push(`Suite pesada Git ausente ou fora da descoberta: ${heavyFile}`)
    }
  }

  const { heavy, rest } = partitionGitSuites(allFiles, heavyFiles)

  if (heavy.length === 0) {
    errors.push('A particao Git Heavy esta vazia.')
  }

  if (rest.length === 0) {
    errors.push('A particao Git Rest esta vazia.')
  }

  const intersection = heavy.filter(f => rest.includes(f))
  if (intersection.length > 0) {
    errors.push(`Suites presentes em ambas as particoes Git: ${intersection.join(', ')}`)
  }

  const union = [...new Set([...heavy, ...rest])].sort()
  const missingFromUnion = allFiles.filter(f => !union.includes(f))
  if (missingFromUnion.length > 0) {
    errors.push(`Suites Git omitidas da uniao das particoes: ${missingFromUnion.join(', ')}`)
  }

  if (union.length !== allFiles.length) {
    errors.push(`Tamanho da uniao (${union.length}) difere do total de suites Git (${allFiles.length}).`)
  }

  return {
    valid: errors.length === 0,
    errors,
    allFiles,
    heavy,
    rest
  }
}

function run() {
  const result = validateGitPartition()
  if (!result.valid) {
    console.error('GIT_LANE_PARTITION_INVALID')
    for (const error of result.errors) console.error(`- ${error}`)
    process.exit(1)
  }
  console.log(`Git Lane Partition PASS (${result.heavy.length} heavy, ${result.rest.length} rest, ${result.allFiles.length} total)`)
}

if (require.main === module) run()

module.exports = {
  GIT_HEAVY_SUITES,
  findGitTestFiles,
  partitionGitSuites,
  validateGitPartition
}
