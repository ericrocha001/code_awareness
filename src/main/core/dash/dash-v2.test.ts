import { describe, expect, it } from 'vitest'
import { DashService } from './dash-service'
import { fixtureMap, request, elements } from './dash-v2-fixtures'
import { getCanonicalTokenizer } from '../tokenizer'
import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import type { PersistedSymbolReference } from '../symbol-reference-resolver'

describe('Pure Signal pipeline', () => {
  it('projects only explicit fields, deduplicates and never reads implicit source', async () => {
    const map = fixtureMap()
    const req = request()
    req.steps.push({ id: 'unused', from: 'x', follow: 'contains', expect: { min: 1, max: 1 } })
    req.emit.push({ from: 'x', include: ['signature'] })
    const result = await new DashService(map).execute(JSON.stringify(req), 'repo')
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(JSON.parse(result.context)).toEqual([
      { name: 'SyncService', signature: 'SyncService()' }
    ])
    expect(map.getElementExactSources).not.toHaveBeenCalled()
    expect(map.getFileContent).not.toHaveBeenCalled()
    expect(result.tokenCount).toBe(getCanonicalTokenizer().count(result.context))
  })
  it('batch retrieves only emitted exact elements and preserves literal Unicode', async () => {
    const map = fixtureMap()
    const req = request()
    req.emit[0].include = ['source']
    const result = await new DashService(map).execute(JSON.stringify(req), 'repo')
    expect(result.success).toBe(true)
    if (result.success)
      expect(JSON.parse(result.context)).toEqual([
        { source: `literal ${elements[0].id} <>&\r\n🚀` }
      ])
    expect(map.getElementExactSources).toHaveBeenCalledWith('repo', [elements[0].id])
    expect(map.getFileContent).not.toHaveBeenCalled()
  })
  it('fails budget without a partial packet', async () => {
    const req = { ...request(), limits: { maxTokens: 1 } }
    const result = await new DashService(fixtureMap()).execute(JSON.stringify(req), 'repo')
    expect(result).toMatchObject({ success: false, report: { error: { code: 'BUDGET_EXCEEDED' } } })
    expect(result).not.toHaveProperty('context')
  })
  it('rejects unknown fields before accessing the map', async () => {
    const map = fixtureMap()
    const result = await new DashService(map).execute(
      JSON.stringify({ ...request(), output: {} }),
      'repo'
    )
    expect(result).toMatchObject({ success: false, report: { error: { code: 'UNKNOWN_FIELD' } } })
    expect(map.awaitReadiness).not.toHaveBeenCalled()
  })
  it('never falls back when exact source is stale', async () => {
    const map = fixtureMap()
    map.getElementExactSources = async () => new Map()
    const req = request()
    req.emit[0].include = ['source']
    const result = await new DashService(map).execute(JSON.stringify(req), 'repo')
    expect(result).toMatchObject({
      success: false,
      report: { error: { code: 'EXACT_SOURCE_UNAVAILABLE' } }
    })
    expect(result).not.toHaveProperty('context')
    expect(map.getFileContent).not.toHaveBeenCalled()
  })
  it('file metadata requires only inventory and zero structure/source access', async () => {
    const map = fixtureMap()
    map.getElements = vi.fn(() => {
      throw new Error('Unexpected structure access')
    })
    const req = {
      protocol: 'code-dash/v2',
      steps: [
        {
          id: 'x',
          find: 'file',
          where: { path: { exact: 'src/sync.ts' } },
          expect: { min: 1, max: 1 }
        }
      ],
      emit: [{ from: 'x', include: ['path', 'bytes'] }]
    }
    const result = await new DashService(map).execute(JSON.stringify(req), 'repo')
    expect(result).toMatchObject({ success: true, context: '[{"path":"src/sync.ts","bytes":100}]' })
    expect(map.awaitReadiness).toHaveBeenCalledExactlyOnceWith('repo', 'FILE_INVENTORY')
    expect(map.getFileContent).not.toHaveBeenCalled()
    expect(map.getElements).not.toHaveBeenCalled()
  })
  it('explicit fileSource is literal, hash checked, never truncated', async () => {
    const map = fixtureMap()
    const content = 'literal 日本語\r\n<>&'
    map.getFiles = () => [
      {
        ...fixtureMap().getFiles('repo')[1],
        contentHash: createHash('sha256').update(content).digest('hex')
      }
    ]
    map.getFileContent = vi.fn(async () => ({
      content,
      relativePath: 'src/sync.ts',
      truncated: false,
      lines: 2,
      sizeBytes: Buffer.byteLength(content)
    }))
    const req = {
      protocol: 'code-dash/v2',
      steps: [
        {
          id: 'x',
          find: 'file',
          where: { path: { exact: 'src/sync.ts' } },
          expect: { min: 1, max: 1 }
        }
      ],
      emit: [{ from: 'x', include: ['fileSource'] }]
    }
    const service = new DashService(map)
    const result = await service.execute(JSON.stringify(req), 'repo')
    expect(result.success).toBe(true)
    if (result.success) expect(JSON.parse(result.context)).toEqual([{ fileSource: content }])
    map.getFileContent = async () => ({
      content,
      relativePath: 'src/sync.ts',
      truncated: true,
      lines: 2,
      sizeBytes: 100
    })
    expect(await service.execute(JSON.stringify(req), 'repo')).toMatchObject({
      success: false,
      report: { error: { code: 'EXACT_SOURCE_UNAVAILABLE' } }
    })
    map.getFileContent = async () => ({
      content: 'changed',
      relativePath: 'src/sync.ts',
      truncated: false,
      lines: 2,
      sizeBytes: 7
    })
    expect(await service.execute(JSON.stringify(req), 'repo')).toMatchObject({
      success: false,
      report: { error: { code: 'STALE_SOURCE' } }
    })
  })
  it('references project only requested occurrence fields and deduplicate', async () => {
    const map = fixtureMap()
    const ref = {
      id: 'r',
      repositoryId: 'repo',
      sourceFileId: 'f0',
      sourceElementId: elements[1].id,
      targetElementId: elements[0].id,
      kind: 'call',
      location: elements[1].location
    } as PersistedSymbolReference
    map.getSymbolReferencesByTargetElement = () => [ref, ref]
    const req = request()
    req.steps.push({ id: 'refs', from: 'x', follow: 'references', expect: { min: 1, max: 1 } })
    req.emit = [{ from: 'refs', include: ['line', 'kind'] }]
    const result = await new DashService(map).execute(JSON.stringify(req), 'repo')
    expect(result).toMatchObject({ success: true, context: '[{"line":2,"kind":"call"}]' })
    expect(map.getElementExactSources).not.toHaveBeenCalled()
    expect(map.getFileContent).not.toHaveBeenCalled()
  })
})
