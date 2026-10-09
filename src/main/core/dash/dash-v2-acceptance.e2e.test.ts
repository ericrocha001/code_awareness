import { describe, expect, it, vi } from 'vitest'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DashService } from './dash-service'
import { createRepositoryModel } from '../repository-model'
import type { DashMapPort } from './dash-map-port'
import type { DashFilter, DashRequest } from '../../../shared/types/dash-types'

const elementRequest = (where: Record<string, DashFilter>, include: string[]): DashRequest => ({
  protocol: 'code-dash/v2',
  steps: [{ id: 'target', find: 'element', where, expect: { min: 1, max: 1 } }],
  emit: [{ from: 'target', include }]
})
describe('Code Dash v2 real repository acceptance', () => {
  it('resolves seven scenarios on the actual Code Map with exact byte proof', async () => {
    const repo = process.cwd().replace(/\\/g, '/')
    const model = createRepositoryModel(repo)
    const map: DashMapPort = {
      awaitReadiness: async (_repo, capability) => {
        if (capability !== 'FILE_INVENTORY') await model.readiness.barrier(capability)
      },
      getFiles: () => model.getFiles(),
      getElements: () => model.getElementsByRepository(),
      getRelationships: () => model.getRelationships(),
      getSymbolReferencesBySourceElement: (_repo, id) =>
        model.getSymbolReferencesBySourceElement(id),
      getSymbolReferencesByTargetElement: (_repo, id) =>
        model.getSymbolReferencesByTargetElement(id),
      getElementExactSources: (_repo, ids) => model.getElementExactSources(ids),
      getFileContent: (_repo, path) => model.getFileContent(path)
    }
    const silent = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const measurements: Record<string, unknown>[] = []
    try {
      await model.indexRepository()
      const dash = new DashService(map)
      const exactRead = vi.spyOn(map, 'getElementExactSources')
      const fileRead = vi.spyOn(map, 'getFileContent')
      const execute = async (scenario: string, req: DashRequest, success = true) => {
        const result = await dash.execute(JSON.stringify(req), repo)
        expect(result.success, JSON.stringify(result.report)).toBe(success)
        measurements.push({
          scenario,
          requests: 1,
          tokens: result.report.tokenCount ?? 0,
          unsolicitedInformation: false,
          secondRequestNecessary: false,
          outcome: result.success ? 'PASS' : result.report.error?.code
        })
        if (!success) {
          expect(result).not.toHaveProperty('context')
          return []
        }
        if (!result.success) throw new Error('unreachable')
        return JSON.parse(result.context) as Record<string, unknown>[]
      }
      const functional = elementRequest({ name: { contains: 'dash' }, kind: { exact: 'class' } }, [
        'path',
        'signature',
        'source'
      ])
      functional.steps[0].expect = { min: 1, max: 4 }
      const functionalPacket = await execute('functional-need-without-repo-map', functional)
      expect(functionalPacket.some((x) => x.path === 'src/main/core/dash/dash-service.ts')).toBe(
        true
      )
      const exact = elementRequest(
        {
          name: { exact: 'readCode' },
          path: { exact: 'src/main/core/context/context-engine.ts' },
          kind: { exact: 'method' }
        },
        ['path', 'signature', 'source']
      )
      const packet = await execute('exact-element', exact)
      const element = map
        .getElements(repo)
        .find(
          (x) =>
            x.name === 'readCode' &&
            x.kind === 'method' &&
            map.getFiles(repo).find((f) => f.id === x.fileId)?.relativePath === packet[0].path
        )!
      const bytes = await readFile(join(repo, packet[0].path as string))
      expect(Buffer.from(packet[0].source as string)).toEqual(
        bytes.subarray(element.location.start.byte, element.location.end.byte)
      )
      expect(Object.keys(packet[0]).sort()).toEqual(['path', 'signature', 'source'])
      exactRead.mockClear()
      fileRead.mockClear()
      const relation = elementRequest(
        { name: { exact: 'DashService' }, kind: { exact: 'class' } },
        ['name']
      )
      relation.steps.push(
        { id: 'deps', from: 'target', follow: 'dependencies', expect: { min: 0, max: 200 } },
        { id: 'refs', from: 'target', follow: 'references', expect: { min: 0, max: 200 } }
      )
      relation.emit = [
        { from: 'deps', include: ['path', 'name'] },
        { from: 'refs', include: ['path', 'line', 'kind', 'sourceTarget'] }
      ]
      const relations = await execute('relationships-metadata-only', relation)
      expect(relations.length).toBeGreaterThan(0)
      expect(relations.every((x) => !('source' in x) && !('fileSource' in x))).toBe(true)
      expect(exactRead).not.toHaveBeenCalled()
      expect(fileRead).not.toHaveBeenCalled()
      for (const [scenario, where] of [
        [
          'markdown-section',
          { path: { exact: 'AGENTS.md' }, name: { exact: '1. Missão' }, kind: { exact: 'section' } }
        ],
        [
          'json-section',
          {
            path: { exact: 'package.json' },
            name: { exact: 'devDependencies' },
            kind: { exact: 'section' }
          }
        ]
      ] as const) {
        const doc = await execute(scenario, elementRequest(where, ['path', 'source']))
        const indexed = map
          .getElements(repo)
          .find(
            (x) =>
              x.kind === 'section' &&
              x.name === where.name.exact &&
              map.getFiles(repo).find((f) => f.id === x.fileId)?.relativePath === where.path.exact
          )!
        const literal = await readFile(join(repo, where.path.exact))
        expect(Buffer.from(doc[0].source as string)).toEqual(
          literal.subarray(indexed.location.start.byte, indexed.location.end.byte)
        )
      }
      const ambiguous = elementRequest({ kind: { exact: 'method' } }, ['source'])
      exactRead.mockClear()
      await execute('ambiguity', ambiguous, false)
      expect(exactRead).not.toHaveBeenCalled()
      await execute('budget', { ...exact, limits: { maxTokens: 1 } }, false)
      const evidence = join(repo, '.code-awareness', 'visual-validation', 'dash-v2-acceptance')
      await mkdir(evidence, { recursive: true })
      await writeFile(
        join(evidence, 'acceptance.json'),
        JSON.stringify(measurements, null, 2),
        'utf8'
      )
      console.log('DASH_V2_ACCEPTANCE', JSON.stringify(measurements))
    } finally {
      model.close()
      silent.mockRestore()
    }
  }, 300_000)
})
