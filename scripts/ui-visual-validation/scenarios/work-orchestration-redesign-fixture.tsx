import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkOrchestrationView } from '../../../src/renderer/src/components/WorkOrchestrationView/WorkOrchestrationView'
import type { OrchestrationAttention } from '../../../src/shared/types/work-orchestration-attention-types'
import type { ObservableWorktree } from '../../../src/shared/types/work-orchestration-types'
import '../../../src/renderer/src/index.css'
const now = '2026-10-15T06:00:00Z'
const trees: ObservableWorktree[] = Array.from({ length: 30 }, (_, i) => ({ worktreeId: String(i), generation: 'g1', path: `C:/fixture/worktrees/${i}/code_awareness`, branch: i ? `codex/feature-${i}-with-readable-context` : 'main', head: 'a'.repeat(40), detached: false, reference: !i, locked: false, missing: false, prunable: false, observation: i < 5 ? 'VERIFIED' : 'NOT_OBSERVED', snapshot: null, stagedCount: i === 1 ? 1 : 0, unstagedCount: 0, untrackedCount: 0, conflictCount: 0, reason: null, snapshotRevision: 's', creation: { quality: 'ESTIMATED', source: 'GIT_ADMIN_BIRTHTIME', at: new Date(Date.parse(now) - i * 86400000).toISOString() } } as ObservableWorktree))
const attention = { repositoryId: 'fixture', coverage: 'PARTIAL', known: 30, observed: 5, paused: false, cadenceMs: 30000, pending: trees.slice(5).map(w => ({worktreeId:w.worktreeId,reason:'PENDING'})), alerts: [] } as unknown as OrchestrationAttention
const alert = { id:'alert', category:'POTENTIAL_STRUCTURAL_INTERFERENCE', state:'CURRENT',provider:'1',consumer:'2', providerGeneration:'g1', consumerGeneration:'g1', providerRevision:'p',consumerRevision:'c',base:'b',verifiedAt:now,evidence:[{contractPath:'service.ts',consumerPath:'consumer.ts',symbol:'Service',contractLine:1,consumerLine:2,signature:'new',previousSignature:'old',binding:'RESOLVED_DIRECT'}] }
const reads: unknown[] = []
Object.assign(window, { fixtureReads: reads })
window.codeAwareness = {getWorkOrchestration: async request => {
  reads.push(request)
  const success = data => ({success:true,context:request.context,data})
  if(request.worktree && (window as any).fixtureDelay) await new Promise(resolve => Object.assign(window,{fixtureRelease:resolve}))
  if(request.worktree) return success({repositoryId:'fixture',observedAt:now,worktree:{...trees.find(w=>w.worktreeId===request.worktree.worktreeId),observation:'VERIFIED'}})
  if(request.changes) return success({repositoryId:'fixture',worktreeId:request.changes.worktreeId,generation:'g1',snapshotRevision:'s',changes:[],totalCount:0,revision:'page',nextCursor:null})
  if(request.timeline) return {success:false,code:'REFLOG_UNAVAILABLE'}
  if(request.documents) return {success:false,code:'DOCUMENT_CONTEXT_UNAVAILABLE'}
  return success({repositoryId:'fixture',worktrees:trees,inventoryCoverage:'COMPLETE',observedAt:now,revision:'r1'})
}} as any
function Fixture() {
 const [mode,setMode] = useState('partial')
 Object.assign(window,{fixtureMode:setMode})
 return <WorkOrchestrationView state={{project:{id:'fixture',name:'code_awareness',path:'C:/fixture'},revision:1}} attention={mode==='unavailable'?{...attention,coverage:'UNAVAILABLE'}:mode==='issue'?{...attention,alerts:[alert as any]}:mode==='stale'?{...attention,alerts:[{...alert,state:'STALE'} as any]}:attention}/>
}
document.body.dataset.theme='dark'
createRoot(document.getElementById('root')!).render(<Fixture/> )
