const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const ts = require('typescript')

const projects = ['node', 'web']
const categories = new Set(['Warning', 'Error', 'Suggestion', 'Message'])
const identity = ({ project, file, code, category, message }) => JSON.stringify([project, file, code, category, message])
const sortDiagnostics = diagnostics => diagnostics.sort((a, b) => identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0)

function normalizedMessage(message, root) {
  return ts.flattenDiagnosticMessageText(message, '\n').replaceAll(root.replaceAll('\\', '/'), '<root>').replaceAll(root.replaceAll('/', '\\'), '<root>').replaceAll('\r\n', '\n').trim()
}

function compactDiagnostic(diagnostic, root) {
  return {
    file: diagnostic.file ? path.relative(root, diagnostic.file.fileName).replaceAll('\\', '/') : null,
    code: diagnostic.code,
    category: ts.DiagnosticCategory[diagnostic.category],
    message: normalizedMessage(diagnostic.messageText, root)
  }
}

function collectProjects(root) {
  root = path.resolve(root).replaceAll('\\', '/')
  const diagnostics = new Map(), checked = []
  for (const project of projects) {
    const configPath = path.join(root, `tsconfig.${project}.json`).replaceAll('\\', '/')
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile)
    if (loaded.error) throw new Error(`INVALID_CONFIG ${project}: ${normalizedMessage(loaded.error.messageText, root)}`)
    const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root, { noEmit: true }, configPath)
    if (config.errors.length) throw new Error(`INVALID_CONFIG ${project}: ${normalizedMessage(config.errors[0].messageText, root)}`)
    const program = ts.createProgram({ rootNames: config.fileNames, options: config.options, configFileParsingDiagnostics: config.errors, projectReferences: config.projectReferences })
    const optionsErrors = program.getOptionsDiagnostics().filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
    if (optionsErrors.length) throw new Error(`INVALID_CONFIG ${project}: TS${optionsErrors[0].code} ${normalizedMessage(optionsErrors[0].messageText, root)}`)
    const roots = config.fileNames.map(file => program.getSourceFile(file)).filter(file => file && !file.isDeclarationFile && /\.[cm]?[jt]sx?$/.test(file.fileName))
    const files = program.getSourceFiles().filter(file => !file.isDeclarationFile && !program.isSourceFileFromExternalLibrary(file) && /\.[cm]?[jt]sx?$/.test(file.fileName))
    if (!roots.length || !files.length) throw new Error(`ZERO_FILES ${project}: expected real source files`)
    if (config.options.rootDir && files.some(file => { const relative = path.relative(config.options.rootDir, file.fileName); return relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) })) throw new Error(`INVALID_CONFIG ${project}: rootDir excludes included source files`)
    const effective = ts.getPreEmitDiagnostics(program)
    for (const diagnostic of effective) {
      const value = { project, ...compactDiagnostic(diagnostic, root) }
      const key = identity(value)
      const existing = diagnostics.get(key)
      if (existing) existing.count++
      else diagnostics.set(key, { ...value, count: 1 })
    }
    checked.push({ project, roots: roots.length, files: files.length, diagnostics: effective.length })
  }
  return { checked, diagnostics: sortDiagnostics([...diagnostics.values()]) }
}

function validateBaseline(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.diagnostics) || Object.keys(value).sort().join(',') !== 'diagnostics,version') throw new Error('INVALID_BASELINE: expected version 1 and diagnostics array')
  const seen = new Set()
  for (const entry of value.diagnostics) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'category,code,count,file,message,project' || !projects.includes(entry.project) || !Number.isSafeInteger(entry.code) || entry.code < 0 || !categories.has(entry.category) || typeof entry.message !== 'string' || !entry.message.trim() || !Number.isSafeInteger(entry.count) || entry.count <= 0) throw new Error('INVALID_BASELINE: malformed diagnostic')
    if (entry.file !== null && (typeof entry.file !== 'string' || !entry.file || entry.file.includes('\\') || path.isAbsolute(entry.file) || /^[A-Za-z]:/.test(entry.file) || entry.file.split('/').includes('..'))) throw new Error('INVALID_BASELINE: expected repository-relative path')
    const key = identity(entry)
    if (seen.has(key)) throw new Error('INVALID_BASELINE: duplicate diagnostic identity')
    seen.add(key)
  }
  return value
}

