export type CodexArchiveState = 'NOT_CONFIGURED' | 'UNAUTHORIZED' | 'EXECUTABLE_UNAVAILABLE' | 'PROTOCOL_UNSUPPORTED' | 'ACCOUNT_IDENTITY_UNAVAILABLE' | 'PROVIDER_UNREACHABLE' | 'CONNECTING' | 'READY'
export interface CodexArchiveReadiness { state: CodexArchiveState; version?: string }
export interface CodexArchiveApi {
  onChanged(callback: (readiness: CodexArchiveReadiness) => void): () => void
  inspect(): Promise<CodexArchiveReadiness>
  enable(): Promise<CodexArchiveReadiness>
  disable(): Promise<CodexArchiveReadiness>
}
