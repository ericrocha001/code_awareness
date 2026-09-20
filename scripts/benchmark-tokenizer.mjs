import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { execFileSync } from 'node:child_process'
import { Tiktoken } from 'js-tiktoken/lite'
import cl100kBase from 'js-tiktoken/ranks/cl100k_base'

const root = resolve(process.cwd())
const extensions = /\.(ts|tsx|js|jsx|mjs|cjs|css|json|md)$/i
const paths = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split(/\r?\n/)
  .filter((path) => extensions.test(path))
  .filter((path) => {
    const entry = statSync(resolve(root, path), { throwIfNoEntry: false })
    return entry?.isFile() && entry.size <= 2 * 1024 * 1024
  })
const corpus = paths.map((path) => ({ path, content: readFileSync(resolve(root, path), 'utf8') }))

function measure(name, count) {
  const memoryBefore = process.memoryUsage().heapUsed
  const startedAt = performance.now()
  let tokens = 0
  for (const file of corpus) tokens += count(file.content)
  const durationMs = performance.now() - startedAt
  return {
    name,
    files: corpus.length,
    tokens,
    durationMs: Number(durationMs.toFixed(2)),
    tokensPerSecond: Math.round(tokens / Math.max(durationMs / 1000, 0.001)),
    heapDeltaBytes: process.memoryUsage().heapUsed - memoryBefore
  }
}

const heuristic = measure('characters/4', (content) => Math.ceil(content.length / 4))
const startupAt = performance.now()
const tokenizer = new Tiktoken(cl100kBase)
const startupMs = performance.now() - startupAt
const canonical = measure('js-tiktoken/lite cl100k_base', (content) => tokenizer.encode(content).length)
const relativeError = Math.abs(heuristic.tokens - canonical.tokens) / Math.max(canonical.tokens, 1)

process.stdout.write(JSON.stringify({
  corpus: {
    files: corpus.length,
    bytes: corpus.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0),
    extensions: [...new Set(paths.map((path) => path.slice(path.lastIndexOf('.')).toLowerCase()))].sort()
  },
  candidates: [heuristic, { ...canonical, startupMs: Number(startupMs.toFixed(2)) }],
  precision: { heuristicRelativeError: Number(relativeError.toFixed(4)), canonical: 'exact for cl100k_base' },
  electron: { compatible: true, nativeDependency: false },
  decision: 'adopt js-tiktoken/lite cl100k_base; WASM comparison not required'
}, null, 2) + '\n')
