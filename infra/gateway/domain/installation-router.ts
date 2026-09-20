import { RelayError, type InstallationId, type McpHttpResponse, type RequestId, type UserId } from '../../../src/shared/distribution/relay-protocol'
import type { AuthenticatedPrincipal } from '../../../src/shared/distribution/authorization-ports'

export interface Installation {
  id: InstallationId
  ownerUserId: UserId
  credentialHash: string
  createdAt: string
  lastSeenAt: string | null
  status: 'ACTIVE' | 'REVOKED'
}

export interface InstallationRegistry {
  get(id: InstallationId): Promise<Installation | null>
  listOwned(owner: UserId): Promise<Installation[]>
  enroll(installation: Installation): Promise<void>
  revoke(id: InstallationId, owner: UserId): Promise<void>
  rotate(id: InstallationId, owner: UserId, credentialHash: string): Promise<void>
}

export interface RoutedMcpResponse extends McpHttpResponse {
  installationId: InstallationId
}

export interface RelaySessionDirectory {
  isOnline(id: InstallationId): Promise<boolean>
  invoke(id: InstallationId, body: string, requestId: RequestId): Promise<McpHttpResponse>
  delivered?(id: InstallationId, requestId: RequestId, durationMs: number): Promise<void>
}

export class InstallationRouter {
  constructor(private readonly registry: InstallationRegistry, private readonly sessions: RelaySessionDirectory) {}

  async forward(user: AuthenticatedPrincipal, body: string, selected: InstallationId | undefined, requestId: RequestId): Promise<RoutedMcpResponse> {
    let installation: Installation | undefined | null
    if (selected) {
      installation = await this.registry.get(selected)
      if (!installation || installation.ownerUserId !== user.id) throw new RelayError('FORBIDDEN')
      if (installation.status === 'REVOKED') throw new RelayError('INSTALLATION_REVOKED')
    } else {
      const owned = (await this.registry.listOwned(user.id)).filter((entry) => entry.status === 'ACTIVE' && entry.ownerUserId === user.id)
      const online = await Promise.all(owned.map(async (entry) => await this.sessions.isOnline(entry.id) ? entry : null))
      const available = online.filter((entry): entry is Installation => entry !== null)
      if (available.length > 1) throw new RelayError('INSTALLATION_AMBIGUOUS')
      installation = available[0]
    }
    if (!installation || !await this.sessions.isOnline(installation.id)) throw new RelayError('INSTALLATION_OFFLINE')
    const response = await this.sessions.invoke(installation.id, body, requestId)
    return { ...response, installationId: installation.id }
  }

  async notifyDelivered(id: InstallationId, requestId: RequestId, durationMs: number): Promise<void> {
    await this.sessions.delivered?.(id, requestId, durationMs)
  }
}
