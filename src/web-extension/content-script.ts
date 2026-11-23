import {
  ACTIVATION_CONTRACT_PROTOCOL,
  extractActivationResultEnvelopes,
  parseActivationCallEnvelopes
} from '../shared/web-activation/activation-contract'
import {
  ActivationSession,
  type ActivationClock,
  type ActivationSessionState,
  type WebActivationTransport
} from '../shared/web-activation/activation-session'
import { getChromeApi, type ChromeApi, type ChromeMessageListener } from './chrome-api'
import type { ChatDomTurn, WebChatAdapter } from './adapters/adapter-interface'
import { DeepSeekWebAdapter } from './adapters/deepseek-adapter'
import { QwenWebAdapter } from './adapters/qwen-adapter'
import { getBuiltWebExtensionBuildId } from './runtime-config'
import {
  createRuntimeMessageTransport as createRuntimeMessageTransportImpl,
  DEFAULT_RUNTIME_MESSAGE_TIMEOUT_MS
} from './runtime-transport'

const GLOBAL_CONTENT_CONTROLLER_KEY = '__codeAwarenessContentController__'
const ACTIVE_DRAFT_TYPING_GRACE_MS = 2500
const MAINTENANCE_DRAIN_WINDOW_MS = 15_000
export { DEFAULT_RUNTIME_MESSAGE_TIMEOUT_MS }
export const DEFAULT_DELIVERY_ACK_TIMEOUT_MS = 10_000
export const DEFAULT_DELIVERY_RECOVERY_TTL_MS = 60_000

const LITERAL_EGRESS_METHODS = new Set([
  'skills.load',
  'skills/get',
  'resources.read',
  'resources/read'
])
const LITERAL_EGRESS_TOOLS = new Set([
  'read_code',
  'read_artifact_section',
  'get_artifact',
  'verify_academy_change_impact',
  'analyze_academy_change_impact',
  'get_academy_git_status'
])

export interface ControllerClock extends ActivationClock {
  now(): number
}

export interface ContentControllerOptions {
  deliveryAckTimeoutMs?: number
  deliveryRecoveryTtlMs?: number
  logicalCallTimeoutMs?: number
  clock?: ControllerClock
}

export interface ControllerDiagnostic {
  code: string
  phase?: 'parse' | 'execution' | 'delivery' | 'session' | 'observer'
  requestId?: string
  message: string
  epoch: number
  conversationKey: string | null
  turnMessageId?: string
  recoverable?: boolean
}

export interface LastDeliveryStatus {
  ok: boolean
  status: 'DELIVERED' | 'AWAITING_DELIVERY_ACK' | 'PENDING_RECOVERY' | 'DELIVERY_UNKNOWN' | 'PRE_DISPATCH_BLOCKED' | 'FAILED'
  reason?: string
  requestIds: string[]
  epoch: number
}

interface RequestTraceEntry {
  requestId: string
  stage: string
  epoch: number
  state: ActivationSessionState
}

interface PendingDeliveryRecord {
  kind: 'tool_result' | 'bootstrap'
  replyText: string
  requestIds: string[]
  expectedEnvelopes: Map<string, string>
  needsLiteralConsent: boolean
  epoch: number
  conversationKey: string | null
  turnMessageId?: string
  assistantAnchor?: { strongKey: string | null; element?: Element }
  bindingSnapshot: {
    mode: 'PROJECT' | 'GLOBAL_ONLY'
    projectId: string | null
    instanceId: string | null
    bindingId: string | null
  }
  baselineUserCount: number
  baselineUserStrongKeys: Set<string>
  baselineUserElements: WeakSet<Element>
  firstAttemptAt: number
  expiresAt: number
  phase: 'PENDING_DISPATCH' | 'AWAITING_DELIVERY_ACK'
  lastReason: string
  inFlight: boolean
}

interface ObservedAnchor {
  element: Element
  index: number
  role: ChatDomTurn['role']
}

