import type * as ClineSdk from '@cline/sdk' with { 'resolution-mode': 'import' }
import type {
  ExecutorBillingClassification,
  ExecutorBillingRecord,
  ExecutorUsageProvenance
} from '../../../../shared/types/buildx/execution-types'
import { sanitizeExecutorDiagnostics } from '../../execution/executor-port'
import { CLINE_OFFICIAL_API_BASE_URL } from './cline-sdk-protocol'

export interface CatalogModelPricing {
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

export interface CatalogModelInfo {
  readonly id?: string
  readonly name?: string
  readonly status?: string
  readonly operation?: string
  readonly capabilities?: readonly string[]
  readonly pricing?: CatalogModelPricing
  readonly thinkingConfig?: { readonly outputPrice?: number }
}

export interface FreeCatalogSdkSurface {
  readonly fetchClineRecommendedModels: typeof ClineSdk.fetchClineRecommendedModels
  readonly getLiveModelsCatalog: typeof ClineSdk.getLiveModelsCatalog
  readonly isClineFreeModelLimitError?: typeof ClineSdk.isClineFreeModelLimitError
  readonly isClineFreeModelLimitMessage?: typeof ClineSdk.isClineFreeModelLimitMessage
  readonly isClinePassLimitError?: typeof ClineSdk.isClinePassLimitError
  readonly isClinePassLimitMessage?: typeof ClineSdk.isClinePassLimitMessage
  readonly isClineNotSubscribedError?: typeof ClineSdk.isClineNotSubscribedError
  readonly isClineNotSubscribedMessage?: typeof ClineSdk.isClineNotSubscribedMessage
  readonly isClineModelNotFoundMessage?: typeof ClineSdk.isClineModelNotFoundMessage
  readonly OAuthReauthRequiredError?: typeof ClineSdk.OAuthReauthRequiredError
  readonly resetClineRecommendedModelsCacheForTests?: typeof ClineSdk.resetClineRecommendedModelsCacheForTests
  readonly clearLiveModelsCatalogCache?: typeof ClineSdk.clearLiveModelsCatalogCache
}

export interface VerifiedFreeModelSelection {
  readonly ok: true
  readonly selectedModelId: string
  readonly availableFreeModelIds: readonly string[]
}

export interface RejectedFreeModelSelection {
  readonly ok: false
  readonly status: 'REFUSED' | 'UNAVAILABLE'
  readonly reason: string
}

export type FreeModelSelectionResult = VerifiedFreeModelSelection | RejectedFreeModelSelection

export function normalizeBaseUrlOrigin(baseUrl = CLINE_OFFICIAL_API_BASE_URL): string {
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`UNAUTHORIZED_ENDPOINT_ORIGIN: unsupported protocol "${parsed.protocol}"`)
  }
  return parsed.origin
}

export function extractRequestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  if (input && typeof input === 'object' && 'url' in input && typeof input.url === 'string') {
    return input.url
  }
  throw new Error('UNAUTHORIZED_ENDPOINT_ORIGIN: invalid request URL')
}

export function assertAllowedOfficialUrl(rawUrl: string, allowedBaseUrl = CLINE_OFFICIAL_API_BASE_URL): URL {
  const expectedOrigin = normalizeBaseUrlOrigin(allowedBaseUrl)
  const parsed = new URL(rawUrl, expectedOrigin)
  if (parsed.origin !== expectedOrigin) {
    throw new Error(`UNAUTHORIZED_ENDPOINT_ORIGIN: blocked request to "${parsed.origin}", expected "${expectedOrigin}"`)
  }
  return parsed
}

export function isZeroPricingModelInfo(model: CatalogModelInfo | undefined): boolean {
  if (!model || !model.pricing) return false
  if (model.status === 'deprecated') return false
  if (model.operation && model.operation !== 'language') return false
  const { input, output, cacheRead = 0, cacheWrite = 0 } = model.pricing
  if (typeof input !== 'number' || typeof output !== 'number') return false
  if (input !== 0 || output !== 0 || cacheRead !== 0 || cacheWrite !== 0) return false
  if (model.thinkingConfig?.outputPrice !== undefined && model.thinkingConfig.outputPrice !== 0) return false
  return true
}

function modelHasToolsCapability(model: CatalogModelInfo): boolean {
  if (!model.capabilities || model.capabilities.length === 0) return true
  return model.capabilities.includes('tools')
}