function compareDiagnostics(current, baseline) {
  const allowed = new Map(baseline.map(entry => [identity(entry), entry]))
  const observed = new Map(current.map(entry => [identity(entry), entry]))
  const added = [], reduced = []
  for (const entry of current) {
    const previous = allowed.get(identity(entry))?.count ?? 0
    if (entry.count > previous) added.push({ ...entry, previousCount: previous })
  }
  for (const entry of baseline) {
    const count = observed.get(identity(entry))?.count ?? 0
    if (count < entry.count) reduced.push({ ...entry, currentCount: count })
  }
  return { added, reduced }
}

function writeBaseline(file, diagnostics, bootstrap) {
  const contents = JSON.stringify(validateBaseline({ version: 1, diagnostics }), null, 2) + '\n'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (bootstrap) { fs.writeFileSync(file, contents, { flag: 'wx' }); return }
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
}

function runGate({ root = process.cwd(), mode = 'check', compiler = collectProjects } = {}) {
  const baselinePath = path.join(root, 'scripts', 'typecheck-baseline.json')
  try {
    if (!['check', 'update', 'bootstrap'].includes(mode)) throw new Error('INVALID_MODE')
    if (mode === 'bootstrap' && fs.existsSync(baselinePath)) throw new Error('BASELINE_EXISTS: bootstrap cannot replace the baseline')
    let baseline
    if (mode !== 'bootstrap') {
      if (!fs.existsSync(baselinePath)) throw new Error('BASELINE_MISSING: restore the versioned baseline')
      try { baseline = validateBaseline(JSON.parse(fs.readFileSync(baselinePath, 'utf8'))) }
      catch (error) { throw new Error(`INVALID_BASELINE: ${error instanceof Error ? error.message : String(error)}`) }
    }
    const collected = compiler(path.resolve(root))
    if (mode === 'bootstrap') {
      writeBaseline(baselinePath, collected.diagnostics, true)
      return { ...collected, status: 'BOOTSTRAPPED', exitCode: 0 }
    }
    const comparison = compareDiagnostics(collected.diagnostics, baseline.diagnostics)
    if (comparison.added.length) return { ...collected, ...comparison, status: 'NEW_DIAGNOSTICS', exitCode: 1 }
    if (mode === 'update') {
      if (!comparison.reduced.length) return { ...collected, status: 'NO_REDUCTION', exitCode: 1 }
      writeBaseline(baselinePath, collected.diagnostics, false)
      return { ...collected, ...comparison, status: 'BASELINE_REDUCED', exitCode: 0 }
    }
    return { ...collected, ...comparison, status: comparison.reduced.length ? 'REDUCTION_REQUIRED' : 'PASS', exitCode: comparison.reduced.length ? 1 : 0 }
  } catch (error) { return { status: 'FAIL', reason: error instanceof Error ? error.message : String(error), exitCode: 1 } }
}

function formatResult(result) {
  const lines = (result.checked ?? []).map(({ project, roots, files, diagnostics }) => `${project}: ${files} source files (${roots} roots), ${diagnostics} ${result.status === 'PASS' ? 'known ' : ''}diagnostics`)
  lines.push(`Typecheck baseline: ${result.status}`)
  if (result.reason) lines.push(result.reason)
  for (const entry of (result.added ?? []).slice(0, 8)) lines.push(`${entry.project} ${entry.file ?? '<project>'} TS${entry.code}: ${entry.message.split('\n')[0]} (${entry.previousCount} -> ${entry.count})`)
  if (result.added?.length > 8) lines.push(`... ${result.added.length - 8} more new identities`)
  if (result.status === 'NEW_DIAGNOSTICS') lines.push('Action: fix new diagnostics; baseline update cannot accept them.')
  if (result.status === 'REDUCTION_REQUIRED') lines.push('Action: debt decreased; run npm run typecheck:baseline to reduce the baseline explicitly.')
  if (result.status === 'NO_REDUCTION') lines.push('Action: baseline is unchanged; no update is needed.')
  if (result.status === 'FAIL') lines.push('Action: resolve the reported failure; restore a missing or malformed baseline from version control.')
  return lines.join('\n')
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const mode = args.length === 0 ? 'check' : args.length === 1 && args[0] === '--update' ? 'update' : args.length === 1 && args[0] === '--bootstrap' ? 'bootstrap' : 'invalid'
  const result = runGate({ mode })
  console.log(formatResult(result))
  process.exitCode = result.exitCode
}

module.exports = { collectProjects, compareDiagnostics, validateBaseline, runGate, formatResult }
