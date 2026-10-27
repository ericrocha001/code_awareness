import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AtlasCommit, AtlasHistorySlice, AtlasPersistence } from './git-atlas-cache'
import type { AtlasCatalogManifest, AtlasCollectionRound, AtlasCatalogDiagnostic } from '../../shared/types/git-atlas-catalog-types'

const formatVersion = 1
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
interface Row { body: string; checksum: string; bytes: number }
const leases = new Map<string, { store: GitAtlasSqliteCache; users: number }>()
function paths(directory: string, repositoryId: string, commonDirectory: string) {
  const physical = realpathSync(commonDirectory), common = process.platform === 'win32' ? physical.toLowerCase() : physical
  const identity = JSON.stringify([repositoryId, common]), legacyIdentity = JSON.stringify([repositoryId, common, formatVersion])
  return { id: digest(identity), identity, legacyIdentity, stable: join(resolve(directory), `${digest(identity)}.sqlite`), legacy: join(resolve(directory), `${digest(legacyIdentity)}.sqlite`) }
}

export class GitAtlasSqliteCache implements AtlasPersistence {
  readonly catalogIdentity: string
  private db?: Database.Database
  private readonly statements = new Map<string, Database.Statement>()
  private maintenance?: NodeJS.Immediate
  private health: AtlasCatalogDiagnostic = { state: 'READY', reason: null }

