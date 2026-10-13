export interface GitRemoteTransport {
  readRemoteHead?(repoPath: string, remote: string, ref: string): Promise<string | null>
  push(repoPath: string, branch: string, remote?: string, expectedHead?: string): Promise<void>
  fetch?(repoPath: string, remote: string): Promise<void>
  pullFastForward?(repoPath: string, remote: string, branch: string): Promise<void>
}
