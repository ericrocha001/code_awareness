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
const DEFAULT_PIPE_TIMEOUT_MS = 2500

export interface LocalChannelDescriptor {
  protocol: string
  token: string
  endpoint: string
}

export interface McpHttpResponse {
  status: number
  body: unknown
}

export type McpHttpTransport = (
  endpoint: string,
  headers: Record<string, string>,
  payload: unknown
) => Promise<McpHttpResponse>

export interface NativeMessagingBridgeOptions {
  consentStore: ConsentStore
  callerOrigin?: string
  requireCallerOrigin?: boolean
  allowedExtensionOrigins?: readonly string[]
  allowedWebOrigins?: readonly string[]
  userDataPath?: string
  resolveDesktopEndpoint?: () => Promise<DesktopSkillsEndpointInfo | null>
  mcpTransport?: McpHttpTransport
  maxOutboundBytes?: number
}

function normalizeExtensionOrigin(origin: string | undefined): string | null {
  if (typeof origin !== 'string') return null
  const trimmed = origin.trim().toLowerCase()
  if (!EXTENSION_ORIGIN_RE.test(trimmed)) return null
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

export async function discoverDesktopWebActivationEndpoint(
  userDataPath: string,
  timeoutMs = DEFAULT_PIPE_TIMEOUT_MS
): Promise<DesktopSkillsEndpointInfo | null> {
  const descriptorPath = join(userDataPath, 'local-agent-channel', 'endpoint.json')
  if (!existsSync(descriptorPath)) {
    return null
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
      return null
    }
    descriptor = {
      protocol: raw.protocol,
      token: raw.token,
      endpoint: raw.endpoint
    }
  } catch {
    return null
  }

  return await new Promise<DesktopSkillsEndpointInfo | null>((resolve) => {
    let settled = false
    const socket = createConnection(descriptor.endpoint)
    let raw = ''

    const finish = (result: DesktopSkillsEndpointInfo | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }

    const timer = setTimeout(() => finish(null), timeoutMs)
    socket.setEncoding('utf8')
    socket.once('error', () => finish(null))
    socket.once('connect', () => {
      socket.write(
        JSON.stringify({
          protocol: descriptor.protocol,
          token: descriptor.token,
          domain: 'web_activation',
          action: 'endpoint',
          args: {}
        }) + '\n'
      )
    })
    socket.on('data', (chunk: string) => {
      raw += chunk
      const newlineIndex = raw.indexOf('\n')
      if (newlineIndex === -1) return
      const line = raw.slice(0, newlineIndex).trim()
      try {
        const parsed = JSON.parse(line) as { result?: DesktopSkillsEndpointInfo; error?: unknown }
        if (parsed && !parsed.error && parsed.result && parsed.result.status === 'RUNNING' && parsed.result.endpoint) {
          finish(parsed.result)
          return
        }
      } catch {
        // Fall through to fail-closed null
      }
      finish(null)
    })
  })
}

async function defaultMcpTransport(
  endpoint: string,
  headers: Record<string, string>,
  payload: unknown
): Promise<McpHttpResponse> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload)
  })
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body }
}

export class NativeMessagingBridge {
  private readonly consentStore: ConsentStore
  private readonly callerOrigin: string | null
  private readonly requireCallerOrigin: boolean
  private readonly allowedExtensionOrigins: Set<string> | null
  private readonly allowedWebOrigins: Set<string>
  private readonly resolveDesktopEndpoint: () => Promise<DesktopSkillsEndpointInfo | null>
  private readonly mcpTransport: McpHttpTransport
  private readonly maxOutboundBytes: number
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
    this.resolveDesktopEndpoint =
      options.resolveDesktopEndpoint ??
      (options.userDataPath
        ? () => discoverDesktopWebActivationEndpoint(options.userDataPath!)
        : async () => null)
    this.mcpTransport = options.mcpTransport ?? defaultMcpTransport
    this.maxOutboundBytes = options.maxOutboundBytes ?? MAX_NATIVE_OUTBOUND_BYTES
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
          bridgeProtocol: WEB_ACTIVATION_BRIDGE_PROTOCOL
        })

      case 'get_status': {
        if (command.webOrigin !== undefined) {
          const checked = this.validateWebOrigin(rawId, command.webOrigin, command.site)
          if ('err' in checked) return checked.err
        }
        const endpointInfo = await this.resolveDesktopEndpoint()
        if (!endpointInfo || endpointInfo.status !== 'RUNNING' || !endpointInfo.endpoint) {
          return this.ok(rawId, {
            available: false,
            errorCode: 'APP_UNAVAILABLE',
            reason: endpointInfo?.reason ?? 'DESKTOP_UNREACHABLE',
            observedAt: new Date().toISOString()
          })
        }
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

        const endpointInfo = await this.resolveDesktopEndpoint()
        if (!endpointInfo || endpointInfo.status !== 'RUNNING' || !endpointInfo.endpoint) {
          return this.error(
            rawId,
            'APP_UNAVAILABLE',
            'Code Awareness Desktop is unavailable; fail-closed',
            { reason: endpointInfo?.reason ?? 'DESKTOP_UNREACHABLE' }
          )
        }

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

        this.rpcCounter += 1
        let httpRes: McpHttpResponse
        try {
          httpRes = await this.mcpTransport(endpointInfo.endpoint, headers, {
            jsonrpc: '2.0',
            id: this.rpcCounter,
            method: command.method,
            params: command.params ?? {}
          })
        } catch (err) {
          return this.error(
            rawId,
            'APP_UNAVAILABLE',
            `Failed to reach Desktop MCP endpoint: ${err instanceof Error ? err.message : String(err)}`
          )
        }

        const rpcError =
          httpRes.body && typeof httpRes.body === 'object'
            ? (httpRes.body as { error?: { code?: number; message?: string; data?: Record<string, unknown> } }).error
            : undefined

        if (httpRes.status === 409 || rpcError?.code === -32001) {
          return this.error(
            rawId,
            'SESSION_INVALIDATED',
            rpcError?.message ?? 'Desktop MCP session binding invalidated',
            rpcError?.data
          )
        }

        if (httpRes.status >= 400 && !httpRes.body) {
          return this.error(rawId, 'MCP_HTTP_ERROR', `Desktop MCP returned HTTP ${httpRes.status}`)
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
}
