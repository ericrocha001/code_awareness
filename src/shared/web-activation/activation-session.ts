import {
  ACTIVATION_CONTRACT_PROTOCOL,
  buildActivationBootstrapMessage,
  formatActivationResultEnvelope,
  parseActivationCallEnvelopes,
  type ActivationEnvelopeResultPayload,
  type AssistantTurnInput,
  type BootstrapSkillSummary,
  type BootstrapToolSummary,
  type ParsedActivationCall
} from './activation-contract'
import { deepEqualFrontmatter, parseSkillFrontmatter } from './skill-frontmatter'
import { ALLOWED_WEB_MCP_TOOLS } from './web-allowlist'

export type ActivationSessionState =
  | 'INACTIVE'
  | 'READY'
  | 'LOADING'
  | 'WAITING_TOOL'
  | 'RESUMING'
  | 'REVOKED'
  | 'UNAVAILABLE'

export type WebActivationTransportErrorCode =
  | 'APP_UNAVAILABLE'
  | 'TIMEOUT'
  | 'INVALID_MCP_RESPONSE'
  | 'TOOL_EXECUTION_ERROR'
  | 'SESSION_INVALIDATED'
  | 'CONSENT_REQUIRED'
  | 'ORIGIN_NOT_ALLOWED'
  | 'METHOD_NOT_ALLOWED'
  | 'TOOL_NOT_ALLOWED'
  | 'INVALID_URI'
  | string

export interface WebActivationStatusResponse {
  available: boolean
  mode?: 'PROJECT' | 'GLOBAL_ONLY'
  projectId?: string | null
  instanceId?: string | null
  bindingId?: string | null
  catalogRevision?: string | null
  consents?: {
    metadata: boolean
    literalSource: boolean
  }
  errorCode?: WebActivationTransportErrorCode
}

export interface WebActivationMcpTransportResult {
  ok: boolean
  mcp?: {
    id?: string | number | null
    result?: unknown
    error?: { code?: number; message?: string }
  }
  error?: {
    code: WebActivationTransportErrorCode
    message: string
    details?: {
      phase?: string
      timeoutMs?: number
      executionStateUnknown?: boolean
      [key: string]: unknown
    }
  }
}

export interface WebActivationTransport {
  getStatus(): Promise<WebActivationStatusResponse>
  mcpRequest(input: {
    method: string
    params?: Record<string, unknown>
    expectedProjectId: string | null
    expectedBindingId: string | null
    expectedInstanceId: string | null
  }): Promise<WebActivationMcpTransportResult>
}

export interface SkillResourceDescriptor {
  uri: string
  digest?: string
  size?: number
  mimeType?: string
}

export interface SkillEntryDescriptor {
  uri?: string
  name: string
  description: string
  frontmatter: Record<string, unknown>
  resources: SkillResourceDescriptor[]
}

export interface ContentBoundApproval {
  fingerprint: string
  server: string
  skillName: string
  site: string
  scope: string
  approvedAt: string
}

export interface VerifiedResourceCacheEntry {
  server: string
  scope: string
  uri: string
  digest: string
  size: number
  text: string
  verifiedAt: string
}

interface ActingWindow {
  server: string
  skillName: string
  skillUri: string
  entry: SkillEntryDescriptor
  resourcesByUri: Map<string, SkillResourceDescriptor>
}

export interface ActivationClock {
  setTimeout(cb: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
}

export interface ActivationSessionOptions {
  site: 'deepseek' | 'qwen' | string
  serverId?: string
  transport: WebActivationTransport
  maxCyclesPerUserTurn?: number
  maxResultChars?: number
  logicalCallTimeoutMs?: number
  clock?: ActivationClock
  requireContentApproval?: boolean
  requestSkillApproval?: (input: {
    server: string
    skillName: string
    site: string
    scope: string
    resources: SkillResourceDescriptor[]
    fingerprint: string
  }) => Promise<boolean>
}

export interface ActivateResult {
  state: ActivationSessionState
  bootstrapPrompt?: string
  skills?: BootstrapSkillSummary[]
  tools?: BootstrapToolSummary[]
  catalogRevision?: string | null
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

export interface ProcessTurnResult {
  state: ActivationSessionState
  emulatedResponses: string[]
  executedCalls: Array<{
    requestId: string
    method: string
    toolName?: string
    ok: boolean
    errorCode?: string
  }>
  cycleCount: number
  shouldSendReply: boolean
}

const DEFAULT_MAX_CYCLES_PER_USER_TURN = 6
const DEFAULT_MAX_RESULT_CHARS = 32_000
const DEFAULT_LOGICAL_CALL_TIMEOUT_MS = 75_000
const MAX_SAFE_ERROR_MESSAGE_CHARS = 400
const SHA256_PREFIX_RE = /^sha256:[0-9a-f]{64}$/i

function sanitizeCompactErrorMessage(raw: unknown, fallback: string): string {
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : fallback
  const trimmed = text
    .split(/\r?\n/)
    .filter((line) => !/^\s+at\s+/.test(line))
    .join(' ')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  if (!trimmed) return fallback
  return trimmed.length > MAX_SAFE_ERROR_MESSAGE_CHARS
    ? `${trimmed.slice(0, MAX_SAFE_ERROR_MESSAGE_CHARS - 3)}...`
    : trimmed
}

function extractMcpToolError(
  mcpResult: unknown
): { code: string; message: string } | null {
  if (!mcpResult || typeof mcpResult !== 'object' || Array.isArray(mcpResult)) {
    return null
  }
  const obj = mcpResult as { isError?: unknown; content?: unknown; code?: unknown; message?: unknown }
  if (obj.isError !== true) {
    return null
  }
  let rawText = ''
  if (Array.isArray(obj.content)) {
    rawText = obj.content
      .map((item) =>
        item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text
          : ''
      )
      .filter(Boolean)
      .join(' ')
  }
  let code = typeof obj.code === 'string' && /^[A-Z][A-Z0-9_]{2,64}$/.test(obj.code) ? obj.code : 'TOOL_EXECUTION_ERROR'
  let message = rawText
  if (rawText.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(rawText) as { code?: unknown; message?: unknown; error?: unknown }
      if (typeof parsed.code === 'string' && /^[A-Z][A-Z0-9_]{2,64}$/.test(parsed.code)) {
        code = parsed.code
      }
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        message = parsed.message
      } else if (typeof parsed.error === 'string' && parsed.error.trim()) {
        message = parsed.error
      }
    } catch {
      // Keep plain text when content is not structured JSON
    }
  } else {
    const codePrefix = /^([A-Z][A-Z0-9_]{2,64}):\s*(.+)$/s.exec(rawText.trim())
    if (codePrefix) {
      code = codePrefix[1]
      message = codePrefix[2]
    }
  }
  return {
    code,
    message: sanitizeCompactErrorMessage(message, 'Read-only MCP tool execution failed')
  }
}

async function computeSha256Hex(bytes: Uint8Array): Promise<{ hex: string; digest: string; byteLength: number }> {
  const cryptoObj = (globalThis as unknown as {
    crypto?: {
      subtle?: {
        digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer>
      }
    }
  }).crypto

  if (!cryptoObj?.subtle) {
    throw new Error('WEB_CRYPTO_SUBTLE_UNAVAILABLE')
  }

  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const hashBuffer = await cryptoObj.subtle.digest('SHA-256', copy)
  const hashBytes = new Uint8Array(hashBuffer)
  let hex = ''
  for (let i = 0; i < hashBytes.length; i++) {
    hex += hashBytes[i].toString(16).padStart(2, '0')
  }
  return {
    hex,
    digest: `sha256:${hex}`,
    byteLength: bytes.byteLength
  }
}

function buildContentApprovalFingerprint(input: {
  server: string
  skillName: string
  site: string
  scope: string
  resources: readonly SkillResourceDescriptor[]
}): string {
  const canonicalResources = [...input.resources]
    .map((r) => `${r.uri}#${r.digest ?? 'no-digest'}:${r.size ?? -1}`)
    .sort()
    .join('|')
  return `${input.server}::${input.skillName}::${input.site}::${input.scope}::${canonicalResources}`
}

