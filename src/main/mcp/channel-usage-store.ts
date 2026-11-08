import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import type { UsageBatch, UsageQuery } from './channel-usage-types'

const dayMs = 86_400_000
const iso = (at: number) => new Date(at).toISOString()
const utcDay = (at: number) => iso(at).slice(0, 10)

export class ChannelUsageStore {
  private readonly db: Database.Database
  private readonly snapshots = new Map<string, { signature: string; expires: number; base: object; key: string; items: unknown[] }>()
  private currentRunId?: string

  constructor(path: string) {
    this.db = new Database(path, { timeout: 1000 })
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_batches (run TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_runs (id TEXT PRIMARY KEY, start INTEGER NOT NULL, last INTEGER NOT NULL, stopped INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS usage_losses (batch TEXT PRIMARY KEY, start INTEGER NOT NULL, end INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_tools (name TEXT PRIMARY KEY, capability TEXT NOT NULL, instrumental INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_catalogs (id INTEGER PRIMARY KEY, run TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER, repository TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_exposure (catalog INTEGER NOT NULL, name TEXT NOT NULL, PRIMARY KEY(catalog,name));
      CREATE INDEX IF NOT EXISTS usage_exposure_tool ON usage_exposure(name,catalog);
      CREATE TABLE IF NOT EXISTS usage_daily (
        day TEXT NOT NULL, name TEXT NOT NULL, capability TEXT NOT NULL, repository TEXT NOT NULL,
        calls INTEGER NOT NULL, errors INTEGER NOT NULL, timeouts INTEGER NOT NULL, duration REAL NOT NULL, maximum REAL NOT NULL,
        PRIMARY KEY(day,name,capability,repository));
      CREATE INDEX IF NOT EXISTS usage_daily_tool ON usage_daily(name,day);
      CREATE INDEX IF NOT EXISTS usage_daily_repository ON usage_daily(repository,day);
    `)
  }

  write(batch: UsageBatch): void {
    this.db.transaction(() => {
      if (!this.db.prepare(`INSERT INTO usage_batches VALUES(?,?) ON CONFLICT(run) DO UPDATE SET sequence=excluded.sequence WHERE sequence<excluded.sequence`).run(batch.runId, batch.id).changes) return
      this.db.prepare(`INSERT INTO usage_runs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET last=MAX(last,excluded.last), stopped=MAX(stopped,excluded.stopped)`)
        .run(batch.runId, batch.startedAt, batch.at, batch.stopped ? 1 : 0)
      const tool = this.db.prepare('INSERT INTO usage_tools VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET capability=excluded.capability, instrumental=excluded.instrumental')
      for (const catalog of batch.catalogs) {
        const hash = createHash('sha256').update(JSON.stringify(catalog.tools)).digest('hex')
        this.db.prepare('UPDATE usage_catalogs SET end=? WHERE run=? AND end IS NULL').run(catalog.at, batch.runId)
        const id = this.db.prepare('INSERT INTO usage_catalogs(run,start,end,repository,hash) VALUES(?,?,NULL,?,?)').run(batch.runId, catalog.at, catalog.repositoryId ?? '', hash).lastInsertRowid
        for (const entry of catalog.tools) {
          tool.run(entry.name, entry.capability, Number(entry.instrumental))
          this.db.prepare('INSERT INTO usage_exposure VALUES(?,?)').run(id, entry.name)
        }
      }
      const increment = this.db.prepare(`INSERT INTO usage_daily VALUES(?,?,?,?,1,?,?,?,?)
        ON CONFLICT(day,name,capability,repository) DO UPDATE SET calls=calls+1, errors=errors+excluded.errors,
          timeouts=timeouts+excluded.timeouts,duration=duration+excluded.duration,maximum=MAX(maximum,excluded.maximum)`)
      for (const event of batch.completions) {
        tool.run(event.name, event.capability, Number(event.instrumental))
        increment.run(utcDay(event.at), event.name, event.capability, event.repositoryId ?? '',
          Number(event.status !== 'success'), Number(event.status === 'timeout'), event.durationMs, event.durationMs)
      }
      if (batch.losses) this.db.prepare('INSERT INTO usage_losses VALUES(?,?,?,?)').run(`${batch.runId}:${batch.id}`, batch.startedAt, batch.at, batch.losses)
    })()
  }

  query(query: UsageQuery, asOf = Date.now()): unknown {
    const signature = createHash('sha256').update(JSON.stringify({ ...query, cursor: undefined })).digest('hex')
    if (query.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString())
        const snapshot = this.snapshots.get(cursor.id)
        if (!snapshot || snapshot.signature !== signature || snapshot.expires < asOf || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > snapshot.items.length) throw new Error()
        return this.page(cursor.id, cursor.offset, query.limit)
      } catch { throw new Error('USAGE_CURSOR_STALE') }
    }
    const first = this.db.prepare('SELECT MIN(start) AS first FROM usage_runs').get() as { first: number | null }
    const start = query.days === 'all' ? first.first ?? asOf : Math.floor(asOf / dayMs) * dayMs - (Number(query.days) - 1) * dayMs
    const end = asOf
    const params = { start, end, firstDay: utcDay(start), lastDay: utcDay(end), repository: query.repositoryId ?? null, capability: query.capability ?? null, instrumental: Number(query.view !== 'ranking' || query.includeInstrumental) }
    const cte = `WITH totals AS (
      SELECT name, SUM(calls) calls, SUM(errors) errors, SUM(timeouts) timeouts, SUM(duration) duration, MAX(maximum) maximum
      FROM usage_daily WHERE day>=@firstDay AND day<=@lastDay AND (@repository IS NULL OR repository=@repository)
        AND (@capability IS NULL OR capability=@capability) GROUP BY name
    ), exposure AS (
      SELECT e.name, MIN(MAX(c.start,@start)) firstExposure, MAX(MIN(COALESCE(c.end,r.last),r.last,@end)) lastExposure,
        SUM(MAX(0,MIN(COALESCE(c.end,r.last),r.last,@end)-MAX(c.start,@start))) exposedMs
      FROM usage_exposure e JOIN usage_catalogs c ON e.catalog=c.id JOIN usage_runs r ON r.id=c.run
      WHERE c.start<=@end AND COALESCE(c.end,r.last)>=@start AND (@repository IS NULL OR c.repository=@repository)
      GROUP BY e.name
    ), rows AS (
      SELECT t.name toolName,t.capability,t.instrumental,COALESCE(u.calls,0) calls,COALESCE(u.errors,0) errors,
        COALESCE(u.timeouts,0) timeouts,COALESCE(u.duration,0) duration,COALESCE(u.maximum,0) maximum,
        e.firstExposure,e.lastExposure,COALESCE(e.exposedMs,0) exposedMs
      FROM usage_tools t LEFT JOIN totals u ON u.name=t.name LEFT JOIN exposure e ON e.name=t.name
      WHERE (@capability IS NULL OR t.capability=@capability) AND (@instrumental=1 OR t.instrumental=0)
    ) `
    const losses = this.db.prepare('SELECT COALESCE(SUM(count),0) AS count FROM usage_losses WHERE start<=@end AND end>=@start').get(params) as { count: number }
    const windows = this.db.prepare('SELECT id,start,last,stopped FROM usage_runs WHERE start<=@end AND last>=@start ORDER BY start DESC LIMIT 21').all(params) as { id: string; start: number; last: number; stopped: number }[]
    const lossWindows = this.db.prepare('SELECT start,end,count FROM usage_losses WHERE start<=@end AND end>=@start ORDER BY end DESC LIMIT 21').all(params) as { start: number; end: number; count: number }[]
    const coverage = {
      source: 'LOCAL_ADAPTER_COMPLETIONS_ONLY', since: first.first === null ? null : iso(first.first),
      windows: windows.slice(0, 20).map(w => ({ start: iso(Math.max(start, w.start)), end: iso(Math.min(end, w.last)), cleanStop: !!w.stopped,
        state: w.stopped ? 'CLEAN_STOP' : w.id === this.currentRunId ? 'ACTIVE' : 'INTERRUPTED_UNCONFIRMED' })),
      moreWindows: windows.length > 20, lostRecords: losses.count,
      lossUnit: 'Completion or catalog record dropped or unconfirmed; conservative after uncertain commit outcome.',
      lossWindows: lossWindows.slice(0, 20).map(w => ({ start: iso(Math.max(start, w.start)), end: iso(Math.min(end, w.end)), count: w.count })), moreLossWindows: lossWindows.length > 20,
      partialDays: true, gaps: 'Outside capture windows is unobserved; an unclean stop may lose the unconfirmed batch.',
      limitations: 'No relay/edge rejections, payloads, tokens or cloud costs. Zero calls is not evidence of low value.'
    }
    const common = { period: { days: query.days, start: iso(start), end: iso(end), asOf: iso(asOf), interval: 'UTC calendar days including today; end inclusive', dailyBuckets: true }, coverage }
    const summarize = (row: any) => ({ toolName: row.toolName, capability: row.capability, instrumental: !!row.instrumental,
      calls: row.calls, successes: row.calls - row.errors, errors: row.errors, timeouts: row.timeouts,
      errorRate: row.calls ? row.errors / row.calls : 0, timeoutRate: row.calls ? row.timeouts / row.calls : 0,
      averageDurationMs: row.calls ? row.duration / row.calls : 0, maxDurationMs: row.maximum,
      firstExposure: row.firstExposure === null ? null : iso(row.firstExposure), lastExposure: row.lastExposure === null ? null : iso(row.lastExposure),
      exposedMs: row.exposedMs, observation: losses.count ? 'KNOWN_CAPTURE_LOSS' : row.exposedMs < end - start ? 'PARTIAL_EXPOSURE' : 'COVERED_EXPOSURE',
      availability: row.firstExposure === null ? 'NOT_EXPOSED_IN_WINDOW' : row.calls ? 'EXPOSED_WITH_CALLS' : 'EXPOSED_NO_OBSERVED_CALLS' })
    if (query.view === 'overview') {
      const totals = this.db.prepare(cte + `SELECT COUNT(*) knownTools, SUM(firstExposure IS NOT NULL) exposedTools,
        SUM(calls>0) toolsWithCalls,SUM(calls=0 AND firstExposure IS NOT NULL) exposedZeroTools,
        COALESCE(SUM(calls),0) calls,COALESCE(SUM(errors),0) errors,COALESCE(SUM(timeouts),0) timeouts,
        COALESCE(SUM(calls=0 AND firstExposure IS NOT NULL AND exposedMs>=@end-@start AND @losses=0),0) coveredZeroTools FROM rows`).get({ ...params, losses: losses.count }) as any
      return { ...common, ...totals, errorRate: totals.calls ? totals.errors / totals.calls : 0, timeoutRate: totals.calls ? totals.timeouts / totals.calls : 0 }
    }
    if (query.view === 'tool') {
      const row = this.db.prepare(cte + 'SELECT * FROM rows WHERE toolName=@tool').get({ ...params, tool: query.toolName })
      if (!row) throw new Error('USAGE_TOOL_NOT_FOUND')
      const daily = query.includeDaily ? this.db.prepare(`SELECT day,SUM(calls) calls,SUM(errors) errors,SUM(timeouts) timeouts,
        SUM(duration)/SUM(calls) averageDurationMs,MAX(maximum) maxDurationMs FROM usage_daily
        WHERE name=@tool AND day>=@firstDay AND day<=@lastDay AND (@repository IS NULL OR repository=@repository)
          AND (@capability IS NULL OR capability=@capability) GROUP BY day ORDER BY day LIMIT 10001`)
        .all({ ...params, tool: query.toolName }) : undefined
      const base = { ...common, tool: summarize(row) }
      return daily ? this.snapshot(signature, base, 'daily', daily, query.limit, asOf) : base
    }
    const where = query.availability === 'exposed' ? 'firstExposure IS NOT NULL' : query.availability === 'unexposed' ? 'firstExposure IS NULL' : query.availability === 'zero' ? 'firstExposure IS NOT NULL AND calls=0' : '1=1'
    const rows = this.db.prepare(cte + `SELECT * FROM rows WHERE ${where} ORDER BY ${query.sort === 'timeouts' ? 'timeouts' : 'calls'} ${query.order === 'asc' ? 'ASC' : 'DESC'}, toolName COLLATE BINARY ASC LIMIT 10001`).all(params)
    return this.snapshot(signature, common, 'items', rows.map(summarize), query.limit, asOf)
  }

  private snapshot(signature: string, base: object, key: string, items: unknown[], limit: number, now: number): unknown {
    if (items.length > 10000 || Buffer.byteLength(JSON.stringify(items)) > 1024 * 1024) throw new Error('USAGE_QUERY_BUDGET_EXCEEDED')
    const id = randomUUID()
    if (this.snapshots.size >= 8) this.snapshots.delete(this.snapshots.keys().next().value!)
    this.snapshots.set(id, { signature, base, key, items, expires: now + 5 * 60_000 })
    return this.page(id, 0, limit)
  }

  private page(id: string, offset: number, limit: number): unknown {
    const snapshot = this.snapshots.get(id)!
    return { ...snapshot.base, [snapshot.key]: snapshot.items.slice(offset, offset + limit),
      nextCursor: snapshot.items.length > offset + limit ? Buffer.from(JSON.stringify({ id, offset: offset + limit })).toString('base64url') : null,
      pagination: { consistency: 'SNAPSHOT', expiresInSeconds: 300, onExpired: 'Restart query without cursor; idle worker release also expires snapshots.' } }
  }

  touch(runId: string, at: number): void {
    this.currentRunId = runId
    this.db.prepare('UPDATE usage_runs SET last=MAX(last,?) WHERE id=? AND stopped=0').run(at, runId)
  }

  close(): void { this.db.close() }
}
