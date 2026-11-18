import {
  ActivationSession,
  type ActivationSessionState,
  type WebActivationTransport
} from '../shared/web-activation/activation-session'
import { getChromeApi, type ChromeApi } from './chrome-api'
import type { ChatDomTurn, WebChatAdapter } from './adapters/adapter-interface'
import { DeepSeekWebAdapter } from './adapters/deepseek-adapter'
import { QwenWebAdapter } from './adapters/qwen-adapter'

export interface ControllerDiagnostic {
  code: string
  message: string
  epoch: number
  conversationKey: string | null
  turnMessageId?: string
}

export interface LastDeliveryStatus {
  ok: boolean
  reason?: string
  requestIds: string[]
  epoch: number
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

export function createRuntimeMessageTransport(
  chromeApi: ChromeApi,
  site: 'deepseek' | 'qwen',
  webOrigin: string
): WebActivationTransport {
  const sendRuntimeMessage = <T>(payload: Record<string, unknown>): Promise<T> =>
    new Promise((resolve) => {
      if (!chromeApi.runtime?.sendMessage) {
        resolve({
          ok: false,
          error: { code: 'APP_UNAVAILABLE', message: 'chrome.runtime.sendMessage unavailable' }
        } as T)
        return
      }
      chromeApi.runtime.sendMessage(payload, (response) => {
        if (chromeApi.runtime?.lastError) {
          resolve({
            ok: false,
            error: {
              code: 'APP_UNAVAILABLE',
              message: chromeApi.runtime.lastError.message ?? 'Extension background disconnected'
            }
          } as T)
          return
        }
        resolve((response ?? { ok: false, error: { code: 'APP_UNAVAILABLE', message: 'Empty bridge response' } }) as T)
      })
    })

  return {
    async getStatus() {
      const res = await sendRuntimeMessage<{
        ok?: boolean
        result?: {
          available?: boolean
          mode?: 'PROJECT' | 'GLOBAL_ONLY'
          projectId?: string | null
          instanceId?: string | null
          bindingId?: string | null
          catalogRevision?: string | null
          errorCode?: string
        }
        error?: { code?: string }
      }>({ type: 'GET_STATUS', site, webOrigin })

      if (!res?.ok || !res.result?.available) {
        return {
          available: false,
          errorCode: res?.error?.code ?? res?.result?.errorCode ?? 'APP_UNAVAILABLE'
        }
      }

      return {
        available: true,
        mode: res.result.mode ?? (res.result.projectId ? 'PROJECT' : 'GLOBAL_ONLY'),
        projectId: res.result.projectId ?? null,
        instanceId: res.result.instanceId ?? null,
        bindingId: res.result.bindingId ?? null,
        ...(res.result.catalogRevision ? { catalogRevision: res.result.catalogRevision } : {})
      }
    },

    async mcpRequest(input) {
      const res = await sendRuntimeMessage<{
        ok?: boolean
        result?: {
          mcp?: { result?: unknown; error?: { code?: number; message?: string } }
        }
        error?: { code: string; message: string; details?: Record<string, unknown> }
      }>({
        type: 'MCP_REQUEST',
        site,
        webOrigin,
        method: input.method,
        params: input.params ?? {},
        expectedProjectId: input.expectedProjectId,
        expectedBindingId: input.expectedBindingId,
        expectedInstanceId: input.expectedInstanceId
      })

      if (!res?.ok) {
        return {
          ok: false,
          error: res?.error ?? { code: 'APP_UNAVAILABLE', message: 'MCP request failed' }
        }
      }

      return {
        ok: true,
        mcp: res.result?.mcp
      }
    }
  }
}

export class ContentSessionController {
  readonly session: ActivationSession
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
  private lastDelivery: LastDeliveryStatus | null = null
  private processing = false
  private pendingMutationCheck = false
  private pillEl: HTMLElement | null = null

  constructor(
    readonly adapter: WebChatAdapter,
    readonly rootDocument: Document,
    transport: WebActivationTransport,
    private readonly mountUi = true
  ) {
    this.session = new ActivationSession({
      site: adapter.site,
      transport
    })
    if (this.mountUi) {
      this.renderPill()
    }
  }