function hasPathTraversalSegment(uri: string): boolean {
  const segments = uri.split(/[\\/]/)
  return segments.some((seg) => seg === '..' || seg === '.')
}

interface ParsedUriNamespace {
  scope: 'global' | 'project'
  destinationId: string | null
  skillId: string
  skillName: string
  relativePath: string
}

function parseSkillUriNamespace(rawUri: string): ParsedUriNamespace | null {
  if (!rawUri.startsWith('skill://') || hasPathTraversalSegment(rawUri)) return null
  const withoutScheme = rawUri.slice('skill://'.length)
  const parts = withoutScheme.split('/')
  if (parts[0] === 'global') {
    if (parts.length < 4) return null
    const [, skillId, skillName, ...rest] = parts
    if (!skillId || !skillName || rest.some((s) => !s)) return null
    return { scope: 'global', destinationId: null, skillId, skillName, relativePath: rest.join('/') }
  }
  if (parts[0] === 'project') {
    if (parts.length < 5) return null
    const [, destinationId, skillId, skillName, ...rest] = parts
    if (!destinationId || !skillId || !skillName || rest.some((s) => !s)) return null
    return { scope: 'project', destinationId, skillId, skillName, relativePath: rest.join('/') }
  }
  return null
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const floored = Math.floor(value)
  return floored > 0 ? floored : undefined
}

function normalizeNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function adjustSurrogateBoundary(text: string, endIndex: number): number {
  if (endIndex <= 0 || endIndex >= text.length) return endIndex
  const code = text.charCodeAt(endIndex - 1)
  if (code >= 0xd800 && code <= 0xdbff) {
    return endIndex - 1
  }
  return endIndex
}

export class ActivationSession {
  private readonly site: string
  private readonly serverId: string
  private readonly transport: WebActivationTransport
  private readonly maxCyclesPerUserTurn: number
  private readonly maxResultChars: number
  private readonly logicalCallTimeoutMs: number
  private readonly clock: ActivationClock
  private readonly requireContentApproval: boolean
  private readonly requestSkillApproval?: ActivationSessionOptions['requestSkillApproval']

  private state: ActivationSessionState = 'INACTIVE'
  private mode: 'PROJECT' | 'GLOBAL_ONLY' = 'GLOBAL_ONLY'
  private projectId: string | null = null
  private instanceId: string | null = null
  private bindingId: string | null = null
  private catalogRevision: string | null = null
  private sessionNonce = ''
  private sessionGeneration = 0
  private activeCallToken = 0
  private activeCallGuard: () => boolean = () => true

  private catalogSkills: BootstrapSkillSummary[] = []
  private internalSkillsByUri = new Map<string, SkillEntryDescriptor>()
  private authorizedDestinationIds = new Set<string>()
  private catalogTools: BootstrapToolSummary[] = []
  private fullToolsByName = new Map<string, BootstrapToolSummary>()
  private toolsLoaded = false

  private seenRequestIds = new Set<string>()
  private heldEntry: ActingWindow | null = null
  private approvals = new Map<string, ContentBoundApproval>()
  private verifiedResourceCache = new Map<string, VerifiedResourceCacheEntry>()
  private activeChatPresence = new Set<string>()
  private turnCycleCount = 0