const EPHEMERAL_NEW_CHAT_PATHS = new Set(['/', '/new', '/c/new', '/a/chat', '/a/chat/s'])
const MAX_DRAIN_ITERATIONS = 16
const RESULT_FENCE_RE = /^ {0,3}`{3,}code-awareness-result\b/m

function isEphemeralNewChatUrl(conversationKey: string): boolean {
  try {
    const parsed = new URL(conversationKey)
    const normalizedPath = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : parsed.pathname
    return EPHEMERAL_NEW_CHAT_PATHS.has(normalizedPath)
  } catch {
    return false
  }
}

function getStrongKey(turn: ChatDomTurn): string | null {
  const trimmed = turn.messageId.trim()
  if (!trimmed) return null
  if (turn.identitySource === 'dom-attribute' || turn.identitySource === 'dom-id') {
    return `${turn.identitySource}:${trimmed}`
  }
  if (turn.identitySource === 'fallback-position' || turn.identitySource === 'ambiguous') {
    return null
  }
  return /-turn-\d+$/.test(trimmed) ? null : `custom-id:${trimmed}`
}

function looksLikeHydratedHistory(turns: readonly ChatDomTurn[]): boolean {
  let completeAssistantCount = 0
  let sawCompleteAssistant = false
  for (const turn of turns) {
    if (turn.role === 'assistant' && turn.isComplete) {
      completeAssistantCount += 1
      sawCompleteAssistant = true
      if (completeAssistantCount > 1) return true
    } else if (turn.role === 'user' && sawCompleteAssistant) {
      return true
    }
  }
  return false
}

export function selectWebChatAdapter(locationHref: string): WebChatAdapter | null {
  const candidates: WebChatAdapter[] = [new DeepSeekWebAdapter(), new QwenWebAdapter()]
  for (const adapter of candidates) {
    if (adapter.matchesLocation(locationHref)) return adapter
  }
  return null
}

export const createRuntimeMessageTransport = createRuntimeMessageTransportImpl

export class ContentSessionController {
  readonly session: ActivationSession
  private readonly clock: ControllerClock
  private readonly deliveryAckTimeoutMs: number
  private readonly deliveryRecoveryTtlMs: number
  private stopObserver: (() => void) | null = null
  private activationEpoch = 0
  private activeConversationKey: string | null = null
  private awaitingPostSwitchHydration = false
  private consumedStrongIds = new Set<string>()
  private observedStrongUserIds = new Set<string>()
  private consumedElements = new WeakSet<Element>()
  private observedUserElements = new WeakSet<Element>()
  private observedAnchorElements: ObservedAnchor[] = []
  private consumedAssistantCount = 0
  private lastConsumedAssistantStrongKey: string | null = null
  private seenUserCount = 0
  private hadAssistantTurnsInConversation = false
  private lastErrorMessage: string | null = null
  private lastDiagnostic: ControllerDiagnostic | null = null
  private readonly requestTrace: RequestTraceEntry[] = []
  private lastDelivery: LastDeliveryStatus | null = null
  private pendingDelivery: PendingDeliveryRecord | null = null
  private userTurnObservedAfterExecution = false
  private deliveryAckTimer: unknown = null
  private deliveryRecoveryExpiryTimer: unknown = null
  private continuationTimer: unknown = null
  private processing = false
  private pendingMutationCheck = false
  private pillEl: HTMLElement | null = null
  private lastComposerInputAt = 0
  private programmaticComposerWrite = false
  private maintenanceDrainUntil = 0
  private readonly inputListener: (ev?: Event) => void
  private onDisposeCallback?: () => void

  constructor(
    readonly adapter: WebChatAdapter,
    readonly rootDocument: Document,
    private readonly transport: WebActivationTransport,
    private readonly mountUi = true,
    options: ContentControllerOptions = {}
  ) {
    this.clock = options.clock ?? {
      now: () => Date.now(),
      setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
      clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>)
    }
    this.deliveryAckTimeoutMs = options.deliveryAckTimeoutMs ?? DEFAULT_DELIVERY_ACK_TIMEOUT_MS
    this.deliveryRecoveryTtlMs = options.deliveryRecoveryTtlMs ?? DEFAULT_DELIVERY_RECOVERY_TTL_MS
    this.session = new ActivationSession({
      site: adapter.site,
      transport,
      ...(options.logicalCallTimeoutMs !== undefined ? { logicalCallTimeoutMs: options.logicalCallTimeoutMs } : {}),
      clock: this.clock
    })
    this.inputListener = (ev?: Event) => {
      if (this.programmaticComposerWrite && ev?.isTrusted === false) {
        return
      }
      this.lastComposerInputAt = this.clock.now()
      if (this.pendingDelivery?.phase === 'PENDING_DISPATCH' && !this.processing && this.canQuickDispatchFromDom()) {
        void this.handleDomMutation()
      }
    }
    this.rootDocument.addEventListener?.('input', this.inputListener, true)
    if (this.mountUi) {
      this.rootDocument.getElementById('code-awareness-activation-pill')?.remove()
      this.renderPill()
    }
  }

  getStatusSnapshot(): {
    site: string
    state: ActivationSessionState
    binding: ReturnType<ActivationSession['getBinding']>
    authenticated: boolean
    buildId: string
    busy: boolean
    lastError: string | null
    lastDiagnostic: ControllerDiagnostic | null
    requestTrace: RequestTraceEntry[]
    lastDelivery: LastDeliveryStatus | null
  } {
    const quiescence = this.checkMaintenanceReadiness(false)
    return {
      site: this.adapter.site,
      state: this.session.getState(),
      binding: this.session.getBinding(),
      authenticated: this.adapter.isAuthenticatedChatReady(this.rootDocument),
      buildId: getBuiltWebExtensionBuildId(),
      busy: !quiescence.ready,
      lastError: this.lastErrorMessage,
      lastDiagnostic: this.lastDiagnostic,
      requestTrace: this.requestTrace.filter((entry) => entry.epoch === this.activationEpoch),
      lastDelivery: this.lastDelivery
    }
  }

  private recordTrace(requestId: string, stage: string): void {
    const shortId = requestId.slice(0, 64)
    if (this.requestTrace.some((entry) =>
      entry.epoch === this.activationEpoch && entry.requestId === shortId && entry.stage === stage
    )) return
    this.requestTrace.push({ requestId: shortId, stage, epoch: this.activationEpoch, state: this.session.getState() })
    if (this.requestTrace.length > 48) this.requestTrace.shift()
  }

  private getConversationKey(): string | null {
    const rawHref =
      this.rootDocument.location?.href ??
      this.rootDocument.defaultView?.location?.href ??
      this.rootDocument.URL
    if (!rawHref) return null
    try {
      const url = new URL(rawHref)
      return `${url.origin.toLowerCase()}${url.pathname}${url.search}`
    } catch {
      return rawHref
    }
  }

  async activate(sendBootstrap = true): Promise<{
    ok: boolean
    state: ActivationSessionState
    bootstrapPrompt?: string
    error?: { code: string; message: string; details?: Record<string, unknown> }
  }> {
    this.lastErrorMessage = null
    this.lastDiagnostic = null
    this.lastDelivery = null
    if (!this.adapter.isAuthenticatedChatReady(this.rootDocument)) {
      this.renderPill()
      return {
        ok: false,
        state: this.session.getState(),
        error: {
          code: 'CHAT_NOT_READY',
          message: 'Sign in and open an active chat composer before activating Code Awareness'
        }
      }
    }

    const res = await this.session.activate()
    if (res.state !== 'READY' || !res.bootstrapPrompt) {
      this.lastErrorMessage = res.error?.message ?? res.state
      this.renderPill()
      return {
        ok: false,
        state: res.state,
        error: res.error
      }
    }

    this.activationEpoch += 1
    this.requestTrace.length = 0
    this.clearPendingDeliveryState()
    this.awaitingPostSwitchHydration = false
    this.pendingMutationCheck = false
    this.activeConversationKey = this.getConversationKey()
    this.markCurrentTurnsSeen()
    this.ensureObserving()

    if (sendBootstrap) {
      const sent = await this.dispatchMessageAndTrack({
        kind: 'bootstrap',
        replyText: res.bootstrapPrompt,
        requestIds: [],
        needsLiteralConsent: false,
        runEpoch: this.activationEpoch,
        runConversationKey: this.activeConversationKey
      })
      if (!sent.dispatched) {
        const reason = sent.reason ?? 'SEND_FAILED'
        return {
          ok: false,
          state: this.session.getState(),
          bootstrapPrompt: res.bootstrapPrompt,
          error: { code: reason, message: `Failed to inject bootstrap prompt (${reason})` }
        }
      }
    }

    this.renderPill()
    return {
      ok: true,
      state: res.state,
      bootstrapPrompt: res.bootstrapPrompt
    }
  }

  startNewChat(): void {
    this.activationEpoch += 1
    this.requestTrace.length = 0
    this.clearPendingDeliveryState()
    this.lastErrorMessage = null
    this.lastDiagnostic = null
    this.lastDelivery = null
    this.pendingMutationCheck = false
    this.session.startNewChat()
    this.activeConversationKey = this.getConversationKey()
    const turns = this.adapter.readTurns(this.rootDocument)
    this.recordBaseline(turns)
    this.awaitingPostSwitchHydration = turns.length === 0
    this.renderPill()
  }

  revoke(): void {
    this.activationEpoch += 1
    this.requestTrace.length = 0
    this.clearPendingDeliveryState()
    this.pendingMutationCheck = false
    this.lastDelivery = null
    this.lastErrorMessage = 'Consent revoked for this chat session'
    this.lastDiagnostic = {
      code: 'SESSION_REVOKED',
      phase: 'session',
      message: 'Consent revoked for this chat session',
      epoch: this.activationEpoch,
      conversationKey: this.activeConversationKey,
      recoverable: false
    }
    this.session.revoke()
    this.stopObserving()
    this.renderPill()
  }

  setOnDispose(callback: () => void): void {
    this.onDisposeCallback = callback
  }

  checkMaintenanceReadiness(enterDrain = true): { ready: boolean; reason?: string; buildId: string } {
    const buildId = getBuiltWebExtensionBuildId()
    if (this.processing) {
      return { ready: false, reason: 'ACTIVE_TOOL_OR_DELIVERY', buildId }
    }
    if (this.pendingDelivery) {
      return { ready: false, reason: 'ACTIVE_DELIVERY_RECOVERY', buildId }
    }
    if (this.adapter.isGenerating(this.rootDocument)) {
      return { ready: false, reason: 'ASSISTANT_STREAMING', buildId }
    }
    if (this.clock.now() - this.lastComposerInputAt < ACTIVE_DRAFT_TYPING_GRACE_MS) {
      return { ready: false, reason: 'ACTIVE_DRAFT_INPUT', buildId }
    }
    if (enterDrain) {
      this.maintenanceDrainUntil = this.clock.now() + MAINTENANCE_DRAIN_WINDOW_MS
    }
    return { ready: true, buildId }
  }

  clearMaintenanceDrain(): void {
    this.maintenanceDrainUntil = 0
  }

  dispose(): void {
    this.activationEpoch += 1
    this.requestTrace.length = 0
    this.clearPendingDeliveryState()
    this.pendingMutationCheck = false
    this.maintenanceDrainUntil = 0
    this.stopObserving()
    this.rootDocument.removeEventListener?.('input', this.inputListener, true)
    this.pillEl?.remove()
    this.pillEl = null
    this.onDisposeCallback?.()
  }

  private markCurrentTurnsSeen(): void {
    const turns = this.adapter.readTurns(this.rootDocument)
    this.recordBaseline(turns)
  }

  private recordBaseline(turns: readonly ChatDomTurn[]): void {
    this.consumedStrongIds.clear()
    this.observedStrongUserIds.clear()
    this.consumedElements = new WeakSet<Element>()
    this.observedUserElements = new WeakSet<Element>()
    this.observedAnchorElements = []
    this.consumedAssistantCount = 0
    this.lastConsumedAssistantStrongKey = null
    this.hadAssistantTurnsInConversation = false

    let userCount = 0
    turns.forEach((turn, idx) => {
      const sk = getStrongKey(turn)
      if (turn.role === 'assistant' && turn.isComplete) {
        this.consumedAssistantCount += 1
        this.hadAssistantTurnsInConversation = true
        if (sk) {
          this.consumedStrongIds.add(sk)
          this.lastConsumedAssistantStrongKey = sk
        } else {
          this.lastConsumedAssistantStrongKey = null
        }
        if (turn.element) this.consumedElements.add(turn.element)
      } else if (turn.role === 'user') {
        userCount += 1
        if (sk) this.observedStrongUserIds.add(sk)
        if (turn.element) this.observedUserElements.add(turn.element)
      }
      if (turn.element && (turn.role !== 'assistant' || turn.isComplete)) {
        this.observedAnchorElements.push({ element: turn.element, index: idx, role: turn.role })
      }
    })
    this.seenUserCount = userCount
  }

  private snapshotAnchors(turns: readonly ChatDomTurn[]): void {
    const anchors: ObservedAnchor[] = []
    turns.forEach((turn, index) => {
      if (turn.element && (turn.role !== 'assistant' || turn.isComplete)) {
        anchors.push({ element: turn.element, index, role: turn.role })
      }
    })
    this.observedAnchorElements = anchors
  }

  private absorbAssistantTurnsUpTo(turns: readonly ChatDomTurn[], maxIndex: number): void {
    for (let i = 0; i <= maxIndex; i += 1) {
      const t = turns[i]
      if (!t || t.role !== 'assistant' || !t.isComplete) continue
      const sk = getStrongKey(t)
      if (sk) this.consumedStrongIds.add(sk)
      if (t.element) this.consumedElements.add(t.element)
    }
  }

  private failClosedAmbiguous(
    turns: readonly ChatDomTurn[],
    maxIndex: number,
    currentAssistantCount: number,
    candidate: ChatDomTurn,
    runEpoch: number,
    message: string
  ): void {
    this.lastDiagnostic = {
      code: 'TURN_IDENTITY_AMBIGUOUS',
      message,
      epoch: runEpoch,
      conversationKey: this.activeConversationKey,
      turnMessageId: candidate.messageId
    }
    this.lastErrorMessage = message
    this.absorbAssistantTurnsUpTo(turns, maxIndex)
    this.consumedAssistantCount = Math.max(this.consumedAssistantCount, currentAssistantCount)
    this.hadAssistantTurnsInConversation = true
    this.snapshotAnchors(turns)
  }

  private reconcileConversationSwitch(turns: readonly ChatDomTurn[]): 'HANDLED' | 'CONTINUE' {
    const currentKey = this.getConversationKey()
    if (this.activeConversationKey !== null && currentKey !== null && currentKey !== this.activeConversationKey) {
      const completeAssistantCount = turns.filter((t) => t.role === 'assistant' && t.isComplete).length
      const canPromoteNewChat =
        isEphemeralNewChatUrl(this.activeConversationKey) &&
        !this.hadAssistantTurnsInConversation &&
        this.consumedStrongIds.size === 0 &&
        this.consumedAssistantCount === 0 &&
        completeAssistantCount <= 1

      if (canPromoteNewChat) {
        this.activeConversationKey = currentKey
      } else {
        this.activationEpoch += 1
        this.requestTrace.length = 0
        this.clearPendingDeliveryState()
        this.activeConversationKey = currentKey
        this.session.startNewChat()
        this.recordBaseline(turns)
        this.awaitingPostSwitchHydration = turns.length === 0
        this.lastErrorMessage = null
        this.lastDelivery = null
        this.lastDiagnostic = {
          code: 'CONVERSATION_SWITCHED',
          phase: 'session',
          message: 'Switched conversation; established baseline for new conversation',
          epoch: this.activationEpoch,
          conversationKey: currentKey
        }
        return 'HANDLED'
      }
    }

    if (this.awaitingPostSwitchHydration && turns.length > 0) {
      this.awaitingPostSwitchHydration = false
      if (looksLikeHydratedHistory(turns)) {
        this.recordBaseline(turns)
        return 'HANDLED'
      }
    }

    return 'CONTINUE'
  }

  private syncUserTurnBoundary(turns: readonly ChatDomTurn[]): void {
    let lastKnownTurnIndex = -1
    turns.forEach((turn, idx) => {
      const sk = getStrongKey(turn)
      if (turn.role === 'assistant') {
        if ((sk !== null && this.consumedStrongIds.has(sk)) || (turn.element !== undefined && this.consumedElements.has(turn.element))) {
          if (idx > lastKnownTurnIndex) lastKnownTurnIndex = idx
        }
      } else if (turn.role === 'user') {
        if ((sk !== null && this.observedStrongUserIds.has(sk)) || (turn.element !== undefined && this.observedUserElements.has(turn.element))) {
          if (idx > lastKnownTurnIndex) lastKnownTurnIndex = idx
        }
      }
    })

    const userEntries = turns
      .map((turn, idx) => ({ turn, idx }))
      .filter((entry) => entry.turn.role === 'user')
    const newTrailingUserEntries = userEntries.filter(({ turn, idx }) => {
      const sk = getStrongKey(turn)
      const alreadyObserved =
        (sk !== null && this.observedStrongUserIds.has(sk)) ||
        (turn.element !== undefined && this.observedUserElements.has(turn.element))
      if (alreadyObserved) return false
      if (lastKnownTurnIndex >= 0) return idx > lastKnownTurnIndex
      return userEntries.length > this.seenUserCount
    })

    if (newTrailingUserEntries.length > 0) {
      const newest = newTrailingUserEntries[newTrailingUserEntries.length - 1].turn
      if (!RESULT_FENCE_RE.test(newest.text)) {
        this.userTurnObservedAfterExecution = true
        this.session.beginUserTurn()
        if (this.pendingDelivery && this.pendingDelivery.phase === 'PENDING_DISPATCH') {
          const cancelled = this.pendingDelivery
          this.clearPendingDeliveryState()
          this.lastDelivery = {
            ok: false,
            status: 'FAILED',
            reason: 'SUPERSEDED_BY_USER_TURN',
            requestIds: cancelled.requestIds,
            epoch: this.activationEpoch
          }
          this.lastErrorMessage = 'SUPERSEDED_BY_USER_TURN'
          this.lastDiagnostic = {
            code: 'SUPERSEDED_BY_USER_TURN',
            phase: 'delivery',
            ...(cancelled.requestIds[0] ? { requestId: cancelled.requestIds[0] } : {}),
            message: 'Pending tool result discarded because a newer user message was submitted.',
            epoch: this.activationEpoch,
            conversationKey: this.activeConversationKey,
            recoverable: false
          }
        } else if (this.pendingDelivery && this.pendingDelivery.phase === 'AWAITING_DELIVERY_ACK') {
          const unknown = this.pendingDelivery
          this.clearPendingDeliveryState()
          this.lastDelivery = {
            ok: false,
            status: 'DELIVERY_UNKNOWN',
            reason: 'DELIVERY_UNKNOWN',
            requestIds: unknown.requestIds,
            epoch: this.activationEpoch
          }
          this.lastErrorMessage = 'DELIVERY_UNKNOWN'
          this.lastDiagnostic = {
            code: 'DELIVERY_UNKNOWN',
            phase: 'delivery',
            ...(unknown.requestIds[0] ? { requestId: unknown.requestIds[0] } : {}),
            message: 'New user turn appeared before dispatched message could be confirmed in DOM.',
            epoch: this.activationEpoch,
            conversationKey: this.activeConversationKey,
            recoverable: false
          }
        }
      }
    }

    for (const { turn } of userEntries) {
      const sk = getStrongKey(turn)
      if (sk) this.observedStrongUserIds.add(sk)
      if (turn.element) this.observedUserElements.add(turn.element)
    }
    this.seenUserCount = userEntries.length
  }

  private ensureObserving(): void {
    if (this.stopObserver) return
    this.stopObserver = this.adapter.observeConversation(this.rootDocument, () => {
      void this.handleDomMutation()
    })
  }

  private stopObserving(): void {
    this.stopObserver?.()
    this.stopObserver = null
  }

  async handleDomMutation(): Promise<void> {
    if (this.processing) {
      this.pendingMutationCheck = true
      return
    }
    const initialState = this.session.getState()
    if (initialState !== 'READY' && initialState !== 'RESUMING' && initialState !== 'LOADING') {
      return
    }

    const startEpoch = this.activationEpoch
    const startConversationKey = this.getConversationKey()
    let cappedWithPending = false
    this.processing = true
    try {
      let iterations = 0
      do {
        this.pendingMutationCheck = false
        iterations += 1
        const state = this.session.getState()
        if (state !== 'READY' && state !== 'RESUMING' && state !== 'LOADING') {
          break
        }
        await this.processSingleDomPass()
      } while (this.pendingMutationCheck && iterations < MAX_DRAIN_ITERATIONS)
      cappedWithPending = this.pendingMutationCheck && iterations >= MAX_DRAIN_ITERATIONS
    } catch (err) {
      this.lastErrorMessage = err instanceof Error ? err.message : 'OBSERVER_PASS_ERROR'
      this.lastDiagnostic = {
        code: 'OBSERVER_PASS_ERROR',
        phase: 'observer',
        message: 'Unexpected error while processing conversation update',
        epoch: this.activationEpoch,
        conversationKey: this.getConversationKey(),
        recoverable: false
      }
    } finally {
      this.processing = false
      this.renderPill()
      if (
        cappedWithPending &&
        startEpoch === this.activationEpoch &&
        this.getConversationKey() === startConversationKey &&
        this.stopObserver !== null &&
        this.continuationTimer === null
      ) {
        this.continuationTimer = this.clock.setTimeout(() => {
          this.continuationTimer = null
          if (startEpoch === this.activationEpoch && this.getConversationKey() === startConversationKey) {
            void this.handleDomMutation()
          }
        }, 0)
      }
    }
  }

  private async processSingleDomPass(): Promise<void> {
    if (this.clock.now() < this.maintenanceDrainUntil) {
      return
    }
    if (!this.adapter.isAuthenticatedChatReady(this.rootDocument)) {
      return
    }
    const turns = this.adapter.readTurns(this.rootDocument)
    if (this.reconcileConversationSwitch(turns) === 'HANDLED') {
      return
    }
    this.confirmDeliveryFromTurns(turns)
    this.syncUserTurnBoundary(turns)

    if (this.pendingDelivery?.phase === 'PENDING_DISPATCH') {
      await this.attemptPendingDeliveryRecovery()
    }

    if (this.adapter.isGenerating(this.rootDocument)) {
      return
    }

    let lastConsumedAssistantIndex = -1
    turns.forEach((turn, idx) => {
      if (turn.role !== 'assistant') return
      const sk = getStrongKey(turn)
      const matchedById = sk !== null && this.consumedStrongIds.has(sk)
      const matchedByEl = turn.element !== undefined && this.consumedElements.has(turn.element)
      if (matchedById || matchedByEl) {
        if (matchedByEl && sk && !this.consumedStrongIds.has(sk)) {
          this.consumedStrongIds.add(sk)
        }
        lastConsumedAssistantIndex = idx
      }
    })

    let activeIdx = -1
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const t = turns[i]
      if (t.role === 'system') continue
      if (t.role === 'user') {
        if (t.text.trim().length > 0) {
          activeIdx = i
          break
        }
      } else if (t.text.trim().length > 0 || !t.isComplete) {
        activeIdx = i
        break
      }
    }

    if (activeIdx === -1) {
      this.snapshotAnchors(turns)
      return
    }

    const candidate = turns[activeIdx]
    if (candidate.role !== 'assistant') {
      const assistantCountBefore = turns.slice(0, activeIdx).filter((t) => t.role === 'assistant' && t.isComplete).length
      this.absorbAssistantTurnsUpTo(turns, activeIdx)
      if (assistantCountBefore > 0) {
        this.consumedAssistantCount = Math.max(this.consumedAssistantCount, assistantCountBefore)
        this.hadAssistantTurnsInConversation = true
      }
      this.snapshotAnchors(turns)
      return
    }

    if (!candidate.isComplete) {
      this.recordTrace('unidentified', 'TURN_INCOMPLETE')
      return
    }

    const candidateStrongKey = getStrongKey(candidate)
    const candidateAssistantOrdinal = turns.slice(0, activeIdx).filter((t) => t.role === 'assistant').length
    const currentAssistantCount = candidateAssistantOrdinal + 1
    const anchoredCount =
      lastConsumedAssistantIndex >= 0
        ? turns.slice(0, lastConsumedAssistantIndex + 1).filter((t) => t.role === 'assistant').length
        : 0
    const effectiveConsumedAssistantCount = Math.max(this.consumedAssistantCount, anchoredCount)
    const runEpoch = this.activationEpoch
    const runConversationKey = this.activeConversationKey
    const candidateCalls = parseActivationCallEnvelopes(candidate)
    for (const request of [...candidateCalls.calls, ...candidateCalls.rejected]) {
      this.recordTrace(request.requestId ?? 'invalid', 'CANDIDATE_SEEN')
    }

    if (
      (candidateStrongKey !== null && this.consumedStrongIds.has(candidateStrongKey)) ||
      (candidate.element !== undefined && this.consumedElements.has(candidate.element)) ||
      activeIdx <= lastConsumedAssistantIndex
    ) {
      this.absorbAssistantTurnsUpTo(turns, activeIdx)
      this.consumedAssistantCount = Math.max(effectiveConsumedAssistantCount, currentAssistantCount)
      this.snapshotAnchors(turns)
      return
    }

    if (candidate.identitySource === 'ambiguous') {
      for (const request of [...candidateCalls.calls, ...candidateCalls.rejected]) {
        this.recordTrace(request.requestId ?? 'invalid', 'TURN_IDENTITY_AMBIGUOUS')
      }
      this.failClosedAmbiguous(
        turns,
        activeIdx,
        currentAssistantCount,
        candidate,
        runEpoch,
        `Duplicate DOM identity "${candidate.messageId}" prevents safe turn correlation`
      )
      return
    }

    if (candidateStrongKey !== null) {
      if (this.consumedAssistantCount > 0 && lastConsumedAssistantIndex === -1) {
        if (
          (currentAssistantCount > this.consumedAssistantCount &&
            candidateAssistantOrdinal >= this.consumedAssistantCount &&
            turns.length >= 2) ||
          candidateAssistantOrdinal < this.consumedAssistantCount
        ) {
          this.failClosedAmbiguous(
            turns,
            activeIdx,
            currentAssistantCount,
            candidate,
            runEpoch,
            `Previously consumed turns disappeared from DOM before "${candidate.messageId}"`
          )
          return
        }
      }
      if (candidateAssistantOrdinal < effectiveConsumedAssistantCount) {
        const virtualScrollAnchored =
          this.lastConsumedAssistantStrongKey !== null &&
          lastConsumedAssistantIndex >= 0 &&
          getStrongKey(turns[lastConsumedAssistantIndex]) === this.lastConsumedAssistantStrongKey
        if (!virtualScrollAnchored) {
          this.failClosedAmbiguous(
            turns,
            activeIdx,
            currentAssistantCount,
            candidate,
            runEpoch,
            `Unordered turn position for "${candidate.messageId}" without contiguous anchor`
          )
          return
        }
      }
    } else {
      if (candidateAssistantOrdinal < effectiveConsumedAssistantCount) {
        this.absorbAssistantTurnsUpTo(turns, activeIdx)
        this.snapshotAnchors(turns)
        return
      }
      if (candidateAssistantOrdinal > effectiveConsumedAssistantCount) {
        this.failClosedAmbiguous(
          turns,
          activeIdx,
          currentAssistantCount,
          candidate,
          runEpoch,
          'Multiple unanchored assistant turns appeared simultaneously without strong DOM IDs'
        )
        return
      }
      if (this.consumedAssistantCount > 0 && lastConsumedAssistantIndex === -1) {
        this.failClosedAmbiguous(
          turns,
          activeIdx,
          currentAssistantCount,
          candidate,
          runEpoch,
          'Previously consumed unanchored assistant turn disappeared before new turn'
        )
        return
      }
      if (this.observedAnchorElements.length > 0) {
        const elementIndexMap = new Map<Element, number>()
        turns.forEach((turn, idx) => {
          if (turn.element) elementIndexMap.set(turn.element, idx)
        })
        const survivingAnchors = this.observedAnchorElements
          .map((anchor) => ({ anchor, currentIndex: elementIndexMap.get(anchor.element) }))
          .filter(
            (entry): entry is { anchor: ObservedAnchor; currentIndex: number } =>
              entry.currentIndex !== undefined && entry.currentIndex < activeIdx
          )
        if (survivingAnchors.length === 0) {
          this.failClosedAmbiguous(
            turns,
            activeIdx,
            currentAssistantCount,
            candidate,
            runEpoch,
            'No previously observed anchor element survived before unanchored assistant turn'
          )
          return
        }
        if (
          this.consumedAssistantCount === 0 &&
          survivingAnchors.some((entry) => entry.currentIndex > entry.anchor.index)
        ) {
          this.failClosedAmbiguous(
            turns,
            activeIdx,
            currentAssistantCount,
            candidate,
            runEpoch,
            'Observed anchor element shifted forward without a consumed assistant anchor'
          )
          return
        }
      }
    }

    this.absorbAssistantTurnsUpTo(turns, activeIdx)
    this.consumedAssistantCount = Math.max(effectiveConsumedAssistantCount, currentAssistantCount)
    this.hadAssistantTurnsInConversation = true
    this.lastConsumedAssistantStrongKey = candidateStrongKey
    this.snapshotAnchors(turns)

    const processed = await this.session.processAssistantTurn(candidate, (requestId, stage) => {
      if (runEpoch === this.activationEpoch && this.getConversationKey() === runConversationKey) {
        this.recordTrace(requestId, stage)
      }
    })
    if (runEpoch !== this.activationEpoch || this.getConversationKey() !== runConversationKey) {
      return
    }
    for (const call of processed.executedCalls) {
      if (call.errorCode === 'METHOD_NOT_ALLOWED' || call.errorCode === 'TOOL_NOT_ALLOWED') {
        this.recordTrace(call.requestId, 'OUT_OF_SCOPE')
      }
    }

    if (processed.shouldSendReply && processed.emulatedResponses.length > 0) {
      this.userTurnObservedAfterExecution = false
      const replyText = processed.emulatedResponses.join('\n\n')
      const requestIds = processed.executedCalls.map((c) => c.requestId)
      const failedCall = processed.executedCalls.find((c) => !c.ok)
      const binding = this.session.getBinding()
      const needsLiteralConsent = processed.executedCalls.some(
        (c) =>
          c.ok &&
          (LITERAL_EGRESS_METHODS.has(c.method) ||
            ((c.method === 'tools.call' || c.method === 'tools/call') &&
              (binding.mode === 'PROJECT' || Boolean(c.toolName && LITERAL_EGRESS_TOOLS.has(c.toolName)))))
      )

      const dispatchOutcome = await this.dispatchMessageAndTrack({
        kind: 'tool_result',
        replyText,
        requestIds,
        needsLiteralConsent,
        runEpoch,
        runConversationKey,
        turnMessageId: candidate.messageId,
        executionError: failedCall
          ? { requestId: failedCall.requestId, code: failedCall.errorCode ?? 'EXECUTION_ERROR' }
          : undefined
      })
      if (!dispatchOutcome.dispatched && runEpoch === this.activationEpoch && this.getConversationKey() === runConversationKey) {
        return
      }
    }
  }

  private clearPendingDeliveryState(): void {
    if (this.deliveryAckTimer !== null) {
      this.clock.clearTimeout(this.deliveryAckTimer)
      this.deliveryAckTimer = null
    }
    if (this.deliveryRecoveryExpiryTimer !== null) {
      this.clock.clearTimeout(this.deliveryRecoveryExpiryTimer)
      this.deliveryRecoveryExpiryTimer = null
    }
    if (this.continuationTimer !== null) {
      this.clock.clearTimeout(this.continuationTimer)
      this.continuationTimer = null
    }
    this.pendingDelivery = null
  }

  private canQuickDispatchFromDom(): boolean {
    if (typeof this.adapter.canDispatchNow === 'function') {
      return this.adapter.canDispatchNow(this.rootDocument)
    }
    return !this.adapter.isGenerating(this.rootDocument)
  }

  private captureBaselineUserTurns(turns: readonly ChatDomTurn[]) {
    const strongKeys = new Set<string>()
    const elements = new WeakSet<Element>()
    let count = 0
    for (const turn of turns) {
      if (turn.role !== 'user') continue
      count += 1
      const sk = getStrongKey(turn)
      if (sk) strongKeys.add(sk)
      if (turn.element) elements.add(turn.element)
    }
    return { count, strongKeys, elements }
  }

  private confirmDeliveryFromTurns(turns: readonly ChatDomTurn[]): boolean {
    const pending = this.pendingDelivery
    if (!pending || pending.phase !== 'AWAITING_DELIVERY_ACK') return false
    if (pending.epoch !== this.activationEpoch || pending.conversationKey !== this.getConversationKey()) {
      return false
    }

    const anchor = pending.assistantAnchor
    const assistantAnchorIndex = !anchor ? -1 : turns.findIndex((turn) =>
      turn.role === 'assistant' &&
      ((anchor.strongKey !== null && getStrongKey(turn) === anchor.strongKey) ||
        (anchor.element !== undefined && turn.element === anchor.element))
    )
    let userOrdinal = 0
    for (const [turnIndex, turn] of turns.entries()) {
      if (turn.role !== 'user') continue
      const idx = userOrdinal
      userOrdinal += 1
      const sk = getStrongKey(turn)
      const isBaseline =
        turn.identitySource === 'ambiguous' ||
        (sk !== null && pending.baselineUserStrongKeys.has(sk)) ||
        (turn.element !== undefined && pending.baselineUserElements.has(turn.element)) ||
        (assistantAnchorIndex >= 0 ? turnIndex <= assistantAnchorIndex : idx < pending.baselineUserCount)
      if (isBaseline) continue

      let matched = false
      if (pending.kind === 'bootstrap') {
        matched =
          !RESULT_FENCE_RE.test(turn.text) &&
          turn.text.includes('[Code Awareness Local Context')
      } else {
        const foundEnvelopes = extractActivationResultEnvelopes(turn.text, this.adapter.site === 'deepseek')
        matched =
          pending.expectedEnvelopes.size > 0 &&
          Array.from(pending.expectedEnvelopes.entries()).every(([reqId, expectedJson]) =>
            foundEnvelopes.some((env) => env.requestId === reqId && env.normalizedJson === expectedJson)
          )
      }

      if (matched) {
        if (sk) this.observedStrongUserIds.add(sk)
        if (turn.element) this.observedUserElements.add(turn.element)
        this.seenUserCount = Math.max(this.seenUserCount, userOrdinal)

        const { requestIds, epoch } = pending
        for (const requestId of requestIds) this.recordTrace(requestId, 'CHAT_DELIVERED')
        this.clearPendingDeliveryState()
        this.lastDelivery = {
          ok: true,
          status: 'DELIVERED',
          requestIds,
          epoch
        }
        this.lastErrorMessage = null
        if (this.lastDiagnostic?.phase === 'delivery' || this.lastDiagnostic?.code === 'CONVERSATION_SWITCHED') {
          this.lastDiagnostic = null
        }
        this.renderPill()
        return true
      }
    }
    return false
  }

  private async dispatchMessageAndTrack(params: {
    kind: 'tool_result' | 'bootstrap'
    replyText: string
    requestIds: string[]
    needsLiteralConsent: boolean
    runEpoch: number
    runConversationKey: string | null
    turnMessageId?: string
    executionError?: { requestId: string; code: string }
    existingPending?: PendingDeliveryRecord
  }): Promise<{ dispatched: boolean; reason?: string }> {
    const beforeDispatch = this.adapter.readTurns(this.rootDocument)
    const baseline = this.captureBaselineUserTurns(beforeDispatch)
    const assistant = beforeDispatch.find((turn) => turn.role === 'assistant' && turn.messageId === params.turnMessageId)
    const assistantAnchor = params.existingPending?.assistantAnchor ?? (assistant
      ? { strongKey: getStrongKey(assistant), element: assistant.element }
      : undefined)
    let sent: Awaited<ReturnType<WebChatAdapter['sendMessage']>>
    try {
      this.programmaticComposerWrite = true
      sent = await this.adapter.sendMessage(
        this.rootDocument,
        params.replyText,
        () =>
          params.runEpoch === this.activationEpoch &&
          this.getConversationKey() === params.runConversationKey &&
          !this.userTurnObservedAfterExecution &&
          (!params.existingPending || ['READY', 'RESUMING', 'LOADING'].includes(this.session.getState()))
      )
    } catch (err) {
      sent = {
        ok: false,
        status: 'DISPATCH_ABORTED',
        reason: err instanceof Error ? err.message : 'SEND_THREW'
      }
    } finally {
      this.programmaticComposerWrite = false
    }

    if (params.runEpoch !== this.activationEpoch || this.getConversationKey() !== params.runConversationKey) {
      this.clearPendingDeliveryState()
      return { dispatched: false, reason: 'CONTEXT_CHANGED_DURING_DISPATCH' }
    }

    const nowMs = this.clock.now()
    const firstAttemptAt = params.existingPending?.firstAttemptAt ?? nowMs
    const expiresAt = params.existingPending?.expiresAt ?? firstAttemptAt + this.deliveryRecoveryTtlMs

    if (!sent.ok) {
      for (const requestId of params.requestIds) this.recordTrace(requestId, 'CHAT_BLOCKED')
      const reason = sent.reason ?? 'SEND_FAILED'
      if (sent.status === 'PRE_DISPATCH_BLOCKED' && nowMs < expiresAt) {
        const expectedEnvelopes =
          params.existingPending?.expectedEnvelopes ??
          new Map(extractActivationResultEnvelopes(params.replyText).map((e) => [e.requestId, e.normalizedJson]))
        const binding = this.session.getBinding()

        const nextPending: PendingDeliveryRecord = {
          kind: params.kind,
          replyText: params.replyText,
          requestIds: params.requestIds,
          expectedEnvelopes,
          needsLiteralConsent: params.needsLiteralConsent,
          epoch: params.runEpoch,
          conversationKey: params.runConversationKey,
          turnMessageId: params.turnMessageId,
          assistantAnchor,
          bindingSnapshot: params.existingPending?.bindingSnapshot ?? { ...binding },
          baselineUserCount: baseline.count,
          baselineUserStrongKeys: baseline.strongKeys,
          baselineUserElements: baseline.elements,
          firstAttemptAt,
          expiresAt,
          phase: 'PENDING_DISPATCH',
          lastReason: reason,
          inFlight: false
        }
        this.pendingDelivery = nextPending
        if (this.deliveryRecoveryExpiryTimer === null) {
          this.deliveryRecoveryExpiryTimer = this.clock.setTimeout(() => {
            this.deliveryRecoveryExpiryTimer = null
            const active = this.pendingDelivery
            if (
              !active ||
              active.phase !== 'PENDING_DISPATCH' ||
              active.epoch !== this.activationEpoch ||
              active.conversationKey !== this.getConversationKey()
            ) {
              return
            }
            const reqIds = active.requestIds
            this.clearPendingDeliveryState()
            this.lastDelivery = {
              ok: false,
              status: 'FAILED',
              reason: 'DELIVERY_RECOVERY_EXPIRED',
              requestIds: reqIds,
              epoch: this.activationEpoch
            }
            this.lastErrorMessage = 'DELIVERY_RECOVERY_EXPIRED'
            this.lastDiagnostic = {
              code: 'DELIVERY_RECOVERY_EXPIRED',
              phase: 'delivery',
              ...(reqIds[0] ? { requestId: reqIds[0] } : {}),
              message: `Pre-dispatch send block (${active.lastReason}) did not clear within 60s; result was not sent.`,
              epoch: this.activationEpoch,
              conversationKey: this.getConversationKey(),
              turnMessageId: active.turnMessageId,
              recoverable: false
            }
            this.renderPill()
          }, Math.max(1, expiresAt - nowMs))
        }

        this.lastDelivery = {
          ok: false,
          status: 'PENDING_RECOVERY',
          reason,
          requestIds: params.requestIds,
          epoch: params.runEpoch
        }
        this.lastErrorMessage = reason
        this.lastDiagnostic = {
          code: reason,
          phase: 'delivery',
          ...(params.requestIds[0] ? { requestId: params.requestIds[0] } : {}),
          message: `Waiting safely to send reply (${reason})`,
          epoch: params.runEpoch,
          conversationKey: params.runConversationKey,
          turnMessageId: params.turnMessageId,
          recoverable: true
        }
        this.renderPill()
        return { dispatched: false, reason }
      }

      this.clearPendingDeliveryState()
      this.lastDelivery = {
        ok: false,
        status: 'FAILED',
        reason,
        requestIds: params.requestIds,
        epoch: params.runEpoch
      }
      this.lastErrorMessage = reason
      this.lastDiagnostic = {
        code: reason,
        phase: 'delivery',
        ...(params.requestIds[0] ? { requestId: params.requestIds[0] } : {}),
        message: `Failed to send activation reply: ${reason}`,
        epoch: params.runEpoch,
        conversationKey: params.runConversationKey,
        turnMessageId: params.turnMessageId,
        recoverable: false
      }
      this.renderPill()
      return { dispatched: false, reason }
    }

    // Sent / clicked cleanly: switch to AWAITING_DELIVERY_ACK until DOM confirmation or 10s expiry
    const expectedEnvelopes =
      params.existingPending?.expectedEnvelopes ??
      new Map(extractActivationResultEnvelopes(params.replyText).map((e) => [e.requestId, e.normalizedJson]))

    if (this.deliveryRecoveryExpiryTimer !== null) {
      this.clock.clearTimeout(this.deliveryRecoveryExpiryTimer)
      this.deliveryRecoveryExpiryTimer = null
    }
    if (this.deliveryAckTimer !== null) {
      this.clock.clearTimeout(this.deliveryAckTimer)
      this.deliveryAckTimer = null
    }

    const ackRecord: PendingDeliveryRecord = {
      kind: params.kind,
      replyText: params.replyText,
      requestIds: params.requestIds,
      expectedEnvelopes,
      needsLiteralConsent: params.needsLiteralConsent,
      epoch: params.runEpoch,
      conversationKey: params.runConversationKey,
      turnMessageId: params.turnMessageId,
      assistantAnchor,
      bindingSnapshot: params.existingPending?.bindingSnapshot ?? { ...this.session.getBinding() },
      baselineUserCount: baseline.count,
      baselineUserStrongKeys: baseline.strongKeys,
      baselineUserElements: baseline.elements,
      firstAttemptAt,
      expiresAt,
      phase: 'AWAITING_DELIVERY_ACK',
      lastReason: 'DISPATCHED',
      inFlight: false
    }
    this.pendingDelivery = ackRecord
    for (const requestId of params.requestIds) this.recordTrace(requestId, 'CHAT_DISPATCH_ATTEMPTED')

    if (params.executionError) {
      this.lastDiagnostic = {
        code: params.executionError.code,
        phase: 'execution',
        requestId: params.executionError.requestId,
        message: `Execution reported ${params.executionError.code} for ${params.executionError.requestId}`,
        epoch: params.runEpoch,
        conversationKey: params.runConversationKey,
        turnMessageId: params.turnMessageId,
        recoverable: false
      }
    }

    // Immediate DOM check (handles synchronous test DOM append on sendBtn.click)
    if (this.confirmDeliveryFromTurns(this.adapter.readTurns(this.rootDocument))) {
      return { dispatched: true }
    }

    this.lastDelivery = {
      ok: false,
      status: 'AWAITING_DELIVERY_ACK',
      requestIds: params.requestIds,
      epoch: params.runEpoch
    }
    this.deliveryAckTimer = this.clock.setTimeout(() => {
      this.deliveryAckTimer = null
      const active = this.pendingDelivery
      if (
        !active ||
        active.phase !== 'AWAITING_DELIVERY_ACK' ||
        active.epoch !== this.activationEpoch ||
        active.conversationKey !== this.getConversationKey()
      ) {
        return
      }
      const reqIds = active.requestIds
      for (const requestId of reqIds) this.recordTrace(requestId, 'CHAT_UNKNOWN')
      this.clearPendingDeliveryState()
      this.lastDelivery = {
        ok: false,
        status: 'DELIVERY_UNKNOWN',
        reason: 'DELIVERY_UNKNOWN',
        requestIds: reqIds,
        epoch: this.activationEpoch
      }
      this.lastErrorMessage = 'DELIVERY_UNKNOWN'
      this.lastDiagnostic = {
        code: 'DELIVERY_UNKNOWN',
        phase: 'delivery',
        ...(reqIds[0] ? { requestId: reqIds[0] } : {}),
        message: 'Message dispatched to chat, but DOM delivery confirmation timed out (do not auto-resend).',
        epoch: this.activationEpoch,
        conversationKey: this.getConversationKey(),
        turnMessageId: active.turnMessageId,
        recoverable: false
      }
      this.renderPill()
    }, this.deliveryAckTimeoutMs)

    this.renderPill()
    return { dispatched: true }
  }

  private async attemptPendingDeliveryRecovery(): Promise<void> {
    const pending = this.pendingDelivery
    if (!pending || pending.phase !== 'PENDING_DISPATCH' || pending.inFlight) return

    if (
      pending.epoch !== this.activationEpoch ||
      pending.conversationKey !== this.getConversationKey() ||
      this.userTurnObservedAfterExecution ||
      !['READY', 'RESUMING', 'LOADING'].includes(this.session.getState())
    ) {
      this.clearPendingDeliveryState()
      return
    }

    if (this.clock.now() >= pending.expiresAt) {
      const reqIds = pending.requestIds
      this.clearPendingDeliveryState()
      this.lastDelivery = {
        ok: false,
        status: 'FAILED',
        reason: 'DELIVERY_RECOVERY_EXPIRED',
        requestIds: reqIds,
        epoch: this.activationEpoch
      }
      this.lastErrorMessage = 'DELIVERY_RECOVERY_EXPIRED'
      this.lastDiagnostic = {
        code: 'DELIVERY_RECOVERY_EXPIRED',
        phase: 'delivery',
        ...(reqIds[0] ? { requestId: reqIds[0] } : {}),
        message: 'Pending send expired after 60s.',
        epoch: this.activationEpoch,
        conversationKey: this.getConversationKey(),
        turnMessageId: pending.turnMessageId,
        recoverable: false
      }
      this.renderPill()
      return
    }

    if (!this.canQuickDispatchFromDom()) {
      return
    }

    pending.inFlight = true
    try {
      const freshStatus = await this.transport.getStatus()
      if (
        this.pendingDelivery !== pending ||
        pending.epoch !== this.activationEpoch ||
        pending.conversationKey !== this.getConversationKey() ||
        this.userTurnObservedAfterExecution ||
        !['READY', 'RESUMING', 'LOADING'].includes(this.session.getState())
      ) {
        if (this.pendingDelivery === pending) this.clearPendingDeliveryState()
        return
      }

      if (!freshStatus.available) {
        this.clearPendingDeliveryState()
        this.lastDelivery = {
          ok: false,
          status: 'FAILED',
          reason: freshStatus.errorCode ?? 'APP_UNAVAILABLE',
          requestIds: pending.requestIds,
          epoch: pending.epoch
        }
        this.lastErrorMessage = freshStatus.errorCode ?? 'APP_UNAVAILABLE'
        this.renderPill()
        return
      }

      const bindingChanged =
        (freshStatus.projectId ?? null) !== pending.bindingSnapshot.projectId ||
        (freshStatus.bindingId ?? null) !== pending.bindingSnapshot.bindingId ||
        (freshStatus.instanceId ?? null) !== pending.bindingSnapshot.instanceId

      if (bindingChanged) {
        this.clearPendingDeliveryState()
        this.session.invalidate()
        this.lastDelivery = {
          ok: false,
          status: 'FAILED',
          reason: 'SESSION_INVALIDATED',
          requestIds: pending.requestIds,
          epoch: pending.epoch
        }
        this.lastErrorMessage = 'SESSION_INVALIDATED'
        this.lastDiagnostic = {
          code: 'SESSION_INVALIDATED',
          phase: 'session',
          ...(pending.requestIds[0] ? { requestId: pending.requestIds[0] } : {}),
          message: 'Desktop project or session binding changed before pending delivery; discarded safely.',
          epoch: pending.epoch,
          conversationKey: pending.conversationKey,
          recoverable: false
        }
        this.renderPill()
        return
      }

      if (
        freshStatus.consents &&
        (!freshStatus.consents.metadata || (pending.needsLiteralConsent && !freshStatus.consents.literalSource))
      ) {
        this.clearPendingDeliveryState()
        this.session.revoke()
        this.lastDelivery = {
          ok: false,
          status: 'FAILED',
          reason: 'CONSENT_REQUIRED',
          requestIds: pending.requestIds,
          epoch: pending.epoch
        }
        this.lastErrorMessage = 'CONSENT_REQUIRED'
        this.renderPill()
        return
      }

      await this.dispatchMessageAndTrack({
        kind: pending.kind,
        replyText: pending.replyText,
        requestIds: pending.requestIds,
        needsLiteralConsent: pending.needsLiteralConsent,
        runEpoch: pending.epoch,
        runConversationKey: pending.conversationKey,
        turnMessageId: pending.turnMessageId,
        existingPending: pending
      })
    } finally {
      pending.inFlight = false
    }
  }

  private renderPill(): void {
    if (!this.mountUi) return
    const body = this.rootDocument.body
    if (!body) return

    if (!this.pillEl) {
      const el = this.rootDocument.createElement('div')
      el.id = 'code-awareness-activation-pill'
      el.setAttribute(
        'style',
        [
          'position:fixed',
          'bottom:16px',
          'right:16px',
          'z-index:2147483000',
          'display:flex',
          'align-items:center',
          'gap:8px',
          'padding:6px 10px',
          'border-radius:9999px',
          'background:#111827',
          'color:#f9fafb',
          'border:1px solid #374151',
          'font:12px/1.2 system-ui,-apple-system,sans-serif',
          'box-shadow:0 4px 12px rgba(0,0,0,0.35)'
        ].join(';')
      )
      body.appendChild(el)
      this.pillEl = el
    }

    const state = this.session.getState()
    const binding = this.session.getBinding()
    this.pillEl.setAttribute('data-ca-state', state)
    this.pillEl.setAttribute('data-ca-site', this.adapter.site)

    const scopeTag = binding.mode === 'PROJECT' && binding.projectId ? `Project` : 'Global'
    const label = this.rootDocument.createElement('span')
    let statusSuffix = ''
    if (state === 'READY' || state === 'RESUMING' || state === 'WAITING_TOOL') {
      if (this.lastDelivery?.status === 'PENDING_RECOVERY') {
        statusSuffix = ' · Pending send'
      } else if (this.lastDelivery?.status === 'AWAITING_DELIVERY_ACK') {
        statusSuffix = ' · Confirming send'
      } else if (this.lastDelivery?.status === 'DELIVERY_UNKNOWN') {
        statusSuffix = ' · Delivery unconfirmed'
      } else if (this.lastDelivery?.status === 'FAILED') {
        statusSuffix = ` · Send failed`
      } else if (this.lastDiagnostic?.phase === 'execution' || this.lastDiagnostic?.phase === 'parse') {
        statusSuffix = ` · ${this.lastDiagnostic.code}`
      }
    }
    label.textContent = `Code Awareness · ${state}${state === 'READY' || state === 'RESUMING' ? ` (${scopeTag})` : ''}${statusSuffix}`
    if (this.lastDiagnostic) {
      const reqInfo = this.lastDiagnostic.requestId ? ` [${this.lastDiagnostic.requestId}]` : ''
      const phaseInfo = this.lastDiagnostic.phase ? `${this.lastDiagnostic.phase}: ` : ''
      label.title = `${phaseInfo}${this.lastDiagnostic.code}${reqInfo} — ${this.lastDiagnostic.message}`
    } else {
      label.title = ''
    }
    const trace = this.getStatusSnapshot().requestTrace
    if (trace.length) {
      label.title = [label.title, ...trace.map(({ requestId, stage }) => `${requestId} ${stage}`)].filter(Boolean).join('\n')
    }

    const btn = this.rootDocument.createElement('button')
    btn.type = 'button'
    btn.setAttribute(
      'style',
      'border:0;border-radius:9999px;padding:3px 8px;background:#2563eb;color:#fff;cursor:pointer;font-size:11px;'
    )
    if (state === 'INACTIVE' || state === 'REVOKED' || state === 'UNAVAILABLE') {
      btn.textContent = 'Activate'
      btn.addEventListener('click', () => {
        void this.activate(true)
      })
    } else {
      btn.textContent = 'Revoke'
      btn.setAttribute(
        'style',
        'border:0;border-radius:9999px;padding:3px 8px;background:#dc2626;color:#fff;cursor:pointer;font-size:11px;'
      )
      btn.addEventListener('click', () => {
        this.revoke()
      })
    }

    this.pillEl.replaceChildren(label, btn)
  }
}

export function bootstrapContentScript(
  chromeApi: ChromeApi | undefined = getChromeApi(),
  doc: Document | undefined = (globalThis as unknown as { document?: Document }).document,
  href: string | undefined = (globalThis as unknown as { location?: { href?: string } }).location?.href
): ContentSessionController | null {
  if (!chromeApi || !doc || !href) return null
  const adapter = selectWebChatAdapter(href)
  if (!adapter) return null

  const globalRegistry = globalThis as unknown as Record<string, ContentSessionController | undefined>
  if (globalRegistry[GLOBAL_CONTENT_CONTROLLER_KEY]) {
    try {
      globalRegistry[GLOBAL_CONTENT_CONTROLLER_KEY]!.dispose()
    } catch {
      // Ignore cleanup failures from stale isolated world controllers
    }
  }

  const controller = new ContentSessionController(
    adapter,
    doc,
    createRuntimeMessageTransport(chromeApi, adapter.site, adapter.allowedOrigin),
    true
  )
  globalRegistry[GLOBAL_CONTENT_CONTROLLER_KEY] = controller

  const listener: ChromeMessageListener = (rawMessage, _sender, sendResponse) => {
    const msg = rawMessage as { type?: string; sendBootstrap?: boolean } | undefined
    if (!msg?.type) return false

    if (msg.type === 'CONTENT_GET_STATE') {
      sendResponse({ ok: true, ...controller.getStatusSnapshot() })
      return false
    }
    if (msg.type === 'CONTENT_ACTIVATE') {
      void controller.activate(msg.sendBootstrap !== false).then(sendResponse)
      return true
    }
    if (msg.type === 'CONTENT_NEW_CHAT') {
      controller.startNewChat()
      sendResponse({ ok: true, ...controller.getStatusSnapshot() })
      return false
    }
    if (msg.type === 'CONTENT_REVOKE') {
      controller.revoke()
      sendResponse({ ok: true, ...controller.getStatusSnapshot() })
      return false
    }
    if (msg.type === 'CONTENT_PREPARE_MAINTENANCE') {
      sendResponse({ ok: true, ...controller.checkMaintenanceReadiness(true) })
      return false
    }
    if (msg.type === 'CONTENT_ABORT_MAINTENANCE') {
      controller.clearMaintenanceDrain()
      sendResponse({ ok: true })
      return false
    }
    return false
  }

  chromeApi.runtime?.onMessage?.addListener(listener)
  controller.setOnDispose(() => {
    chromeApi.runtime?.onMessage?.removeListener?.(listener)
    if (globalRegistry[GLOBAL_CONTENT_CONTROLLER_KEY] === controller) {
      delete globalRegistry[GLOBAL_CONTENT_CONTROLLER_KEY]
    }
  })

  return controller
}

bootstrapContentScript()
