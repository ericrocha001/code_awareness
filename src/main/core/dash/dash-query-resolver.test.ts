import { describe, expect, it } from 'vitest'
import { DashQueryResolver } from './dash-query-resolver'
import { files, elements, fixtureMap, request } from './dash-v2-fixtures'
import type { DashRequest, DashFollow } from '../../../shared/types/dash-types'
import type { CodeMapElement, CodeMapRelationship } from '../../../shared/types'
import type { PersistedSymbolReference } from '../symbol-reference-resolver'
describe('deterministic map resolution', () => {
  it('finds lexical names and contains exactly one hop without source', async () => {
    const map = fixtureMap()
    const req = request()
    req.steps[0] = {
      id: 'x',
      find: 'element',
      where: { name: { containsAll: ['sync', 'service'] }, path: { startsWith: 'src/' } },
      expect: { min: 1, max: 1 }
    }
    req.steps.push({ id: 'child', from: 'x', follow: 'contains', expect: { min: 1, max: 1 } })
    const sets = await new DashQueryResolver(map, 'repo').resolve(req, { steps: [] })
    expect(sets.get('child')!.entities.map((x) => x.id)).toEqual([elements[1].id])
    expect(map.getElementExactSources).not.toHaveBeenCalled()
    expect(map.awaitReadiness).toHaveBeenCalledTimes(1)
  })
  it('does not choose or widen cardinality mismatches', async () => {
    const req = request()
    req.steps[0] = {
      id: 'x',
      find: 'element',
      where: { kind: { exact: 'method' } },
      expect: { min: 1, max: 1 }
    }
    await expect(
      new DashQueryResolver(fixtureMap(), 'repo').resolve(req, { steps: [] })
    ).rejects.toMatchObject({ code: 'CARDINALITY_MISMATCH' })
    req.steps[0].where = { name: { exact: 'missing' } }
    await expect(
      new DashQueryResolver(fixtureMap(), 'repo').resolve(req, { steps: [] })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('deduplicates union with canonical ordering', async () => {
    const req = request()
    req.steps.push(
      {
        id: 'all',
        find: 'element',
        where: { path: { contains: 'src' } },
        expect: { min: 4, max: 4 }
      },
      { id: 'union', set: 'union', from: ['all', 'x'], expect: { min: 4, max: 4 } }
    )
    const sets = await new DashQueryResolver(fixtureMap(), 'repo').resolve(req, { steps: [] })
    expect(sets.get('union')!.entities.map((x) => x.id)).toEqual([
      elements[2].id,
      elements[0].id,
      elements[1].id,
      elements[3].id
    ])
  })
  it.each(['intersect', 'subtract'] as const)('implements %s by identity', async (operation) => {
    const req = request()
    req.steps.push(
      {
        id: 'all',
        find: 'element',
        where: { path: { contains: 'src' } },
        expect: { min: 4, max: 4 }
      },
      { id: 'set', set: operation, from: ['all', 'x'], expect: { min: 0, max: 4 } }
    )
    const sets = await new DashQueryResolver(fixtureMap(), 'repo').resolve(req, { steps: [] })
    expect(sets.get('set')!.entities.map((x) => x.id)).toEqual(
      operation === 'intersect'
        ? [elements[0].id]
        : [elements[2].id, elements[1].id, elements[3].id]
    )
  })
  it.each([
    ['extends', 0, 1],
    ['extendedBy', 1, 0],
    ['implements', 0, 2],
    ['implementedBy', 2, 0],
    ['containedBy', 3, 1],
    ['dependencies', 0, 2]
  ] as const)('follows %s in the requested direction only', async (follow, from, to) => {
    const map = fixtureMap()
    map.getRelationships = () =>
      [
        {
          sourceId: elements[0].id,
          targetId: elements[1].id,
          type: 'extends',
          sourceKind: 'element',
          targetKind: 'element'
        },
        {
          sourceId: elements[1].id,
          targetId: elements[3].id,
          type: 'extends',
          sourceKind: 'element',
          targetKind: 'element'
        },
        {
          sourceId: elements[0].id,
          targetId: elements[2].id,
          type: 'implements',
          sourceKind: 'element',
          targetKind: 'element'
        }
      ] as CodeMapRelationship[]
    map.getSymbolReferencesBySourceElement = () => [
      {
        id: 'r',
        targetElementId: elements[2].id,
        sourceFileId: files[0].id,
        sourceElementId: elements[0].id,
        location: elements[0].location,
        kind: 'call'
      } as PersistedSymbolReference
    ]
    const req = request()
    req.steps[0] = {
      id: 'x',
      find: 'element',
      where: { name: { exact: elements[from].name } },
      expect: { min: 1, max: 1 }
    }
    req.steps.push({ id: 'follow', from: 'x', follow, expect: { min: 1, max: 1 } })
    const result = await new DashQueryResolver(map, 'repo').resolve(req, { steps: [] })
    expect(result.get('follow')!.entities.map((x) => x.id)).toEqual([elements[to].id])
    expect(map.getElementExactSources).not.toHaveBeenCalled()
  })
  it.each(['imports', 'importedBy'] as DashFollow[])(
    'uses internal file import edges for %s',
    async (follow) => {
      const map = fixtureMap()
      map.getRelationships = () => [
        {
          sourceId: elements[0].id,
          targetId: files[1].id,
          sourceKind: 'element',
          targetKind: 'file',
          type: 'imports'
        } as CodeMapRelationship
      ]
      const from = follow === 'imports' ? 0 : 1
      const req: DashRequest = {
        protocol: 'code-dash/v2',
        steps: [
          {
            id: 'x',
            find: 'file',
            where: { path: { exact: files[from].relativePath } },
            expect: { min: 1, max: 1 }
          },
          { id: 'y', from: 'x', follow, expect: { min: 1, max: 1 } }
        ],
        emit: [{ from: 'y', include: ['path'] }]
      }
      const result = await new DashQueryResolver(map, 'repo').resolve(req, { steps: [] })
      expect(result.get('y')!.entities.map((x) => x.id)).toEqual([files[1 - from].id])
    }
  )
  it('accepts imports only from compatible import elements', async () => {
    const map = fixtureMap()
    const req = request()
    req.steps.push({ id: 'y', from: 'x', follow: 'imports', expect: { min: 0, max: 1 } })
    await expect(
      new DashQueryResolver(map, 'repo').resolve(req, { steps: [] })
    ).rejects.toMatchObject({ code: 'TYPE_MISMATCH' })
    map.getElements = () => [{ ...elements[0], kind: 'import' } as CodeMapElement]
    map.getRelationships = () => [
      {
        sourceId: elements[0].id,
        targetId: files[1].id,
        sourceKind: 'element',
        targetKind: 'file',
        type: 'imports'
      } as CodeMapRelationship
    ]
    const result = await new DashQueryResolver(map, 'repo').resolve(req, { steps: [] })
    expect(result.get('y')!.entities.map((x) => x.id)).toEqual([files[1].id])
  })
})
