/*
-T ---
*/

const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const mainBundlePath = path.join(projectRoot, 'out', 'main', 'main.js')
const nativeModules = [
  'better-sqlite3',
  'tree-sitter',
  'tree-sitter-typescript',
  'tree-sitter-javascript'
]

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function moduleHasExternalRequire(bundleSource, moduleName) {
  const escaped = escapeRegExp(moduleName)
  const requirePattern = new RegExp(`(?:require|__require)\\(["']${escaped}["']\\)`)
  return requirePattern.test(bundleSource)
}

function moduleLooksBundled(bundleSource, moduleName) {
  const normalizedSource = bundleSource.replace(/\\\\/g, '/')
  return normalizedSource.includes(`node_modules/${moduleName}/`)
}

function readMainBundle(entry) {
  const root = fs.realpathSync(path.dirname(entry)), pending = [entry], seen = new Set(), sources = []
  let size = 0
  while (pending.length) {
    const file = fs.realpathSync(pending.pop()), scope = path.relative(root, file)
    if (path.isAbsolute(scope) || scope.startsWith('..')) throw new Error('MAIN_BUNDLE_CHUNK_OUTSIDE_OUTPUT')
    if (seen.has(file)) continue
    seen.add(file)
    const source = fs.readFileSync(file, 'utf8'); size += Buffer.byteLength(source)
    if (seen.size > 64 || size > 16 * 1024 * 1024) throw new Error('MAIN_BUNDLE_GRAPH_LIMIT')
    sources.push(source)
    for (const match of source.matchAll(/(?:require|__require)\(["'](\.\.?\/[^"']+\.(?:c?js))["']\)/g)) pending.push(path.resolve(path.dirname(file), match[1]))
  }
  return sources.join('\n')
}

function runCli() {
  if (!fs.existsSync(mainBundlePath)) {
    console.error(`NATIVE_BUNDLE_INVALID\nout/main/main.js expected: present\nfound: absent\naction: Run npm run build before native:bundle-guard.`)
    process.exit(1)
  }

  const bundleSource = readMainBundle(mainBundlePath)
  const failures = []

  if (bundleSource.includes('scripts/test-runtime-lanes.cjs')) {
    failures.push({
      moduleName: 'test runtime lanes',
      external: true,
      bundled: false,
      action: 'keep test harness modules out of the Electron Main runtime bundle.'
    })
    console.log(`${'test runtime lanes'.padEnd(24)} isolated FAIL`)
  } else {
    console.log(`${'test runtime lanes'.padEnd(24)} isolated PASS`)
  }

  for (const moduleName of nativeModules) {
    const external = moduleHasExternalRequire(bundleSource, moduleName)
    const bundled = moduleLooksBundled(bundleSource, moduleName)

    if (external && !bundled) {
      console.log(`${moduleName.padEnd(24)} external PASS`)
      continue
    }

    failures.push({ moduleName, external, bundled })
    console.log(`${moduleName.padEnd(24)} external FAIL`)
  }

  if (failures.length > 0) {
    console.error('NATIVE_BUNDLE_INVALID')
    for (const failure of failures) {
      console.error([
        failure.moduleName,
        'expected: external require in the reachable Electron Main bundle',
        `found: external=${failure.external}, bundled=${failure.bundled}`,
        `action: ${failure.action ?? 'keep native dependencies direct and externalized by electron-vite externalizeDepsPlugin().'}`
      ].join('\n'))
    }
    process.exit(1)
  }

  console.log('Native Bundle      HEALTHY')
}

if (require.main === module) {
  runCli()
}
module.exports = { readMainBundle, moduleHasExternalRequire, moduleLooksBundled }
