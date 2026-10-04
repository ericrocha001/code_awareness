export const GITHUB_API_VERSION = '2026-03-10'
export const GITHUB_API_BASE_URL = 'https://api.github.com'
export const GITHUB_OAUTH_BASE_URL = 'https://github.com/login'
export const GITHUB_USER_AGENT = 'Code-Awareness-Desktop'

export interface GitHubProductConfig {
  clientId: string
  appSlug: string
}

export function loadGitHubProductConfig(environment: NodeJS.ProcessEnv = process.env): GitHubProductConfig | null {
  const clientId = environment.CODE_AWARENESS_GITHUB_CLIENT_ID?.trim()
  const appSlug = environment.CODE_AWARENESS_GITHUB_APP_SLUG?.trim()
  return clientId && appSlug ? { clientId, appSlug } : null
}
