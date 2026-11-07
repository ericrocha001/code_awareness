import { expect, it } from 'vitest'
import { assertArtifactAgent, authenticatedAgentPrincipal, authorizeArtifactAgent, type AgentAuthority } from './agent-authority'

it('derives repository-scoped authority from a host-authenticated connection and rechecks revocation', () => {
  let connected = true, current = true
  const principal = authenticatedAgentPrincipal('LOCAL_AGENT_CHANNEL', () => connected)
  const authority = authorizeArtifactAgent(principal, 'repo-A', () => current, 'worktree-A')
  expect(() => assertArtifactAgent(authority, 'repo-A')).not.toThrow()
  expect(() => assertArtifactAgent(authority, 'repo-B')).toThrow('REPOSITORY_MISMATCH')
  expect(() => assertArtifactAgent({ ...authority } as AgentAuthority, 'repo-A')).toThrow('AGENT_UNAUTHORIZED')
  current = false
  expect(() => assertArtifactAgent(authority, 'repo-A')).toThrow('AGENT_UNAUTHORIZED')
  current = true; connected = false
  expect(() => assertArtifactAgent(authority, 'repo-A')).toThrow('AGENT_UNAUTHORIZED')
  expect(() => authorizeArtifactAgent({ ...principal }, 'repo-A', () => true)).toThrow('AGENT_UNAUTHORIZED')
})
