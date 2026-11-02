import type { CommandRunner } from './entire-provider'
import type {
  CodeProvenanceCandidate,
  InspectCheckpointDisambiguateResult,
  InspectCheckpointMetadataResult,
  InspectCheckpointReadFieldResult,
  PromptField,
  PromptScope
} from './provenance-types'
import { sanitize, utf8Prefix } from './privacy'

export interface InspectEntireCheckpointQuery {
  checkpointId?: string
  commit?: string
  mode?: 'INSPECT' | 'DISAMBIGUATE' | 'READ_FIELD'
  file?: string
  includePromptPreview?: boolean
  sessionIndex?: number
  field?: PromptField
  promptIndex?: number
  cursor?: string
  worktreeId?: string
  generation?: string
}

interface EntireCheckpointTopJson {
  cli_version?: string
  checkpoint_id?: string
  strategy?: string
  branch?: string
  created_at?: string
  checkpoints_count?: number
  files_touched?: string[]
  sessions?: Array<Record<string, unknown>>
  token_usage?: Record<string, number>
  redaction?: Record<string, unknown>
}

interface EntireSessionJson {
  cli_version?: string
  checkpoint_id?: string
  session_id?: string
  strategy?: string
  created_at?: string
  branch?: string
  files_touched?: string[]
  agent?: string
  model?: string
  intent?: string
  token_usage?: Record<string, number>
  redaction?: Record<string, unknown>
}

export function validateCheckpointId(id: string): string {
  const clean = id.trim()
  if (!/^[A-Za-z0-9]{10,40}$/.test(clean)) throw new Error('INVALID_ARGUMENT')
  return clean
}

export function validateCommitSha(sha: string): string {
  const clean = sha.trim().toLowerCase()
  if (!/^[a-f0-9]{40}$/.test(clean)) throw new Error('INVALID_ARGUMENT')
  return clean
}

export async function resolveCheckpointFromCommit(
  runner: CommandRunner,
  root: string,
  commitSha: string,
  assertActive: () => void = () => {}
): Promise<{ checkpointId: string; commitSha: string }> {
  assertActive()
  const sha = validateCommitSha(commitSha)
  const log = await runner(
    'git',
    ['-c', 'core.fsmonitor=false', 'log', '-1', '--format=%B', sha],
    root,
    64 * 1024,
    undefined,
    5000
  )
  assertActive()
  if (log.code !== 0 || log.limited) throw new Error('COMMIT_NOT_FOUND')

  const match = log.text.match(/(?:^|\r?\n)Entire-Checkpoint:\s*([A-Za-z0-9]+)/i)
  if (!match) throw new Error('CHECKPOINT_NOT_FOUND')
  return { checkpointId: validateCheckpointId(match[1]), commitSha: sha }
}

export async function readCheckpointTopMetadata(
  runner: CommandRunner,
  root: string,
  checkpointId: string,
  assertActive: () => void = () => {}
): Promise<{ json: EntireCheckpointTopJson; checkpointRef: string }> {
  assertActive()
  const cleanId = validateCheckpointId(checkpointId)
  const suffix = cleanId.slice(-2)
  const checkpointRef = `refs/entire/checkpoints/${suffix}/${cleanId}`

  const refCheck = await runner(
    'git',
    ['-c', 'core.fsmonitor=false', 'rev-parse', '--verify', '--quiet', checkpointRef],
    root,
    4096,
    undefined,
    5000
  )
  assertActive()
  if (refCheck.code !== 0 || refCheck.limited) throw new Error('CHECKPOINT_NOT_FOUND')

  const catMetadata = await runner(
    'git',
    ['-c', 'core.fsmonitor=false', 'cat-file', '-p', `${checkpointRef}:metadata.json`],
    root,
    512 * 1024,
    undefined,
    5000
  )
  assertActive()
  if (catMetadata.code !== 0 || catMetadata.limited) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')

  let json: EntireCheckpointTopJson
  try {
    json = JSON.parse(catMetadata.text)
  } catch {
    throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
  }

  if (json.cli_version !== '0.12.2') {
    throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
  }

  return { json, checkpointRef }
}

