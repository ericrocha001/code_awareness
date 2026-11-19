import { existsSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { ConsentStore } from './consent-store'
import { MAX_NATIVE_OUTBOUND_BYTES } from './native-messaging-protocol'
import {
  ALLOWED_WEB_MCP_TOOLS,
  classifyWebMcpDataClass,
  DEFAULT_ALLOWED_WEB_ORIGINS,
  normalizeConsentProjectId,
  normalizeWebOrigin,
  resolveSiteForWebOrigin,
  validateReadOnlyWebMcpRequest,
  WEB_ACTIVATION_BRIDGE_PROTOCOL,
  type DesktopSkillsEndpointInfo,
  type NativeBridgeCommand,
  type NativeBridgeErrorPayload,
  type NativeBridgeResponse
} from './web-activation-types'

const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-z0-9]{16,64}\/?$/i
export const DEFAULT_PIPE_TIMEOUT_MS = 2500
export const DEFAULT_MCP_HTTP_TIMEOUT_MS = 15_000

export interface LocalChannelDescriptor {
  protocol: string
  token: string
  endpoint: string
}

export interface McpHttpResponse {
  status: number
  body: unknown
  timedOut?: boolean
  timeoutMs?: number
}

export type McpHttpTransport = (
  endpoint: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs?: number
) => Promise<McpHttpResponse>

export type LocalWebActivationDispatcher = (
  action: string,
  args: Record<string, unknown>
) => Promise<{ ok: true; result: unknown } | { ok: false; code: string; message: string; details?: Record<string, unknown> }>

export type DesktopEndpointLookupResult =
  | { ok: true; info: DesktopSkillsEndpointInfo }
  | { ok: false; code: 'APP_UNAVAILABLE' | 'TIMEOUT'; message: string; details?: Record<string, unknown> }

export interface NativeMessagingBridgeOptions {
  consentStore: ConsentStore
  callerOrigin?: string
  requireCallerOrigin?: boolean
  allowedExtensionOrigins?: readonly string[]
  allowedWebOrigins?: readonly string[]
  userDataPath?: string
  pipeTimeoutMs?: number
  mcpTimeoutMs?: number
  resolveDesktopEndpoint?: () => Promise<DesktopSkillsEndpointInfo | null>
  resolveDesktopEndpointDetailed?: () => Promise<DesktopEndpointLookupResult>
  dispatchLocalAction?: LocalWebActivationDispatcher
  mcpTransport?: McpHttpTransport
  maxOutboundBytes?: number
  hostBuildId?: string
  hostApplication?: string
}

