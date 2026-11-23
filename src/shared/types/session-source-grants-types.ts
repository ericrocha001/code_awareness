export type ProviderGrantState = 'READY' | 'MISSING' | 'UNAVAILABLE' | 'INVALID' | 'REVOKED'

export interface CodexAccountCandidate {
  accountHash: string
  label: string
}

export interface ProviderGrantSummary {
  provider: 'antigravityApp' | 'codex'
  state: ProviderGrantState
  eligible: boolean
  allowLexicalIndex: boolean
  reasonCode?: string
  accountSelectionRequired?: boolean
  accountCandidates?: CodexAccountCandidate[]
}

export interface SessionSourceGrantsStatus {
  repositoryId: string
  readOnly: boolean
  dismissed: boolean
  allowLexicalIndex: boolean
  providers: {
    antigravityApp: ProviderGrantSummary
    codex: ProviderGrantSummary
  }
  needsOnboarding: boolean
  partialSuccess?: boolean
}

export interface SessionSourceGrantsApi {
  status: (repositoryId: string, worktreeRoot?: string) => Promise<SessionSourceGrantsStatus>
  enable: (input: {
    repositoryId: string
    worktreeRoot?: string
    allowLexicalIndex?: boolean
    selectedCodexAccountHash?: string
  }) => Promise<SessionSourceGrantsStatus>
  revoke: (input: {
    repositoryId: string
    provider?: 'antigravityApp' | 'codex' | 'all'
    worktreeRoot?: string
  }) => Promise<SessionSourceGrantsStatus>
  setLexicalIndex: (input: {
    repositoryId: string
    allowLexicalIndex: boolean
    worktreeRoot?: string
  }) => Promise<SessionSourceGrantsStatus>
  dismiss: (input: { repositoryId: string; worktreeRoot?: string }) => Promise<SessionSourceGrantsStatus>
}
