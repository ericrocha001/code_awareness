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

function runCli() {
  if (!fs.existsSync(mainBundlePath)) {
    console.error(`NATIVE_BUNDLE_INVALID\nout/main/main.js expected: present\nfound: absent\naction: Run npm run build before native:bundle-guard.`)
    process.exit(1)
  }

  const bundleSource = fs.readFileSync(mainBundlePath, 'utf8')
  const failures = []

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
        'expected: external require in out/main/main.js',
        `found: external=${failure.external}, bundled=${failure.bundled}`,
        'action: keep native dependencies direct and externalized by electron-vite externalizeDepsPlugin().'
      ].join('\n'))
    }
    process.exit(1)
  }

  console.log('Native Bundle      HEALTHY')
}

if (require.main === module) {
  runCli()
}
