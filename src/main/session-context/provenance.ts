import { isAbsolute, normalize, relative, resolve } from 'node:path'
import { lstat } from 'node:fs/promises'
import type { CommandRunner } from './entire-provider'
import type {
  CodeProvenanceSegment,
  InspectCodeProvenanceDetailResult,
  InspectCodeProvenanceMapResult,
  ProvenanceStatus
} from './provenance-types'
import { readCheckpointDisambiguate } from './checkpoint'

export interface InspectCodeProvenanceQuery {
  file: string
  startLine?: number
  endLine?: number
  mode?: 'MAP' | 'DETAIL'
  worktreeId?: string
  generation?: string
}

export function sanitizeRepoRelativePath(root: string, filePath: string): string {
  if (!filePath || typeof filePath !== 'string') throw new Error('INVALID_ARGUMENT')
  const clean = filePath.replace(/\\/g, '/').trim()
  if (!clean || clean.includes('\0') || isAbsolute(clean) || /^[A-Za-z]:/i.test(clean) || /(?:^|\/)\.\.(?:\/|$)/.test(clean)) {
    throw new Error('PATH_OUTSIDE_REPOSITORY')
  }
  const resolved = resolve(root, clean)
  const rel = relative(resolve(root), resolved).replace(/\\/g, '/')
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('PATH_OUTSIDE_REPOSITORY')
  return rel
}

interface BlameBlock {
  sha: string
  origLine: number
  finalLine: number
  numLines: number
}

interface CommitMeta {
  author?: string
  authorTime?: string
  summary?: string
  checkpointId?: string | null
  status?: ProvenanceStatus
}

export function parseGitBlameIncremental(output: string): { blocks: BlameBlock[]; commits: Map<string, CommitMeta> } {
  const lines = output.split(/\r?\n/)
  const blocks: BlameBlock[] = []
  const commits = new Map<string, CommitMeta>()
  let currentSha: string | undefined

  for (const line of lines) {
    const headerMatch = line.match(/^([a-f0-9]{40})\s+(\d+)\s+(\d+)\s+(\d+)$/)
    if (headerMatch) {
      currentSha = headerMatch[1]
      const block: BlameBlock = {
        sha: currentSha,
        origLine: Number(headerMatch[2]),
        finalLine: Number(headerMatch[3]),
        numLines: Number(headerMatch[4])
      }
      blocks.push(block)
      if (!commits.has(currentSha)) {
        commits.set(currentSha, {})
      }
      continue
    }

    if (!currentSha) continue
    const meta = commits.get(currentSha)!

    if (line.startsWith('author ')) {
      meta.author = line.slice(7).trim()
    } else if (line.startsWith('author-time ')) {
      const ts = Number(line.slice(12).trim())
      if (Number.isSafeInteger(ts) && ts > 0) {
        meta.authorTime = new Date(ts * 1000).toISOString()
      }
    } else if (line.startsWith('summary ')) {
      meta.summary = line.slice(8).trim()
    }
  }

  return { blocks, commits }
}

