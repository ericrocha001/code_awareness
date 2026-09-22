/**
 * publish-artifact.cjs
 *
 * Offline-capable publisher for Continuum artifacts.
 * Requires only Node.js and local filesystem/Git — no Electron, no SQLite.
 *
 * Usage:
 *   node scripts/continuum/publish-artifact.cjs implementation-handoff <markdown-file> --title "<title>"
 *
 * NOTE: repositoryKey is derived from the normalized repository root path.
 * If the repository is physically moved to another location, the key will change.
 * Cross-machine or cross-location identity resolution is out of scope for this implementation.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execSync } = require('node:child_process')

// ── Repository root discovery ────────────────────────────────────────────────

function findRepositoryRoot(startDir) {
  let current = startDir
  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) {
      throw new Error('REPO_ROOT_NOT_FOUND: could not locate repository root from ' + startDir)
    }
    current = parent
  }
}

function deriveRepositoryKey(repoRoot) {
  // Normalize: lowercase, forward slashes, no trailing slash.
  const normalized = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 32)
}

// ── Git HEAD capture ─────────────────────────────────────────────────────────

function captureGitHead(repoRoot) {
  try {
    const head = execSync('git rev-parse HEAD', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim()
    return head.length > 0 ? head : null
  } catch {
    return null
  }
}

// ── Atomic inbox write ───────────────────────────────────────────────────────

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function writeAtomic(inboxDir, artifactId, content) {
  ensureDir(inboxDir)
  const finalPath = path.join(inboxDir, artifactId + '.json')
  const tmpPath = path.join(inboxDir, crypto.randomUUID() + '.tmp')
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8', flag: 'wx' })
  fs.renameSync(tmpPath, finalPath)
  return finalPath
}

// ── CLI argument parsing ─────────────────────────────────────────────────────

function parseArgs(argv) {
  // argv = process.argv.slice(2)
  // Expected: implementation-handoff <markdown-file> --title "<title>"
  const [subcommand, markdownFile, ...rest] = argv

  if (subcommand !== 'implementation-handoff') {
    throw new Error(
      'INVALID_COMMAND: expected "implementation-handoff <markdown-file> --title <title>"'
    )
  }
  if (!markdownFile) {
    throw new Error('MISSING_ARGUMENT: <markdown-file> is required')
  }

  const titleIndex = rest.indexOf('--title')
  if (titleIndex === -1 || !rest[titleIndex + 1]) {
    throw new Error('MISSING_ARGUMENT: --title <title> is required')
  }
  const title = rest[titleIndex + 1]

  return { markdownFile, title }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error('ERROR: ' + err.message)
    console.error('')
    console.error('Usage: node scripts/continuum/publish-artifact.cjs implementation-handoff <markdown-file> --title "<title>"')
    process.exit(1)
  }

  const { markdownFile, title } = args

  // Validate title
  if (title.trim().length === 0) {
    console.error('ERROR: --title must not be empty')
    process.exit(1)
  }

  // Resolve markdown file path
  const markdownPath = path.resolve(process.cwd(), markdownFile)
  if (!fs.existsSync(markdownPath)) {
    console.error('ERROR: MARKDOWN_FILE_NOT_FOUND: ' + markdownPath)
    process.exit(1)
  }

  const rawMarkdown = fs.readFileSync(markdownPath, { encoding: 'utf8' })
  if (rawMarkdown.trim().length === 0) {
    console.error('ERROR: MARKDOWN_EMPTY: file has no content')
    process.exit(1)
  }

  if (NON_TEXTUAL_CONTROL_CHAR_REGEX.test(rawMarkdown)) {
    console.error('ERROR: SUSPICIOUS_CONTROL_CHARACTERS: file contains non-textual control characters (e.g. NUL, BEL)')
    process.exit(1)
  }

  // Discover repository
  const repoRoot = findRepositoryRoot(process.cwd())
  const repositoryKey = deriveRepositoryKey(repoRoot)
  const gitHead = captureGitHead(repoRoot)

  // Build envelope with cryptographic content hash
  const artifactId = 'artifact-' + crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const contentHash = crypto.createHash('sha256').update(rawMarkdown, 'utf8').digest('hex')

  const envelope = {
    protocol: 'continuum-artifact/v1',
    artifactId,
    type: 'IMPLEMENTATION_HANDOFF',
    schemaVersion: 1,
    title: title.trim(),
    producerRole: 'IMPLEMENTER',
    repositoryKey,
    createdAt,
    sourceFingerprint: null,
    gitHead,
    contentHash,
    rawMarkdown
  }

  const content = JSON.stringify(envelope, null, 2)

  // Write to inbox
  const inboxDir = path.join(repoRoot, '.code-awareness', 'continuum', 'inbox')
  const filePath = writeAtomic(inboxDir, artifactId, content)

  // Receipt
  const receipt = {
    status: 'PUBLISHED',
    artifactId,
    type: 'IMPLEMENTATION_HANDOFF',
    createdAt,
    inboxPath: filePath
  }

  console.log(JSON.stringify(receipt, null, 2))
  process.exit(0)
}

const NON_TEXTUAL_CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

function containsNonTextualControlChars(content) {
  return NON_TEXTUAL_CONTROL_CHAR_REGEX.test(content)
}

function computeContentHash(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex')
}

if (require.main === module) {
  main()
}

module.exports = {
  findRepositoryRoot,
  deriveRepositoryKey,
  captureGitHead,
  writeAtomic,
  parseArgs,
  main,
  NON_TEXTUAL_CONTROL_CHAR_REGEX,
  containsNonTextualControlChars,
  computeContentHash
}
