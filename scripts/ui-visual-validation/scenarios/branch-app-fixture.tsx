import React from 'react'
import { createRoot } from 'react-dom/client'
import { BranchManagerView } from '../../../src/renderer/src/components/WorkOrchestrationView/BranchManagerView'
import '../../../src/renderer/src/index.css'
const repositoryId = 'visual-fixture', context = { projectId: repositoryId, revision: 1 }
const branches = Array.from({ length: 141 }, (_, i) => ({ repositoryId, key: String(i), ref: `refs/heads/feature-${i}`, name: i === 0 ? 'feature-000/preview-com-nome-longo-para-verificar-truncamento-e-acessibilidade' : `feature-${i}`, namespace: 'LOCAL', head: 'a'.repeat(40), revision: String(i), generation: 'fixture', creation: { at: null, source: 'UNKNOWN' }, worktrees: i === 0 ? [{ worktreeId: 'tree', generation: 'fixture' }] : [], lastCommitAt: null }))
branches[0].ref = 'refs/heads/' + branches[0].name
const inventory = { repositoryId, branches, worktrees: [{ worktreeId: 'tree', generation: 'fixture', branch: branches[0].name, path: 'C:/isolated/fixture', head: 'a'.repeat(40) }], unassignedWorktrees: [], revision: 'fixture', coverage: 'COMPLETE' }
let session: any = null, lastOperation: any = null, pending: string | null = null
function complete(operationId: string, data: unknown) { pending = operationId; setTimeout(() => { lastOperation = { operationId, code: null, result: { success: true, data } }; pending = null }, 20); return { kind: 'SESSION', session: null, pending: true, operationId } }
window.codeAwareness = {
  onContinuumChanged: () => () => {},
  getBranchOrchestration: async ({ operation }: any) => {
    let data: any
    if (operation.action === 'INVENTORY') data = { kind: 'INVENTORY', inventory }
    else if (operation.action === 'PULL_REQUESTS') data = { kind: 'PULL_REQUESTS', inventoryRevision: 'fixture', pullRequests: { repositoryId, relations: [], received: [], orphaned: [], catalog: { coverage: 'UNAVAILABLE', reason: 'VISUAL_FIXTURE', observedAt: new Date().toISOString(), items: [] } } }
    else if (operation.action === 'EXECUTIONS') data = { kind: 'EXECUTIONS', page: { repositoryId, branchRef: operation.ref, branchRevision: operation.revision, bindings: [], coverage: 'COMPLETE' } }
    else if (operation.action === 'PREVIEW_RUNTIME') {
      const r = operation.request
      let value: any
      if (r.action === 'LIST') value = { kind: 'SESSIONS', sessions: session ? [session] : [], nextCursor: null, pendingOperationId: pending, lastOperation }
      else if (r.action === 'RUN_BRANCH_APP' && r.ref !== branches[0].ref) value = { kind: 'BRANCH_APP', reasonCode: 'BRANCH_CHECKOUT_REQUIRED', message: 'Esta branch precisa de um checkout local compatível antes de rodar.' }
      else if (r.action === 'RUN_BRANCH_APP') {
        session = { sessionId: 'visual-session', operationId: r.operationId, selection: { repositoryId, worktreeId: 'tree', generation: 'fixture' }, state: 'RUNNING', resources: 'RESERVED', source: { branch: branches[0].name }, readiness: 'READY', liveness: 'VERIFIED', observation: 'HISTORICAL', failure: null, coverage: [], qualifications: [], startedAt: new Date().toISOString(), at: new Date().toISOString() }
        value = complete(r.operationId, { kind: 'SESSION', session, pending: false })
      } else if (r.action === 'INSPECT' || r.action === 'STOP') {
        if (r.action === 'STOP') session = { ...session, state: 'STOPPED', resources: 'RELEASED' }
        value = complete(session.operationId, { kind: 'SESSION', session, pending: false })
      } else throw Error('UNSUPPORTED_VISUAL_FIXTURE_ACTION')
      data = { kind: 'PREVIEW_RUNTIME', result: { success: true, data: value } }
    } else throw Error('UNSUPPORTED_VISUAL_FIXTURE_OPERATION')
    return { success: true, context, data }
  }
} as any
document.body.dataset.theme = 'light'
createRoot(document.getElementById('root')!).render(<BranchManagerView state={{ revision: 1, project: { id: repositoryId, name: 'Visual fixture', path: 'C:/isolated/fixture' } }}/>)
