export type CodexArchiveState = 'NOT_CONFIGURED' | 'UNAUTHORIZED' | 'EXECUTABLE_UNAVAILABLE' | 'PROTOCOL_UNSUPPORTED' | 'ACCOUNT_IDENTITY_UNAVAILABLE' | 'PROVIDER_UNREACHABLE' | 'CONNECTING' | 'READY'
export interface CodexArchiveDiscovery {
  state: 'ONE_VERIFIED_CANDIDATE' | 'AMBIGUOUS' | 'NOT_FOUND' | 'INVALID'
  reason?: 'PROFILE_MISSING' | 'UNSAFE_CANDIDATE' | 'CANDIDATE_CHANGED' | 'CANCELED'
  candidates: { id: string; executable: string; profile: string }[]
  selectedId?: string
}
export interface CodexArchiveReadiness { state: CodexArchiveState; version?: string; discovery?: CodexArchiveDiscovery }
export interface CodexArchiveApi {
  onChanged(callback: (readiness: CodexArchiveReadiness) => void): () => void
  inspect(): Promise<CodexArchiveReadiness>
  enable(): Promise<CodexArchiveReadiness>
  disable(): Promise<CodexArchiveReadiness>
  select(candidateId: string): Promise<CodexArchiveReadiness>
  chooseAdvanced(): Promise<CodexArchiveReadiness>
}
