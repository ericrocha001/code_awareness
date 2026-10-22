export interface ActiveProject {
  id: string
  path: string
  name: string
}

export interface ActiveProjectState {
  revision: number
  project: ActiveProject | null
  context?: ActiveContext
}

export type CapabilityReadinessState = 'UNINITIALIZED' | 'INITIALIZING' | 'READY' | 'DEGRADED' | 'UNAVAILABLE'
export type ActiveContextCapability = 'codeMap' | 'continuum' | 'channel'
export interface CapabilityReadiness { state: CapabilityReadinessState; reasonCode?: string }

export interface ActiveContext {
  revision: number
  mode: 'HOST' | 'PREVIEW'
  identity: 'UNBOUND' | 'IDENTITY_BOUND'
  repositoryId: string | null
  activeCheckout: { path: string; basis: 'REPOSITORY_CATALOG' | 'LEGACY_CODEMAP' } | null
  legacyCodeMapProjectId: string | null
  sessionId: string | null
  dataPolicy: 'HOST_CANONICAL' | 'EMPTY' | 'REPOSITORY_SNAPSHOT'
  worktree?: { worktreeId: string; generation: string }
  dataOrigin?: { at: string; digest: string; artifacts: number; media: number }
  capabilities: Record<ActiveContextCapability, CapabilityReadiness>
}
