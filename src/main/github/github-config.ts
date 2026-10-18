export const GITHUB_API_VERSION = '2026-03-10'
export const GITHUB_API_BASE_URL = 'https://api.github.com'
export const GITHUB_OAUTH_BASE_URL = 'https://github.com/login'
export const GITHUB_USER_AGENT = 'Code-Awareness-Desktop'
export const GITHUB_OFFICIAL_APP = Object.freeze({ clientId: 'Iv23liiSmi57iYNQVgM2', appSlug: 'code-awareness-desktop' })

export interface GitHubProductConfig {
  clientId: string
  appSlug: string
}

export function loadGitHubProductConfig(environment: NodeJS.ProcessEnv = process.env): GitHubProductConfig | null {
  if (environment.CODE_AWARENESS_GITHUB_CLIENT_ID === undefined && environment.CODE_AWARENESS_GITHUB_APP_SLUG === undefined) return { ...GITHUB_OFFICIAL_APP }
  const clientId = environment.CODE_AWARENESS_GITHUB_CLIENT_ID?.trim()
  const appSlug = environment.CODE_AWARENESS_GITHUB_APP_SLUG?.trim()
  return clientId && appSlug ? { clientId, appSlug } : null
}
