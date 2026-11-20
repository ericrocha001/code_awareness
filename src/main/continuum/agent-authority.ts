import { randomUUID } from 'node:crypto'
import type { AuthenticatedSessionWitness, DeliveryContextRequest } from '../../shared/types/delivery-context-types'

const principals = new WeakSet<object>()
const grants = new WeakSet<object>()
export interface AgentPrincipal {
  readonly principalId: string
  readonly transport: 'LOCAL_AGENT_CHANNEL' | 'MCP' | 'AUTOMATION'
  readonly isActive: () => boolean
}
export interface AgentAuthorityScope {
  readonly deliveryContext?: DeliveryContextRequest
  readonly deliveryContextError?: string
  readonly sessionWitness?: AuthenticatedSessionWitness
}
export interface AgentAuthority {
  readonly principal: AgentPrincipal
  readonly repositoryId: string
  readonly worktreeId?: string
  readonly deliveryContext?: DeliveryContextRequest
  readonly deliveryContextError?: string
  readonly sessionWitness?: AuthenticatedSessionWitness
  readonly isActive: () => boolean
}
export function authenticatedAgentPrincipal(transport: AgentPrincipal['transport'], isActive: () => boolean): AgentPrincipal {
  const principal = Object.freeze({ principalId: `${transport}:${randomUUID()}`, transport, isActive })
  principals.add(principal)
  return principal
}
export function authorizeArtifactAgent(
  principal: AgentPrincipal,
  repositoryId: string,
  isActive: () => boolean,
  worktreeId?: string,
  scope?: AgentAuthorityScope
): AgentAuthority {
  if (!principals.has(principal) || !principal.isActive() || !repositoryId) throw new Error('AGENT_UNAUTHORIZED')
  const authority = Object.freeze({
    principal,
    repositoryId,
    isActive,
    ...(worktreeId ? { worktreeId } : {}),
    ...(scope?.deliveryContext ? { deliveryContext: Object.freeze({ ...scope.deliveryContext }) } : {}),
    ...(scope?.deliveryContextError ? { deliveryContextError: scope.deliveryContextError } : {}),
    ...(scope?.sessionWitness ? { sessionWitness: Object.freeze({ ...scope.sessionWitness }) } : {})
  })
  grants.add(authority)
  return authority
}
export function assertArtifactAgent(authority: AgentAuthority | undefined, repositoryId: string): asserts authority is AgentAuthority {
  if (!authority || !grants.has(authority) || !principals.has(authority.principal) || !authority.principal.isActive() || !authority.isActive()) throw new Error('AGENT_UNAUTHORIZED')
  if (authority.repositoryId !== repositoryId) throw new Error('REPOSITORY_MISMATCH')
}