export async function readCheckpointDisambiguate(
  runner: CommandRunner,
  root: string,
  query: { checkpointId: string; commit?: string; file?: string; includePromptPreview?: boolean },
  assertActive: () => void = () => {}
): Promise<InspectCheckpointDisambiguateResult> {
  const { json, checkpointRef } = await readCheckpointTopMetadata(runner, root, query.checkpointId, assertActive)
  const sessionsCount = json.sessions?.length ?? 0
  const candidateSessions: Array<CodeProvenanceCandidate & { promptPreview?: string; isPreview?: boolean }> = []

  for (let i = 0; i < sessionsCount; i++) {
    assertActive()
    const catSession = await runner(
      'git',
      ['-c', 'core.fsmonitor=false', 'cat-file', '-p', `${checkpointRef}:${i}/metadata.json`],
      root,
      256 * 1024,
      undefined,
      5000
    )
    assertActive()

    if (catSession.code !== 0 || catSession.limited) continue
    let sessionJson: EntireSessionJson
    try {
      sessionJson = JSON.parse(catSession.text)
    } catch {
      continue
    }

    const promptStat = await runner(
      'git',
      ['-c', 'core.fsmonitor=false', 'cat-file', '-s', `${checkpointRef}:${i}/prompt.txt`],
      root,
      4096,
      undefined,
      5000
    )
    assertActive()
    const promptSize = promptStat.code === 0 && !promptStat.limited ? Number(promptStat.text.trim()) : 0
    const promptAvailable = Number.isSafeInteger(promptSize) && promptSize > 0

    let promptPreview: string | undefined
    let isPreview: boolean | undefined
    if (query.includePromptPreview && promptAvailable) {
      const promptRead = await runner(
        'git',
        ['-c', 'core.fsmonitor=false', 'cat-file', '-p', `${checkpointRef}:${i}/prompt.txt`],
        root,
        4096,
        undefined,
        5000
      )
      assertActive()
      if (promptRead.code === 0 && !promptRead.limited) {
        promptPreview = utf8Prefix(sanitize(promptRead.text), 120)
        isPreview = true
      }
    }

    const fileMatch = query.file ? sessionJson.files_touched?.includes(query.file) ?? false : undefined
    const intentAvailable = typeof sessionJson.intent === 'string' && sessionJson.intent.trim().length > 0

    candidateSessions.push({
      sessionIndex: i,
      providerSessionId: sessionJson.session_id,
      agent: sessionJson.agent,
      model: sessionJson.model,
      createdAt: sessionJson.created_at,
      fileMatch,
      sessionFallback: false,
      promptAvailable,
      intentAvailable,
      promptScope: 'SESSION',
      linkOrigin: query.commit ? 'TRAILER_VERIFIED' : 'EXPLICIT_SELECTION',
      ...(promptPreview ? { promptPreview, isPreview } : {})
    })
  }

  return {
    source: 'ENTIRE_CHECKPOINT_LOCAL',
    checkpointId: query.checkpointId,
    commit: query.commit,
    sessions: candidateSessions,
    coverage: 'COMPLETE'
  }
}

export function safeUtf8ByteLimit(buf: Buffer, maxBytes: number): number {
  if (buf.length <= maxBytes) return buf.length
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--
  }
  if (end === 0) return 0
  const lead = buf[end]
  let seqLen = 1
  if ((lead & 0x80) === 0) seqLen = 1
  else if ((lead & 0xe0) === 0xc0) seqLen = 2
  else if ((lead & 0xf0) === 0xe0) seqLen = 3
  else if ((lead & 0xf8) === 0xf0) seqLen = 4

  if (end + seqLen > maxBytes) {
    return end
  }
  return end + seqLen
}

export function splitPrompts(rawPrompt: string): string[] {
  if (!rawPrompt) return []
  if (!rawPrompt.includes('---')) return [rawPrompt]
  return rawPrompt.split(/(?:\r?\n){1,2}---\s*(?:\r?\n){1,2}/)
}

