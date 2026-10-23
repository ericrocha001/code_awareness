import React from 'react'
import { createRoot } from 'react-dom/client'
import { RuntimePreviewPreflight } from '../../../src/renderer/src/components/WorkOrchestrationView/RuntimePreviewPreflight'
import type { BranchManagerData, BranchManagerOperation } from '../../../src/shared/types/branch-manager-types'
import '../../../src/renderer/src/index.css'
import '../../../src/renderer/src/components/WorkOrchestrationView/WorkOrchestrationView.css'
import '../../../src/renderer/src/components/WorkOrchestrationView/BranchManagerView.css'

let reads = 0
let activations = 0
Object.defineProperty(window, 'fixtureReadCount', { get: () => reads })
Object.defineProperty(window, 'fixtureActivationCount', { get: () => activations })
window.codeAwareness = { listRepositories: async () => ['fixture', 'other'].map(id => ({ id, name: id === 'fixture' ? 'Repositório ativo' : 'Outro repositório gerenciado', status: 'ACTIVE', localCheckout: { availability: 'AVAILABLE', gitState: 'GIT' } })), activateRepository: async () => { activations++; throw new Error('Activation forbidden in preview preflight') } } as any
const query = async (operation: BranchManagerOperation): Promise<BranchManagerData> => {
  reads++
  if (operation.action === 'PREVIEW_WORKTREES') return { kind: 'PREVIEW_WORKTREES', repositoryId: operation.repositoryId, worktrees: [{ worktreeId: 'other-tree', generation: 'other-generation', branch: 'feature-b', path: 'C:/other-repository/worktrees/feature-b' } as any] }
  if (operation.action === 'PREVIEW_PROFILES') return { kind: 'PREVIEW_PROFILES', profiles: [{ profileId: 'web-isolated', revision: 2, fingerprint: 'fixture', approved: true, runtime: 'WEB_DEV_SERVER' }] }
  if (operation.action !== 'PREVIEW_PREFLIGHT') throw new Error('Unexpected fixture operation')
  return { kind: 'PREVIEW_PREFLIGHT', preflight: { selection: operation.selection, profileRevision: 2, status: 'INCOMPATIBLE', process: 'NOT_IMPLEMENTED', readiness: 'NOT_OBSERVED', diagnostics: [{ reasonCode: 'SECURITY_ISOLATION_UNAVAILABLE', message: 'O host não oferece enforcement para as garantias exigidas.', missingRequirements: [{ capability: 'NETWORK_EGRESS_RESTRICTION', guarantee: 'Egress limitado a loopback', availableMechanism: { kind: 'PROFILE_ISOLATION', name: 'Separação operacional de recursos', basis: 'Sem firewall ou sandbox integrado; observação de sockets não restringe rede.' }, resolutions: [{ action: 'INDEPENDENT_POLICY_REVIEW', description: 'Reavaliar risco e política com aprovação material independente. Nenhum downgrade automático.', requiresIndependentApproval: true }] }] }] } }
}
document.body.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<div className="wo-view"><main className="bm-detail" style={{ maxWidth: 520, margin: '20px auto' }}><h2>feature/runtime-preview</h2><p>Fixture sintética · componente real · nenhum processo de preview</p><RuntimePreviewPreflight repositoryId="fixture" worktrees={[{ worktreeId: 'tree', generation: 'g', path: 'C:/worktrees/feature/runtime-preview' } as any]} query={query} disabled={false}/></main></div>)
