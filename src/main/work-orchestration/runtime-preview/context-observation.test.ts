import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, renameSync, watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { RepositoryPreviewContextProvisioner, previewCorpusPath } from './context-data'
import type { PreviewProfile } from '../preview-profile'
vi.mock('node:fs', async original => { const actual = await original<typeof import('node:fs')>(); return { ...actual, watch: vi.fn(actual.watch) } })
const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.reverse()) close(); cleanup.length = 0 })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'preview-corpus-observer-')), file = previewCorpusPath(root, 'repo')
  mkdirSync(dirname(file), { recursive: true })
  const writer = new DatabaseSync(file); writer.exec(`PRAGMA journal_mode=WAL; CREATE TABLE data(value TEXT); INSERT INTO data VALUES ('original')`)
  const sink = vi.fn(), readers: DatabaseSync[] = []
  const provider = new RepositoryPreviewContextProvisioner({} as any, join(root, 'continuum'), ((path: string) => {
    const db = new DatabaseSync(path, { readOnly: true }); readers.push(db)
    return { pragma: () => db.prepare('PRAGMA data_version').get()!.data_version, close: () => { if (db.isOpen) db.close() } }
  }) as any)
  const observation = provider.observeChanges({ repositoryId: 'repo', bootstrap: { dataPolicy: 'REPOSITORY_SNAPSHOT' } } as PreviewProfile, sink)
  cleanup.push(() => rmSync(root, { recursive: true, force: true }), () => { if (writer.isOpen) writer.close() }, observation.close)
  return { file, writer, observation, sink, readers }
}
describe('corpus materiality with real SQLite in Node, without Electron', () => {
  it('preserves preparation after WAL touches/checkpoint without an external commit', async () => {
    const f = fixture(); f.writer.exec('PRAGMA wal_checkpoint(PASSIVE)')
    utimesSync(f.file + '-wal', new Date(), new Date())
    await vi.waitFor(() => expect(f.sink).toHaveBeenCalled())
    expect(f.observation.state).toBe('SUSPECT')
    await expect(Promise.resolve(f.observation.assertCurrent())).resolves.toBeUndefined()
    expect(f.observation.state).toBe('CURRENT')
    expect(f.sink).toHaveBeenCalledWith(expect.objectContaining({ decision: 'NO_CHANGE' }))
    expect(() => f.readers[0].exec(`INSERT INTO data VALUES ('forbidden')`)).toThrow()
  })
  it('rejects a commit made by another connection, including WAL-only changes', () => {
    const f = fixture(); f.writer.exec(`INSERT INTO data VALUES ('changed')`)
    expect(() => f.observation.assertCurrent()).toThrow('PREPARED_CORPUS_CHANGED')
    expect(f.observation.state).toBe('INVALID')
  })
  it('rejects a different physical database', () => {
    const f = fixture(); f.readers.forEach(db => db.close()); f.writer.close(); renameSync(f.file, f.file + '.previous')
    const replacement = new DatabaseSync(f.file); replacement.close()
    expect(() => f.observation.assertCurrent()).toThrow('PREPARED_CORPUS_IDENTITY_CHANGED')
  })
  it('never accepts a closed observer and closes its read-only connection once', () => {
    const f = fixture(); f.observation.close(); f.observation.close()
    expect(() => f.observation.assertCurrent()).toThrow('PREVIEW_CORPUS_OBSERVER_LOST')
    expect(f.observation.state).toBe('UNVERIFIABLE')
  })
  it.each(['error', 'close', 'event storm'])('loses coverage after an unexpected watcher %s', event => {
    const f = fixture(), watcher = vi.mocked(watch).mock.results.at(-1)!.value
    if (event === 'event storm') {
      const call = (vi.mocked(watch).mock.calls as unknown as Array<[string, unknown, (event: string, path: string) => void]>).at(-1)!
      for (let i = 0; i < 1025; i++) call[2]('change', 'continuum.db-wal')
    } else watcher.emit(event, ...(event === 'error' ? [new Error('fixture loss')] : []))
    expect(() => f.observation.assertCurrent()).toThrow('PREVIEW_CORPUS_OBSERVER_LOST')
    expect(f.observation.state).toBe('UNVERIFIABLE')
    expect(f.sink).toHaveBeenCalledWith(expect.objectContaining({ decision: 'COVERAGE_LOST' }))
  })

})
