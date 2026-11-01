const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '../..')
const registered = [
  'src/renderer/src/components/shared/Button/Button.tsx',
  'src/renderer/src/components/shared/ContextHelp/ContextHelp.tsx',
  'src/renderer/src/components/shared/SelectField/SelectField.tsx',
  'scripts/ui-visual-validation/scenarios/ui-primitives-fixture.tsx'
]
const uncertain = Symbol('dynamic')

function analyzeSource(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const diagnostics = []
  const add = (node, category, rule, cause) => {
    const point = source.getLineAndCharacterOfPosition(node.getStart(source))
    diagnostics.push({ file, line: point.line + 1, column: point.character + 1, category, rule, cause })
  }
  for (const diagnostic of source.parseDiagnostics) add({ getStart: () => diagnostic.start ?? 0 }, 'ERROR', 'syntax', ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  const wrappers = new Map()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const module = statement.moduleSpecifier.text.replaceAll('\\', '/')
    const name = ['Button', 'ContextHelp', 'SelectField'].find(name => module.endsWith(`/${name}/${name}`))
    if (!name || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue
    for (const element of statement.importClause.namedBindings.elements) {
      if ((element.propertyName ?? element.name).text === name) wrappers.set(element.name.text, name)
    }
  }
  const literal = attribute => {
    if (!attribute) return undefined
    if (!attribute.initializer) return true
    if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text
    if (ts.isJsxExpression(attribute.initializer)) {
      const expression = attribute.initializer.expression
      if (expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))) return expression.text
      if (expression?.kind === ts.SyntaxKind.FalseKeyword) return false
      if (expression?.kind === ts.SyntaxKind.TrueKeyword) return true
    }
    return uncertain
  }
  const allElements = []
  const collect = node => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) allElements.push(node)
    ts.forEachChild(node, collect)
  }
  collect(source)
  const attr = (node, name) => node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(source) === name)
  const labels = allElements.filter(node => node.tagName.getText(source) === 'label')
  const nonempty = value => typeof value === 'string' && value.trim().length > 0
  for (const node of allElements) {
    const tag = node.tagName.getText(source), wrapper = wrappers.get(tag)
    const get = name => literal(attr(node, name))
    const spread = node.attributes.properties.some(ts.isJsxSpreadAttribute)
    const children = ts.isJsxOpeningElement(node) ? node.parent.children : []
    const hasText = nonempty(get('children')) || children.some(child => ts.isJsxText(child) && child.text.trim())
    const dynamicChild = get('children') === uncertain || children.some(child => ts.isJsxExpression(child) && child.expression)
    const nestedContent = children.some(child => {
      if (!ts.isJsxElement(child)) return false
      if (child.openingElement.tagName.getText(source) !== 'svg') return true
      return Boolean(attr(child.openingElement, 'aria-label') || attr(child.openingElement, 'aria-labelledby')) ||
        child.children.some(value => ts.isJsxElement(value) && value.openingElement.tagName.getText(source) === 'title')
    })
    const named = nonempty(get('aria-label')) || nonempty(get('aria-labelledby'))
    const dynamicName = get('aria-label') === uncertain || get('aria-labelledby') === uncertain
    if (tag === 'button' || wrapper === 'Button') {
      const iconOnly = get('iconOnly') === true || (!hasText && !dynamicChild && !nestedContent)
      if (iconOnly && !named) {
        if (dynamicName || spread) add(node, 'REVIEW', 'accessible-name', 'Name supplied dynamically; demonstrate the rendered accessible name.')
        else add(node, 'ERROR', 'accessible-name', 'Icon-only or empty button needs a nonempty aria-label or aria-labelledby.')
      } else if (!named && (dynamicChild || nestedContent)) add(node, 'REVIEW', 'accessible-name', 'Rendered children determine the name; verify with a role/name interaction test.')
      if (wrapper === 'Button') {
        for (const [name, values] of Object.entries({ size: ['comfortable', 'compact'], intent: ['primary', 'neutral', 'danger'], variant: ['pill', 'ghost', 'solid', 'outline', 'subtle'] })) {
          const value = get(name)
          if (value !== undefined && value !== uncertain && !values.includes(value)) add(node, 'ERROR', 'canonical-control', `${name} must use the shared Button contract: ${values.join(', ')}.`)
          if (value === uncertain) add(node, 'REVIEW', 'canonical-control', `Dynamic ${name} needs typed or behavioral evidence.`)
        }
      }
    }
    if (wrapper === 'SelectField' || wrapper === 'ContextHelp') {
      const label = get('label')
      if (!nonempty(label)) add(node, label === uncertain || spread ? 'REVIEW' : 'ERROR', 'field-label', `${wrapper} needs a meaningful label; dynamic values require rendered evidence.`)
    }
    if (tag === 'select' && !named) {
      const id = get('id')
      const associated = nonempty(id) && labels.some(label => literal(attr(label, 'htmlFor')) === id)
      const nested = (() => { let parent = node.parent; while (parent) { if (ts.isJsxElement(parent) && parent.openingElement.tagName.getText(source) === 'label') return true; parent = parent.parent } return false })()
      if (!associated && !nested) add(node, dynamicName || id === uncertain || spread ? 'REVIEW' : 'ERROR', 'field-label', 'Native select needs an associated label or accessible name; dynamic association requires interaction evidence.')
    }
    const state = get('data-ui-state') ?? get('intent')
    if (['success', 'warning', 'working', 'info', 'error', 'danger', 'unknown'].includes(state)) {
      const style = attr(node, 'style')?.initializer
      if (style && ts.isJsxExpression(style) && style.expression && ts.isObjectLiteralExpression(style.expression)) {
        for (const property of style.expression.properties) {
          if (!ts.isPropertyAssignment(property)) continue
          const key = property.name.getText(source).replaceAll(/['"]/g, '')
          if (!['color', 'background', 'backgroundColor', 'borderColor'].includes(key)) continue
          if (ts.isStringLiteral(property.initializer)) {
            if (/var\(\s*--brand-(blue|violet)\b|#(?:6915b6|0487ed)\b/i.test(property.initializer.text)) add(property, 'ERROR', 'brand-is-not-state', 'Operational state color must use semantic tokens, not brand identity.')
          } else add(property, 'REVIEW', 'brand-is-not-state', 'Dynamic state styling needs semantic-color inspection in the runtime.')
        }
      } else if (style) add(node, 'REVIEW', 'brand-is-not-state', 'Dynamic state styling requires runtime evidence.')
    }
  }
  return diagnostics
}

function checkFiles(files, checkout = root) {
  if (!files.length) throw new Error('EMPTY_SCOPE: register canonical UI files or pass --file <path>; no files were checked.')
  const realRoot = fs.realpathSync(checkout)
  const diagnostics = []
  for (const file of [...new Set(files)]) {
    const absolute = path.resolve(checkout, file)
    const relative = path.relative(realRoot, fs.realpathSync(absolute))
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || !/\.[jt]sx$/.test(relative) || !fs.statSync(absolute).isFile()) throw new Error(`INVALID_SCOPE: ${file}; select explicit JSX/TSX files inside this checkout.`)
    diagnostics.push(...analyzeSource(fs.readFileSync(absolute, 'utf8'), file.replaceAll('\\', '/')))
  }
  return { files: [...new Set(files)], diagnostics, errors: diagnostics.filter(value => value.category === 'ERROR').length,
    review: diagnostics.filter(value => value.category === 'REVIEW').length,
    visual: 'NOT_ASSESSED: inspect affordance, text, geometry, focus, contrast and states in the real runtime; static success is not visual acceptance.' }
}

function main(args) {
  const files = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== '--file' || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('USAGE: node scripts/ui-quality/check.cjs [--file path.tsx ...]. Default: explicit canonical registry. Git auto-selection is not supported.')
    files.push(args[++index])
  }
  const result = checkFiles(args.length ? files : registered)
  process.stdout.write(`${JSON.stringify({ status: result.errors ? 'FAIL' : 'MECHANICAL_PASS', ...result }, null, 2)}\n`)
  return result.errors ? 1 : 0
}
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)) }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
module.exports = { analyzeSource, checkFiles, registered, main }