export function createFreeLockedFetch(options: {
  readonly lockedModelId: string
  readonly allowedBaseUrl?: string
  readonly baseFetch?: typeof fetch
  readonly onHttpStatus?: (status: number) => void
}): typeof fetch {
  const baseFetch = options.baseFetch ?? globalThis.fetch
  const allowedBaseUrl = options.allowedBaseUrl ?? CLINE_OFFICIAL_API_BASE_URL
  const expectedOrigin = normalizeBaseUrlOrigin(allowedBaseUrl)

  return async (input, init) => {
    const rawUrl = extractRequestUrl(input)
    const parsedUrl = assertAllowedOfficialUrl(rawUrl, allowedBaseUrl)

    const isInferenceEndpoint = /\/(?:chat\/completions|responses|messages)\/?$/i.test(parsedUrl.pathname)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()

    if (isInferenceEndpoint && method === 'POST') {
      let bodyText: string | null = null
      if (typeof init?.body === 'string') {
        bodyText = init.body
      } else if (init?.body instanceof Uint8Array || init?.body instanceof ArrayBuffer) {
        bodyText = Buffer.from(init.body instanceof ArrayBuffer ? new Uint8Array(init.body) : init.body).toString('utf8')
      } else if (input instanceof Request) {
        bodyText = await input.clone().text()
      }

      if (!bodyText) {
        throw new Error('FREE_MODEL_LOCK_MISMATCH: missing inference JSON body')
      }

      let parsedBody: Record<string, unknown>
      try {
        parsedBody = JSON.parse(bodyText) as Record<string, unknown>
      } catch {
        throw new Error('FREE_MODEL_LOCK_MISMATCH: unparseable inference JSON body')
      }

      if (parsedBody.model !== options.lockedModelId) {
        throw new Error(
          `FREE_MODEL_LOCK_MISMATCH: blocked model "${String(parsedBody.model ?? '')}", expected "${options.lockedModelId}"`
        )
      }
    }

    const response = await baseFetch(input, init)
    if (response.url) {
      const responseOrigin = new URL(response.url).origin
      if (responseOrigin !== expectedOrigin) {
        throw new Error(`UNAUTHORIZED_ENDPOINT_ORIGIN: blocked response origin "${responseOrigin}"`)
      }
    }
    options.onHttpStatus?.(response.status)
    return response
  }
}

