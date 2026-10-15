import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitService } from '../core/git-service'
import { GitOperationsService } from './git-operations-service'
import { GitHubGitTransport } from '../github/github-git-transport'
import { createTempGitRepo, cleanupTempRepo, gitExec, stageAll, commit } from '../core/git-test-helpers'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await cleanupTempRepo(root) })
async function fixture() {
  const root=await createTempGitRepo(), parent=mkdtempSync(join(tmpdir(),'worktree-provenance-'));roots.push(root,parent)
  writeFileSync(join(root,'base.txt'),'one');await stageAll(root);await commit(root,'inherited one')
  writeFileSync(join(root,'base.txt'),'two');await stageAll(root);await commit(root,'inherited two')
  const base=(await gitExec(root,['rev-parse','HEAD'])).trim(),a=join(parent,'a'),b=join(parent,'b')
  await gitExec(root,['worktree','add','-b','local-a',a]);await gitExec(root,['worktree','add','-b','local-b',b])
  writeFileSync(join(a,'a.txt'),'a');await stageAll(a);await commit(a,'local A')
  const local=(await gitExec(a,['rev-parse','HEAD'])).trim(),git=new GitService(),service=new GitOperationsService(root,git,new GitHubGitTransport(null,git),{repositoryId:'provenance',isActive:()=>true})
  const records=(await service.discoverCoordinationWorktrees()).worktrees,record=records.find(r=>r.path===a)!,other=records.find(r=>r.path===b)!
  return {root,parent,a,b,base,local,git,service,record,other,records}
}
it('shows only locally evidenced commit operations, excluding inherited ancestors and ref moves from another worktree',async()=>{
  const f=await fixture()
  const first=await f.service.getWorktreeTimeline({worktreeId:f.record.worktreeId,generation:f.record.generation})
  expect(first.items.map(item=>item.sha)).toEqual([f.local])
  writeFileSync(join(f.b,'b.txt'),'b');await stageAll(f.b);await commit(f.b,'local B')
  const otherHead=(await gitExec(f.b,['rev-parse','HEAD'])).trim()
  await gitExec(f.a,['reset','--hard',otherHead])
  const after=await f.service.getWorktreeTimeline({worktreeId:f.record.worktreeId,generation:f.record.generation})
  expect(after.items.map(item=>item.sha)).toEqual([f.local])
},60000)
it('verifies amend, cherry-pick and recreated rebase commits, preserving local events after reset',async()=>{
  const f=await fixture(), query={worktreeId:f.record.worktreeId,generation:f.record.generation}
  writeFileSync(join(f.a,'a.txt'),'amended');await stageAll(f.a);await gitExec(f.a,['commit','--amend','-m','amended A'])
  const amended=(await gitExec(f.a,['rev-parse','HEAD'])).trim()
  writeFileSync(join(f.b,'b.txt'),'picked');await stageAll(f.b);await commit(f.b,'B to pick')
  const bHead=(await gitExec(f.b,['rev-parse','HEAD'])).trim()
  await gitExec(f.a,['cherry-pick',bHead]);const picked=(await gitExec(f.a,['rev-parse','HEAD'])).trim()
  writeFileSync(join(f.b,'other.txt'),'new base');await stageAll(f.b);await commit(f.b,'B advanced')
  await gitExec(f.a,['rebase','local-b']);const rewritten=(await gitExec(f.a,['rev-parse','HEAD'])).trim()
  const before=await f.service.getWorktreeTimeline(query)
  expect(before.items.map(item=>item.sha)).toEqual(expect.arrayContaining([f.local,amended,picked,rewritten]))
  expect(before.items.find(item=>item.sha===amended)?.events[0].operation).toBe('AMEND')
  expect(before.items.find(item=>item.sha===picked)?.events[0].operation).toBe('CHERRY_PICK')
  expect(before.items.find(item=>item.sha===rewritten)?.events[0].operation).toBe('REBASE_PICK')
  expect(before.items.some(item=>item.sha===bHead||item.sha===f.base)).toBe(false)
  await gitExec(f.a,['reset','--hard',f.base])
  const reset=await f.service.getWorktreeTimeline(query)
  expect(reset.items.map(item=>item.sha)).toEqual(before.items.map(item=>item.sha))
  expect(reset.items.every(item=>item.reachability==='NOT_REACHABLE')).toBe(true)
  expect(reset.coverage).toBe('PARTIAL')
},90000)
it('deduplicates identical amend objects while preserving multiple recorded local operations, including detached HEAD',async()=>{
  const f=await fixture(), date=(await gitExec(f.a,['show','-s','--format=%cI','HEAD'])).trim(), old=process.env.GIT_COMMITTER_DATE
  try {process.env.GIT_COMMITTER_DATE=date;await gitExec(f.a,['commit','--amend','--no-edit'])}finally{if(old===undefined)delete process.env.GIT_COMMITTER_DATE;else process.env.GIT_COMMITTER_DATE=old}
  expect((await gitExec(f.a,['rev-parse','HEAD'])).trim()).toBe(f.local)
  const page=await f.service.getWorktreeTimeline({worktreeId:f.record.worktreeId,generation:f.record.generation})
  expect(page.items).toHaveLength(1);expect(page.items[0].events).toHaveLength(2)
  await gitExec(f.a,['switch','--detach'])
  writeFileSync(join(f.a,'detached.txt'),'detached');await stageAll(f.a);await commit(f.a,'detached local')
  const detached=await f.service.getWorktreeTimeline({worktreeId:f.record.worktreeId,generation:f.record.generation})
  expect(detached.items[0]).toMatchObject({title:'detached local',reachability:'HEAD_CURRENT'})
  expect(detached.identifiedCount).toBe(2)
  const main=f.records.find(record=>record.path===f.root)!
  const primary=await f.service.getWorktreeTimeline({worktreeId:main.worktreeId,generation:main.generation})
  expect(primary.items.map(item=>item.title)).toEqual(['inherited two','inherited one'])
},60000)
it('reports missing, expired or unavailable objects honestly and rejects generation, move and log drift',async()=>{
  const f=await fixture(),query={worktreeId:f.record.worktreeId,generation:f.record.generation},admin=await f.git.getWorktreeDirectory(f.a),log=join(admin,'logs','HEAD')
  await expect(f.service.getWorktreeTimeline({...query,generation:'replaced'})).rejects.toThrow('WORKTREE_STALE')
  const original=f.git.getCommitOperationObjects.bind(f.git)
  vi.spyOn(f.git,'getCommitOperationObjects').mockImplementationOnce(async(...args)=>{const result=await original(...args);const text=readFileSync(log,'utf8');writeFileSync(log,text+text.split('\n')[0]+'\n');return result})
  await expect(f.service.getWorktreeTimeline(query)).rejects.toThrow('GIT_STATE_CHANGED')
  vi.restoreAllMocks()
  await gitExec(f.a,['reset','--hard',f.base])
  const common=await f.git.getCommonDirectory(f.root)
  unlinkSync(join(common,'objects',f.local.slice(0,2),f.local.slice(2)))
  const missing=await f.service.getWorktreeTimeline(query)
  expect(missing).toMatchObject({coverage:'PARTIAL',identifiedCount:0,omitted:1})
  unlinkSync(log)
  expect(await f.service.getWorktreeTimeline(query)).toMatchObject({coverage:'UNAVAILABLE',identifiedCount:0})
  writeFileSync(log,'')
  expect(await f.service.getWorktreeTimeline(query)).toMatchObject({coverage:'UNAVAILABLE',identifiedCount:0})
  const moved=join(f.parent,'moved');await gitExec(f.root,['worktree','move',f.a,moved])
  await expect(f.service.getWorktreeTimeline(query)).rejects.toThrow('WORKTREE_STALE')
},60000)
it('bounds reflog observation and rejects non-commit objects even with a commit-like reflog message',async()=>{
  const f=await fixture(),query={worktreeId:f.record.worktreeId,generation:f.record.generation},log=join(await f.git.getWorktreeDirectory(f.a),'logs','HEAD')
  const text=readFileSync(log,'utf8'),line=text.trimEnd().split('\n').at(-1)!
  writeFileSync(log,Array.from({length:9000},()=>line+'\n').join(''))
  const bounded=await f.service.getWorktreeTimeline(query)
  expect(bounded).toMatchObject({coverage:'PARTIAL',truncated:true,identifiedCount:1,observedEvents:2000})
  expect(bounded.items[0].events).toHaveLength(2000)
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(1048576)
  const blob=(await gitExec(f.a,['rev-parse','HEAD:a.txt'])).trim()
  writeFileSync(log,line.replace(f.local,blob)+'\n')
  expect(await f.service.getWorktreeTimeline(query)).toMatchObject({coverage:'PARTIAL',identifiedCount:0,omitted:1})
},60000)