function normalizeExtensionOrigin(origin: string | undefined): string | null {
  if (typeof origin !== 'string') return null
  const trimmed = origin.trim().toLowerCase()
  if (!EXTENSION_ORIGIN_RE.test(trimmed)) return null
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

function extensionIdFromOrigin(origin: string | null): string | null {
  if (!origin) return null
  const match = /^chrome-extension:\/\/([a-z0-9]{16,64})\/?$/i.exec(origin)
  return match ? match[1].toLowerCase() : null
}

/**
 * Invokes a `web_activation` domain action over Desktop's Local Agent Channel socket.
 */
export async function invokeDesktopWebActivationAction(
  userDataPath: string,
  action: string,
  args: Record<string, unknown> = {},
  timeoutMs = DEFAULT_PIPE_TIMEOUT_MS
): Promise<
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> }
> {
  const descriptorPath = join(userDataPath, 'local-agent-channel', 'endpoint.json')
  if (!existsSync(descriptorPath)) {
    return { ok: false, code: 'APP_UNAVAILABLE', message: 'Local agent channel descriptor not found' }
  }

  let descriptor: LocalChannelDescriptor
  try {
    const raw = JSON.parse(readFileSync(descriptorPath, 'utf8')) as Partial<LocalChannelDescriptor>
    if (
      typeof raw.protocol !== 'string' ||
      typeof raw.token !== 'string' ||
      typeof raw.endpoint !== 'string' ||
      !raw.endpoint.trim()
    ) {
      return { ok: false, code: 'APP_UNAVAILABLE', message: 'Malformed local agent channel descriptor' }
    }
    descriptor = {
      protocol: raw.protocol,
      token: raw.token,
      endpoint: raw.endpoint
    }
  } catch {
    return { ok: false, code: 'APP_UNAVAILABLE', message: 'Failed to read local agent channel descriptor' }
  }

  return await new Promise((resolve) => {
    let settled = false
    const socket = createConnection(descriptor.endpoint)
    let raw = ''

    const finish = (
      outcome:
        | { ok: true; result: unknown }
        | { ok: false; code: string; message: string; details?: Record<string, unknown> }
    ) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(outcome)
    }

    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          code: 'TIMEOUT',
          message: `Local agent channel discovery timed out after ${timeoutMs}ms`,
          details: { phase: 'desktop_discovery', timeoutMs, executionStateUnknown: false }
        }),
      timeoutMs
    )
    socket.setEncoding('utf8')
    socket.once('error', (err) =>
      finish({ ok: false, code: 'APP_UNAVAILABLE', message: err instanceof Error ? err.message : String(err) })
    )
    socket.once('connect', () => {
      socket.write(
        JSON.stringify({
          protocol: descriptor.protocol,
          token: descriptor.token,
          domain: 'web_activation',
          action,
          args
        }) + '\n'
      )
    })
    socket.on('data', (chunk: string) => {
      raw += chunk
      const newlineIndex = raw.indexOf('\n')
      if (newlineIndex === -1) return
      const line = raw.slice(0, newlineIndex).trim()
      try {
        const parsed = JSON.parse(line) as { result?: unknown; error?: { code?: string; message?: string } }
        if (parsed?.error) {
          finish({
            ok: false,
            code: parsed.error.code || 'INTERNAL_ERROR',
            message: parsed.error.message || parsed.error.code || 'Local channel error'
          })
          return
        }
        if (parsed && 'result' in parsed) {
          finish({ ok: true, result: parsed.result })
          return
        }
      } catch {
        // Fall through to unavailable
      }
      finish({ ok: false, code: 'APP_UNAVAILABLE', message: 'Invalid response from local agent channel' })
    })
  })
}

export async function discoverDesktopWebActivationEndpointDetailed(
  userDataPath: string,
  timeoutMs = DEFAULT_PIPE_TIMEOUT_MS
): Promise<DesktopEndpointLookupResult> {
  const response = await invokeDesktopWebActivationAction(userDataPath, 'endpoint', {}, timeoutMs)
  if (!response.ok) {
    return {
      ok: false,
      code: response.code === 'TIMEOUT' ? 'TIMEOUT' : 'APP_UNAVAILABLE',
      message: response.message,
      ...(response.details ? { details: response.details } : {})
    }
  }
  if (!response.result || typeof response.result !== 'object') {
    return { ok: false, code: 'APP_UNAVAILABLE', message: 'Desktop endpoint discovery returned invalid payload' }
  }
  const info = response.result as DesktopSkillsEndpointInfo
  if (info.status !== 'RUNNING' || !info.endpoint) {
    return { ok: false, code: 'APP_UNAVAILABLE', message: info.reason ?? 'DESKTOP_UNREACHABLE' }
  }
  return { ok: true, info }
}

export async function discoverDesktopWebActivationEndpoint(
  userDataPath: string,
  timeoutMs = DEFAULT_PIPE_TIMEOUT_MS
): Promise<DesktopSkillsEndpointInfo | null> {
  const detailed = await discoverDesktopWebActivationEndpointDetailed(userDataPath, timeoutMs)
  return detailed.ok ? detailed.info : null
}

