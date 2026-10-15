import type { GitRemoteTransport } from '../core/git-remote-transport'
import type { GitService } from '../core/git-service'
import type { GitHubAuthService } from './github-auth-service'

export class GitHubGitTransport implements GitRemoteTransport {
  constructor(
    private readonly auth: GitHubAuthService | null,
    private readonly git: GitService
  ) {}

  private async tokenFor(repoPath: string, remote: string): Promise<string | undefined> {
    const url = await this.git.getRemoteUrl(repoPath, remote)
    if (!url || !/^https:\/\/github\.com\//i.test(url) || !this.auth) return undefined
    return await this.auth.getValidAccessToken() || undefined
  }

  async fetch(repoPath: string, remote: string): Promise<void> {
    await this.git.fetchRemote(repoPath, remote, await this.tokenFor(repoPath, remote))
  }

  async readRemoteHead(repoPath: string, remote: string, ref: string): Promise<string | null> {
    return this.git.readRemoteHead(repoPath, remote, ref, await this.tokenFor(repoPath, remote))
  }

  async pullFastForward(repoPath: string, remote: string, branch: string): Promise<void> {
    await this.git.pullFastForward(repoPath, remote, branch, await this.tokenFor(repoPath, remote))
  }

  async push(repoPath: string, branch: string, remote = 'origin', expectedHead?: string): Promise<void> {
    const token = await this.tokenFor(repoPath, remote)
    if (token) {
      await this.git.pushAuthenticated(repoPath, remote, branch, token, expectedHead)
      return
    }
    await this.git.push(repoPath, remote, branch, expectedHead)
  }
}