  getStatusSnapshot(): {
    site: string
    state: ActivationSessionState
    binding: ReturnType<ActivationSession['getBinding']>
    authenticated: boolean
    lastError: string | null
    lastDiagnostic: ControllerDiagnostic | null
    lastDelivery: LastDeliveryStatus | null
  } {
    return {
      site: this.adapter.site,
      state: this.session.getState(),
      binding: this.session.getBinding(),
      authenticated: this.adapter.isAuthenticatedChatReady(this.rootDocument),
      lastError: this.lastErrorMessage,
      lastDiagnostic: this.lastDiagnostic,
      lastDelivery: this.lastDelivery
    }
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
    this.awaitingPostSwitchHydration = false
    this.pendingMutationCheck = false
    this.activeConversationKey = this.getConversationKey()
    this.markCurrentTurnsSeen()
    this.ensureObserving()

    if (sendBootstrap) {
      const sent = await this.adapter.sendMessage(this.rootDocument, res.bootstrapPrompt)
      if (!sent.ok) {
        const reason = sent.reason ?? 'SEND_FAILED'
        this.lastErrorMessage = reason
        this.lastDelivery = {
          ok: false,
          reason,
          requestIds: [],
          epoch: this.activationEpoch
        }
        this.lastDiagnostic = {
          code: reason,
          message: `Failed to inject bootstrap prompt: ${reason}`,
          epoch: this.activationEpoch,
          conversationKey: this.activeConversationKey
        }
        this.renderPill()
        return {
          ok: false,
          state: this.session.getState(),
          bootstrapPrompt: res.bootstrapPrompt,
          error: { code: reason, message: 'Failed to inject bootstrap prompt' }
        }
      }
      this.lastDelivery = {
        ok: true,
        requestIds: [],
        epoch: this.activationEpoch
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
    this.pendingMutationCheck = false
    this.lastErrorMessage = 'Consent revoked for this chat session'
    this.session.revoke()
    this.stopObserving()
    this.renderPill()
  }

  dispose(): void {
    this.activationEpoch += 1
    this.pendingMutationCheck = false
    this.stopObserving()
    this.pillEl?.remove()
    this.pillEl = null
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
        this.activeConversationKey = currentKey
        this.session.startNewChat()
        this.recordBaseline(turns)
        this.awaitingPostSwitchHydration = turns.length === 0
        this.lastErrorMessage = null
        this.lastDiagnostic = {
          code: 'CONVERSATION_SWITCHED',
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
        this.session.beginUserTurn()
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
    } finally {
      this.processing = false
      this.renderPill()
    }
  }

  private async processSingleDomPass(): Promise<void> {
    if (!this.adapter.isAuthenticatedChatReady(this.rootDocument)) {
      return
    }
    const turns = this.adapter.readTurns(this.rootDocument)
    if (this.reconcileConversationSwitch(turns) === 'HANDLED') {
      return
    }
    this.syncUserTurnBoundary(turns)

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

    const processed = await this.session.processAssistantTurn(candidate)
    if (runEpoch !== this.activationEpoch || this.getConversationKey() !== runConversationKey) {
      return
    }

    if (processed.shouldSendReply && processed.emulatedResponses.length > 0) {
      const replyText = processed.emulatedResponses.join('\n\n')
      const requestIds = processed.executedCalls.map((c) => c.requestId)
      const sent = await this.adapter.sendMessage(this.rootDocument, replyText)
      if (runEpoch !== this.activationEpoch || this.getConversationKey() !== runConversationKey) {
        return
      }
      this.lastDelivery = {
        ok: sent.ok,
        ...(sent.reason ? { reason: sent.reason } : {}),
        requestIds,
        epoch: runEpoch
      }
      if (!sent.ok) {
        const reason = sent.reason ?? 'SEND_FAILED'
        this.lastErrorMessage = reason
        this.lastDiagnostic = {
          code: reason,
          message: `Failed to send activation reply: ${reason}`,
          epoch: runEpoch,
          conversationKey: runConversationKey,
          turnMessageId: candidate.messageId
        }
      } else {
        this.lastErrorMessage = null
      }
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
    label.textContent = `Code Awareness · ${state}${state === 'READY' || state === 'RESUMING' ? ` (${scopeTag})` : ''}`

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

  const controller = new ContentSessionController(
    adapter,
    doc,
    createRuntimeMessageTransport(chromeApi, adapter.site, adapter.allowedOrigin),
    true
  )

  chromeApi.runtime?.onMessage?.addListener((rawMessage, _sender, sendResponse) => {
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
    return false
  })

  return controller
}

bootstrapContentScript()
