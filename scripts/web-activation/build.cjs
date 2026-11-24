const { createHash, randomUUID } = require('node:crypto')
const { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { delimiter, join, relative, resolve } = require('node:path')

function resolveEsbuild(nodePaths) {
  try {
    return require('esbuild')
  } catch (err) {
    for (const candidateDir of nodePaths ?? []) {
      try {
        const candidateReq = createRequire(join(resolve(candidateDir), '_resolve.js'))
        return candidateReq('esbuild')
      } catch {}
    }
    throw err
  }
}

const DEFAULT_NATIVE_HOST_NAME = 'com.ericrocha.codeawareness.web_activation'

function hashBufferSha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function walkFiles(dir, predicate, out = []) {
  if (!existsSync(dir)) return out
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(full, predicate, out)
    } else if (entry.isFile() && predicate(full, entry.name)) {
      out.push(full)
    }
  }
  return out
}

function collectWebActivationInputs(repoRoot) {
  const root = resolve(repoRoot)
  const isProdSource = (full, name) => !name.endsWith('.test.ts') && !name.endsWith('.test.js') && /\.(ts|json|html|cjs)$/.test(name)
  const files = [
    ...walkFiles(join(root, 'src', 'web-extension'), isProdSource),
    ...walkFiles(join(root, 'src', 'main', 'web-activation'), isProdSource),
    ...walkFiles(join(root, 'src', 'shared', 'web-activation'), isProdSource),
    join(root, 'scripts', 'web-activation', 'build.cjs'),
    join(root, 'scripts', 'web-activation', 'native-host.cjs'),
    join(root, 'package.json')
  ]
  const unique = [...new Set(files.filter((file) => existsSync(file)).map((file) => resolve(file)))]
  return unique
    .map((file) => ({
      absolutePath: file,
      relativePath: relative(root, file).replaceAll('\\', '/')
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

function computeWebActivationInputsFingerprint(repoRoot) {
  const inputs = collectWebActivationInputs(repoRoot)
  const hasher = createHash('sha256')
  for (const item of inputs) {
    const buf = readFileSync(item.absolutePath)
    hasher.update(`${item.relativePath}\0${buf.length}\0`)
    hasher.update(buf)
    hasher.update('\0')
  }
  return hasher.digest('hex')
}

function hashDirectoryFiles(dir) {
  const result = {}
  if (!existsSync(dir)) return result
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = join(dir, entry.name)
    const buf = readFileSync(full)
    result[entry.name] = {
      sha256: hashBufferSha256(buf),
      bytes: buf.length
    }
  }
  return result
}

/**
 * Compiles web extension bundles and the Native Messaging host bundle into the target directories
 * with an immutable buildId and computes deterministic input/output SHA-256 verification metadata.
 */
async function buildWebActivationArtifacts(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? resolve(__dirname, '..', '..'))
  const extDir = join(repoRoot, 'src', 'web-extension')
  const extOutDir = resolve(options.extOutDir ?? join(repoRoot, 'dist', 'web-extension'))
  const hostOutDir = resolve(options.hostOutDir ?? join(repoRoot, 'dist', 'web-activation'))
  const metaOutPath = options.metaOutPath ? resolve(options.metaOutPath) : join(hostOutDir, 'build-metadata.json')
  const nativeHostApplication = options.nativeHostApplication || DEFAULT_NATIVE_HOST_NAME
  const sourceHead = typeof options.sourceHead === 'string' ? options.sourceHead : ''
  const inputsFingerprint = computeWebActivationInputsFingerprint(repoRoot)
  const buildId =
    typeof options.buildId === 'string' && options.buildId.trim()
      ? options.buildId.trim()
      : `wa-${inputsFingerprint.slice(0, 12)}-${randomUUID().slice(0, 8)}`

  const cleanExtOutDir = options.cleanExtOutDir !== false
  const cleanHostOutDir = options.cleanHostOutDir !== false
  if (cleanExtOutDir) rmSync(extOutDir, { recursive: true, force: true })
  if (cleanHostOutDir) rmSync(hostOutDir, { recursive: true, force: true })
  mkdirSync(extOutDir, { recursive: true })
  mkdirSync(hostOutDir, { recursive: true })

  const manifestRaw = readFileSync(join(extDir, 'manifest.json'), 'utf8')
  const manifestParsed = JSON.parse(manifestRaw)
  const manifestVersion = typeof manifestParsed.version === 'string' ? manifestParsed.version : '0.0.0'

  const define = {
    __WEB_ACTIVATION_BUILD_ID__: JSON.stringify(buildId),
    __WEB_ACTIVATION_NATIVE_HOST__: JSON.stringify(nativeHostApplication),
    __WEB_ACTIVATION_SOURCE_HEAD__: JSON.stringify(sourceHead)
  }

  const nodePaths = Array.isArray(options.nodePaths) && options.nodePaths.length > 0
    ? options.nodePaths.map((p) => resolve(p))
    : process.env.NODE_PATH
      ? process.env.NODE_PATH.split(delimiter).filter(Boolean).map((p) => resolve(p))
      : undefined
  const esbuild = resolveEsbuild(nodePaths)

  await esbuild.build({
    entryPoints: {
      background: join(extDir, 'background.ts'),
      'content-script': join(extDir, 'content-script.ts'),
      popup: join(extDir, 'popup.ts'),
      'context-picker': join(extDir, 'context-picker.ts')
    },
    outdir: extOutDir,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome114',
    sourcemap: false,
    logLevel: 'silent',
    ...(nodePaths ? { nodePaths } : {}),
    define
  })

  await esbuild.build({
    entryPoints: [join(repoRoot, 'src', 'main', 'web-activation', 'native-host-cli.ts')],
    outfile: join(hostOutDir, 'native-host.cjs'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    logLevel: 'silent',
    ...(nodePaths ? { nodePaths } : {}),
    define
  })

  copyFileSync(join(extDir, 'manifest.json'), join(extOutDir, 'manifest.json'))
  copyFileSync(join(extDir, 'popup.html'), join(extOutDir, 'popup.html'))
  copyFileSync(join(extDir, 'context-picker.html'), join(extOutDir, 'context-picker.html'))

  const metadata = {
    schemaVersion: 1,
    buildId,
    sourceHead,
    inputsFingerprint,
    manifestVersion,
    builtAt: new Date().toISOString(),
    extOutDir,
    hostOutDir,
    candidatePath: extOutDir,
    nativeHostApplication,
    extFiles: hashDirectoryFiles(extOutDir),
    hostFiles: hashDirectoryFiles(hostOutDir)
  }

  mkdirSync(join(metaOutPath, '..'), { recursive: true })
  writeFileSync(metaOutPath, JSON.stringify(metadata, null, 2), 'utf8')
  return metadata
}

function parseCliArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    const next = argv[i + 1]
    if (arg === '--ext-out' && next) { parsed.extOutDir = next; i += 1 }
    else if (arg === '--host-out' && next) { parsed.hostOutDir = next; i += 1 }
    else if (arg === '--meta-out' && next) { parsed.metaOutPath = next; i += 1 }
    else if (arg === '--build-id' && next) { parsed.buildId = next; i += 1 }
    else if (arg === '--source-head' && next) { parsed.sourceHead = next; i += 1 }
    else if (arg === '--native-host' && next) { parsed.nativeHostApplication = next; i += 1 }
    else if (arg === '--repo-root' && next) { parsed.repoRoot = next; i += 1 }
    else throw new Error(`INVALID_BUILD_ARG:${arg}`)
  }
  return parsed
}

if (require.main === module) {
  const cli = parseCliArgs(process.argv.slice(2))
  buildWebActivationArtifacts(cli)
    .then((metadata) => {
      if (cli.json) {
        process.stdout.write(`${JSON.stringify(metadata)}\n`)
      } else {
        console.log(
          `Built web activation extension & native host artifacts [${metadata.buildId}] -> ${metadata.extOutDir} & ${metadata.hostOutDir}`
        )
      }
    })
    .catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
}

module.exports = {
  DEFAULT_NATIVE_HOST_NAME,
  collectWebActivationInputs,
  computeWebActivationInputsFingerprint,
  hashDirectoryFiles,
  buildWebActivationArtifacts
}
