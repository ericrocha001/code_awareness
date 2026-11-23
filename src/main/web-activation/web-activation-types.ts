import { ALLOWED_WEB_MCP_METHODS, ALLOWED_WEB_MCP_TOOLS, webMcpPolicy } from '../../shared/web-activation/web-allowlist'

export { ALLOWED_WEB_MCP_METHODS, ALLOWED_WEB_MCP_TOOLS }

export const WEB_ACTIVATION_BRIDGE_PROTOCOL = 'code-awareness-web-bridge/v1'
export const WEB_MCP_BOOTSTRAP_PROTOCOL = 'code-awareness-mcp-bootstrap/v1'
export const WEB_NATIVE_HOST_NAME = 'com.ericrocha.codeawareness.web_activation'
export const GLOBAL_CONSENT_PROJECT_ID = '__GLOBAL__'

export const DEFAULT_ALLOWED_WEB_ORIGINS = [
  'https://chat.deepseek.com',
  'https://chat.qwen.ai'
] as const

export type WebSiteId = 'deepseek' | 'qwen'
export type WebEgressDataClass = 'METADATA' | 'LITERAL_SOURCE'

const LITERAL_SOURCE_TOOLS = new Set<string>([
  'read_code',
  'read_artifact_section',
  'get_artifact',
  'verify_academy_change_impact',
  'analyze_academy_change_impact',
  'get_academy_git_status'
])

const PROJECT_CONDITIONAL_LITERAL_TOOLS = new Set<string>([
  'get_academy_skill',
  'get_academy_skill_history'
])

export interface WebConsentRecord {
  site: string
  projectId: string
  dataClass: WebEgressDataClass
  origin?: string
  grantedAt: string
}

export interface DesktopSkillsEndpointInfo {
  protocol?: string
  status: 'RUNNING' | 'UNAVAILABLE'
  mode?: 'PROJECT' | 'GLOBAL_ONLY'
  endpoint?: string
  projectId?: string | null
  instanceId?: string
  bindingId?: string
  reason?: string
  observedAt: string
}

export interface NativeBridgeErrorPayload {
  code:
    | 'ORIGIN_NOT_ALLOWED'
    | 'INVALID_REQUEST'
    | 'APP_UNAVAILABLE'
    | 'TIMEOUT'
    | 'INVALID_MCP_RESPONSE'
    | 'SESSION_INVALIDATED'
    | 'METHOD_NOT_ALLOWED'
    | 'TOOL_NOT_ALLOWED'
    | 'INVALID_URI'
    | 'CONSENT_REQUIRED'
    | 'MCP_HTTP_ERROR'
    | 'RESPONSE_TOO_LARGE'
    | 'MAINTENANCE_UNAUTHORIZED'
    | 'INTERNAL_ERROR'
  message: string
  details?: Record<string, unknown>
}

export const WEB_EXTENSION_MANAGER_TOOL_NAMES = Object.freeze([
  'get_web_extension_status',
  'start_web_extension_operation',
  'get_web_extension_operation'
] as const)

export type NativeBridgeCommand =
  | { id: string; action: 'ping' }
  | {
      id: string
      action: 'get_status'
      site?: string
      webOrigin?: string
    }
  | {
      id: string
      action: 'get_consent'
      site: string
      projectId?: string | null
      webOrigin?: string
    }
  | {
      id: string
      action: 'set_consent'
      site: string
      projectId?: string | null
      dataClass: WebEgressDataClass
      granted: boolean
      webOrigin?: string
    }
  | {
      id: string
      action: 'mcp_request'
      site: string
      webOrigin: string
      method: string
      params?: unknown
      expectedProjectId?: string | null
      expectedBindingId?: string | null
      expectedInstanceId?: string | null
    }
  | {
      id: string
      action: 'maintenance_check'
      installationId: string
      extensionId: string
      profileId: string
      bootId: string
      buildId: string
      manifestVersion: string
      installType: string
    }
  | {
      id: string
      action: 'maintenance_claim'
      operationId: string
      installationId: string
      extensionId: string
      profileId: string
      bootId: string
      buildId: string
      targetBuildId: string
      nonce: string
      epoch: number
      readyToReload: boolean
      activeBusyReason?: string
    }
  | {
      id: string
      action: 'maintenance_report'
      phase: 'BOOT_ATTESTATION' | 'REINJECT_RESULT' | 'QUIESCENCE_BLOCKED'
      report: import('./extension-manager-types').ExtensionRuntimeAttestation
    }