export async function resolveFreeClineCatalogSelection(
  sdk: FreeCatalogSdkSurface,
  options?: {
    readonly requestedModelId?: string | null
    readonly apiBaseUrl?: string
    readonly fetchImpl?: typeof fetch
    readonly requireToolsCapability?: boolean
    readonly liveCatalogOverride?: Record<string, Record<string, CatalogModelInfo>>
  }
): Promise<FreeModelSelectionResult> {
  const apiBaseUrl = options?.apiBaseUrl ?? CLINE_OFFICIAL_API_BASE_URL
  const baseFetch = options?.fetchImpl ?? globalThis.fetch
  const requireTools = options?.requireToolsCapability ?? true

  const liveFeedState: {
    confirmed: boolean
    freeIds: Set<string> | null
    error?: string
  } = {
    confirmed: false,
    freeIds: null
  }

  const trackedFetch: typeof fetch = async (input, init) => {
    const rawUrl = extractRequestUrl(input)
    assertAllowedOfficialUrl(rawUrl, apiBaseUrl)
    try {
      const response = await baseFetch(input, init)
      if (rawUrl.includes('/recommended-models')) {
        if (response.ok) {
          try {
            const payload = (await response.clone().json()) as { free?: Array<{ id?: unknown }> }
            if (Array.isArray(payload?.free)) {
              liveFeedState.confirmed = true
              liveFeedState.freeIds = new Set(
                payload.free
                  .map((entry) => (typeof entry?.id === 'string' ? entry.id.trim() : ''))
                  .filter(Boolean)
              )
            } else {
              liveFeedState.error = 'INVALID_RECOMMENDED_MODELS_PAYLOAD'
            }
          } catch {
            liveFeedState.error = 'UNPARSEABLE_RECOMMENDED_MODELS_PAYLOAD'
          }
        } else {
          liveFeedState.error = `HTTP_${response.status}`
        }
      }
      return response
    } catch (error) {
      if (rawUrl.includes('/recommended-models')) {
        liveFeedState.error = error instanceof Error ? error.message : String(error)
      }
      throw error
    }
  }

  const isCustomEndpoint =
    normalizeBaseUrlOrigin(apiBaseUrl) !== normalizeBaseUrlOrigin(CLINE_OFFICIAL_API_BASE_URL)
  const customCatalogUrl = isCustomEndpoint
    ? `${normalizeBaseUrlOrigin(apiBaseUrl)}/api/v1/ai/models`
    : undefined

  let catalogModels: Record<string, CatalogModelInfo> | undefined
  const catalogLoader = async (): Promise<Record<string, Record<string, any>>> => {
    if (options?.liveCatalogOverride) {
      return options.liveCatalogOverride
    }
    if (customCatalogUrl) {
      const response = await trackedFetch(customCatalogUrl, { method: 'GET' })
      if (!response.ok) {
        throw new Error(`HTTP_${response.status} fetching custom models catalog`)
      }
      const raw = (await response.json()) as {
        cline?: { models?: Record<string, Record<string, any>> }
      }
      const rawModels = raw?.cline?.models ?? {}
      const mapped: Record<string, CatalogModelInfo> = {}
      for (const [id, entry] of Object.entries(rawModels)) {
        const cost = (entry?.cost ?? {}) as Record<string, unknown>
        mapped[id] = {
          id,
          name: typeof entry?.name === 'string' ? entry.name : id,
          ...(entry?.tool_call === true ? { capabilities: ['tools'] } : {}),
          pricing: {
            input: typeof cost.input === 'number' ? cost.input : Number.NaN,
            output: typeof cost.output === 'number' ? cost.output : Number.NaN,
            cacheRead: typeof cost.cache_read === 'number' ? cost.cache_read : 0,
            cacheWrite: typeof cost.cache_write === 'number' ? cost.cache_write : 0
          }
        }
      }
      return { cline: mapped }
    }
    const live = await sdk.getLiveModelsCatalog({
      includeClineCloudModels: false
    })
    return live as unknown as Record<string, Record<string, any>>
  }

  sdk.resetClineRecommendedModelsCacheForTests?.()
  sdk.clearLiveModelsCatalogCache?.(customCatalogUrl)

  let recommended: ClineSdk.ClineRecommendedModelsData
  let loadedCatalog: Record<string, Record<string, CatalogModelInfo>>
  try {
    ;[recommended, loadedCatalog] = await Promise.all([
      sdk.fetchClineRecommendedModels({
        baseUrl: apiBaseUrl,
        fetchImpl: trackedFetch,
        catalogLoader
      }),
      catalogLoader()
    ])
    catalogModels = loadedCatalog?.cline
  } catch (error) {
    return {
      ok: false,
      status: 'UNAVAILABLE',
      reason: `FREE_CATALOG_UNAVAILABLE: ${sanitizeDiagnostics(error instanceof Error ? error.message : String(error))}`
    }
  }

  const verifiedFreeIds = liveFeedState.freeIds
  if (!liveFeedState.confirmed || !verifiedFreeIds) {
    return {
      ok: false,
      status: 'UNAVAILABLE',
      reason: `FREE_CATALOG_UNAVAILABLE: live recommended-models feed could not be verified (${liveFeedState.error ?? 'FALLBACK_REJECTED'})`
    }
  }

  for (const candidate of recommended.free ?? []) {
    if (candidate?.id && !verifiedFreeIds.has(candidate.id)) {
      return {
        ok: false,
        status: 'UNAVAILABLE',
        reason: 'FREE_CATALOG_UNAVAILABLE: rejected non-live fallback recommended-models feed'
      }
    }
  }

  if (!catalogModels || Object.keys(catalogModels).length === 0) {
    return {
      ok: false,
      status: 'UNAVAILABLE',
      reason: 'FREE_CATALOG_UNAVAILABLE: live Cline model pricing catalog is empty'
    }
  }

  const eligibleFreeIds: string[] = []
  for (const candidate of recommended.free ?? []) {
    if (!candidate?.id) continue
    const info = catalogModels[candidate.id]
    if (!isZeroPricingModelInfo(info)) continue
    if (requireTools && info && !modelHasToolsCapability(info)) continue
    eligibleFreeIds.push(candidate.id)
  }

  if (options?.requestedModelId) {
    const cleanId = options.requestedModelId.trim()
    if (!eligibleFreeIds.includes(cleanId)) {
      const requestedInfo = catalogModels[cleanId]
      const listedInFreeFeed = (recommended.free ?? []).some((m: { id?: string }) => m?.id === cleanId)
      if (requestedInfo && !isZeroPricingModelInfo(requestedInfo)) {
        return {
          ok: false,
          status: 'REFUSED',
          reason: `FREE_MODEL_NOT_ELIGIBLE: model "${cleanId}" is not zero-priced`
        }
      }
      if (!listedInFreeFeed) {
        return {
          ok: false,
          status: 'REFUSED',
          reason: `FREE_MODEL_NOT_ELIGIBLE: model "${cleanId}" is absent from live free catalog`
        }
      }
      return {
        ok: false,
        status: 'REFUSED',
        reason: `FREE_MODEL_NOT_ELIGIBLE: model "${cleanId}" lacks verified free pricing or required tool support`
      }
    }
    return {
      ok: true,
      selectedModelId: cleanId,
      availableFreeModelIds: eligibleFreeIds
    }
  }

  if (eligibleFreeIds.length === 0) {
    return {
      ok: false,
      status: 'REFUSED',
      reason: 'FREE_MODEL_NOT_ELIGIBLE: no verified zero-priced tool-capable free model available in live catalog'
    }
  }

  return {
    ok: true,
    selectedModelId: eligibleFreeIds[0],
    availableFreeModelIds: eligibleFreeIds
  }
}