export async function inspectCodeProvenance(
  runner: CommandRunner,
  root: string,
  query: InspectCodeProvenanceQuery,
  assertActive: () => void = () => {}
): Promise<InspectCodeProvenanceMapResult | InspectCodeProvenanceDetailResult> {
  assertActive()
  const file = sanitizeRepoRelativePath(root, query.file)
  const mode = query.mode ?? 'MAP'

  const absPath = resolve(root, file)
  let stat
  try {
    stat = await lstat(absPath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('FILE_NOT_FOUND')
  } catch {
    throw new Error('FILE_NOT_FOUND')
  }

  if (query.startLine !== undefined && query.endLine !== undefined && query.startLine > query.endLine) {
    throw new Error('INVALID_ARGUMENT')
  }

  let startLine: number
  let endLine: number

  if (query.startLine === undefined && query.endLine === undefined) {
    startLine = 1
    endLine = 100
  } else if (query.startLine === undefined) {
    startLine = 1
    endLine = query.endLine!
  } else if (query.endLine === undefined) {
    startLine = query.startLine
    endLine = mode === 'DETAIL' ? startLine : startLine + 99
  } else {
    startLine = query.startLine
    endLine = query.endLine
  }

  if (endLine - startLine + 1 > 1000) {
    throw new Error('RANGE_TOO_LARGE')
  }

  assertActive()
  const blameOutput = await runner(
    'git',
    ['-c', 'core.fsmonitor=false', 'blame', '-L', `${startLine},${endLine}`, '--incremental', '--', file],
    root,
    2 * 1024 * 1024,
    undefined,
    10_000
  )
  assertActive()

  if (blameOutput.code !== 0 || blameOutput.limited) {
    const singleSegment: CodeProvenanceSegment = {
      startLine,
      endLine,
      lineCount: endLine - startLine + 1,
      status: 'unavailable'
    }
    if (mode === 'MAP') {
      return {
        source: 'GIT_BLAME_PROVENANCE',
        file,
        range: { startLine, endLine },
        segments: [singleSegment],
        coverage: 'PARTIAL',
        associationCoverage: 'TRAILER_ONLY'
      }
    }
    return {
      source: 'GIT_BLAME_PROVENANCE',
      file,
      range: { startLine, endLine },
      linkStrength: 'UNKNOWN',
      commit: null,
      checkpointId: null,
      candidates: [],
      coverage: 'PARTIAL'
    }
  }

  const { blocks, commits } = parseGitBlameIncremental(blameOutput.text)

  for (const [sha, meta] of commits) {
    assertActive()
    if (sha === '0000000000000000000000000000000000000000') {
      meta.status = 'uncommitted'
      meta.checkpointId = null
      continue
    }

    const logOutput = await runner(
      'git',
      ['-c', 'core.fsmonitor=false', 'log', '-1', '--format=%B', sha],
      root,
      64 * 1024,
      undefined,
      5000
    )
    assertActive()

    const trailerMatch = logOutput.text.match(/(?:^|\r?\n)Entire-Checkpoint:\s*([A-Za-z0-9]+)/i)
    if (trailerMatch) {
      const candidateCheckpointId = trailerMatch[1]
      const suffix = candidateCheckpointId.slice(-2)
      const refCheck = await runner(
        'git',
        ['-c', 'core.fsmonitor=false', 'rev-parse', '--verify', '--quiet', `refs/entire/checkpoints/${suffix}/${candidateCheckpointId}`],
        root,
        4096,
        undefined,
        5000
      )
      assertActive()

      if (refCheck.code === 0 && !refCheck.limited) {
        meta.status = 'checkpoint'
        meta.checkpointId = candidateCheckpointId
      } else {
        meta.status = 'commit'
        meta.checkpointId = null
      }
    } else {
      meta.status = 'commit'
      meta.checkpointId = null
    }
  }

  blocks.sort((a, b) => a.finalLine - b.finalLine)

  const segments: CodeProvenanceSegment[] = []
  let expectedNextLine = startLine

  for (const block of blocks) {
    const blockStart = block.finalLine
    const blockEnd = block.finalLine + block.numLines - 1

    if (blockStart > expectedNextLine) {
      segments.push({
        startLine: expectedNextLine,
        endLine: blockStart - 1,
        lineCount: blockStart - expectedNextLine,
        status: 'unavailable'
      })
    }

    const meta = commits.get(block.sha)
    const segment: CodeProvenanceSegment = {
      startLine: blockStart,
      endLine: blockEnd,
      lineCount: block.numLines,
      status: meta?.status ?? 'commit',
      commit: block.sha === '0000000000000000000000000000000000000000' ? null : block.sha,
      author: meta?.author,
      authorTime: meta?.authorTime,
      summary: meta?.summary,
      checkpointId: meta?.checkpointId ?? null
    }

    const prev = segments[segments.length - 1]
    if (
      prev &&
      prev.status === segment.status &&
      prev.commit === segment.commit &&
      prev.checkpointId === segment.checkpointId &&
      prev.endLine + 1 === segment.startLine
    ) {
      prev.endLine = segment.endLine
      prev.lineCount = prev.endLine - prev.startLine + 1
    } else {
      segments.push(segment)
    }

    expectedNextLine = blockEnd + 1
  }

  if (expectedNextLine <= endLine) {
    segments.push({
      startLine: expectedNextLine,
      endLine,
      lineCount: endLine - expectedNextLine + 1,
      status: 'unavailable'
    })
  }

  const hasUnavailable = segments.some(s => s.status === 'unavailable')
  const coverage = hasUnavailable ? 'PARTIAL' : 'COMPLETE'

  if (mode === 'MAP') {
    return {
      source: 'GIT_BLAME_PROVENANCE',
      file,
      range: { startLine, endLine },
      segments,
      coverage,
      associationCoverage: 'TRAILER_ONLY'
    }
  }

  const checkpointSegment = segments.find(s => s.status === 'checkpoint' && s.checkpointId)
  if (checkpointSegment && checkpointSegment.checkpointId) {
    const disambiguate = await readCheckpointDisambiguate(
      runner,
      root,
      { checkpointId: checkpointSegment.checkpointId, commit: checkpointSegment.commit ?? undefined, file },
      assertActive
    )
    return {
      source: 'GIT_BLAME_PROVENANCE',
      file,
      range: { startLine, endLine },
      linkStrength: 'TRAILER_VERIFIED',
      commit: checkpointSegment.commit ?? null,
      checkpointId: checkpointSegment.checkpointId,
      candidates: disambiguate.sessions.map(s => ({
        sessionIndex: s.sessionIndex,
        providerSessionId: s.providerSessionId,
        agent: s.agent,
        model: s.model,
        fileMatch: s.fileMatch,
        sessionFallback: s.sessionFallback,
        promptAvailable: s.promptAvailable,
        intentAvailable: s.intentAvailable,
        promptScope: s.promptScope,
        linkOrigin: s.linkOrigin
      })),
      coverage
    }
  }

  const primaryCommit = segments.find(s => s.commit)?.commit ?? null
  return {
    source: 'GIT_BLAME_PROVENANCE',
    file,
    range: { startLine, endLine },
    linkStrength: 'UNKNOWN',
    commit: primaryCommit,
    checkpointId: null,
    candidates: [],
    coverage
  }
}