export interface CursorPayload {
  checkpointId: string
  sessionIndex: number
  field: PromptField
  promptIndex: number
  offset: number
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

export function decodeCursor(cursorStr: string): CursorPayload {
  try {
    const raw = Buffer.from(cursorStr, 'base64url').toString('utf8')
    const parsed = JSON.parse(raw) as CursorPayload
    if (
      typeof parsed.checkpointId !== 'string' ||
      typeof parsed.sessionIndex !== 'number' ||
      typeof parsed.field !== 'string' ||
      typeof parsed.promptIndex !== 'number' ||
      typeof parsed.offset !== 'number'
    ) {
      throw new Error()
    }
    return parsed
  } catch {
    throw new Error('CURSOR_INVALID')
  }
}

export async function inspectEntireCheckpoint(
  runner: CommandRunner,
  root: string,
  query: InspectEntireCheckpointQuery,
  assertActive: () => void = () => {}
): Promise<InspectCheckpointMetadataResult | InspectCheckpointDisambiguateResult | InspectCheckpointReadFieldResult> {
  assertActive()
  let checkpointId = query.checkpointId
  let commit = query.commit

  if (!checkpointId && !commit) {
    throw new Error('INVALID_ARGUMENT')
  }

  if (commit) {
    const resolved = await resolveCheckpointFromCommit(runner, root, commit, assertActive)
    if (checkpointId && checkpointId !== resolved.checkpointId) {
      throw new Error('SOURCE_IDENTITY_CONFLICT')
    }
    checkpointId = resolved.checkpointId
  }

  if (!checkpointId) throw new Error('CHECKPOINT_NOT_FOUND')
  const cleanCheckpointId = validateCheckpointId(checkpointId)
  const mode = query.mode ?? 'INSPECT'

  if (mode === 'INSPECT') {
    const { json } = await readCheckpointTopMetadata(runner, root, cleanCheckpointId, assertActive)
    return {
      source: 'ENTIRE_CHECKPOINT_LOCAL',
      checkpointId: cleanCheckpointId,
      commit,
      linkSource: commit ? 'TRAILER_VERIFIED' : 'EXPLICIT_SELECTION',
      cliVersion: json.cli_version,
      branch: json.branch,
      createdAt: json.created_at,
      sessionsCount: json.sessions?.length ?? 0,
      filesTouched: json.files_touched ?? [],
      tokenUsage: json.token_usage,
      redaction: json.redaction,
      coverage: 'COMPLETE'
    }
  }

  if (mode === 'DISAMBIGUATE') {
    return readCheckpointDisambiguate(
      runner,
      root,
      {
        checkpointId: cleanCheckpointId,
        commit,
        file: query.file,
        includePromptPreview: query.includePromptPreview
      },
      assertActive
    )
  }

  if (mode === 'READ_FIELD') {
    const sessionIndex = query.sessionIndex
    if (sessionIndex === undefined || !Number.isSafeInteger(sessionIndex) || sessionIndex < 0) {
      throw new Error('INVALID_ARGUMENT')
    }
    const field = query.field
    if (field !== 'STORED_PROMPT' && field !== 'INTENT') {
      throw new Error('INVALID_ARGUMENT')
    }

    const { json, checkpointRef } = await readCheckpointTopMetadata(runner, root, cleanCheckpointId, assertActive)
    const sessions = json.sessions ?? []
    if (sessionIndex >= sessions.length) {
      throw new Error('SESSION_INDEX_OUT_OF_BOUNDS')
    }

    let rawFieldText = ''
    let source: InspectCheckpointReadFieldResult['source'] = 'STORED_PROMPT'
    let promptScope: PromptScope = 'SESSION'
    let promptIndex = query.promptIndex ?? 0
    let promptCount = 1

    if (field === 'STORED_PROMPT') {
      const promptRead = await runner(
        'git',
        ['-c', 'core.fsmonitor=false', 'cat-file', '-p', `${checkpointRef}:${sessionIndex}/prompt.txt`],
        root,
        4 * 1024 * 1024,
        undefined,
        10_000
      )
      assertActive()
      if (promptRead.code !== 0 || promptRead.limited) throw new Error('PROMPT_UNAVAILABLE')

      const prompts = splitPrompts(promptRead.text)
      promptCount = prompts.length
      if (promptCount === 0) {
        rawFieldText = ''
      } else {
        if (promptIndex < 0 || promptIndex >= promptCount) {
          throw new Error('PROMPT_INDEX_OUT_OF_RANGE')
        }
        rawFieldText = prompts[promptIndex]
      }
      source = 'STORED_PROMPT'
      promptScope = 'SESSION'
    } else {
      const catSession = await runner(
        'git',
        ['-c', 'core.fsmonitor=false', 'cat-file', '-p', `${checkpointRef}:${sessionIndex}/metadata.json`],
        root,
        256 * 1024,
        undefined,
        5000
      )
      assertActive()
      if (catSession.code !== 0 || catSession.limited) throw new Error('INTENT_UNAVAILABLE')

      let sessionJson: EntireSessionJson
      try {
        sessionJson = JSON.parse(catSession.text)
      } catch {
        throw new Error('INTENT_UNAVAILABLE')
      }

      if (typeof sessionJson.intent !== 'string' || !sessionJson.intent.trim().length) {
        throw new Error('INTENT_UNAVAILABLE')
      }
      rawFieldText = sessionJson.intent.trim()
      source = 'INTENT_FALLBACK'
      promptScope = 'SESSION'
      promptIndex = 0
      promptCount = 1
    }

    const totalBytes = Buffer.byteLength(rawFieldText, 'utf8')
    let offset = 0

    if (query.cursor) {
      const decoded = decodeCursor(query.cursor)
      if (
        decoded.checkpointId !== cleanCheckpointId ||
        decoded.sessionIndex !== sessionIndex ||
        decoded.field !== field ||
        decoded.promptIndex !== promptIndex
      ) {
        throw new Error('CURSOR_INVALID')
      }
      if (decoded.offset > totalBytes) {
        throw new Error('CURSOR_STALE')
      }
      offset = decoded.offset
    }

    const PAGE_BUDGET = 6144
    const fullBuf = Buffer.from(rawFieldText, 'utf8')
    const remainingBuf = fullBuf.subarray(offset)
    const chunkSize = safeUtf8ByteLimit(remainingBuf, PAGE_BUDGET)
    const pageText = remainingBuf.subarray(0, chunkSize).toString('utf8')
    const endByte = offset + chunkSize
    const hasMore = endByte < totalBytes

    const nextCursor = hasMore
      ? encodeCursor({
          checkpointId: cleanCheckpointId,
          sessionIndex,
          field,
          promptIndex,
          offset: endByte
        })
      : undefined

    return {
      source,
      promptScope,
      checkpointId: cleanCheckpointId,
      sessionIndex,
      field,
      promptIndex,
      promptCount,
      content: pageText,
      range: { startByte: offset, endByte },
      totalBytes,
      complete: !hasMore,
      truncated: false,
      nextCursor,
      sanitized: false,
      provenance: 'OBSERVED_FROM_CHECKPOINT_REF',
      untrusted: true
    }
  }

  throw new Error('INVALID_ARGUMENT')
}