export function classifyClineBillingTwoDimensional(input: {
  readonly reportedTotalCost?: number | null
  readonly balanceBefore?: number | null
  readonly balanceAfter?: number | null
  readonly transaction?: Pick<ClineSdk.ClineAccountUsageTransaction, 'creditsUsed' | 'costUsd'> | null
  readonly billingApiVerified?: boolean
}): ExecutorBillingRecord {
  const upstreamFromTx = typeof input.transaction?.costUsd === 'number' ? input.transaction.costUsd : null
  const upstreamFromSdk = typeof input.reportedTotalCost === 'number' ? input.reportedTotalCost : null
  const upstreamCostUsd = upstreamFromTx ?? upstreamFromSdk

  const hasBalances = typeof input.balanceBefore === 'number' && typeof input.balanceAfter === 'number'
  const balanceDelta = hasBalances ? input.balanceAfter! - input.balanceBefore! : null
  const creditsUsed =
    typeof input.transaction?.creditsUsed === 'number'
      ? input.transaction.creditsUsed
      : balanceDelta === 0
        ? 0
        : null

  let classification: ExecutorBillingClassification = 'UNKNOWN'
  let provenance: ExecutorUsageProvenance = 'UNAVAILABLE'

  if ((creditsUsed !== null && creditsUsed > 0) || (balanceDelta !== null && balanceDelta < 0)) {
    classification = 'CHARGED'
    provenance = 'PROVIDER_BILLING_API'
  } else if (
    (input.transaction && input.transaction.creditsUsed === 0 && (balanceDelta === null || balanceDelta === 0)) ||
    (input.billingApiVerified && balanceDelta === 0)
  ) {
    classification = 'ZERO_COST_CONFIRMED'
    provenance = 'PROVIDER_BILLING_API'
  } else if (upstreamFromSdk === 0) {
    classification = 'UNKNOWN'
    provenance = 'EXECUTOR_REPORTED'
  }

  return {
    ...(upstreamCostUsd !== null ? { upstreamCostUsd } : {}),
    ...(creditsUsed !== null ? { creditsUsed } : {}),
    ...(balanceDelta !== null ? { balanceDelta } : {}),
    currency: 'USD',
    classification,
    provenance
  }
}

export function sanitizeDiagnostics(message: string): string {
  return sanitizeExecutorDiagnostics(message)
}

export function classifyClineErrorReason(
  sdk: Partial<FreeCatalogSdkSurface>,
  error: unknown,
  httpStatus?: number
): string {
  const rawMessage = error instanceof Error ? error.message : String(error ?? 'UNKNOWN_CLINE_ERROR')
  const cleanMessage = sanitizeDiagnostics(rawMessage)

  if (cleanMessage.includes('FREE_MODEL_LOCK_MISMATCH')) return 'FREE_MODEL_LOCK_MISMATCH'
  if (cleanMessage.includes('FREE_MODEL_NOT_ELIGIBLE')) return cleanMessage
  if (cleanMessage.includes('FREE_CATALOG_UNAVAILABLE')) return cleanMessage
  if (cleanMessage.includes('UNAUTHORIZED_ENDPOINT_ORIGIN')) return cleanMessage
  if (cleanMessage.includes('PATH_OUTSIDE_BOUND_WORKTREE')) return cleanMessage
  if (cleanMessage.includes('TOOL_FORBIDDEN_BY_BUILDX_POLICY')) return cleanMessage

  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    (sdk.OAuthReauthRequiredError && error instanceof sdk.OAuthReauthRequiredError) ||
    /\b(401|403|unauthorized|unauthenticated|invalid credentials|oauth.*expired|reauth)\b/i.test(rawMessage)
  ) {
    return `CLINE_AUTHENTICATION_FAILED: ${cleanMessage}`
  }

  if (
    httpStatus === 429 ||
    sdk.isClineFreeModelLimitError?.(error) ||
    sdk.isClineFreeModelLimitMessage?.(rawMessage) ||
    sdk.isClinePassLimitError?.(error) ||
    sdk.isClinePassLimitMessage?.(rawMessage) ||
    sdk.isClineNotSubscribedError?.(error) ||
    sdk.isClineNotSubscribedMessage?.(rawMessage) ||
    /\b(429|quota|rate limit|free model limit|insufficient credits|payment required|402)\b/i.test(rawMessage)
  ) {
    return `CLINE_FREE_QUOTA_OR_RATE_LIMIT: ${cleanMessage}`
  }

  if (httpStatus === 404 || sdk.isClineModelNotFoundMessage?.(rawMessage)) {
    return `CLINE_MODEL_UNAVAILABLE: ${cleanMessage}`
  }

  return cleanMessage
}