async function defaultMcpTransport(
  endpoint: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs = DEFAULT_MCP_HTTP_TIMEOUT_MS
): Promise<McpHttpResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    const text = await response.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = { raw: text }
    }
    return { status: response.status, body }
  } catch (err) {
    if (
      controller.signal.aborted ||
      (err && typeof err === 'object' && 'name' in err && (err as { name?: unknown }).name === 'AbortError')
    ) {
      return { status: 0, body: null, timedOut: true, timeoutMs }
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export class NativeMessagingBridge {
  private readonly consentStore: ConsentStore
  private readonly callerOrigin: string | null
  private readonly requireCallerOrigin: boolean
  private readonly allowedExtensionOrigins: Set<string> | null
  private readonly allowedWebOrigins: Set<string>
  private readonly resolveDesktopEndpointDetailed: () => Promise<DesktopEndpointLookupResult>
  private readonly dispatchLocalAction: LocalWebActivationDispatcher
  private readonly mcpTransport: McpHttpTransport
  private readonly mcpTimeoutMs: number
  private readonly maxOutboundBytes: number
  private readonly hostBuildId: string
  private readonly hostApplication: string
  private rpcCounter = 0

  constructor(options: NativeMessagingBridgeOptions) {
    this.consentStore = options.consentStore
    this.callerOrigin = normalizeExtensionOrigin(options.callerOrigin)
    this.requireCallerOrigin = options.requireCallerOrigin ?? true
    this.allowedExtensionOrigins =
      options.allowedExtensionOrigins && options.allowedExtensionOrigins.length > 0
        ? new Set(
            options.allowedExtensionOrigins
              .map((entry) => normalizeExtensionOrigin(entry))
              .filter((entry): entry is string => entry !== null)
          )
        : null
    const webOrigins = options.allowedWebOrigins ?? DEFAULT_ALLOWED_WEB_ORIGINS
    this.allowedWebOrigins = new Set(
      webOrigins.map((entry) => normalizeWebOrigin(entry)).filter((entry): entry is string => entry !== null)
    )
    const pipeTimeout = options.pipeTimeoutMs ?? DEFAULT_PIPE_TIMEOUT_MS
    this.mcpTimeoutMs = options.mcpTimeoutMs ?? DEFAULT_MCP_HTTP_TIMEOUT_MS
    if (options.resolveDesktopEndpointDetailed) {
      this.resolveDesktopEndpointDetailed = options.resolveDesktopEndpointDetailed
    } else if (options.resolveDesktopEndpoint) {
      const legacyResolve = options.resolveDesktopEndpoint
      this.resolveDesktopEndpointDetailed = async () => {
        const info = await legacyResolve()
        return info && info.status === 'RUNNING' && info.endpoint
          ? { ok: true, info }
          : { ok: false, code: 'APP_UNAVAILABLE', message: info?.reason ?? 'DESKTOP_UNREACHABLE' }
      }
    } else if (options.userDataPath) {
      const userDataPath = options.userDataPath
      this.resolveDesktopEndpointDetailed = () => discoverDesktopWebActivationEndpointDetailed(userDataPath, pipeTimeout)
    } else {
      this.resolveDesktopEndpointDetailed = async () => ({
        ok: false,
        code: 'APP_UNAVAILABLE',
        message: 'Desktop endpoint resolver unavailable'
      })
    }
    this.dispatchLocalAction =
      options.dispatchLocalAction ??
      (options.userDataPath
        ? (action, args) => invokeDesktopWebActivationAction(options.userDataPath!, action, args, pipeTimeout)
        : async () => ({ ok: false, code: 'APP_UNAVAILABLE', message: 'Local channel path not configured' }))
    this.mcpTransport = options.mcpTransport ?? defaultMcpTransport
    this.maxOutboundBytes = options.maxOutboundBytes ?? MAX_NATIVE_OUTBOUND_BYTES
    this.hostBuildId = options.hostBuildId?.trim() || 'dev-unbuilt'
    this.hostApplication = options.hostApplication?.trim() || 'com.ericrocha.codeawareness.web_activation'
  }

  private error(
    id: string,
    code: NativeBridgeErrorPayload['code'],
    message: string,
    details?: Record<string, unknown>
  ): NativeBridgeResponse {
    return {
      id,
      ok: false,
      protocol: WEB_ACTIVATION_BRIDGE_PROTOCOL,
      error: {
        code,
        message,
        ...(details ? { details } : {})
      }
    }
  }

  private ok(id: string, result: unknown): NativeBridgeResponse {
    const response: NativeBridgeResponse = {
      id,
      ok: true,
      protocol: WEB_ACTIVATION_BRIDGE_PROTOCOL,
      result
    }
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > this.maxOutboundBytes) {
      return this.error(
        id,
        'RESPONSE_TOO_LARGE',
        `Bridge response exceeds ${this.maxOutboundBytes} byte Native Messaging limit`
      )
    }
    return response
  }

  private validateCallerOrigin(id: string): NativeBridgeResponse | null {
    if (!this.callerOrigin) {
      if (!this.requireCallerOrigin) return null
      return this.error(id, 'ORIGIN_NOT_ALLOWED', 'Missing or invalid chrome-extension caller origin')
    }
    if (this.allowedExtensionOrigins && !this.allowedExtensionOrigins.has(this.callerOrigin)) {
      return this.error(id, 'ORIGIN_NOT_ALLOWED', `Caller origin "${this.callerOrigin}" is not allowlisted`)
    }
    return null
  }

  private validateWebOrigin(id: string, rawWebOrigin: unknown, expectedSite?: string): { origin: string } | { err: NativeBridgeResponse } {
    const normalizedOrigin = normalizeWebOrigin(rawWebOrigin)
    if (!normalizedOrigin || !this.allowedWebOrigins.has(normalizedOrigin)) {
      return {
        err: this.error(id, 'ORIGIN_NOT_ALLOWED', `Web origin "${String(rawWebOrigin ?? '')}" is not allowlisted`)
      }
    }
    const mappedSite = resolveSiteForWebOrigin(normalizedOrigin)
    if (expectedSite && mappedSite && expectedSite.trim().toLowerCase() !== mappedSite) {
      return {
        err: this.error(id, 'ORIGIN_NOT_ALLOWED', `Site "${expectedSite}" does not match web origin "${normalizedOrigin}"`)
      }
    }
    return { origin: normalizedOrigin }
  }

  async handle(rawCommand: unknown): Promise<NativeBridgeResponse> {
    const rawId =
      rawCommand && typeof rawCommand === 'object' && typeof (rawCommand as { id?: unknown }).id === 'string'
        ? (rawCommand as { id: string }).id
        : ''

    const callerErr = this.validateCallerOrigin(rawId)
    if (callerErr) return callerErr

    if (!rawCommand || typeof rawCommand !== 'object' || typeof (rawCommand as { action?: unknown }).action !== 'string') {
      return this.error(rawId, 'INVALID_REQUEST', 'Native bridge message must be an object with a string action')
    }

    const command = rawCommand as NativeBridgeCommand

    switch (command.action) {
      case 'ping':
        return this.ok(rawId, {
          available: true,
          callerOrigin: this.callerOrigin,
          bridgeProtocol: WEB_ACTIVATION_BRIDGE_PROTOCOL,
          hostBuildId: this.hostBuildId,
          hostApplication: this.hostApplication
        })

      case 'maintenance_check':
      case 'maintenance_claim':
      case 'maintenance_report':
        return this.handleMaintenanceCommand(rawId, command)

      case 'get_status': {
        if (command.webOrigin !== undefined) {
          const checked = this.validateWebOrigin(rawId, command.webOrigin, command.site)
          if ('err' in checked) return checked.err
        }
        const lookup = await this.resolveDesktopEndpointDetailed()
        if (!lookup.ok) {
          return this.ok(rawId, {
            available: false,
            errorCode: lookup.code,
            reason: lookup.message,
            ...(lookup.details ? { details: lookup.details } : {}),
            observedAt: new Date().toISOString()
          })
        }
        const endpointInfo = lookup.info
        const projectKey = normalizeConsentProjectId(endpointInfo.projectId)
        const site = typeof command.site === 'string' ? command.site.trim().toLowerCase() : ''
        const consents = site
          ? {
              metadata: this.consentStore.hasConsent(site, projectKey, 'METADATA'),
              literalSource: this.consentStore.hasConsent(site, projectKey, 'LITERAL_SOURCE')
            }
          : undefined
        return this.ok(rawId, {
          available: true,
          mode: endpointInfo.mode ?? (endpointInfo.projectId ? 'PROJECT' : 'GLOBAL_ONLY'),
          endpoint: endpointInfo.endpoint,
          projectId: endpointInfo.projectId ?? null,
          consentProjectKey: projectKey,
          instanceId: endpointInfo.instanceId ?? null,
          bindingId: endpointInfo.bindingId ?? null,
          ...(consents ? { consents } : {}),
          observedAt: endpointInfo.observedAt
        })
      }

      case 'get_consent': {
        if (typeof command.site !== 'string' || !command.site.trim()) {
          return this.error(rawId, 'INVALID_REQUEST', 'get_consent requires a non-empty site')
        }
        if (command.webOrigin !== undefined) {
          const checked = this.validateWebOrigin(rawId, command.webOrigin, command.site)
          if ('err' in checked) return checked.err
        }
        const projectKey = normalizeConsentProjectId(command.projectId)
        return this.ok(rawId, {
          site: command.site.trim().toLowerCase(),
          projectId: projectKey,
          metadata: this.consentStore.hasConsent(command.site, projectKey, 'METADATA'),
          literalSource: this.consentStore.hasConsent(command.site, projectKey, 'LITERAL_SOURCE'),
          records: this.consentStore.listConsents({ site: command.site, projectId: projectKey })
        })
      }

      case 'set_consent': {
        if (
          typeof command.site !== 'string' ||
          !command.site.trim() ||
          (command.dataClass !== 'METADATA' && command.dataClass !== 'LITERAL_SOURCE') ||
          typeof command.granted !== 'boolean'
        ) {
          return this.error(rawId, 'INVALID_REQUEST', 'set_consent requires site, dataClass, and boolean granted')
        }
        if (command.webOrigin !== undefined) {
          const checked = this.validateWebOrigin(rawId, command.webOrigin, command.site)
          if ('err' in checked) return checked.err
        }
        const projectKey = normalizeConsentProjectId(command.projectId)
        if (command.granted) {
          const record = this.consentStore.grantConsent({
            site: command.site,
            projectId: projectKey,
            dataClass: command.dataClass,
            origin: command.webOrigin
          })
          return this.ok(rawId, { granted: true, record })
        }
        const removed = this.consentStore.revokeConsent({
          site: command.site,
          projectId: projectKey,
          dataClass: command.dataClass
        })
        return this.ok(rawId, { granted: false, removed })
      }

      case 'mcp_request': {
        if (typeof command.site !== 'string' || !command.site.trim() || typeof command.method !== 'string') {
          return this.error(rawId, 'INVALID_REQUEST', 'mcp_request requires site, webOrigin, and method')
        }
        const checkedOrigin = this.validateWebOrigin(rawId, command.webOrigin, command.site)
        if ('err' in checkedOrigin) return checkedOrigin.err

        const allowCheck = validateReadOnlyWebMcpRequest(command.method, command.params)
        if (!allowCheck.ok) {
          return this.error(rawId, allowCheck.code, allowCheck.message)
        }

        const lookup = await this.resolveDesktopEndpointDetailed()
        if (!lookup.ok) {
          return this.error(
            rawId,
            lookup.code,
            lookup.code === 'TIMEOUT'
              ? lookup.message
              : 'Code Awareness Desktop is unavailable; fail-closed',
            lookup.code === 'TIMEOUT'
              ? { phase: 'desktop_discovery', executionStateUnknown: false, ...lookup.details }
              : { reason: lookup.message }
          )
        }
        const endpointInfo = lookup.info

        const activeProjectId = endpointInfo.projectId ?? null
        const activeBindingId = endpointInfo.bindingId ?? null
        const activeInstanceId = endpointInfo.instanceId ?? null

        if (command.expectedBindingId !== undefined && command.expectedBindingId !== activeBindingId) {
          return this.error(rawId, 'SESSION_INVALIDATED', 'Desktop MCP binding changed; re-bootstrap required', {
            reason: 'BINDING_CHANGED',
            expectedBindingId: command.expectedBindingId,
            actualBindingId: activeBindingId
          })
        }
        if (command.expectedInstanceId !== undefined && command.expectedInstanceId !== activeInstanceId) {
          return this.error(rawId, 'SESSION_INVALIDATED', 'Desktop instance changed; re-bootstrap required', {
            reason: 'INSTANCE_CHANGED',
            expectedInstanceId: command.expectedInstanceId,
            actualInstanceId: activeInstanceId
          })
        }
        if (command.expectedProjectId !== undefined && command.expectedProjectId !== activeProjectId) {
          return this.error(rawId, 'SESSION_INVALIDATED', 'Active Desktop project changed; re-bootstrap required', {
            reason: 'PROJECT_CHANGED',
            expectedProjectId: command.expectedProjectId,
            actualProjectId: activeProjectId
          })
        }

        const consentProjectId = normalizeConsentProjectId(activeProjectId)
        const dataClass = classifyWebMcpDataClass(command.method, command.params, activeProjectId)
        if (!this.consentStore.hasConsent(command.site, consentProjectId, dataClass)) {
          return this.error(
            rawId,
            'CONSENT_REQUIRED',
            `Explicit ${dataClass} egress consent is required for site "${command.site}" and scope "${consentProjectId}"`,
            {
              site: command.site.trim().toLowerCase(),
              projectId: consentProjectId,
              dataClass,
              webOrigin: checkedOrigin.origin
            }
          )
        }

        const headers: Record<string, string> = {}
        if (activeBindingId) headers['x-code-awareness-binding'] = activeBindingId
        if (activeInstanceId) headers['x-code-awareness-instance'] = activeInstanceId
        if (activeProjectId) headers['x-code-awareness-project'] = activeProjectId

        const endpointUrl = endpointInfo.endpoint
        if (!endpointUrl) {
          return this.error(rawId, 'APP_UNAVAILABLE', 'Desktop MCP endpoint is missing')
        }
        this.rpcCounter += 1
        const expectedRpcId = this.rpcCounter
        let httpRes: McpHttpResponse
        try {
          httpRes = await this.mcpTransport(
            endpointUrl,
            headers,
            {
              jsonrpc: '2.0',
              id: expectedRpcId,
              method: command.method,
              params: command.params ?? {}
            },
            this.mcpTimeoutMs
          )
        } catch (err) {
          return this.error(
            rawId,
            'APP_UNAVAILABLE',
            `Failed to reach Desktop MCP endpoint: ${err instanceof Error ? err.message : String(err)}`,
            { phase: 'mcp_http' }
          )
        }

        if (httpRes.timedOut) {
          const timeoutMs = httpRes.timeoutMs ?? this.mcpTimeoutMs
          return this.error(
            rawId,
            'TIMEOUT',
            `Desktop MCP HTTP request timed out after ${timeoutMs}ms`,
            { phase: 'mcp_http', timeoutMs, executionStateUnknown: true }
          )
        }

        const bodyObj =
          httpRes.body && typeof httpRes.body === 'object' && !Array.isArray(httpRes.body)
            ? (httpRes.body as Record<string, unknown>)
            : null

        const rpcError = bodyObj && bodyObj.error && typeof bodyObj.error === 'object'
          ? (bodyObj.error as { code?: number; message?: string; data?: Record<string, unknown> })
          : undefined

        if (httpRes.status === 409 || rpcError?.code === -32001) {
          return this.error(
            rawId,
            'SESSION_INVALIDATED',
            rpcError?.message ?? 'Desktop MCP session binding invalidated',
            rpcError?.data
          )
        }

        if (!bodyObj) {
          if (httpRes.status >= 400) {
            return this.error(rawId, 'MCP_HTTP_ERROR', `Desktop MCP returned HTTP ${httpRes.status}`, { phase: 'mcp_http', httpStatus: httpRes.status })
          }
          return this.error(rawId, 'INVALID_MCP_RESPONSE', 'Desktop MCP returned non-object payload', { phase: 'mcp_http' })
        }

        if ('id' in bodyObj && bodyObj.id !== undefined && bodyObj.id !== expectedRpcId) {
          return this.error(rawId, 'INVALID_MCP_RESPONSE', 'Desktop MCP JSON-RPC correlation id mismatch', { phase: 'mcp_http' })
        }

        if (httpRes.status >= 400 && !rpcError) {
          return this.error(rawId, 'MCP_HTTP_ERROR', `Desktop MCP returned HTTP ${httpRes.status}`, { phase: 'mcp_http', httpStatus: httpRes.status })
        }

        if (!rpcError && !('result' in bodyObj)) {
          return this.error(rawId, 'INVALID_MCP_RESPONSE', 'Desktop MCP JSON-RPC payload omitted result and error', { phase: 'mcp_http' })
        }

        let sanitizedMcpBody = httpRes.body
        if (
          command.method === 'tools/list' &&
          httpRes.body &&
          typeof httpRes.body === 'object' &&
          (httpRes.body as { result?: { tools?: unknown[] } }).result &&
          Array.isArray((httpRes.body as { result: { tools?: unknown[] } }).result.tools)
        ) {
          const cloned = { ...(httpRes.body as Record<string, unknown>) }
          const origResult = (httpRes.body as { result: Record<string, unknown> }).result
          cloned.result = {
            ...origResult,
            tools: (origResult.tools as Array<{ name?: unknown }>).filter(
              (tool) => typeof tool?.name === 'string' && ALLOWED_WEB_MCP_TOOLS.has(tool.name)
            )
          }
          sanitizedMcpBody = cloned
        }

        return this.ok(rawId, {
          httpStatus: httpRes.status,
          mcp: sanitizedMcpBody,
          session: {
            mode: endpointInfo.mode ?? (activeProjectId ? 'PROJECT' : 'GLOBAL_ONLY'),
            projectId: activeProjectId,
            instanceId: activeInstanceId,
            bindingId: activeBindingId
          }
        })
      }

      default:
        return this.error(rawId, 'INVALID_REQUEST', `Unknown bridge action "${String((command as { action?: unknown }).action)}"`)
    }
  }

  private async handleMaintenanceCommand(
    rawId: string,
    command: Extract<NativeBridgeCommand, { action: 'maintenance_check' | 'maintenance_claim' | 'maintenance_report' }>
  ): Promise<NativeBridgeResponse> {
    if ('webOrigin' in (command as unknown as Record<string, unknown>)) {
      return this.error(rawId, 'MAINTENANCE_UNAUTHORIZED', 'Maintenance actions are forbidden for web origins')
    }

    const callerExtId = extensionIdFromOrigin(this.callerOrigin)
    if (this.requireCallerOrigin && !callerExtId) {
      return this.error(rawId, 'MAINTENANCE_UNAUTHORIZED', 'Caller extension origin is required for maintenance commands')
    }

    const declaredExtensionId =
      command.action === 'maintenance_report'
        ? command.report?.extensionId
        : command.extensionId

    if (callerExtId && typeof declaredExtensionId === 'string' && declaredExtensionId.trim().toLowerCase() !== callerExtId) {
      return this.error(
        rawId,
        'MAINTENANCE_UNAUTHORIZED',
        `Declared extensionId "${declaredExtensionId}" does not match authenticated caller "${callerExtId}"`
      )
    }

    const args: Record<string, unknown> =
      command.action === 'maintenance_report'
        ? {
            phase: command.phase,
            report: {
              ...command.report,
              hostBuildId: this.hostBuildId,
              hostCompatible: true,
              hostApplication: this.hostApplication
            }
          }
        : {
            ...command,
            hostBuildId: this.hostBuildId,
            hostApplication: this.hostApplication
          }
    if ('id' in args) delete args.id
    if ('action' in args) delete args.action

    const dispatched = await this.dispatchLocalAction(command.action, args)
    if (!dispatched.ok) {
      const code = dispatched.code === 'TIMEOUT' ? 'TIMEOUT' : dispatched.code === 'APP_UNAVAILABLE' ? 'APP_UNAVAILABLE' : 'INVALID_REQUEST'
      return this.error(rawId, code, dispatched.message, dispatched.details)
    }

    return this.ok(rawId, {
      ...(dispatched.result && typeof dispatched.result === 'object' ? dispatched.result : { result: dispatched.result }),
      hostBuildId: this.hostBuildId,
      hostApplication: this.hostApplication
    })
  }
}
