import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkOrchestrationView } from '../../../src/renderer/src/components/WorkOrchestrationView/WorkOrchestrationView'
import type { OrchestrationAttention } from '../../../src/shared/types/work-orchestration-attention-types'
import type { ObservableWorktree } from '../../../src/shared/types/work-orchestration-types'
import '../../../src/renderer/src/index.css'
import { GlobalSidebarNav } from '../../../src/renderer/src/components/GlobalSidebar/GlobalSidebarNav'
import { NAV_ITEMS } from '../../../src/renderer/src/config/navigation'
import '../../../src/renderer/src/components/GlobalSidebar/GlobalSidebar.css'
import logo from '../../../src/renderer/public/logo.svg'
const now = '2026-10-15T06:00:00Z'
const trees: ObservableWorktree[] = Array.from({ length: 30 }, (_, i) => ({ worktreeId: String(i), generation: 'g1', path: `C:/fixture/worktrees/${i}/code_awareness`, branch: i ? `codex/feature-${i}-with-readable-context` : 'main', head: 'a'.repeat(40), detached: false, reference: !i, locked: false, missing: false, prunable: false, observation: i < 5 ? 'VERIFIED' : 'NOT_OBSERVED', snapshot: null, stagedCount: i === 1 ? 1 : 0, unstagedCount: 0, untrackedCount: 0, conflictCount: 0, reason: null, snapshotRevision: 's', localChanges: i < 5 ? {total: i === 1 ? 1 : 0, categories: {added:0,modified:i === 1 ? 1 : 0,deleted:0,renamed:0,untracked:0,conflicted:0}} : undefined, creation: { quality: 'ESTIMATED', source: 'ADMIN_DIRECTORY_BIRTHTIME', at: new Date(Date.parse(now) - Math.floor(i / 6) * 86400000).toISOString() } } as ObservableWorktree))
const attention = { repositoryId: 'fixture', coverage: 'PARTIAL', known: 30, observed: 5, checkedAt: now, paused: false, cadenceMs: 30000, pending: trees.slice(5).map(w => ({worktreeId:w.worktreeId,reason:'PENDING'})), alerts: [] } as unknown as OrchestrationAttention
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
 return <><aside className="global-sidebar sidebar-open fixture-sidebar"><div className="global-sidebar-header"><span className="global-sidebar-logo-title-container"><img className="global-sidebar-logo-img" src={logo} alt="Code Awareness" /><span className="global-sidebar-logo-title">Code Awareness</span></span></div><div className="fixture-project-context"><small>PROJETO ATIVO</small><strong>code_awareness</strong></div><GlobalSidebarNav items={NAV_ITEMS} activeTab="work-orchestration" onSelect={()=>{}} isSidebarOpen /></aside><div className="fixture-feature"><WorkOrchestrationView state={{project:{id:'fixture',name:'code_awareness',path:'C:/fixture'},revision:1}} attention={mode==='unavailable'?{...attention,coverage:'UNAVAILABLE'}:mode==='issue'?{...attention,alerts:[alert as any]}:mode==='stale'?{...attention,alerts:[{...alert,state:'STALE'} as any]}:attention}/></div></>
}
document.body.dataset.theme='dark'
createRoot(document.getElementById('root')!).render(<Fixture/> )