  constructor(options: ActivationSessionOptions) {
    this.site = options.site
    this.serverId = options.serverId ?? 'code-awareness-desktop'
    this.transport = options.transport
    this.maxCyclesPerUserTurn = options.maxCyclesPerUserTurn ?? DEFAULT_MAX_CYCLES_PER_USER_TURN
    this.maxResultChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS
    this.logicalCallTimeoutMs = options.logicalCallTimeoutMs ?? DEFAULT_LOGICAL_CALL_TIMEOUT_MS
    this.clock = options.clock ?? {
      setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
      clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>)
    }
    this.requireContentApproval = options.requireContentApproval ?? false
    this.requestSkillApproval = options.requestSkillApproval
  }

  getState(): ActivationSessionState {
    return this.state
  }

  getBinding(): {
    mode: 'PROJECT' | 'GLOBAL_ONLY'
    projectId: string | null
    instanceId: string | null
    bindingId: string | null
    catalogRevision: string | null
  } {
    return {
      mode: this.mode,
      projectId: this.projectId,
      instanceId: this.instanceId,
      bindingId: this.bindingId,
      catalogRevision: this.catalogRevision
    }
  }

  getCatalogRevision(): string | null {
    return this.catalogRevision
  }

  getInternalSkillCatalog(): SkillEntryDescriptor[] {
    return Array.from(this.internalSkillsByUri.values())
  }

  getActingWindow(): { server: string; skillName: string; skillUri: string; allowedUris: string[] } | null {
    if (!this.heldEntry) return null
    return {
      server: this.heldEntry.server,
      skillName: this.heldEntry.skillName,
      skillUri: this.heldEntry.skillUri,
      allowedUris: Array.from(this.heldEntry.resourcesByUri.keys())
    }
  }

  getVerifiedCachedEntry(uri: string): VerifiedResourceCacheEntry | undefined {
    const entry = this.verifiedResourceCache.get(uri)
    return entry ? { ...entry } : undefined
  }

  isPresentInActiveChat(uri: string): boolean {
    return this.activeChatPresence.has(uri)
  }

  getTurnCycleCount(): number {
    return this.turnCycleCount
  }

  private getScopeKey(): string {
    return this.projectId ?? '__GLOBAL__'
  }

  private purgeEphemeralSessionState(preserveVerifiedCache = false): void {
    this.sessionGeneration += 1
    this.activeCallToken += 1
    this.heldEntry = null
    this.activeChatPresence.clear()
    this.seenRequestIds.clear()
    this.turnCycleCount = 0
    if (!preserveVerifiedCache) {
      this.verifiedResourceCache.clear()
      this.approvals.clear()
      this.catalogSkills = []
      this.internalSkillsByUri.clear()
      this.authorizedDestinationIds.clear()
      this.catalogTools = []
      this.fullToolsByName.clear()
      this.toolsLoaded = false
      this.catalogRevision = null
    }
  }

  startNewChat(): void {
    // New web conversation has NO local context until bootstrap and verified resources are explicitly delivered into it
    this.purgeEphemeralSessionState(true)
    this.sessionNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    if (this.state === 'LOADING' || this.state === 'WAITING_TOOL' || this.state === 'RESUMING') {
      this.state = 'READY'
    }
  }

  revoke(): void {
    this.purgeEphemeralSessionState(false)
    this.state = 'REVOKED'
  }

  invalidate(): void {
    this.purgeEphemeralSessionState(false)
    this.projectId = null
    this.bindingId = null
    this.instanceId = null
    this.state = 'INACTIVE'
  }

  clearActingWindow(): void {
    this.heldEntry = null
    if (this.state === 'LOADING' || this.state === 'WAITING_TOOL' || this.state === 'RESUMING') {
      this.state = 'READY'
    }
  }

  beginUserTurn(): void {
    this.turnCycleCount = 0
    this.clearActingWindow()
  }

  grantContentApproval(entry: SkillEntryDescriptor): ContentBoundApproval {
    const scope = this.getScopeKey()
    const fingerprint = buildContentApprovalFingerprint({
      server: this.serverId,
      skillName: entry.name,
      site: this.site,
      scope,
      resources: entry.resources
    })
    const approval: ContentBoundApproval = {
      fingerprint,
      server: this.serverId,
      skillName: entry.name,
      site: this.site,
      scope,
      approvedAt: new Date().toISOString()
    }
    this.approvals.set(`${this.serverId}::${entry.name}::${this.site}::${scope}`, approval)
    return { ...approval }
  }

  private ingestSkillsCatalogPayload(rawResult: Record<string, unknown> | undefined): void {
    const rawSkills = Array.isArray(rawResult?.skills)
      ? (rawResult.skills as Array<Record<string, unknown>>)
      : []

    this.catalogSkills = []
    this.internalSkillsByUri.clear()
    this.authorizedDestinationIds.clear()

    const resourcesDigestMap = new Map<string, { digest?: string; size?: number }>()

    for (const item of rawSkills) {
      const fm = (item?.frontmatter && typeof item.frontmatter === 'object' ? item.frontmatter : item) as
        | Record<string, unknown>
        | undefined
      const name = typeof fm?.name === 'string' ? fm.name : typeof item?.name === 'string' ? item.name : ''
      const description =
        typeof fm?.description === 'string' ? fm.description : typeof item?.description === 'string' ? item.description : ''
      const uri = typeof item?.uri === 'string' ? item.uri : ''
      if (!name || !description) continue

      const parsedNs = uri ? parseSkillUriNamespace(uri) : null
      if (parsedNs?.scope === 'project' && parsedNs.destinationId) {
        this.authorizedDestinationIds.add(parsedNs.destinationId)
      }

      const scope: BootstrapSkillSummary['scope'] = parsedNs?.scope ?? (
        uri.startsWith('skill://global/')
          ? 'global'
          : uri.startsWith('skill://project/')
            ? 'project'
            : 'unknown'
      )

      this.catalogSkills.push({
        server: this.serverId,
        name,
        description,
        ...(uri ? { uri } : {}),
        scope
      })

      if (uri && Array.isArray(item?.resources) && fm) {
        const resources: SkillResourceDescriptor[] = []
        for (const r of item.resources as Array<Record<string, unknown>>) {
          if (r && typeof r.uri === 'string') {
            const desc: SkillResourceDescriptor = {
              uri: r.uri,
              ...(typeof r.digest === 'string' ? { digest: r.digest } : {}),
              ...(typeof r.size === 'number' ? { size: r.size } : {}),
              ...(typeof r.mimeType === 'string' ? { mimeType: r.mimeType } : {})
            }
            resources.push(desc)
            resourcesDigestMap.set(desc.uri, { digest: desc.digest, size: desc.size })
          }
        }
        this.internalSkillsByUri.set(uri, {
          uri,
          name,
          description,
          frontmatter: fm,
          resources
        })
      }
    }

    const rev = typeof rawResult?.catalogRevision === 'string' ? rawResult.catalogRevision : null
    this.catalogRevision = rev

    // Selectively revalidate cached resources: evict changed/removed skills, retain unchanged (server, scope, uri, digest, size)
    const activeScope = this.getScopeKey()
    for (const [cachedUri, cached] of this.verifiedResourceCache.entries()) {
      if (cached.server !== this.serverId || cached.scope !== activeScope) {
        this.verifiedResourceCache.delete(cachedUri)
        continue
      }
      const nextMeta = resourcesDigestMap.get(cachedUri)
      if (!nextMeta) {
        // When catalog listing includes resources for skills, an unlisted resource was removed
        if (resourcesDigestMap.size > 0) {
          this.verifiedResourceCache.delete(cachedUri)
        }
        continue
      }
      if (nextMeta.digest && cached.digest.toLowerCase() !== nextMeta.digest.toLowerCase()) {
        this.verifiedResourceCache.delete(cachedUri)
        continue
      }
      if (typeof nextMeta.size === 'number' && cached.size !== nextMeta.size) {
        this.verifiedResourceCache.delete(cachedUri)
      }
    }
  }

  async refreshCatalog(): Promise<{ changed: boolean; catalogRevision: string | null }> {
    const previousRevision = this.catalogRevision
    const skillsRes = await this.transport.mcpRequest({
      method: 'skills/list',
      params: {},
      expectedProjectId: this.projectId,
      expectedBindingId: this.bindingId,
      expectedInstanceId: this.instanceId
    })
    if (!skillsRes.ok) {
      const code = skillsRes.error?.code
      if (code === 'CONSENT_REQUIRED') this.revoke()
      else if (code === 'SESSION_INVALIDATED') this.invalidate()
      else if (code === 'APP_UNAVAILABLE') this.state = 'UNAVAILABLE'
      return { changed: true, catalogRevision: null }
    }
    const resultObj = skillsRes.mcp?.result as Record<string, unknown> | undefined
    const nextRevision = typeof resultObj?.catalogRevision === 'string' ? resultObj.catalogRevision : null
    if (previousRevision !== null && nextRevision !== previousRevision) {
      // Invalidate catalog view immediately when revision drifts
      this.catalogSkills = []
      this.internalSkillsByUri.clear()
      this.heldEntry = null
    }
    this.ingestSkillsCatalogPayload(resultObj)
    return {
      changed: previousRevision !== this.catalogRevision,
      catalogRevision: this.catalogRevision
    }
  }

  private async ensureToolsInventory(): Promise<{ ok: true } | { ok: false; res: WebActivationMcpTransportResult }> {
    if (this.toolsLoaded) {
      return { ok: true }
    }
    const toolsRes = await this.transport.mcpRequest({
      method: 'tools/list',
      params: {},
      expectedProjectId: this.projectId,
      expectedBindingId: this.bindingId,
      expectedInstanceId: this.instanceId
    })
    if (!toolsRes.ok) {
      return { ok: false, res: toolsRes }
    }
    const rawTools =
      ((toolsRes.mcp?.result as { tools?: Array<Record<string, unknown>> } | undefined)?.tools) ?? []
    this.catalogTools = []
    this.fullToolsByName.clear()
    for (const item of rawTools) {
      if (typeof item?.name !== 'string' || !ALLOWED_WEB_MCP_TOOLS.has(item.name)) continue
      const compact: BootstrapToolSummary = {
        name: item.name,
        ...(typeof item.description === 'string' ? { description: item.description } : {})
      }
      this.catalogTools.push(compact)
      this.fullToolsByName.set(item.name, {
        ...compact,
        ...(item.inputSchema && typeof item.inputSchema === 'object'
          ? { inputSchema: item.inputSchema as Record<string, unknown> }
          : {})
      })
    }
    this.toolsLoaded = true
    return { ok: true }
  }

  async activate(): Promise<ActivateResult> {
    this.state = 'LOADING'
    this.purgeEphemeralSessionState(false)

    const status = await this.transport.getStatus()
    if (!status.available) {
      this.state = 'UNAVAILABLE'
      return {
        state: 'UNAVAILABLE',
        error: {
          code: status.errorCode ?? 'APP_UNAVAILABLE',
          message: 'Code Awareness Desktop is unavailable'
        }
      }
    }

    this.mode = status.mode ?? (status.projectId ? 'PROJECT' : 'GLOBAL_ONLY')
    this.projectId = status.projectId ?? null
    this.instanceId = status.instanceId ?? null
    this.bindingId = status.bindingId ?? null
    this.sessionNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

    const skillsRes = await this.transport.mcpRequest({
      method: 'skills/list',
      params: {},
      expectedProjectId: this.projectId,
      expectedBindingId: this.bindingId,
      expectedInstanceId: this.instanceId
    })

    if (!skillsRes.ok) {
      return this.handleActivateError(skillsRes)
    }

    const resultObj = skillsRes.mcp?.result as Record<string, unknown> | undefined
    this.ingestSkillsCatalogPayload(resultObj)

    // Progressive first-turn bootstrap intentionally omits MCP tools and schemas until a skill is loaded
    const bootstrapPrompt = buildActivationBootstrapMessage({
      site: this.site,
      mode: this.mode,
      projectId: this.projectId,
      skills: this.catalogSkills,
      sessionNonce: this.sessionNonce
    })

    this.state = 'READY'
    this.activeChatPresence.add('bootstrap://activation-contract')

    return {
      state: 'READY',
      bootstrapPrompt,
      skills: [...this.catalogSkills],
      catalogRevision: this.catalogRevision
    }
  }

  private handleActivateError(res: WebActivationMcpTransportResult): ActivateResult {
    const code = res.error?.code ?? 'MCP_ERROR'
    const message = res.error?.message ?? 'Activation request failed'
    if (code === 'CONSENT_REQUIRED') {
      this.state = 'REVOKED'
    } else if (code === 'APP_UNAVAILABLE') {
      this.state = 'UNAVAILABLE'
    } else {
      this.state = 'INACTIVE'
    }
    return {
      state: this.state,
      error: {
        code,
        message,
        ...(res.error?.details ? { details: res.error.details } : {})
      }
    }
  }

  async processAssistantTurn(turn: AssistantTurnInput): Promise<ProcessTurnResult> {
    if (this.state === 'INACTIVE' || this.state === 'REVOKED' || this.state === 'UNAVAILABLE') {
      return {
        state: this.state,
        emulatedResponses: [],
        executedCalls: [],
        cycleCount: this.turnCycleCount,
        shouldSendReply: false
      }
    }

    const parsed = parseActivationCallEnvelopes(turn)
    if (parsed.ignoredReason) {
      return {
        state: this.state,
        emulatedResponses: [],
        executedCalls: [],
        cycleCount: this.turnCycleCount,
        shouldSendReply: false
      }
    }

    if (parsed.calls.length === 0 && parsed.rejected.length === 0) {
      this.clearActingWindow()
      return {
        state: this.state,
        emulatedResponses: [],
        executedCalls: [],
        cycleCount: this.turnCycleCount,
        shouldSendReply: false
      }
    }

    const emulatedResponses: string[] = []
    const executedCalls: ProcessTurnResult['executedCalls'] = []

    for (const bad of parsed.rejected) {
      const requestId = bad.requestId ?? 'invalid'
      emulatedResponses.push(
        formatActivationResultEnvelope({
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId,
          server: this.serverId,
          ok: false,
          error: { code: bad.code, message: bad.message }
        })
      )
      executedCalls.push({ requestId, method: 'invalid', ok: false, errorCode: bad.code })
    }

    for (let i = 0; i < parsed.calls.length; i += 1) {
      const call = parsed.calls[i]
      if (this.seenRequestIds.has(call.requestId)) {
        emulatedResponses.push(
          formatActivationResultEnvelope({
            protocol: ACTIVATION_CONTRACT_PROTOCOL,
            requestId: call.requestId,
            server: this.serverId,
            ok: false,
            error: { code: 'DUPLICATE_REQUEST_ID', message: `RequestId "${call.requestId}" already processed` }
          })
        )
        executedCalls.push({ requestId: call.requestId, method: call.method, ok: false, errorCode: 'DUPLICATE_REQUEST_ID' })
        continue
      }

      if (this.turnCycleCount >= this.maxCyclesPerUserTurn) {
        this.clearActingWindow()
        for (let j = i; j < parsed.calls.length; j += 1) {
          const skipped = parsed.calls[j]
          emulatedResponses.push(
            formatActivationResultEnvelope({
              protocol: ACTIVATION_CONTRACT_PROTOCOL,
              requestId: skipped.requestId,
              server: this.serverId,
              ok: false,
              error: {
                code: 'CYCLE_LIMIT_EXCEEDED',
                message: `Exceeded maximum of ${this.maxCyclesPerUserTurn} activation calls for this turn`
              }
            })
          )
          executedCalls.push({
            requestId: skipped.requestId,
            method: skipped.method,
            ok: false,
            errorCode: 'CYCLE_LIMIT_EXCEEDED'
          })
        }
        break
      }

      this.seenRequestIds.add(call.requestId)
      this.turnCycleCount += 1
      this.state = 'WAITING_TOOL'

      const resultEnvelope = await this.executeCallWithDeadline(call)
      emulatedResponses.push(formatActivationResultEnvelope(resultEnvelope))
      executedCalls.push({
        requestId: call.requestId,
        method: call.method,
        ...(typeof call.params.name === 'string' && call.params.name.trim()
          ? { toolName: call.params.name.trim() }
          : {}),
        ok: resultEnvelope.ok,
        ...(resultEnvelope.error ? { errorCode: resultEnvelope.error.code } : {})
      })

      if (this.getState() === 'REVOKED' || this.getState() === 'UNAVAILABLE' || this.getState() === 'INACTIVE') {
        break
      }
    }

    if (this.getState() === 'WAITING_TOOL') {
      this.state = 'RESUMING'
    }

    return {
      state: this.state,
      emulatedResponses,
      executedCalls,
      cycleCount: this.turnCycleCount,
      shouldSendReply: emulatedResponses.length > 0
    }
  }

  private async executeCallWithDeadline(call: ParsedActivationCall): Promise<ActivationEnvelopeResultPayload> {
    const startSessionGen = this.sessionGeneration
    const callToken = ++this.activeCallToken
    let settled = false
    const previousGuard = this.activeCallGuard
    const guard = () =>
      !settled &&
      this.sessionGeneration === startSessionGen &&
      this.activeCallToken === callToken
    this.activeCallGuard = guard

    let timeoutTimer: unknown = null
    try {
      const deadlinePromise = new Promise<ActivationEnvelopeResultPayload>((resolve) => {
        timeoutTimer = this.clock.setTimeout(() => {
          if (settled) return
          settled = true
          if (this.sessionGeneration === startSessionGen && this.getState() === 'WAITING_TOOL') {
            this.state = 'RESUMING'
          }
          resolve({
            protocol: ACTIVATION_CONTRACT_PROTOCOL,
            requestId: call.requestId,
            server: this.serverId,
            ok: false,
            error: {
              code: 'TIMEOUT',
              message: `Activation call timed out after ${this.logicalCallTimeoutMs}ms (phase: execution); remote execution outcome is unknown, do not assume it failed to run.`
            }
          })
        }, this.logicalCallTimeoutMs)
      })

      const executionPromise = Promise.resolve()
        .then(() => this.executeSingleCall(call, guard))
        .catch((err): ActivationEnvelopeResultPayload => ({
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId: call.requestId,
          server: this.serverId,
          ok: false,
          error: {
            code: 'EXECUTION_ERROR',
            message: sanitizeCompactErrorMessage(err, 'Activation call failed unexpectedly')
          }
        }))

      const outcome = await Promise.race([executionPromise, deadlinePromise])
      settled = true
      return outcome
    } finally {
      settled = true
      if (timeoutTimer !== null) {
        this.clock.clearTimeout(timeoutTimer)
      }
      if (this.activeCallGuard === guard) {
        this.activeCallGuard = previousGuard
      }
      if (this.sessionGeneration === startSessionGen && this.getState() === 'WAITING_TOOL') {
        this.state = 'RESUMING'
      }
    }
  }

  private mapTransportFailure(requestId: string, res: WebActivationMcpTransportResult): ActivationEnvelopeResultPayload {
    const errCode = res.error?.code ?? 'MCP_ERROR'
    const phase = typeof res.error?.details?.phase === 'string' ? res.error.details.phase : undefined
    const rawMsg = res.error?.message ?? 'MCP request failed'
    const compactMsg = sanitizeCompactErrorMessage(rawMsg, 'MCP request failed')
    const errMsg =
      errCode === 'TIMEOUT'
        ? `${compactMsg}${phase ? ` (phase: ${phase})` : ''} — execution state may be unknown.`
        : compactMsg
    if (errCode === 'CONSENT_REQUIRED') {
      this.revoke()
    } else if (errCode === 'APP_UNAVAILABLE') {
      this.clearActingWindow()
      this.state = 'UNAVAILABLE'
    } else if (errCode === 'SESSION_INVALIDATED') {
      this.invalidate()
    } else if (errCode !== 'TIMEOUT') {
      this.clearActingWindow()
    }
    return {
      protocol: ACTIVATION_CONTRACT_PROTOCOL,
      requestId,
      server: this.serverId,
      ok: false,
      error: { code: errCode, message: errMsg }
    }
  }

  private validateAuthorizedNamespace(uri: string): string | null {
    const parsed = parseSkillUriNamespace(uri)
    if (!parsed) {
      return `Skill URI "${uri}" is malformed or outside authorized skill:// namespaces`
    }
    if (this.mode === 'GLOBAL_ONLY' && parsed.scope === 'project') {
      return `Project skill URI "${uri}" is not authorized in GLOBAL_ONLY mode`
    }
    if (
      parsed.scope === 'project' &&
      this.authorizedDestinationIds.size > 0 &&
      parsed.destinationId &&
      !this.authorizedDestinationIds.has(parsed.destinationId)
    ) {
      return `Project destination "${parsed.destinationId}" is not authorized for the active project`
    }
    return null
  }

  private async executeSingleCall(
    call: ParsedActivationCall,
    guard: () => boolean = () => true
  ): Promise<ActivationEnvelopeResultPayload> {
    if (call.method === 'tools.schema' || call.method === 'tools/describe') {
      return await this.executeToolsSchemaCall(call.requestId, call.params)
    }

    if (call.method === 'skills.load') {
      return await this.executeSkillsLoadCall(call.requestId, call.params)
    }

    const normalizedMethod =
      call.method === 'resources.read'
        ? 'resources/read'
        : call.method === 'tools.call'
          ? 'tools/call'
          : call.method

    let outboundParams = call.params
    let requestedUri: string | undefined

    if (normalizedMethod === 'skills/get') {
      if (typeof outboundParams.uri === 'string' && outboundParams.uri.trim()) {
        requestedUri = outboundParams.uri.trim()
        const nsErr = this.validateAuthorizedNamespace(requestedUri)
        if (nsErr) {
          this.clearActingWindow()
          return {
            protocol: ACTIVATION_CONTRACT_PROTOCOL,
            requestId: call.requestId,
            server: this.serverId,
            ok: false,
            error: { code: 'SKILL_NAMESPACE_UNAUTHORIZED', message: nsErr }
          }
        }
      } else if (typeof outboundParams.name === 'string') {
        const matched = this.catalogSkills.find((s) => s.name === outboundParams.name && typeof s.uri === 'string')
        if (matched?.uri) {
          requestedUri = matched.uri
          outboundParams = { ...outboundParams, uri: matched.uri }
        }
      }
    }

    if (normalizedMethod === 'resources/read') {
      const uri = typeof call.params.uri === 'string' ? call.params.uri.trim() : ''
      if (!this.heldEntry || !this.heldEntry.resourcesByUri.has(uri)) {
        this.clearActingWindow()
        return {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId: call.requestId,
          server: this.serverId,
          ok: false,
          error: {
            code: 'RESOURCE_OUTSIDE_ACTING_WINDOW',
            message: `Resource "${uri}" is not declared in the active skill acting window`
          }
        }
      }
      outboundParams = { uri }
    }

    if (normalizedMethod === 'tools/call') {
      const toolName = typeof call.params.name === 'string' ? call.params.name.trim() : ''
      if (!ALLOWED_WEB_MCP_TOOLS.has(toolName)) {
        return {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId: call.requestId,
          server: this.serverId,
          ok: false,
          error: {
            code: 'TOOL_NOT_ALLOWED',
            message: `Tool "${toolName}" is not in the read-only web allowlist`
          }
        }
      }
      outboundParams = {
        name: toolName,
        arguments:
          call.params.arguments && typeof call.params.arguments === 'object' && !Array.isArray(call.params.arguments)
            ? call.params.arguments
            : {}
      }
    }

    const res = await this.transport.mcpRequest({
      method: normalizedMethod,
      params: outboundParams,
      expectedProjectId: this.projectId,
      expectedBindingId: this.bindingId,
      expectedInstanceId: this.instanceId
    })

    if (!res.ok) {
      if (!guard()) {
        return {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId: call.requestId,
          server: this.serverId,
          ok: false,
          error: { code: 'TIMEOUT', message: 'Call superseded or timed out before transport response completed' }
        }
      }
      return this.mapTransportFailure(call.requestId, res)
    }

    if (!guard()) {
      return {
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId: call.requestId,
        server: this.serverId,
        ok: false,
        error: { code: 'TIMEOUT', message: 'Call superseded or timed out before result processing' }
      }
    }

    if (!res.mcp || typeof res.mcp !== 'object' || Array.isArray(res.mcp)) {
      return {
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId: call.requestId,
        server: this.serverId,
        ok: false,
        error: { code: 'INVALID_MCP_RESPONSE', message: 'Bridge returned missing or malformed MCP payload' }
      }
    }

    if (res.mcp.error) {
      this.clearActingWindow()
      return {
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId: call.requestId,
        server: this.serverId,
        ok: false,
        error: {
          code: `JSONRPC_${res.mcp.error.code ?? -32000}`,
          message: sanitizeCompactErrorMessage(res.mcp.error.message, 'MCP server returned JSON-RPC error')
        }
      }
    }

    if (!('result' in res.mcp) || res.mcp.result === undefined) {
      return {
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId: call.requestId,
        server: this.serverId,
        ok: false,
        error: { code: 'INVALID_MCP_RESPONSE', message: 'MCP response omitted both result and error' }
      }
    }

    const mcpResult = res.mcp.result

    if (normalizedMethod === 'skills/get') {
      return await this.handleSkillsGetResult(call.requestId, requestedUri, mcpResult)
    }

    if (normalizedMethod === 'resources/read') {
      const uri = typeof outboundParams.uri === 'string' ? outboundParams.uri : ''
      return await this.handleResourcesReadResult(
        call.requestId,
        uri,
        mcpResult,
        normalizeNonNegativeInt(call.params.offset),
        normalizePositiveInt(call.params.maxChars)
      )
    }

    if (normalizedMethod === 'tools/call') {
      return this.handleToolsCallResult(
        call.requestId,
        mcpResult,
        normalizeNonNegativeInt(call.params.offset),
        normalizePositiveInt(call.params.maxChars)
      )
    }

    return this.boundedSuccessEnvelope(call.requestId, mcpResult)
  }

  private async executeToolsSchemaCall(
    requestId: string,
    params: Record<string, unknown>
  ): Promise<ActivationEnvelopeResultPayload> {
    const requestedNames: string[] = []
    if (typeof params.name === 'string' && params.name.trim()) {
      requestedNames.push(params.name.trim())
    }
    if (Array.isArray(params.names)) {
      for (const n of params.names) {
        if (typeof n === 'string' && n.trim() && !requestedNames.includes(n.trim())) {
          requestedNames.push(n.trim())
        }
      }
    }
    if (requestedNames.length === 0) {
      return {
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId,
        server: this.serverId,
        ok: false,
        error: { code: 'INVALID_PARAMS', message: 'tools.schema requires at least one tool name' }
      }
    }

    for (const toolName of requestedNames) {
      if (!ALLOWED_WEB_MCP_TOOLS.has(toolName)) {
        return {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId,
          server: this.serverId,
          ok: false,
          error: { code: 'TOOL_NOT_ALLOWED', message: `Tool "${toolName}" is not allowed in web activation` }
        }
      }
    }

    const loaded = await this.ensureToolsInventory()
    if (!loaded.ok) {
      return this.mapTransportFailure(requestId, loaded.res)
    }

    const schemas: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> = []
    for (const toolName of requestedNames) {
      const toolDef = this.fullToolsByName.get(toolName)
      if (!toolDef) {
        return {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId,
          server: this.serverId,
          ok: false,
          error: {
            code: 'TOOL_NOT_ALLOWED',
            message: `Tool "${toolName}" is unavailable in the active session scope`
          }
        }
      }
      schemas.push({
        name: toolDef.name,
        ...(toolDef.description ? { description: toolDef.description } : {}),
        inputSchema: toolDef.inputSchema ?? { type: 'object', properties: {} }
      })
    }

    return this.boundedSuccessEnvelope(requestId, { tools: schemas })
  }

  private async executeSkillsLoadCall(
    requestId: string,
    params: Record<string, unknown>
  ): Promise<ActivationEnvelopeResultPayload> {
    let requestedUri = typeof params.uri === 'string' ? params.uri.trim() : ''
    if (!requestedUri && typeof params.name === 'string') {
      const matched = this.catalogSkills.find((s) => s.name === params.name && typeof s.uri === 'string')
      if (matched?.uri) {
        requestedUri = matched.uri
      }
    }
    if (!requestedUri && typeof params.name !== 'string') {
      return {
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId,
        server: this.serverId,
        ok: false,
        error: { code: 'INVALID_PARAMS', message: 'skills.load requires params.uri or a known skill params.name' }
      }
    }
    if (requestedUri) {
      const nsErr = this.validateAuthorizedNamespace(requestedUri)
      if (nsErr) {
        this.clearActingWindow()
        return {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId,
          server: this.serverId,
          ok: false,
          error: { code: 'SKILL_NAMESPACE_UNAUTHORIZED', message: nsErr }
        }
      }
    }

    const getRes = await this.transport.mcpRequest({
      method: 'skills/get',
      params: requestedUri ? { uri: requestedUri } : { name: params.name },
      expectedProjectId: this.projectId,
      expectedBindingId: this.bindingId,
      expectedInstanceId: this.instanceId
    })
    if (!getRes.ok) {
      return this.mapTransportFailure(requestId, getRes)
    }
    if (getRes.mcp?.error) {
      this.clearActingWindow()
      return {
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId,
        server: this.serverId,
        ok: false,
        error: {
          code: `JSONRPC_${getRes.mcp.error.code ?? -32000}`,
          message: getRes.mcp.error.message ?? 'skills/get failed'
        }
      }
    }

    const verifiedWindow = await this.verifyAndOpenSkillWindow(
      requestId,
      requestedUri || undefined,
      getRes.mcp?.result
    )
    if (!verifiedWindow.ok) {
      return verifiedWindow.envelope
    }

    const window = verifiedWindow.window
    const skillMdUri = window.skillUri
    const expectedSkillMd = window.resourcesByUri.get(skillMdUri)

    const currentScope = this.getScopeKey()
    const cached = this.verifiedResourceCache.get(skillMdUri)
    let verifiedText: string | null = null

    if (
      cached &&
      cached.server === this.serverId &&
      cached.scope === currentScope &&
      expectedSkillMd?.digest &&
      cached.digest.toLowerCase() === expectedSkillMd.digest.toLowerCase() &&
      (typeof expectedSkillMd.size !== 'number' || cached.size === expectedSkillMd.size)
    ) {
      verifiedText = cached.text
    } else {
      const readRes = await this.transport.mcpRequest({
        method: 'resources/read',
        params: { uri: skillMdUri },
        expectedProjectId: this.projectId,
        expectedBindingId: this.bindingId,
        expectedInstanceId: this.instanceId
      })
      if (!readRes.ok) {
        return this.mapTransportFailure(requestId, readRes)
      }
      if (readRes.mcp?.error) {
        this.clearActingWindow()
        return {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId,
          server: this.serverId,
          ok: false,
          error: {
            code: `JSONRPC_${readRes.mcp.error.code ?? -32000}`,
            message: readRes.mcp.error.message ?? 'resources/read failed'
          }
        }
      }

      const verifiedRead = await this.verifyResourcePayload(requestId, skillMdUri, window, readRes.mcp?.result)
      if (!verifiedRead.ok) {
        return verifiedRead.envelope
      }
      verifiedText = verifiedRead.text
    }

    this.activeChatPresence.add(skillMdUri)

    const toolsLoaded = await this.ensureToolsInventory()
    const availableTools = toolsLoaded.ok
      ? this.catalogTools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {})
        }))
      : []

    const auxiliaryResources = window.entry.resources
      .map((r) => r.uri)
      .filter((u) => u !== skillMdUri)

    const skillScope: 'global' | 'project' = skillMdUri.startsWith('skill://global/') ? 'global' : 'project'
    const offset = normalizeNonNegativeInt(params.offset)
    const maxChars = normalizePositiveInt(params.maxChars)

    return this.buildPaginatedEnvelope(requestId, verifiedText, offset, maxChars, (slice, meta) => ({
      skill: {
        name: window.entry.name,
        description: window.entry.description,
        uri: skillMdUri,
        scope: skillScope,
        auxiliaryResources
      },
      content: slice,
      truncated: meta.truncated,
      totalChars: meta.totalChars,
      offset: meta.offset,
      ...(meta.nextOffset !== undefined ? { nextOffset: meta.nextOffset } : {}),
      availableTools,
      nextMethods: {
        schema: 'tools.schema',
        call: 'tools.call',
        readResource: 'resources.read'
      }
    }))
  }

  private async verifyAndOpenSkillWindow(
    requestId: string,
    requestedUri: string | undefined,
    mcpResult: unknown
  ): Promise<{ ok: true; window: ActingWindow } | { ok: false; envelope: ActivationEnvelopeResultPayload }> {
    const wrapped = mcpResult as
      | { skill?: Partial<SkillEntryDescriptor>; catalogRevision?: unknown }
      | Partial<SkillEntryDescriptor>
      | undefined
    const entry =
      wrapped && typeof wrapped === 'object' && 'skill' in wrapped && wrapped.skill && typeof wrapped.skill === 'object'
        ? wrapped.skill
        : (wrapped as Partial<SkillEntryDescriptor> | undefined)

    const responseCatalogRevision =
      wrapped && typeof wrapped === 'object' && typeof (wrapped as { catalogRevision?: unknown }).catalogRevision === 'string'
        ? (wrapped as { catalogRevision: string }).catalogRevision
        : null

    const frontmatterObj =
      entry?.frontmatter && typeof entry.frontmatter === 'object' && !Array.isArray(entry.frontmatter)
        ? (entry.frontmatter as Record<string, unknown>)
        : null

    const resolvedName =
      typeof frontmatterObj?.name === 'string'
        ? frontmatterObj.name
        : typeof entry?.name === 'string'
          ? entry.name
          : ''
    const resolvedDescription =
      typeof frontmatterObj?.description === 'string'
        ? frontmatterObj.description
        : typeof entry?.description === 'string'
          ? entry.description
          : ''

    if (!entry || !resolvedName || !resolvedDescription || !frontmatterObj || !Array.isArray(entry.resources)) {
      this.clearActingWindow()
      return {
        ok: false,
        envelope: {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId,
          server: this.serverId,
          ok: false,
          error: { code: 'INVALID_SKILL_ENTRY', message: 'skills/get returned malformed skill descriptor' }
        }
      }
    }

    const resourcesByUri = new Map<string, SkillResourceDescriptor>()
    let skillMdUri: string | null = null
    for (const resource of entry.resources) {
      if (!resource || typeof resource.uri !== 'string' || !resource.uri.trim()) {
        this.clearActingWindow()
        return {
          ok: false,
          envelope: {
            protocol: ACTIVATION_CONTRACT_PROTOCOL,
            requestId,
            server: this.serverId,
            ok: false,
            error: { code: 'INVALID_SKILL_ENTRY', message: 'Skill resource entry is missing a URI' }
          }
        }
      }
      if (hasPathTraversalSegment(resource.uri)) {
        this.clearActingWindow()
        return {
          ok: false,
          envelope: {
            protocol: ACTIVATION_CONTRACT_PROTOCOL,
            requestId,
            server: this.serverId,
            ok: false,
            error: { code: 'INVALID_URI', message: `Skill resource URI contains unsafe segment: ${resource.uri}` }
          }
        }
      }
      if (resourcesByUri.has(resource.uri)) {
        this.clearActingWindow()
        return {
          ok: false,
          envelope: {
            protocol: ACTIVATION_CONTRACT_PROTOCOL,
            requestId,
            server: this.serverId,
            ok: false,
            error: { code: 'INVALID_SKILL_ENTRY', message: `Duplicate resource URI declared: ${resource.uri}` }
          }
        }
      }
      if (resource.uri.endsWith('/SKILL.md')) {
        skillMdUri = resource.uri
      }
      resourcesByUri.set(resource.uri, resource)
    }

    if (!skillMdUri) {
      this.clearActingWindow()
      return {
        ok: false,
        envelope: {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId,
          server: this.serverId,
          ok: false,
          error: { code: 'INVALID_SKILL_ENTRY', message: 'Skill descriptor must declare a SKILL.md resource' }
        }
      }
    }

    const canonicalSkillUri = typeof entry.uri === 'string' && entry.uri.trim() ? entry.uri.trim() : skillMdUri
    if (canonicalSkillUri !== skillMdUri) {
      this.clearActingWindow()
      return {
        ok: false,
        envelope: {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId,
          server: this.serverId,
          ok: false,
          error: {
            code: 'SKILL_URI_MISMATCH',
            message: `Canonical skill.uri "${canonicalSkillUri}" does not match SKILL.md resource "${skillMdUri}"`
          }
        }
      }
    }

    if (requestedUri && canonicalSkillUri !== requestedUri) {
      this.clearActingWindow()
      return {
        ok: false,
        envelope: {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId,
          server: this.serverId,
          ok: false,
          error: {
            code: 'SKILL_URI_MISMATCH',
            message: `Requested URI "${requestedUri}" does not match returned skill.uri "${canonicalSkillUri}"`
          }
        }
      }
    }

    const nsErr = this.validateAuthorizedNamespace(canonicalSkillUri)
    if (nsErr) {
      this.clearActingWindow()
      return {
        ok: false,
        envelope: {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId,
          server: this.serverId,
          ok: false,
          error: { code: 'SKILL_NAMESPACE_UNAUTHORIZED', message: nsErr }
        }
      }
    }

    if (!this.activeCallGuard()) {
      return {
        ok: false,
        envelope: {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId,
          server: this.serverId,
          ok: false,
          error: { code: 'TIMEOUT', message: 'Skill activation superseded or timed out' }
        }
      }
    }

    if (responseCatalogRevision && this.catalogRevision !== null && responseCatalogRevision !== this.catalogRevision) {
      this.catalogRevision = responseCatalogRevision
    }

    const fullEntry: SkillEntryDescriptor = {
      uri: canonicalSkillUri,
      name: resolvedName,
      description: resolvedDescription,
      frontmatter: frontmatterObj,
      resources: entry.resources
    }
    this.internalSkillsByUri.set(canonicalSkillUri, fullEntry)

    const scope = this.getScopeKey()
    const approvalKey = `${this.serverId}::${fullEntry.name}::${this.site}::${scope}`
    const fingerprint = buildContentApprovalFingerprint({
      server: this.serverId,
      skillName: fullEntry.name,
      site: this.site,
      scope,
      resources: fullEntry.resources
    })

    const existingApproval = this.approvals.get(approvalKey)
    if (existingApproval && existingApproval.fingerprint !== fingerprint) {
      this.approvals.delete(approvalKey)
      this.clearActingWindow()
      return {
        ok: false,
        envelope: {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId,
          server: this.serverId,
          ok: false,
          error: {
            code: 'CONTENT_APPROVAL_MISMATCH',
            message: `Skill "${fullEntry.name}" changed since previous approval; explicit re-approval required`
          }
        }
      }
    }

    if (!existingApproval && this.requireContentApproval) {
      const approved = this.requestSkillApproval
        ? await this.requestSkillApproval({
            server: this.serverId,
            skillName: fullEntry.name,
            site: this.site,
            scope,
            resources: fullEntry.resources,
            fingerprint
          })
        : false
      if (!approved) {
        this.clearActingWindow()
        return {
          ok: false,
          envelope: {
            protocol: ACTIVATION_CONTRACT_PROTOCOL,
            requestId,
            server: this.serverId,
            ok: false,
            error: {
              code: 'SKILL_APPROVAL_REQUIRED',
              message: `Content-bound approval denied or missing for skill "${fullEntry.name}"`
            }
          }
        }
      }
      this.approvals.set(approvalKey, {
        fingerprint,
        server: this.serverId,
        skillName: fullEntry.name,
        site: this.site,
        scope,
        approvedAt: new Date().toISOString()
      })
    }

    if (!this.activeCallGuard()) {
      return {
        ok: false,
        envelope: {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId,
          server: this.serverId,
          ok: false,
          error: { code: 'TIMEOUT', message: 'Skill activation timed out before opening window' }
        }
      }
    }
    const window: ActingWindow = {
      server: this.serverId,
      skillName: fullEntry.name,
      skillUri: canonicalSkillUri,
      entry: fullEntry,
      resourcesByUri
    }
    this.heldEntry = window
    return { ok: true, window }
  }

  private async handleSkillsGetResult(
    requestId: string,
    requestedUri: string | undefined,
    mcpResult: unknown
  ): Promise<ActivationEnvelopeResultPayload> {
    const verified = await this.verifyAndOpenSkillWindow(requestId, requestedUri, mcpResult)
    if (!verified.ok) {
      return verified.envelope
    }

    const { window } = verified
    const toolsLoaded = await this.ensureToolsInventory()
    const availableTools = toolsLoaded.ok
      ? this.catalogTools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {})
        }))
      : []

    // Model-facing projection strips digests, byte sizes, TTL, and cacheScope
    const projectedSkill = {
      uri: window.skillUri,
      name: window.entry.name,
      description: window.entry.description,
      frontmatter: window.entry.frontmatter,
      resources: window.entry.resources.map((r) => ({
        uri: r.uri,
        ...(r.mimeType ? { mimeType: r.mimeType } : {})
      }))
    }

    return this.boundedSuccessEnvelope(requestId, {
      skill: projectedSkill,
      availableTools
    })
  }

  private async verifyResourcePayload(
    requestId: string,
    expectedUri: string,
    window: ActingWindow,
    mcpResult: unknown
  ): Promise<{ ok: true; text: string; mimeType: string } | { ok: false; envelope: ActivationEnvelopeResultPayload }> {
    const expectedResource = window.resourcesByUri.get(expectedUri)
    if (!expectedResource) {
      this.clearActingWindow()
      return {
        ok: false,
        envelope: {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId,
          server: this.serverId,
          ok: false,
          error: {
            code: 'RESOURCE_OUTSIDE_ACTING_WINDOW',
            message: `Resource "${expectedUri}" is outside the current acting window`
          }
        }
      }
    }

    const contents =
      mcpResult && typeof mcpResult === 'object' && Array.isArray((mcpResult as { contents?: unknown }).contents)
        ? ((mcpResult as { contents: Array<Record<string, unknown>> }).contents)
        : null

    if (!contents || contents.length !== 1) {
      this.clearActingWindow()
      return {
        ok: false,
        envelope: {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId,
          server: this.serverId,
          ok: false,
          error: {
            code: 'INVALID_RESOURCE_PAYLOAD',
            message: 'resources/read must return exactly one content item matching the requested URI'
          }
        }
      }
    }

    const item = contents[0]
    if (item.uri !== expectedUri || typeof item.text !== 'string') {
      this.clearActingWindow()
      return {
        ok: false,
        envelope: {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId,
          server: this.serverId,
          ok: false,
          error: {
            code: 'INVALID_RESOURCE_PAYLOAD',
            message: 'Resource content URI mismatch or non-text payload'
          }
        }
      }
    }

    const bytes = new TextEncoder().encode(item.text)
    if (typeof expectedResource.size === 'number' && bytes.byteLength !== expectedResource.size) {
      this.verifiedResourceCache.delete(expectedUri)
      this.clearActingWindow()
      return {
        ok: false,
        envelope: {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId,
          server: this.serverId,
          ok: false,
          error: {
            code: 'SIZE_MISMATCH',
            message: `Byte size mismatch for "${expectedUri}": expected ${expectedResource.size}, got ${bytes.byteLength}`
          }
        }
      }
    }

    const hashed = await computeSha256Hex(bytes)
    if (typeof expectedResource.digest === 'string') {
      if (!SHA256_PREFIX_RE.test(expectedResource.digest) || hashed.digest.toLowerCase() !== expectedResource.digest.toLowerCase()) {
        this.verifiedResourceCache.delete(expectedUri)
        this.clearActingWindow()
        return {
          ok: false,
          envelope: {
            protocol: ACTIVATION_CONTRACT_PROTOCOL,
            requestId,
            server: this.serverId,
            ok: false,
            error: {
              code: 'DIGEST_MISMATCH',
              message: `Digest mismatch for "${expectedUri}": expected ${expectedResource.digest}, got ${hashed.digest}`
            }
          }
        }
      }
    }

    if (expectedUri.endsWith('/SKILL.md')) {
      const parsedFrontmatter = parseSkillFrontmatter(item.text)
      if (!parsedFrontmatter.ok) {
        this.verifiedResourceCache.delete(expectedUri)
        this.clearActingWindow()
        return {
          ok: false,
          envelope: {
            protocol: ACTIVATION_CONTRACT_PROTOCOL,
            requestId,
            server: this.serverId,
            ok: false,
            error: {
              code: 'FRONTMATTER_MISMATCH',
              message: `Invalid SKILL.md frontmatter: ${parsedFrontmatter.message}`
            }
          }
        }
      }

      if (!deepEqualFrontmatter(parsedFrontmatter.frontmatter, window.entry.frontmatter)) {
        this.verifiedResourceCache.delete(expectedUri)
        this.clearActingWindow()
        return {
          ok: false,
          envelope: {
            protocol: ACTIVATION_CONTRACT_PROTOCOL,
            requestId,
            server: this.serverId,
            ok: false,
            error: {
              code: 'FRONTMATTER_MISMATCH',
              message: `SKILL.md frontmatter does not match verified entry "${window.skillName}"`
            }
          }
        }
      }
    }

    if (!this.activeCallGuard()) {
      return {
        ok: false,
        envelope: {
          protocol: ACTIVATION_CONTRACT_PROTOCOL,
          requestId,
          server: this.serverId,
          ok: false,
          error: { code: 'TIMEOUT', message: 'Resource read timed out before cache commit' }
        }
      }
    }

    this.verifiedResourceCache.set(expectedUri, {
      server: this.serverId,
      scope: this.getScopeKey(),
      uri: expectedUri,
      digest: hashed.digest,
      size: hashed.byteLength,
      text: item.text,
      verifiedAt: new Date().toISOString()
    })

    return {
      ok: true,
      text: item.text,
      mimeType: typeof item.mimeType === 'string' ? item.mimeType : expectedResource.mimeType ?? 'text/plain'
    }
  }

  private async handleResourcesReadResult(
    requestId: string,
    expectedUri: string,
    mcpResult: unknown,
    offset: number,
    maxChars?: number
  ): Promise<ActivationEnvelopeResultPayload> {
    const window = this.heldEntry
    if (!window) {
      this.clearActingWindow()
      return {
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId,
        server: this.serverId,
        ok: false,
        error: {
          code: 'RESOURCE_OUTSIDE_ACTING_WINDOW',
          message: `Resource "${expectedUri}" is outside the current acting window`
        }
      }
    }

    const verified = await this.verifyResourcePayload(requestId, expectedUri, window, mcpResult)
    if (!verified.ok) {
      return verified.envelope
    }

    this.activeChatPresence.add(expectedUri)

    return this.buildPaginatedEnvelope(requestId, verified.text, offset, maxChars, (slice, meta) => ({
      contents: [
        {
          uri: expectedUri,
          mimeType: verified.mimeType,
          text: slice
        }
      ],
      ...(meta.truncated || meta.offset > 0
        ? {
            truncated: meta.truncated,
            totalChars: meta.totalChars,
            offset: meta.offset,
            ...(meta.nextOffset !== undefined ? { nextOffset: meta.nextOffset } : {})
          }
        : {})
    }))
  }

  private handleToolsCallResult(
    requestId: string,
    mcpResult: unknown,
    offset: number,
    maxChars?: number
  ): ActivationEnvelopeResultPayload {
    const toolError = extractMcpToolError(mcpResult)
    if (toolError) {
      return {
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId,
        server: this.serverId,
        ok: false,
        error: toolError
      }
    }

    const serialized = JSON.stringify(mcpResult)
    if (serialized.length <= this.maxResultChars && offset === 0 && !maxChars) {
      return {
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId,
        server: this.serverId,
        ok: true,
        result: mcpResult
      }
    }

    if (
      mcpResult &&
      typeof mcpResult === 'object' &&
      Array.isArray((mcpResult as { content?: unknown }).content) &&
      (mcpResult as { content: Array<{ type?: unknown; text?: unknown }> }).content.length === 1 &&
      typeof (mcpResult as { content: Array<{ type?: unknown; text?: unknown }> }).content[0]?.text === 'string'
    ) {
      const fullText = (mcpResult as { content: Array<{ text: string }> }).content[0].text
      return this.buildPaginatedEnvelope(requestId, fullText, offset, maxChars, (slice, meta) => ({
        content: [{ type: 'text', text: slice }],
        truncated: meta.truncated,
        totalChars: meta.totalChars,
        offset: meta.offset,
        ...(meta.nextOffset !== undefined ? { nextOffset: meta.nextOffset } : {})
      }))
    }

    return this.boundedSuccessEnvelope(requestId, mcpResult)
  }

  private buildPaginatedEnvelope(
    requestId: string,
    fullText: string,
    offset: number,
    requestedMaxChars: number | undefined,
    buildResult: (
      slice: string,
      meta: { truncated: boolean; totalChars: number; offset: number; nextOffset?: number }
    ) => unknown
  ): ActivationEnvelopeResultPayload {
    const totalChars = fullText.length
    const safeOffset = Math.max(0, Math.min(totalChars, offset))
    const availableLen = totalChars - safeOffset
    const initialMax = requestedMaxChars ? Math.min(requestedMaxChars, availableLen) : availableLen

    const probeEmpty = buildResult('', {
      truncated: true,
      totalChars,
      offset: safeOffset,
      nextOffset: safeOffset
    })
    const emptySerializedLen = formatActivationResultEnvelope({
      protocol: ACTIVATION_CONTRACT_PROTOCOL,
      requestId,
      server: this.serverId,
      ok: true,
      result: probeEmpty
    }).length

    if (emptySerializedLen >= this.maxResultChars) {
      return {
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId,
        server: this.serverId,
        ok: false,
        error: {
          code: 'RESULT_EXCEEDS_CONTEXT_BUDGET',
          message: `Envelope metadata alone (${emptySerializedLen} chars) exceeds ${this.maxResultChars} char chat budget`
        }
      }
    }

    const fitsSlice = (sliceLen: number): { fits: boolean; payload: unknown } => {
      const candidateEnd = adjustSurrogateBoundary(fullText, Math.min(totalChars, safeOffset + sliceLen))
      const slice = fullText.slice(safeOffset, candidateEnd)
      const truncated = candidateEnd < totalChars
      const payload = buildResult(slice, {
        truncated,
        totalChars,
        offset: safeOffset,
        ...(truncated ? { nextOffset: candidateEnd } : {})
      })
      const renderedLen = formatActivationResultEnvelope({
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId,
        server: this.serverId,
        ok: true,
        result: payload
      }).length
      return { fits: renderedLen <= this.maxResultChars, payload }
    }

    const directCheck = fitsSlice(initialMax)
    if (directCheck.fits) {
      return {
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId,
        server: this.serverId,
        ok: true,
        result: directCheck.payload
      }
    }

    // Binary search for largest slice length that stays within maxResultChars after JSON/fence overhead
    let lo = 1
    let hi = Math.min(initialMax, this.maxResultChars)
    let bestPayload: unknown = buildResult('', {
      truncated: safeOffset < totalChars,
      totalChars,
      offset: safeOffset,
      ...(safeOffset < totalChars ? { nextOffset: safeOffset } : {})
    })

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      const attempt = fitsSlice(mid)
      if (attempt.fits) {
        bestPayload = attempt.payload
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }

    return {
      protocol: ACTIVATION_CONTRACT_PROTOCOL,
      requestId,
      server: this.serverId,
      ok: true,
      result: bestPayload
    }
  }

  private boundedSuccessEnvelope(requestId: string, result: unknown): ActivationEnvelopeResultPayload {
    const serialized = JSON.stringify(result)
    if (serialized.length > this.maxResultChars) {
      return {
        protocol: ACTIVATION_CONTRACT_PROTOCOL,
        requestId,
        server: this.serverId,
        ok: false,
        error: {
          code: 'RESULT_EXCEEDS_CONTEXT_BUDGET',
          message: `Serialized MCP response (${serialized.length} chars) exceeds ${this.maxResultChars} char chat budget`
        }
      }
    }
    return {
      protocol: ACTIVATION_CONTRACT_PROTOCOL,
      requestId,
      server: this.serverId,
      ok: true,
      result
    }
  }
}