export interface NativeBridgeResponse {
  id: string
  ok: boolean
  protocol: string
  result?: unknown
  error?: NativeBridgeErrorPayload
}

export function normalizeConsentProjectId(projectId?: string | null): string {
  const trimmed = typeof projectId === 'string' ? projectId.trim() : ''
  return trimmed.length > 0 ? trimmed : GLOBAL_CONSENT_PROJECT_ID
}

export function normalizeWebOrigin(rawOrigin: unknown): string | null {
  if (typeof rawOrigin !== 'string' || !rawOrigin.trim()) return null
  try {
    const parsed = new URL(rawOrigin.trim())
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.origin.toLowerCase()
  } catch {
    return null
  }
}

export function resolveSiteForWebOrigin(origin: string): WebSiteId | null {
  const normalized = normalizeWebOrigin(origin)
  if (normalized === 'https://chat.deepseek.com') return 'deepseek'
  if (normalized === 'https://chat.qwen.ai') return 'qwen'
  return null
}

export function validateReadOnlyWebMcpRequest(
  method: string,
  params: unknown,
  site: string | null = null
): { ok: true } | { ok: false; code: 'METHOD_NOT_ALLOWED' | 'TOOL_NOT_ALLOWED' | 'INVALID_URI'; message: string } {
  const policy = webMcpPolicy(site)
  if (!policy.methods.has(method)) {
    return {
      ok: false,
      code: 'METHOD_NOT_ALLOWED',
      message: `MCP method "${method}" is not in the web read-only allowlist`
    }
  }

  if (method === 'tools/call') {
    const toolName =
      params && typeof params === 'object' && typeof (params as { name?: unknown }).name === 'string'
        ? (params as { name: string }).name.trim()
        : ''
    if (!toolName || !policy.tools.has(toolName)) {
      return {
        ok: false,
        code: 'TOOL_NOT_ALLOWED',
        message: `MCP tool "${toolName}" is not permitted over the web activation bridge`
      }
    }
  }

  if (method === 'resources/read') {
    const uri =
      params && typeof params === 'object' && typeof (params as { uri?: unknown }).uri === 'string'
        ? (params as { uri: string }).uri.trim()
        : ''
    if (!uri.startsWith('skill://global/') && !uri.startsWith('skill://project/')) {
      return {
        ok: false,
        code: 'INVALID_URI',
        message: 'resources/read over the web bridge only permits skill://global/ or skill://project/ URIs'
      }
    }
  }

  return { ok: true }
}

export function classifyWebMcpDataClass(
  method: string,
  params: unknown,
  activeProjectId: string | null
): WebEgressDataClass {
  if (method === 'resources/read') {
    const uri =
      params && typeof params === 'object' && typeof (params as { uri?: unknown }).uri === 'string'
        ? (params as { uri: string }).uri.trim()
        : ''
    return uri.startsWith('skill://project/') ? 'LITERAL_SOURCE' : 'METADATA'
  }

  if (method === 'tools/call') {
    const toolName =
      params && typeof params === 'object' && typeof (params as { name?: unknown }).name === 'string'
        ? (params as { name: string }).name.trim()
        : ''
    if (LITERAL_SOURCE_TOOLS.has(toolName)) {
      return 'LITERAL_SOURCE'
    }
    if (PROJECT_CONDITIONAL_LITERAL_TOOLS.has(toolName) && activeProjectId) {
      return 'LITERAL_SOURCE'
    }
  }

  return 'METADATA'
}
