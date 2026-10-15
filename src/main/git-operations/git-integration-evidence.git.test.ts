import { expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTempGitRepo, cleanupTempRepo, gitExec, stageAll, commit } from '../core/git-test-helpers'
import { GitService } from '../core/git-service'
import { GitOperationsService } from './git-operations-service'
import { GitHubGitTransport } from '../github/github-git-transport'
import { GitWorktreeLifecycle } from './git-worktree-lifecycle'
import { GitWorktreeValidation } from './git-worktree-validation'
import { RuntimeIdentityProvider } from '../runtime-identity/runtime-identity-provider'
import type { ValidationLedger } from '../validation-ledger/validation-ledger'
import type { ValidationProof, RecordProofInput } from '../validation-ledger/validation-ledger-types'

it('requires genuine current validation of the exact integrated candidate and explicit requirements', async () => {
  const root = await createTempGitRepo(), parent = mkdtempSync(join(tmpdir(),'candidate-evidence-')), git = new GitService()
  let validation: GitWorktreeValidation | undefined
  try {
    writeFileSync(join(root,'file.txt'),'base');await stageAll(root);await commit(root,'base')
    const sourcePath=join(parent,'source'), candidatePath=join(parent,'candidate')
    await gitExec(root,['worktree','add','-b','source',sourcePath])
    writeFileSync(join(sourcePath,'file.txt'),'integrated');await stageAll(sourcePath);await commit(sourcePath,'source')
    const sourceHead=(await gitExec(sourcePath,['rev-parse','HEAD'])).trim()
    writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{'test:node':'node acceptance.cjs',typecheck:'node acceptance.cjs'}}))
    writeFileSync(join(root,'acceptance.cjs'),"require('node:assert/strict').equal(require('node:fs').readFileSync('file.txt','utf8'),'integrated')")
    await stageAll(root);await commit(root,'profile on target')
    const targetHead=(await gitExec(root,['rev-parse','HEAD'])).trim()
    await gitExec(root,['branch','unoccupied',targetHead]);await gitExec(root,['worktree','add','-b','candidate',candidatePath]);await gitExec(candidatePath,['merge','--no-edit',sourceHead])
    const identity={repositoryId:'candidate-test',isActive:()=>true}, proofs=new Map<string,ValidationProof>()
    const ledger={recordProof:(input:RecordProofInput)=>{const proof={...input,proofId:'proof-'+proofs.size,recordedAt:new Date().toISOString()} as ValidationProof;proofs.set(proof.proofId,proof);return proof},getProof:(id:string)=>proofs.get(id)??null} as unknown as ValidationLedger
    const runtime=new RuntimeIdentityProvider({rootDir:root});await runtime.sourceOriginReady
    validation=new GitWorktreeValidation(root,git,identity,ledger,runtime)
    const service=new GitOperationsService(root,git,new GitHubGitTransport(null,git),identity,false,undefined,false,validation)
    const records=(await service.discoverCoordinationWorktrees()).worktrees, source=records.find(r=>r.path===sourcePath)!, candidate=records.find(r=>r.path===candidatePath)!
    new GitWorktreeLifecycle(await git.getCommonDirectory(root)).save({...candidate,repositoryId:identity.repositoryId,startPoint:targetHead,createdAt:new Date().toISOString()})
    const started=await validation.start(candidate.worktreeId,{profileId:'test-node'})
    let done=await validation.get(started.runId)
    const end=Date.now()+30000
    while(done.status==='RUNNING' && Date.now()<end){await new Promise(resolve=>setTimeout(resolve,200));done=await validation.get(started.runId)}
    expect(done,JSON.stringify(done)).toMatchObject({status:'PASSED'})
    const proofId=done.proofId!, request={worktreeId:source.worktreeId,generation:source.generation,targetBranch:'unoccupied',candidate:{worktreeId:candidate.worktreeId,generation:candidate.generation,head:candidate.head!,sourceHead,targetHead,requirements:[{profileId:'test-node',proofIds:[proofId]}]}}
    expect(await service.evaluateWorktreeIntegration(request)).toMatchObject({state:'ELIGIBLE_FOR_REVIEW',compatibility:'CANDIDATE_VERIFIED',blockers:[],missing:[],proofs:[{freshness:'CURRENT',producer:'SYSTEM',head:candidate.head}]})
    expect(await service.evaluateWorktreeIntegration({...request,candidate:{...request.candidate,requirements:[]}})).toMatchObject({state:'EVIDENCE_PENDING',missing:['VALIDATION_REQUIREMENTS_NOT_DEFINED']})
    expect(await validation.inspectIntegrationProof(candidate.worktreeId,sourceHead,'test-node',proofId)).toMatchObject({freshness:'HISTORICAL'})
    expect(await validation.inspectIntegrationProof(candidate.worktreeId,candidate.head!,'different-requirement',proofId)).toMatchObject({freshness:'HISTORICAL'})
    expect(await validation.inspectIntegrationProof(candidate.worktreeId,candidate.head!,'test-node','missing')).toMatchObject({freshness:'NOT_AVAILABLE'})
    const typed = await validation.start(candidate.worktreeId,{profileId:'typecheck'})
    let typeDone=await validation.get(typed.runId)
    const typeEnd=Date.now()+30000
    while(typeDone.status==='RUNNING' && Date.now()<typeEnd){await new Promise(resolve=>setTimeout(resolve,200));typeDone=await validation.get(typed.runId)}
    expect(typeDone).toMatchObject({status:'PASSED'})
    expect(await validation.inspectIntegrationProof(candidate.worktreeId,candidate.head!,'typecheck',typeDone.proofId!)).toMatchObject({freshness:'CURRENT'})
    expect(await validation.verify(candidate.worktreeId,candidate.head!,[typeDone.proofId!])).toBe(false)
    expect(await validation.verify(candidate.worktreeId,candidate.head!,[proofId,typeDone.proofId!])).toBe(true)
    const restarted=new GitWorktreeValidation(root,git,identity,ledger,new RuntimeIdentityProvider({rootDir:root}))
    expect(await restarted.inspectIntegrationProof(candidate.worktreeId,candidate.head!,'test-node',proofId)).toMatchObject({freshness:'UNVERIFIABLE'});await restarted.shutdown()
    await gitExec(root,['update-ref','refs/heads/unoccupied',sourceHead])
    expect(await service.evaluateWorktreeIntegration(request)).toMatchObject({state:'STALE'})
  }finally{await validation?.shutdown();await cleanupTempRepo(root);await cleanupTempRepo(parent)}
},120000)