  static acquire(directory: string, repositoryId: string, commonDirectory: string): AtlasPersistence {
    const key = paths(directory, repositoryId, commonDirectory).id
    let entry = leases.get(key)
    if (!entry) { entry = { store: new GitAtlasSqliteCache(directory, repositoryId, commonDirectory), users: 0 }; leases.set(key, entry) }
    entry.users++
    let released = false
    const selected = entry
    return new Proxy(selected.store, { get(target, property) {
      if (property === 'close') return () => { if (released) return; released = true; if (--selected.users === 0) { target.close(); leases.delete(key) } }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }

  static clearRepository(directory: string, repositoryId: string, commonDirectory: string, authorization: { repositoryId: string; confirmed: true }): void {
    if (authorization.repositoryId !== repositoryId || authorization.confirmed !== true) throw new Error('ATLAS_CLEAR_NOT_AUTHORIZED')
    const selected = paths(directory, repositoryId, commonDirectory)
    if (leases.has(selected.id)) throw new Error('ATLAS_CATALOG_IN_USE')
    const files = [selected.stable, selected.legacy].flatMap(file => [file, file + '-wal', file + '-shm'])
    for (const file of files) if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('ATLAS_CATALOG_LINK_NOT_ALLOWED')
    for (const file of files) if (existsSync(file)) unlinkSync(file)
  }

  constructor(private readonly directory: string, private readonly repositoryId: string, private readonly commonDirectory: string) {
    this.catalogIdentity = paths(directory, repositoryId, commonDirectory).id
    this.open()
  }

  retry(): boolean {
    if (this.health.state === 'READY' && this.db) return true
    if (!['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_FULL', 'SQLITE_CANTOPEN'].includes(this.health.reason ?? '')) return false
    this.close()
    this.open()
    return this.health.state === 'READY'
  }

  private open() {
    const { directory, repositoryId, commonDirectory } = this
    const selected = paths(directory, repositoryId, commonDirectory)
    try {
      if (existsSync(selected.stable) && existsSync(selected.legacy)) throw new Error('ATLAS_CATALOG_AMBIGUOUS_FILES')
      mkdirSync(directory, { recursive: true })
      const file = existsSync(selected.legacy) ? selected.legacy : selected.stable
      if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('ATLAS_CATALOG_LINK_NOT_ALLOWED')
      const db = this.db = new Database(file, { timeout: 0 })
      db.pragma('busy_timeout = 0')
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = NORMAL')
      db.pragma('journal_size_limit = 4194304')
      db.pragma('max_page_count = 2147483646')
      const version = db.pragma('user_version', { simple: true })
      if (![0, 1, 2].includes(Number(version))) throw new Error('ATLAS_CATALOG_SCHEMA_INCOMPATIBLE')
      db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS cache_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS git_commit (sha TEXT PRIMARY KEY, body TEXT NOT NULL, checksum TEXT NOT NULL, bytes INTEGER NOT NULL, last_access INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS history_slice (key TEXT PRIMARY KEY, body TEXT NOT NULL, checksum TEXT NOT NULL, bytes INTEGER NOT NULL, last_access INTEGER NOT NULL, revision TEXT NOT NULL, since_ms INTEGER, upper_ms INTEGER, page_offset INTEGER NOT NULL, complete INTEGER NOT NULL);
        DROP INDEX IF EXISTS atlas_commit_lru;
        CREATE INDEX IF NOT EXISTS atlas_slice_lru ON history_slice(last_access);
        CREATE INDEX IF NOT EXISTS atlas_slice_revision ON history_slice(revision, complete, page_offset, last_access);
      `)
      const stored = this.statement('SELECT value FROM cache_meta WHERE key = ?').get('identity') as { value: string } | undefined
      if (stored && stored.value !== selected.identity && !(Number(version) <= 1 && stored.value === selected.legacyIdentity)) throw new Error('ATLAS_CATALOG_IDENTITY_MISMATCH')
      const columns = new Set((db.pragma('table_info(git_commit)') as Array<{name:string}>).map(column=>column.name))
      for(const definition of ['author TEXT','committed_at TEXT','subject TEXT','message TEXT','committer TEXT','authored_at TEXT','parent_count INTEGER','normalized INTEGER NOT NULL DEFAULT 0']) if(!columns.has(definition.split(' ')[0])) db.exec(`ALTER TABLE git_commit ADD COLUMN ${definition}`)
      db.exec(`
        CREATE TABLE IF NOT EXISTS atlas_parent(child_sha TEXT NOT NULL,position INTEGER NOT NULL,parent_sha TEXT NOT NULL,PRIMARY KEY(child_sha,position));
        CREATE INDEX IF NOT EXISTS atlas_parent_reverse ON atlas_parent(parent_sha,child_sha);
        CREATE TABLE IF NOT EXISTS atlas_commit_observation(sha TEXT NOT NULL,revision TEXT NOT NULL,observer_generation TEXT NOT NULL,observed_at TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(sha,revision,observer_generation));
        CREATE TABLE IF NOT EXISTS atlas_ref_observation(scope_key TEXT NOT NULL,revision TEXT NOT NULL,observer_generation TEXT NOT NULL,ref TEXT NOT NULL,sha TEXT NOT NULL,kind TEXT NOT NULL,observed_at TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(scope_key,revision,observer_generation,ref,sha));
        CREATE INDEX IF NOT EXISTS atlas_ref_history ON atlas_ref_observation(ref,observed_at);
        CREATE TABLE IF NOT EXISTS atlas_round(id TEXT PRIMARY KEY,manifest TEXT NOT NULL,topology TEXT NOT NULL,revision TEXT NOT NULL,status TEXT NOT NULL,checkpoint_version INTEGER NOT NULL,ordering TEXT NOT NULL,acquired INTEGER NOT NULL DEFAULT 0,reason TEXT,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS atlas_frontier(id INTEGER PRIMARY KEY AUTOINCREMENT,round_id TEXT NOT NULL,sha TEXT NOT NULL,UNIQUE(round_id,sha));
        CREATE INDEX IF NOT EXISTS atlas_frontier_round ON atlas_frontier(round_id,id);
        CREATE TABLE IF NOT EXISTS atlas_round_visit(round_id TEXT NOT NULL,sha TEXT NOT NULL,PRIMARY KEY(round_id,sha));
        CREATE INDEX IF NOT EXISTS atlas_visit_sha ON atlas_round_visit(sha,round_id);
        PRAGMA user_version = 2;
      `)
      this.statement('INSERT OR REPLACE INTO cache_meta(key,value) VALUES (?,?)').run('identity',selected.identity)
      if(Number(version)===1) this.statement('INSERT OR IGNORE INTO cache_meta(key,value) VALUES (?,?)').run('legacy_identity',selected.legacyIdentity)
      this.statement('INSERT OR REPLACE INTO cache_meta(key,value) VALUES (?,?)').run('limits',JSON.stringify({schemaVersion:2,durableFacts:'NO_AUTOMATIC_EVICTION',sliceBytes:8*1024*1024,slices:256}))
      })()
      this.health = { state: 'READY', reason: null }
    } catch (error) { this.failure(error) }
  }

  diagnostic(): AtlasCatalogDiagnostic { return !this.db && this.health.state==='READY' ? {state:'UNAVAILABLE',reason:'CONNECTION_CLOSED'} : {...this.health} }
  suspend(reason: string): void { this.health={state:'SUSPENDED',reason} }
  private failure(error: unknown) {
    if(this.db?.inTransaction) throw error
    const reason=String((error as {code?:string;message?:string})?.code??(error as Error)?.message??'ATLAS_CATALOG_UNAVAILABLE')
    this.health={state:['SQLITE_FULL','SQLITE_BUSY','ATLAS_BATCH_LIMIT'].includes(reason)?'SUSPENDED':'UNAVAILABLE',reason}
    this.close()
  }

  private statement(sql: string) {
    let statement = this.statements.get(sql)
    if (!statement) { statement = this.db!.prepare(sql); this.statements.set(sql, statement) }
    return statement
  }

  private read<T>(table: 'git_commit' | 'history_slice', key: string, maximum: number): T | undefined {
    if (!this.db) return undefined
    try {
      const column = table === 'git_commit' ? 'sha' : 'key'
      const row = this.statement(`SELECT substr(body, 1, ?) AS body, checksum, bytes FROM ${table} WHERE ${column} = ?`).get(maximum, key) as Row | undefined
      if (!row) return undefined
      if (row.bytes > maximum || Buffer.byteLength(row.body) !== row.bytes || digest(key + row.body) !== row.checksum) throw new Error('ATLAS_CACHE_CORRUPT')
      const value = JSON.parse(row.body) as T
      this.statement(`UPDATE ${table} SET last_access = ? WHERE ${column} = ?`).run(Date.now(), key)
      return value
    } catch (error) { this.failure(error); return undefined }
  }

  getCommit(sha: string): AtlasCommit | undefined {
    const commit = this.read<AtlasCommit>('git_commit', sha, 4 * 1024 * 1024)
    if (!commit) return undefined
    if (commit.sha !== sha || !shaPattern.test(commit.sha) || !Array.isArray(commit.parents) || commit.parents.length > 1024 || commit.parents.some(parent => typeof parent !== 'string' || !shaPattern.test(parent)) ||
      typeof commit.author !== 'string' || typeof commit.subject !== 'string' || typeof commit.timestamp !== 'string' || !Number.isFinite(Date.parse(commit.timestamp)) || ['message','committer','authoredAt','authorEmail','committerEmail'].some(key=>key in commit && typeof commit[key as keyof AtlasCommit]!=='string')) { this.failure(new Error('ATLAS_CATALOG_INTEGRITY')); return undefined }
    return commit
  }

  getSlice(key: string): AtlasHistorySlice | undefined {
    const slice = this.read<AtlasHistorySlice>('history_slice', key, 32 * 1024)
    if (!slice) return undefined
    if (!Array.isArray(slice.shas) || slice.shas.length > 101 || slice.shas.some(sha => typeof sha !== 'string' || !shaPattern.test(sha)) || typeof slice.hasMore !== 'boolean' ||
      !Array.isArray(slice.tips) || slice.tips.length > 512 || slice.tips.some(sha => typeof sha !== 'string' || !shaPattern.test(sha)) ||
      typeof slice.anchorAt !== 'string' || typeof slice.queriedAt !== 'string' || !Number.isFinite(Date.parse(slice.anchorAt)) || !Number.isFinite(Date.parse(slice.queriedAt)) ||
      !['PRESENT', 'CHECKOUT'].includes(slice.anchorKind) || !Number.isInteger(slice.offset) || slice.offset < 0 || !Number.isInteger(slice.limit) || slice.limit < 1 || slice.limit > 100) { this.close(); return undefined }
    if (slice.upperBound !== null && (typeof slice.upperBound !== 'string' || !Number.isFinite(Date.parse(slice.upperBound))) || slice.since !== null && (typeof slice.since !== 'string' || !Number.isFinite(Date.parse(slice.since)))) { this.close(); return undefined }
    return slice
  }

  getDisplayCommit(sha: string): AtlasCommit | undefined {
    if(!this.db) return undefined
    try {
      const row=this.statement('SELECT author,committed_at AS timestamp,subject,parent_count,normalized FROM git_commit WHERE sha=?').get(sha) as {author:string;timestamp:string;subject:string;parent_count:number;normalized:number}|undefined
      if(!row) return undefined
      if(!row.normalized) {
        const legacy=this.getCommit(sha)
        return legacy ? {sha:legacy.sha,parents:legacy.parents,author:legacy.author,timestamp:legacy.timestamp,subject:legacy.subject} : undefined
      }
      const parents=(this.statement('SELECT parent_sha FROM atlas_parent WHERE child_sha=? ORDER BY position LIMIT 1025').all(sha) as Array<{parent_sha:string}>).map(parent=>parent.parent_sha)
      if(parents.length!==row.parent_count || parents.some(parent=>!shaPattern.test(parent)) || typeof row.author!=='string' || typeof row.subject!=='string' || !Number.isFinite(Date.parse(row.timestamp))) throw new Error('ATLAS_CATALOG_INTEGRITY')
      return {sha,parents,author:row.author,timestamp:row.timestamp,subject:row.subject}
    } catch(error) { this.failure(error); return undefined }
  }

  findSlice(revision: string, since: string | null, until: string): AtlasHistorySlice | undefined {
    if (!this.db) return undefined
    try {
      const start = since === null ? null : Date.parse(since)
      const row = this.statement('SELECT key FROM history_slice WHERE revision = ? AND complete = 1 AND page_offset = 0 AND (since_ms IS NULL OR (? IS NOT NULL AND since_ms <= ?)) AND (upper_ms IS NULL OR upper_ms >= ?) ORDER BY last_access DESC LIMIT 1').get(revision, start, start, Date.parse(until)) as { key: string } | undefined
      return row ? this.getSlice(row.key) : undefined
    } catch { this.close(); return undefined }
  }

  private putCommit(commit: AtlasCommit, observation: Pick<AtlasCatalogManifest,'revision'|'worktreeGeneration'|'observedAt'>) {
    if(commit.message===undefined) {
      const normalized=this.statement('SELECT normalized FROM git_commit WHERE sha=?').get(commit.sha) as {normalized:number}|undefined
      if(normalized?.normalized) {
        const display=this.getDisplayCommit(commit.sha)
        if(!display || JSON.stringify([display.parents,display.author,display.timestamp,display.subject])!==JSON.stringify([commit.parents,commit.author,commit.timestamp,commit.subject])) throw new Error('ATLAS_CATALOG_IMMUTABLE_CONFLICT')
        this.statement('INSERT OR IGNORE INTO atlas_commit_observation(sha,revision,observer_generation,observed_at,source) VALUES (?,?,?,?,?)').run(commit.sha,observation.revision,observation.worktreeGeneration,observation.observedAt,'GIT_LOCAL')
        return
      }
    }
    const previous=this.getCommit(commit.sha)
    if(previous && JSON.stringify([previous.parents,previous.author,previous.timestamp,previous.subject])!==JSON.stringify([commit.parents,commit.author,commit.timestamp,commit.subject])) throw new Error('ATLAS_CATALOG_IMMUTABLE_CONFLICT')
    const merged={...previous,...commit}
    for(const key of ['message','committer','authoredAt','authorEmail','committerEmail'] as const) {
      if(previous?.[key]!==undefined && commit[key]!==undefined && previous[key]!==commit[key]) throw new Error('ATLAS_CATALOG_IMMUTABLE_CONFLICT')
      if(commit[key]===undefined && previous?.[key]!==undefined) merged[key]=previous[key]
    }
    const body=JSON.stringify(merged),bytes=Buffer.byteLength(body)
    if(bytes>4*1024*1024) throw new Error('ATLAS_FACT_SIZE_LIMIT')
    this.statement('INSERT INTO git_commit(sha,body,checksum,bytes,last_access,author,committed_at,subject,message,committer,authored_at,parent_count,normalized) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(sha) DO UPDATE SET body=excluded.body,checksum=excluded.checksum,bytes=excluded.bytes,last_access=excluded.last_access,author=excluded.author,committed_at=excluded.committed_at,subject=excluded.subject,message=excluded.message,committer=excluded.committer,authored_at=excluded.authored_at,parent_count=excluded.parent_count,normalized=1').run(merged.sha,body,digest(merged.sha+body),bytes,Date.now(),merged.author,merged.timestamp,merged.subject,merged.message??null,merged.committer??null,merged.authoredAt??null,merged.parents.length)
    merged.parents.forEach((parent,position)=>this.statement('INSERT OR IGNORE INTO atlas_parent(child_sha,position,parent_sha) VALUES (?,?,?)').run(merged.sha,position,parent))
    this.statement('INSERT OR IGNORE INTO atlas_commit_observation(sha,revision,observer_generation,observed_at,source) VALUES (?,?,?,?,?)').run(merged.sha,observation.revision,observation.worktreeGeneration,observation.observedAt,'GIT_LOCAL')
  }

  private observe(manifest: AtlasCatalogManifest) {
    for(const ref of [...manifest.refs,...manifest.tags.map(tag=>({ref:`refs/tags/${tag.name}`,sha:tag.sha,kind:'TAG'}))]) this.statement('INSERT OR IGNORE INTO atlas_ref_observation(scope_key,revision,observer_generation,ref,sha,kind,observed_at,source) VALUES (?,?,?,?,?,?,?,?)').run(manifest.scopeKey,manifest.revision,manifest.worktreeGeneration,ref.ref,ref.sha,ref.kind,manifest.observedAt,'GIT_LOCAL')
  }

  save(key: string, slice: AtlasHistorySlice, commits: readonly AtlasCommit[], observation?: AtlasCatalogManifest): boolean {
    if (!this.db) return false
    try {
      if(commits.length>102) throw new Error('ATLAS_BATCH_LIMIT')
      const body = JSON.stringify(slice), bytes = Buffer.byteLength(body)
      this.db.transaction(() => {
        const now = Date.now()
        for(const commit of commits) this.putCommit(commit,observation??{revision:slice.revision,worktreeGeneration:slice.worktreeGeneration,observedAt:slice.queriedAt})
        if(observation) this.observe(observation)
        if(bytes<=32*1024) this.statement('INSERT OR REPLACE INTO history_slice(key, body, checksum, bytes, last_access, revision, since_ms, upper_ms, page_offset, complete) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(key, body, digest(key + body), bytes, now, slice.revision, slice.since === null ? null : Date.parse(slice.since), slice.upperBound === null ? null : Date.parse(slice.upperBound), slice.offset, Number(!slice.hasMore))
      })()
      this.scheduleMaintenance()
      return true
    } catch(error) { this.failure(error); return false }
  }

  beginRound(manifest: AtlasCatalogManifest): AtlasCollectionRound | undefined {
    if(!this.db || this.health.state!=='READY') return undefined
    try {
      const id=digest(JSON.stringify([manifest.scopeKey,manifest.revision,manifest.topology,[...manifest.tips].sort(),'PARENT_FRONTIER_V1']))
      if(!this.getRound(id)) this.db.transaction(()=>{
        this.statement('INSERT INTO atlas_round(id,manifest,topology,revision,status,checkpoint_version,ordering,updated_at) VALUES (?,?,?,?,?,1,?,?)').run(id,JSON.stringify(manifest),manifest.topology,manifest.revision,'NOT_STARTED','PARENT_FRONTIER_V1',new Date().toISOString())
        for(const sha of manifest.tips) this.statement('INSERT OR IGNORE INTO atlas_frontier(round_id,sha) VALUES (?,?)').run(id,sha)
        this.observe(manifest)
      })()
      return this.getRound(id)
    } catch(error) { this.failure(error); return undefined }
  }

  getRound(id: string): AtlasCollectionRound | undefined {
    if(!this.db) return undefined
    try {
      const row=this.statement('SELECT * FROM atlas_round WHERE id=?').get(id) as {manifest:string;status:AtlasCollectionRound['status'];checkpoint_version:number;ordering:string;acquired:number;reason:string|null}|undefined
      if(!row) return undefined
      if(row.checkpoint_version!==1 || row.ordering!=='PARENT_FRONTIER_V1' || !['NOT_STARTED','PARTIAL','COMPLETE','UNKNOWN'].includes(row.status)) throw new Error('ATLAS_CHECKPOINT_INCOMPATIBLE')
      return {id,manifest:JSON.parse(row.manifest),status:row.status,checkpointVersion:1,ordering:'PARENT_FRONTIER_V1',acquired:row.acquired,reason:row.reason}
    } catch(error) { this.failure(error); return undefined }
  }

  frontier(id: string, limit: number): string[] {
    if(!this.db) return []
    try {
      if(!Number.isInteger(limit)||limit<1||limit>64) throw new Error('ATLAS_BATCH_LIMIT')
      return (this.statement('SELECT sha FROM atlas_frontier WHERE round_id=? ORDER BY id LIMIT ?').all(id,limit) as Array<{sha:string}>).map(row=>row.sha)
    } catch(error) { this.failure(error); return [] }
  }

  covered(sha: string, topology: string): boolean {
    if(!this.db) return false
    try { return !!this.statement('SELECT 1 FROM atlas_round_visit v JOIN atlas_round r ON r.id=v.round_id WHERE v.sha=? AND r.topology=? AND r.status=? LIMIT 1').get(sha,topology,'COMPLETE') }
    catch(error) { this.failure(error); return false }
  }

  checkpoint(id: string, commits: readonly AtlasCommit[], processed: readonly string[]): boolean {
    if(!this.db || this.health.state!=='READY') return false
    try {
      if(processed.length>64 || commits.length>64) throw new Error('ATLAS_BATCH_LIMIT')
      const round=this.getRound(id)
      if(!round||round.status==='COMPLETE') return false
      this.db.transaction(()=>{
        for(const commit of commits) this.putCommit(commit,round.manifest)
        const accepted: AtlasCommit[]=[]
        for(const sha of processed) {
          if(!this.statement('SELECT 1 FROM atlas_frontier WHERE round_id=? AND sha=?').get(id,sha)) throw new Error('ATLAS_CHECKPOINT_STALE')
          const commit=this.getCommit(sha)
          if(!commit || typeof commit.message!=='string') throw new Error('ATLAS_METADATA_INCOMPLETE')
          if(!commits.some(item=>item.sha===sha)) this.putCommit(commit,round.manifest)
          accepted.push(commit)
          this.statement('INSERT OR IGNORE INTO atlas_round_visit(round_id,sha) VALUES (?,?)').run(id,sha)
        }
        if(accepted.reduce((count,commit)=>count+commit.parents.length,0)>4096) throw new Error('ATLAS_BATCH_LIMIT')
        for(const commit of accepted) {
          if(!this.covered(commit.sha,round.manifest.topology)) for(const parent of commit.parents) {
            if(!this.covered(parent,round.manifest.topology) && !this.statement('SELECT 1 FROM atlas_round_visit WHERE round_id=? AND sha=?').get(id,parent)) this.statement('INSERT OR IGNORE INTO atlas_frontier(round_id,sha) VALUES (?,?)').run(id,parent)
          }
          this.statement('DELETE FROM atlas_frontier WHERE round_id=? AND sha=?').run(id,commit.sha)
        }
        this.statement('UPDATE atlas_round SET status=?,acquired=acquired+?,reason=NULL,updated_at=? WHERE id=?').run('PARTIAL',processed.length,new Date().toISOString(),id)
      })()
      return true
    } catch(error) { this.failure(error); return false }
  }

  finishRound(id: string, revision: string, available: boolean): boolean {
    if(!this.db || this.health.state!=='READY') return false
    try {
      return this.db.transaction(()=>{
        const round=this.getRound(id)
        if(!round || round.manifest.revision!==revision || !available || !round.manifest.available) { this.markUnknown(id,'SOURCE_COVERAGE_UNAVAILABLE'); return false }
        if(this.statement('SELECT 1 FROM atlas_frontier WHERE round_id=? LIMIT 1').get(id)) return false
        this.statement('UPDATE atlas_round SET status=?,reason=NULL,updated_at=? WHERE id=?').run('COMPLETE',new Date().toISOString(),id)
        return true
      })()
    } catch(error) { this.failure(error); return false }
  }

  markUnknown(id: string, reason: string): void {
    if(!this.db) return
    try { this.statement('UPDATE atlas_round SET status=?,reason=?,updated_at=? WHERE id=? AND status<>?').run('UNKNOWN',reason,new Date().toISOString(),id,'COMPLETE') }
    catch(error) { this.failure(error) }
  }

  private scheduleMaintenance() {
    if (!this.db || this.maintenance) return
    this.maintenance = setImmediate(() => {
      this.maintenance = undefined
      if (!this.db) return
      try {
        const stats = this.statement('SELECT COUNT(*) AS slices,COALESCE(SUM(bytes),0) AS bytes FROM history_slice').get() as {slices:number;bytes:number}
        if(stats.slices<=256 && stats.bytes<=8*1024*1024) return
        this.statement('DELETE FROM history_slice WHERE key IN (SELECT key FROM history_slice ORDER BY last_access LIMIT 32)').run()
        this.scheduleMaintenance()
      } catch(error) { this.failure(error) }
    })
  }

  close(): void {
    if (this.maintenance) clearImmediate(this.maintenance)
    this.maintenance = undefined
    try { this.db?.close() } catch {}
    this.db = undefined; this.statements.clear()
  }
}
