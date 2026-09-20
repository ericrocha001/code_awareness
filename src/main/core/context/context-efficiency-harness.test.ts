import { describe, expect, it } from 'vitest'
import { getCanonicalTokenizer } from '../tokenizer'
import { parseCodeTargetId } from './code-target'
import { serializeDiscovery, serializeInspectFiles, serializeReferences, serializeRelationships, serializeReadCode, serializeSymbolDependencies, serializeSymbolHierarchy } from './context-navigation-serializer'
import { createEfficiencyFixture } from './context-efficiency-fixture'
import {
  aggregateMeasurements,
  assertEfficiency,
  assertPurity,
  checkDiscoveryPurity,
  checkRelationshipsPurity,
  checkInspectPurity,
  checkReadCodePurity,
  checkReferencesPurity,
  checkSymbolDependenciesPurity,
  checkSymbolHierarchyPurity,
  compareEfficiency,
  computeAllowedTokens,
  computeNavigationOverhead,
  computeReadCodeEnvelopeOverhead,
  ContextEfficiencyHarness,
  formatRegressionMessage,
  measureScenario,
  PurityError
} from './context-efficiency-harness'
import { BASELINE_V1, BASELINE_V2, BASELINE_V3, BASELINE_V4 } from './context-efficiency-baseline'

import type {
  DiscoverRepositoryResult,
  GetRelationshipsResult,
  InspectFilesResult,
  ReadCodeResult,
  GetReferencesResult,
  GetSymbolDependenciesResult,
  GetSymbolHierarchyResult
} from '../../../shared/types/context-navigation-types'

describe('Symbol References - compact projection metrics and purity', () => {
  it('freezes deterministic single, multiple and empty scenarios in BASELINE_V2', async () => {
    const fixture = createEfficiencyFixture()
    const inspect = await fixture.engine.inspectFiles(fixture.repoPath, ['src/service.ts', 'src/types.ts', 'src/unused.ts'])
    const dataService = inspect.files[0].elements.find((element) => element.name === 'DataService')!.target!
    const serviceConfig = inspect.files[1].elements.find((element) => element.name === 'ServiceConfig')!.target!
    const unused = inspect.files[2].elements.find((element) => element.name === 'standaloneHelper')!.target!

    const single = await fixture.engine.getReferences(fixture.repoPath, [dataService])
    const multiple = await fixture.engine.getReferences(fixture.repoPath, [serviceConfig, dataService])
    const empty = await fixture.engine.getReferences(fixture.repoPath, [unused])
    const scenarios = [
      { name: 'references_single', result: single, targets: [dataService], baseline: BASELINE_V2.scenarios.references_single },
      { name: 'references_multiple', result: multiple, targets: [serviceConfig, dataService], baseline: BASELINE_V2.scenarios.references_multiple },
      { name: 'references_empty', result: empty, targets: [unused], baseline: BASELINE_V2.scenarios.references_empty }
    ] as const

    for (const scenario of scenarios) {
      const serialized = serializeReferences(scenario.result)
      const repeated = serializeReferences(await fixture.engine.getReferences(fixture.repoPath, [...scenario.targets]))
      const measurement = measureScenario(scenario.name, serialized)
      expect(repeated).toBe(serialized)
      expect(measurement).toMatchObject(scenario.baseline)
      assertPurity(checkReferencesPurity(scenario.name, scenario.result, serialized, scenario.targets))
      const comparison = compareEfficiency(scenario.name, scenario.baseline.tokens, measurement.tokens)
      assertEfficiency(comparison)
      expect(comparison.allowedTokens).toBe(Math.max(scenario.baseline.tokens + 32, Math.ceil(scenario.baseline.tokens * 1.2)))
    }

    expect(computeAllowedTokens(BASELINE_V2.scenarios.references_single.tokens)).toBe(49)
    expect(computeAllowedTokens(BASELINE_V2.scenarios.references_multiple.tokens)).toBe(67)
    expect(computeAllowedTokens(BASELINE_V2.scenarios.references_empty.tokens)).toBe(39)
    expect(empty.targets[0].references).toEqual([])
    expect(fixture.getSourceReadsCount()).toBe(0)
  })

  it('extends the literal historical baselines without changing their values', () => {
    expect(BASELINE_V1).toEqual({
      version: 1,
      scenarios: {
        discover_root: { tokens: 5, characters: 8 },
        discover_src: { tokens: 13, characters: 42 },
        relationships_both: { tokens: 15, characters: 49 },
        relationships_in: { tokens: 9, characters: 31 },
        relationships_out: { tokens: 9, characters: 34 },
        relationships_details: { tokens: 17, characters: 65 },
        inspect_service: { tokens: 19, characters: 73 },
        inspect_signatures: { tokens: 23, characters: 98 },
        navigation_overhead: { tokens: 52, characters: 172 },
        read_code_envelope: { serializedTokens: 37, sourceTokens: 28, envelopeTokens: 9 }
      }
    })
    expect(BASELINE_V2).toEqual({
      version: 2,
      scenarios: {
        ...BASELINE_V1.scenarios,
        references_single: { tokens: 17, characters: 57 },
        references_multiple: { tokens: 35, characters: 111 },
        references_empty: { tokens: 7, characters: 21 }
      }
    })
    for (const [name, baseline] of Object.entries(BASELINE_V1.scenarios)) {
      expect(BASELINE_V2.scenarios[name as keyof typeof BASELINE_V1.scenarios]).toBe(baseline)
    }
    expect(BASELINE_V3).toEqual({
      version: 3,
      scenarios: {
        ...BASELINE_V2.scenarios,
        dependencies_single: { tokens: 16, characters: 59 },
        dependencies_multiple: { tokens: 42, characters: 141 },
        dependencies_empty: { tokens: 7, characters: 21 }
      }
    })
    for (const [name, baseline] of Object.entries(BASELINE_V2.scenarios)) {
      expect(BASELINE_V3.scenarios[name as keyof typeof BASELINE_V2.scenarios]).toBe(baseline)
    }
    expect(BASELINE_V4).toEqual({
      version: 4,
      scenarios: {
        ...BASELINE_V3.scenarios,
        hierarchy_up: { tokens: 17, characters: 57 },
        hierarchy_down: { tokens: 17, characters: 61 },
        hierarchy_both: { tokens: 17, characters: 57 },
        hierarchy_empty: { tokens: 7, characters: 21 }
      }
    })
    for (const [name, baseline] of Object.entries(BASELINE_V3.scenarios)) {
      expect(BASELINE_V4.scenarios[name as keyof typeof BASELINE_V3.scenarios]).toBe(baseline)
    }
  })

  it('rejects a synthetically contaminated reference projection', async () => {
    const fixture = createEfficiencyFixture()
    const inspect = await fixture.engine.inspectFiles(fixture.repoPath, ['src/service.ts'])
    const target = inspect.files[0].elements.find((element) => element.name === 'DataService')!.target!
    const result = await fixture.engine.getReferences(fixture.repoPath, [target])
    const serialized = serializeReferences(result)
    expect(() => assertPurity(checkReferencesPurity('references_clean', result, serialized, [target]))).not.toThrow()

    const contaminated = structuredClone(result) as GetReferencesResult
    Object.assign(contaminated.targets[0].references[0], { targetElementId: '0123456789abcdef' })
    expect(() => assertPurity(checkReferencesPurity('references_contaminated', contaminated, serialized, [target]))).toThrow(PurityError)
  })
})

describe('Symbol Dependencies - compact outbound projection metrics and purity', () => {
  it('freezes deterministic single, multiple and empty scenarios in BASELINE_V3', async () => {
    const fixture = createEfficiencyFixture()
    const inspect = await fixture.engine.inspectFiles(fixture.repoPath, ['src/app.ts', 'src/service.ts', 'src/unused.ts'])
    const startApp = inspect.files[0].elements.find((element) => element.name === 'startApp')!.target!
    const execute = inspect.files[1].elements.find((element) => element.name === 'DataService')!.children!.find((element) => element.name === 'execute')!.target!
    const unused = inspect.files[2].elements.find((element) => element.name === 'standaloneHelper')!.target!

    const scenarios = [
      { name: 'dependencies_single', targets: [startApp], baseline: BASELINE_V3.scenarios.dependencies_single, dependencies: 1 },
      { name: 'dependencies_multiple', targets: [execute, startApp], baseline: BASELINE_V3.scenarios.dependencies_multiple, dependencies: 3 },
      { name: 'dependencies_empty', targets: [unused], baseline: BASELINE_V3.scenarios.dependencies_empty, dependencies: 0 }
    ] as const

    for (const scenario of scenarios) {
      const result = await fixture.engine.getSymbolDependencies(fixture.repoPath, [...scenario.targets])
      const serialized = serializeSymbolDependencies(result)
      expect(serializeSymbolDependencies(await fixture.engine.getSymbolDependencies(fixture.repoPath, [...scenario.targets]))).toBe(serialized)
      assertPurity(checkSymbolDependenciesPurity(scenario.name, result, serialized, scenario.targets))
      const measurement = measureScenario(scenario.name, serialized)
      expect(measurement).toMatchObject(scenario.baseline)
      expect(result.sources.reduce((count, source) => count + source.dependencies.length, 0)).toBe(scenario.dependencies)
      expect(measurement.tokens).toBe(getCanonicalTokenizer().count(serialized))
      for (const dependency of result.sources.flatMap((source) => source.dependencies)) {
        expect(parseCodeTargetId(dependency.target)).not.toBeNull()
      }
      const comparison = compareEfficiency(scenario.name, scenario.baseline.tokens, measurement.tokens)
      assertEfficiency(comparison)
      expect(comparison.allowedTokens).toBe(Math.max(scenario.baseline.tokens + 32, Math.ceil(scenario.baseline.tokens * 1.2)))
    }

    const single = await fixture.engine.getSymbolDependencies(fixture.repoPath, [startApp])
    const multiple = await fixture.engine.getSymbolDependencies(fixture.repoPath, [execute, startApp])
    const empty = await fixture.engine.getSymbolDependencies(fixture.repoPath, [unused])
    expect(single.sources[0].dependencies).toHaveLength(1)
    expect(multiple.sources.map((entry) => entry.dependencies.length)).toEqual([2, 1])
    expect(empty.sources[0].dependencies).toEqual([])
    expect(fixture.getSourceReadsCount()).toBe(0)
    expect(computeAllowedTokens(BASELINE_V3.scenarios.dependencies_single.tokens)).toBe(48)
    expect(computeAllowedTokens(BASELINE_V3.scenarios.dependencies_multiple.tokens)).toBe(74)
    expect(computeAllowedTokens(BASELINE_V3.scenarios.dependencies_empty.tokens)).toBe(39)
  })

  it('rejects a synthetically contaminated or duplicated dependency projection', async () => {
    const fixture = createEfficiencyFixture()
    const inspect = await fixture.engine.inspectFiles(fixture.repoPath, ['src/app.ts'])
    const source = inspect.files[0].elements.find((element) => element.name === 'startApp')!.target!
    const result = await fixture.engine.getSymbolDependencies(fixture.repoPath, [source])
    const serialized = serializeSymbolDependencies(result)
    expect(() => assertPurity(checkSymbolDependenciesPurity('dependencies_clean', result, serialized, [source]))).not.toThrow()

    const contaminated = structuredClone(result) as GetSymbolDependenciesResult
    Object.assign(contaminated.sources[0].dependencies[0], { targetElementId: '0123456789abcdef' })
    contaminated.sources[0].dependencies.push({ ...contaminated.sources[0].dependencies[0] })
    expect(() => assertPurity(checkSymbolDependenciesPurity('dependencies_contaminated', contaminated, serialized, [source]))).toThrow(PurityError)
  })
})

describe('Symbol Hierarchy - direct structural projection metrics and purity', () => {
  it('freezes deterministic up, down, both and empty scenarios in BASELINE_V4', async () => {
    const fixture = createEfficiencyFixture()
    const inspect = await fixture.engine.inspectFiles(fixture.repoPath, ['src/service.ts', 'src/types.ts', 'src/unused.ts'])
    const service = inspect.files[0].elements.find((element) => element.name === 'DataService')!.target!
    const contract = inspect.files[1].elements.find((element) => element.name === 'ServiceConfig')!.target!
    const empty = inspect.files[2].elements.find((element) => element.name === 'standaloneHelper')!.target!
    const scenarios = [
      { name: 'hierarchy_up', targets: [service], direction: 'up' as const, edges: 1, baseline: BASELINE_V4.scenarios.hierarchy_up },
      { name: 'hierarchy_down', targets: [contract], direction: 'down' as const, edges: 1, baseline: BASELINE_V4.scenarios.hierarchy_down },
      { name: 'hierarchy_both', targets: [service], direction: 'both' as const, edges: 1, baseline: BASELINE_V4.scenarios.hierarchy_both },
      { name: 'hierarchy_empty', targets: [empty], direction: 'both' as const, edges: 0, baseline: BASELINE_V4.scenarios.hierarchy_empty }
    ] as const

    for (const scenario of scenarios) {
      const result = await fixture.engine.getSymbolHierarchy(fixture.repoPath, scenario.targets, { direction: scenario.direction })
      const serialized = serializeSymbolHierarchy(result)
      expect(serializeSymbolHierarchy(await fixture.engine.getSymbolHierarchy(fixture.repoPath, scenario.targets, { direction: scenario.direction }))).toBe(serialized)
      assertPurity(checkSymbolHierarchyPurity(scenario.name, result, serialized, scenario.targets))
      expect(result.targets.flatMap((entry) => [...(entry.up ?? []), ...(entry.down ?? [])])).toHaveLength(scenario.edges)
      for (const relation of result.targets.flatMap((entry) => [...(entry.up ?? []), ...(entry.down ?? [])])) {
        expect(parseCodeTargetId(relation.target)).not.toBeNull()
      }
      const measurement = measureScenario(scenario.name, serialized)
      expect(measurement).toMatchObject(scenario.baseline)
      const comparison = compareEfficiency(scenario.name, scenario.baseline.tokens, measurement.tokens)
      assertEfficiency(comparison)
      expect(comparison.allowedTokens).toBe(Math.max(scenario.baseline.tokens + 32, Math.ceil(scenario.baseline.tokens * 1.2)))
    }

    expect(fixture.getSourceReadsCount()).toBe(0)
    expect(computeAllowedTokens(BASELINE_V4.scenarios.hierarchy_up.tokens)).toBe(49)
    expect(computeAllowedTokens(BASELINE_V4.scenarios.hierarchy_down.tokens)).toBe(49)
    expect(computeAllowedTokens(BASELINE_V4.scenarios.hierarchy_both.tokens)).toBe(49)
    expect(computeAllowedTokens(BASELINE_V4.scenarios.hierarchy_empty.tokens)).toBe(39)
  })

  it('hard-fails contaminated and duplicated hierarchy projections', async () => {
    const fixture = createEfficiencyFixture()
    const inspect = await fixture.engine.inspectFiles(fixture.repoPath, ['src/service.ts'])
    const service = inspect.files[0].elements.find((element) => element.name === 'DataService')!.target!
    const result = await fixture.engine.getSymbolHierarchy(fixture.repoPath, [service])
    const serialized = serializeSymbolHierarchy(result)
    expect(() => assertPurity(checkSymbolHierarchyPurity('hierarchy_clean', result, serialized, [service]))).not.toThrow()

    const contaminated = structuredClone(result) as GetSymbolHierarchyResult
    Object.assign(contaminated.targets[0].up![0], { targetElementId: '0123456789abcdef' })
    contaminated.targets[0].up!.push({ ...contaminated.targets[0].up![0] })
    expect(() => assertPurity(checkSymbolHierarchyPurity('hierarchy_contaminated', contaminated, serialized, [service]))).toThrow(PurityError)
  })
})

describe('Context Efficiency Harness - Foundation & Deterministic Fixture', () => {
  it('proves token counting uses canonical tokenizer', () => {
    const sample = 'export function demo(): string { return "hello" }'
    const canonical = getCanonicalTokenizer()
    const measurement = measureScenario('canonical_check', sample)

    expect(measurement.tokens).toBe(canonical.count(sample))
    expect(measurement.name).toBe('canonical_check')
  })

  it('proves character counting is deterministic', () => {
    const sample = 'const value = 12345\n'
    const measurement1 = measureScenario('char_check_1', sample)
    const measurement2 = measureScenario('char_check_2', sample)

    expect(measurement1.characters).toBe(sample.length)
    expect(measurement2.characters).toBe(sample.length)
  })

  it('proves same output produces identical measurements across runs', () => {
    const text = '[.]\nsrc/\n'
    const first = measureScenario('repeat_test', text)
    const second = measureScenario('repeat_test', text)

    expect(first).toEqual(second)
  })

  it('proves Discovery of the fixture can be measured and is non-empty', async () => {
    const fixture = createEfficiencyFixture()
    const discoveryResult = await fixture.engine.discoverRepository(fixture.repoPath)
    const serialized = serializeDiscovery(discoveryResult)

    expect(serialized.trim().length).toBeGreaterThan(0)
    expect(serialized).toContain('src/')

    const measurement = measureScenario('discovery', serialized)

    expect(measurement.tokens).toBeGreaterThan(0)
    expect(measurement.characters).toBeGreaterThan(0)
    expect(measurement.characters).toBe(serialized.length)
  })

  it('proves Inspect Files of the fixture can be measured', async () => {
    const fixture = createEfficiencyFixture()
    const inspectResult = await fixture.engine.inspectFiles(fixture.repoPath, ['src/service.ts'])
    const serialized = serializeInspectFiles(inspectResult)

    expect(serialized.trim().length).toBeGreaterThan(0)
    expect(serialized).toContain('DataService')

    const measurement = measureScenario('inspect_service', serialized)

    expect(measurement.tokens).toBeGreaterThan(0)
    expect(measurement.characters).toBeGreaterThan(0)
    expect(measurement.characters).toBe(serialized.length)
  })

  it('proves targets returned by Inspect have usable public format and can be read', async () => {
    const fixture = createEfficiencyFixture()
    const inspectResult = await fixture.engine.inspectFiles(fixture.repoPath, ['src/service.ts'])
    const serviceFile = inspectResult.files[0]
    expect(serviceFile).toBeDefined()

    const classElement = serviceFile.elements.find((element) => element.name === 'DataService')
    expect(classElement).toBeDefined()
    expect(classElement?.children).toBeDefined()

    const methodElement = classElement?.children?.find((child) => child.name === 'execute')
    expect(methodElement).toBeDefined()
    expect(methodElement?.target).toBeDefined()

    const targetId = methodElement!.target!
    const parsed = parseCodeTargetId(targetId)
    expect(parsed).not.toBeNull()
    expect(parsed?.kind).toBe('full')
    expect(targetId).toMatch(/^t:[A-Za-z0-9_-]{11}$/)

    const [readResult] = await fixture.engine.readCode(fixture.repoPath, [targetId])
    expect(readResult).toBeDefined()
    expect(readResult.targetId).toBe(targetId)
    expect(readResult.relativePath).toBe('src/service.ts')
    expect(readResult.source).toContain('execute(config: ServiceConfig)')
  })

  it('aggregates multiple measurements cleanly in ContextEfficiencyHarness', () => {
    const harness = new ContextEfficiencyHarness()
    const m1 = harness.measure('scenario_a', 'abc')
    const m2 = harness.measure('scenario_b', 'defgh')

    expect(harness.getMeasurements()).toEqual([m1, m2])

    const report = harness.report()
    expect(report.measurements).toEqual([m1, m2])
    expect(report.totalTokens).toBe(m1.tokens + m2.tokens)
    expect(report.totalCharacters).toBe(m1.characters + m2.characters)
  })

  it('aggregates standalone measurement arrays', () => {
    const measurements = [
      measureScenario('step1', 'hello'),
      measureScenario('step2', 'world!')
    ]
    const report = aggregateMeasurements(measurements)

    expect(report.totalTokens).toBe(measurements[0].tokens + measurements[1].tokens)
    expect(report.totalCharacters).toBe(measurements[0].characters + measurements[1].characters)
  })
})

describe('Harness 2 - Discovery Purity & Efficiency', () => {
  it('proves discover_root returns only immediate children with zero cross-layer leak', async () => {
    const fixture = createEfficiencyFixture()
    const result = await fixture.engine.discoverRepository(fixture.repoPath)
    const serialized = serializeDiscovery(result)

    expect(result.directories).toHaveLength(1)
    expect(result.directories[0].relativePath).toBe('.')
    expect(result.directories[0].children).toEqual(['src/'])

    expect(serialized).toBe('[.]\nsrc/')

    const violations = checkDiscoveryPurity('discover_root', result, serialized)
    assertPurity(violations)

    const measurement = measureScenario('discover_root', serialized)
    expect(measurement.tokens).toBe(5)
    expect(measurement.characters).toBe(8)
  })

  it('proves discover_src returns only immediate files without recursive or body leak', async () => {
    const fixture = createEfficiencyFixture()
    const result = await fixture.engine.discoverRepository(fixture.repoPath, ['src'])
    const serialized = serializeDiscovery(result)

    expect(result.directories).toHaveLength(1)
    expect(result.directories[0].relativePath).toBe('src')
    expect(result.directories[0].children).toEqual(['app.ts', 'service.ts', 'types.ts', 'unused.ts'])

    expect(serialized).toBe('[src]\napp.ts\nservice.ts\ntypes.ts\nunused.ts')

    const violations = checkDiscoveryPurity('discover_src', result, serialized)
    assertPurity(violations)

    const measurement = measureScenario('discover_src', serialized)
    expect(measurement.tokens).toBe(13)
    expect(measurement.characters).toBe(42)
  })
})

describe('Harness 2 - Relationships Purity & Directional Isolation', () => {
  it('proves relationships_both provides strict bidirectional 1-hop without self-edges or transitives', async () => {
    const fixture = createEfficiencyFixture()
    const result = await fixture.engine.getRelationships(fixture.repoPath, ['src/service.ts'], { direction: 'both' })
    const serialized = serializeRelationships(result)

    expect(result.files).toHaveLength(1)
    const file = result.files[0]
    expect(file.relativePath).toBe('src/service.ts')
    expect(file.out).toEqual([{ relativePath: 'src/types.ts' }])
    expect(file.in).toEqual([{ relativePath: 'src/app.ts' }])

    expect(file.out?.some((e) => e.relativePath === 'src/app.ts')).toBe(false)
    expect(file.in?.some((e) => e.relativePath === 'src/types.ts')).toBe(false)
    expect(file.out?.some((e) => e.relativePath === 'src/service.ts')).toBe(false)
    expect(file.in?.some((e) => e.relativePath === 'src/service.ts')).toBe(false)

    expect(serialized).toBe('[src/service.ts]\n\nOUT\nsrc/types.ts\n\nIN\nsrc/app.ts')

    const violations = checkRelationshipsPurity('relationships_both', result, serialized, { expectDetails: false })
    assertPurity(violations)

    const measurement = measureScenario('relationships_both', serialized)
    expect(measurement.tokens).toBe(15)
    expect(measurement.characters).toBe(49)
  })

  it('proves relationships_out isolates outbound imports with zero inbound leak', async () => {
    const fixture = createEfficiencyFixture()
    const result = await fixture.engine.getRelationships(fixture.repoPath, ['src/service.ts'], { direction: 'out' })
    const serialized = serializeRelationships(result)

    expect(result.files).toHaveLength(1)
    const file = result.files[0]
    expect(file.relativePath).toBe('src/service.ts')
    expect(file.out).toEqual([{ relativePath: 'src/types.ts' }])
    expect(file.in).toBeUndefined()

    expect(serialized).toBe('[src/service.ts]\n\nOUT\nsrc/types.ts')
    expect(serialized).not.toContain('src/app.ts')
    expect(serialized).not.toContain('IN')

    const violations = checkRelationshipsPurity('relationships_out', result, serialized, { expectDetails: false })
    assertPurity(violations)

    const measurement = measureScenario('relationships_out', serialized)
    expect(measurement.tokens).toBe(9)
    expect(measurement.characters).toBe(34)
  })

  it('proves relationships_in isolates inbound importers with zero outbound leak', async () => {
    const fixture = createEfficiencyFixture()
    const result = await fixture.engine.getRelationships(fixture.repoPath, ['src/service.ts'], { direction: 'in' })
    const serialized = serializeRelationships(result)

    expect(result.files).toHaveLength(1)
    const file = result.files[0]
    expect(file.relativePath).toBe('src/service.ts')
    expect(file.in).toEqual([{ relativePath: 'src/app.ts' }])
    expect(file.out).toBeUndefined()

    expect(serialized).toBe('[src/service.ts]\n\nIN\nsrc/app.ts')
    expect(serialized).not.toContain('src/types.ts')
    expect(serialized).not.toContain('OUT')

    const violations = checkRelationshipsPurity('relationships_in', result, serialized, { expectDetails: false })
    assertPurity(violations)

    const measurement = measureScenario('relationships_in', serialized)
    expect(measurement.tokens).toBe(9)
    expect(measurement.characters).toBe(31)
  })

  it('proves relationships_empty on isolated file returns clean empty boundaries without invented relations', async () => {
    const fixture = createEfficiencyFixture()
    const result = await fixture.engine.getRelationships(fixture.repoPath, ['src/unused.ts'], { direction: 'both' })
    const serialized = serializeRelationships(result)

    expect(result.files).toHaveLength(1)
    const file = result.files[0]
    expect(file.relativePath).toBe('src/unused.ts')
    expect(file.out).toEqual([])
    expect(file.in).toEqual([])

    expect(serialized).toBe('[src/unused.ts]\n\nOUT\n\nIN')

    const violations = checkRelationshipsPurity('relationships_empty', result, serialized, { expectDetails: false })
    assertPurity(violations)

    const measurement = measureScenario('relationships_empty', serialized)
    expect(measurement.tokens).toBe(8)
    expect(measurement.characters).toBe(24)
  })

  it('proves details option surfaces explicit edge types and default never leaks details', async () => {
    const fixture = createEfficiencyFixture()
    const defaultResult = await fixture.engine.getRelationships(fixture.repoPath, ['src/service.ts'], { direction: 'both' })
    const defaultSerialized = serializeRelationships(defaultResult)

    const detailedResult = await fixture.engine.getRelationships(fixture.repoPath, ['src/service.ts'], { direction: 'both', details: true })
    const detailedSerialized = serializeRelationships(detailedResult)

    expect(defaultSerialized).not.toBe(detailedSerialized)
    expect(defaultSerialized).not.toContain('imports')
    expect(detailedSerialized).toBe('[src/service.ts]\n\nOUT\nsrc/types.ts imports\n\nIN\nsrc/app.ts imports')

    const defaultViolations = checkRelationshipsPurity('relationships_default', defaultResult, defaultSerialized, { expectDetails: false })
    assertPurity(defaultViolations)

    const detailedViolations = checkRelationshipsPurity('relationships_details', detailedResult, detailedSerialized, { expectDetails: true })
    assertPurity(detailedViolations)

    const measurement = measureScenario('relationships_details', detailedSerialized)
    expect(measurement.tokens).toBe(17)
    expect(measurement.characters).toBe(65)
  })
})

describe('Harness 2 - Negative Purity Tests', () => {
  it('fails purity check when Discovery output is contaminated with source code', () => {
    const syntheticResult: DiscoverRepositoryResult = {
      directories: [{ relativePath: '.', children: ['src/'] }]
    }
    const contaminatedSerialized = '[.]\nsrc/\nexport function leaked(): void {}'

    const violations = checkDiscoveryPurity('contaminated_discovery_source', syntheticResult, contaminatedSerialized)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.some((v) => v.invariant === 'no_source_code')).toBe(true)
    expect(() => assertPurity(violations)).toThrow(PurityError)
  })

  it('fails purity check when Discovery output is contaminated with CodeTargets', () => {
    const syntheticResult: DiscoverRepositoryResult = {
      directories: [{ relativePath: '.', children: ['src/'] }]
    }
    const contaminatedSerialized = '[.]\nsrc/\nt:0000000000000001'

    const violations = checkDiscoveryPurity('contaminated_discovery_target', syntheticResult, contaminatedSerialized)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.some((v) => v.invariant === 'no_code_targets')).toBe(true)
    expect(() => assertPurity(violations)).toThrow(PurityError)
  })

  it('fails purity check when Relationships output contains self-edges or duplicate edges', () => {
    const syntheticResult: GetRelationshipsResult = {
      files: [{
        relativePath: 'src/service.ts',
        out: [{ relativePath: 'src/service.ts' }, { relativePath: 'src/types.ts' }, { relativePath: 'src/types.ts' }],
        in: []
      }]
    }
    const serialized = serializeRelationships(syntheticResult)

    const violations = checkRelationshipsPurity('contaminated_self_edge', syntheticResult, serialized)
    expect(violations.some((v) => v.invariant === 'no_self_edge')).toBe(true)
    expect(violations.some((v) => v.invariant === 'no_duplicate_edges')).toBe(true)
    expect(() => assertPurity(violations)).toThrow(PurityError)
  })

  it('fails purity check when Relationships output is contaminated with outline elements', () => {
    const syntheticResult: GetRelationshipsResult = {
      files: [{ relativePath: 'src/service.ts', out: [{ relativePath: 'src/types.ts' }], in: [] }]
    }
    const contaminatedSerialized = '[src/service.ts]\n\nOUT\nsrc/types.ts\nclass DataService\n  method execute'

    const violations = checkRelationshipsPurity('contaminated_relationships_outline', syntheticResult, contaminatedSerialized)
    expect(violations.some((v) => v.invariant === 'no_outline_elements')).toBe(true)
    expect(() => assertPurity(violations)).toThrow(PurityError)
  })

  it('fails purity check when default Relationships output contains unsolicited edge details', () => {
    const syntheticResult: GetRelationshipsResult = {
      files: [{ relativePath: 'src/service.ts', out: [{ relativePath: 'src/types.ts', type: 'imports' }], in: [] }]
    }
    const serialized = serializeRelationships(syntheticResult)

    const violations = checkRelationshipsPurity('unsolicited_details', syntheticResult, serialized, { expectDetails: false })
    expect(violations.some((v) => v.invariant === 'no_unsolicited_details')).toBe(true)
    expect(() => assertPurity(violations)).toThrow(PurityError)
  })
})

describe('Harness 3 - Inspect Files Purity & Efficiency', () => {
  it('proves inspect_service produces minimal outline without params or locals', async () => {
    const fixture = createEfficiencyFixture()
    const result = await fixture.engine.inspectFiles(fixture.repoPath, ['src/service.ts'])
    const serialized = serializeInspectFiles(result)

    expect(result.files).toHaveLength(1)
    const file = result.files[0]
    expect(file.relativePath).toBe('src/service.ts')

    const classElement = file.elements.find((e) => e.name === 'DataService')
    expect(classElement).toBeDefined()
    expect(classElement?.kind).toBe('class')

    const methodElement = classElement?.children?.find((e) => e.name === 'execute')
    expect(methodElement).toBeDefined()
    expect(methodElement?.kind).toBe('method')
    expect(methodElement?.target).toBeDefined()

    expect(file.elements.some((e) => e.name === 'config' || e.name === 'active')).toBe(false)
    expect(classElement?.children?.some((e) => e.name === 'config' || e.name === 'active')).toBe(false)

    expect(serialized).toBe('[src/service.ts]\n\nclass DataService t:AAAAAAAAAAQ\n  execute t:AAAAAAAAAAU')

    const violations = checkInspectPurity('inspect_service', result, serialized, ['src/service.ts'])
    assertPurity(violations)

    const measurement = measureScenario('inspect_service', serialized)
    expect(measurement.tokens).toBe(19)
    expect(measurement.characters).toBe(73)
  })

  it('proves inspect_types preserves structural interfaces and type aliases', async () => {
    const fixture = createEfficiencyFixture()
    const result = await fixture.engine.inspectFiles(fixture.repoPath, ['src/types.ts'])
    const serialized = serializeInspectFiles(result)

    expect(result.files).toHaveLength(1)
    const file = result.files[0]
    expect(file.relativePath).toBe('src/types.ts')

    const names = file.elements.map((e) => e.name)
    expect(names).toContain('ServiceConfig')
    expect(names).toContain('ExecutionResult')

    const serviceConfig = file.elements.find((e) => e.name === 'ServiceConfig')!
    expect(serviceConfig.kind).toBe('interface')
    expect(serviceConfig.target).toBeDefined()

    const executionResult = file.elements.find((e) => e.name === 'ExecutionResult')!
    expect(executionResult.kind).toBe('typeAlias')
    expect(executionResult.target).toBeDefined()

    const violations = checkInspectPurity('inspect_types', result, serialized, ['src/types.ts'])
    assertPurity(violations)

    const measurement = measureScenario('inspect_types', serialized)
    expect(measurement.tokens).toBe(22)
    expect(measurement.characters).toBe(serialized.length)
  })

  it('proves inspect_multiple scopes strictly to requested files without leak', async () => {
    const fixture = createEfficiencyFixture()
    const requested = ['src/service.ts', 'src/types.ts']
    const result = await fixture.engine.inspectFiles(fixture.repoPath, requested)
    const serialized = serializeInspectFiles(result)

    expect(result.files).toHaveLength(2)
    expect(result.files.map((f) => f.relativePath)).toEqual(requested)

    expect(serialized).toContain('[src/service.ts]')
    expect(serialized).toContain('[src/types.ts]')
    expect(serialized).not.toContain('src/app.ts')
    expect(serialized).not.toContain('src/unused.ts')

    const violations = checkInspectPurity('inspect_multiple', result, serialized, requested)
    assertPurity(violations)

    const measurement = measureScenario('inspect_multiple', serialized)
    expect(measurement.tokens).toBe(42)
    expect(measurement.characters).toBe(serialized.length)
  })

  it('proves signatures option expands details without reading file source', async () => {
    const fixture = createEfficiencyFixture()
    const readsBefore = fixture.getSourceReadsCount()

    const defaultResult = await fixture.engine.inspectFiles(fixture.repoPath, ['src/service.ts'])
    const defaultSerialized = serializeInspectFiles(defaultResult)

    const signaturesResult = await fixture.engine.inspectFiles(fixture.repoPath, ['src/service.ts'], { signatures: true })
    const signaturesSerialized = serializeInspectFiles(signaturesResult)

    expect(fixture.getSourceReadsCount()).toBe(readsBefore)
    expect(fixture.getSourceReadsCount()).toBe(0)

    expect(defaultSerialized).not.toBe(signaturesSerialized)
    expect(signaturesSerialized).toContain('execute(config): ExecutionResult')

    const violations = checkInspectPurity('inspect_signatures', signaturesResult, signaturesSerialized, ['src/service.ts'])
    assertPurity(violations)

    const measurement = measureScenario('inspect_signatures', signaturesSerialized)
    expect(measurement.tokens).toBe(23)
    expect(measurement.characters).toBe(signaturesSerialized.length)
    expect(measurement.tokens).toBeGreaterThan(measureScenario('inspect_service', defaultSerialized).tokens)
  })

  it('fails purity check when Inspect output is contaminated with internal or leaked elements', () => {
    const syntheticResult: InspectFilesResult = {
      files: [{
        relativePath: 'src/service.ts',
        elements: [
          { kind: 'class', name: 'DataService', target: 't:0000000000000001' },
          { kind: 'parameter' as any, name: 'config' }
        ]
      }]
    }
    const serialized = serializeInspectFiles(syntheticResult)

    const violations = checkInspectPurity('contaminated_inspect', syntheticResult, serialized, ['src/service.ts'])
    expect(violations.some((v) => v.invariant === 'only_navigable_kinds')).toBe(true)
    expect(() => assertPurity(violations)).toThrow(PurityError)
  })
})

describe('Harness 3 - Read Code Purity, Exact Retrieval & Envelope Overhead', () => {
  it('proves read_single retrieves literal target source with exact byte equality', async () => {
    const fixture = createEfficiencyFixture()
    const inspectResult = await fixture.engine.inspectFiles(fixture.repoPath, ['src/service.ts'])
    const method = inspectResult.files[0].elements.find((e) => e.name === 'DataService')?.children?.find((e) => e.name === 'execute')
    expect(method?.target).toBeDefined()
    const targetId = method!.target!

    const readResult = await fixture.engine.readCode(fixture.repoPath, [targetId])
    expect(readResult).toHaveLength(1)
    expect(readResult[0].targetId).toBe(targetId)
    expect(readResult[0].relativePath).toBe('src/service.ts')

    const serviceContent = fixture.files['src/service.ts']
    const expectedSource = serviceContent.slice(
      serviceContent.indexOf('execute(config: ServiceConfig)'),
      serviceContent.indexOf('  }\n') + 3
    )
    expect(readResult[0].source).toBe(expectedSource)

    const serialized = serializeReadCode(readResult[0])
    expect(serialized).toBe(`[${targetId} src/service.ts]\n\n${expectedSource}`)

    const violations = checkReadCodePurity('read_single', readResult, serialized, [targetId])
    assertPurity(violations)

    const measurement = measureScenario('read_single', serialized)
    expect(measurement.tokens).toBe(37)
    expect(measurement.characters).toBe(serialized.length)
  })

  it('proves read_multiple preserves requested order and exact source slices', async () => {
    const fixture = createEfficiencyFixture()

    const inspectApp = await fixture.engine.inspectFiles(fixture.repoPath, ['src/app.ts'])
    const targetApp = inspectApp.files[0].elements.find((e) => e.name === 'startApp')!.target!

    const inspectService = await fixture.engine.inspectFiles(fixture.repoPath, ['src/service.ts'])
    const targetService = inspectService.files[0].elements.find((e) => e.name === 'DataService')!.children!.find((e) => e.name === 'execute')!.target!

    const batch1 = await fixture.engine.readCode(fixture.repoPath, [targetApp, targetService])
    expect(batch1).toHaveLength(2)
    expect(batch1.map((r) => r.targetId)).toEqual([targetApp, targetService])

    const batch2 = await fixture.engine.readCode(fixture.repoPath, [targetService, targetApp])
    expect(batch2).toHaveLength(2)
    expect(batch2.map((r) => r.targetId)).toEqual([targetService, targetApp])

    const serializedBatch1 = batch1.map((r) => serializeReadCode(r)).join('\n\n')
    const violations = checkReadCodePurity('read_multiple', batch1, serializedBatch1, [targetApp, targetService])
    assertPurity(violations)

    const measurement = measureScenario('read_multiple', serializedBatch1)
    expect(measurement.tokens).toBe(70)
    expect(measurement.characters).toBe(serializedBatch1.length)
  })

  it('fails purity check when Read Code is contaminated with unexpected target count or order', () => {
    const syntheticResult: ReadCodeResult[] = [
      { targetId: 't:0000000000000001', relativePath: 'src/app.ts', source: 'function one() {}' },
      { targetId: 't:0000000000000002', relativePath: 'src/service.ts', source: 'function two() {}' }
    ]
    const serialized = syntheticResult.map((r) => serializeReadCode(r)).join('\n\n')

    const violations = checkReadCodePurity('contaminated_read', syntheticResult, serialized, ['t:0000000000000001'])
    expect(violations.some((v) => v.invariant === 'exact_target_count')).toBe(true)
    expect(() => assertPurity(violations)).toThrow(PurityError)
  })

  it('computes Read Code Envelope Overhead and guarantees non-negativity', async () => {
    const fixture = createEfficiencyFixture()
    const inspectResult = await fixture.engine.inspectFiles(fixture.repoPath, ['src/service.ts'])
    const targetId = inspectResult.files[0].elements.find((e) => e.name === 'DataService')!.children!.find((e) => e.name === 'execute')!.target!

    const [readResult] = await fixture.engine.readCode(fixture.repoPath, [targetId])
    const serialized = serializeReadCode(readResult)

    const overhead = computeReadCodeEnvelopeOverhead(serialized, readResult.source)

    expect(overhead.serializedTokens).toBe(37)
    expect(overhead.sourceTokens).toBe(28)
    expect(overhead.envelopeTokens).toBe(9)
    expect(overhead.envelopeTokens).toBeGreaterThanOrEqual(0)
    expect(overhead.serializedTokens - overhead.sourceTokens).toBe(overhead.envelopeTokens)

    expect(() => computeReadCodeEnvelopeOverhead('small', 'very long source code exceeds serialized wrapper')).toThrow(
      /Read Code Envelope Overhead cannot be negative/
    )
  })
})

describe('Harness 3 - Navigation Overhead', () => {
  it('computes canonical Navigation Overhead across the four primary navigation steps', async () => {
    const fixture = createEfficiencyFixture()

    const discRoot = await fixture.engine.discoverRepository(fixture.repoPath)
    const mDiscRoot = measureScenario('discover_root', serializeDiscovery(discRoot))

    const discSrc = await fixture.engine.discoverRepository(fixture.repoPath, ['src'])
    const mDiscSrc = measureScenario('discover_src', serializeDiscovery(discSrc))

    const relBoth = await fixture.engine.getRelationships(fixture.repoPath, ['src/service.ts'], { direction: 'both' })
    const mRelBoth = measureScenario('relationships_both', serializeRelationships(relBoth))

    const inspService = await fixture.engine.inspectFiles(fixture.repoPath, ['src/service.ts'])
    const mInspService = measureScenario('inspect_service', serializeInspectFiles(inspService))

    const overhead = computeNavigationOverhead(mDiscRoot, mDiscSrc, mRelBoth, mInspService)

    expect(overhead.discoverRootTokens).toBe(5)
    expect(overhead.discoverSrcTokens).toBe(13)
    expect(overhead.relationshipsBothTokens).toBe(15)
    expect(overhead.inspectServiceTokens).toBe(19)

    expect(overhead.totalTokens).toBe(5 + 13 + 15 + 19)
    expect(overhead.totalTokens).toBe(52)
    expect(overhead.totalCharacters).toBe(8 + 42 + 49 + 73)
    expect(overhead.totalCharacters).toBe(172)
  })
})

describe('Harness 4 - Regression Policy (Artificial)', () => {
  it('PASS when current equals baseline', () => {
    const c = compareEfficiency('test_equal', 15, 15)

    expect(c.status).toBe('PASS')
    expect(c.baselineTokens).toBe(15)
    expect(c.currentTokens).toBe(15)
    expect(c.allowedTokens).toBe(computeAllowedTokens(15))
    expect(c.delta).toBe(0)
    expect(c.deltaPercent).toBe(0)
    expect(() => assertEfficiency(c)).not.toThrow()
  })

  it('PASS when current exceeds baseline but stays within budget', () => {
    const baseline = 15
    const allowed = computeAllowedTokens(baseline)
    const c = compareEfficiency('test_within_budget', baseline, allowed)

    expect(c.status).toBe('PASS')
    expect(c.allowedTokens).toBe(Math.max(15 + 32, Math.ceil(15 * 1.2)))
    expect(c.delta).toBeGreaterThan(0)
    expect(() => assertEfficiency(c)).not.toThrow()
  })

  it('FAIL when current exceeds allowed budget, and formatRegressionMessage includes required fields', () => {
    const baseline = 15
    const allowed = computeAllowedTokens(baseline)
    const current = allowed + 1
    const c = compareEfficiency('test_over_budget', baseline, current)

    expect(c.status).toBe('FAIL')
    expect(c.currentTokens).toBeGreaterThan(c.allowedTokens)

    const msg = formatRegressionMessage(c)
    expect(msg).toContain('Context efficiency regression')
    expect(msg).toContain('scenario: test_over_budget')
    expect(msg).toContain(`baseline: ${baseline} tokens`)
    expect(msg).toContain(`current:  ${current} tokens`)
    expect(msg).toContain(`allowed:  ${allowed} tokens`)

    expect(() => assertEfficiency(c)).toThrow('Context efficiency regression')
    expect(() => assertEfficiency(c)).toThrow('scenario: test_over_budget')
  })

  it('FAIL when navigation_overhead exceeds its own budget', () => {
    const baselineOverhead = BASELINE_V1.scenarios.navigation_overhead.tokens
    const allowed = computeAllowedTokens(baselineOverhead)
    const c = compareEfficiency('navigation_overhead', baselineOverhead, allowed + 1)

    expect(c.status).toBe('FAIL')
    expect(() => assertEfficiency(c)).toThrow('scenario: navigation_overhead')
  })

  it('FAIL when read_code_envelope exceeds its own budget', () => {
    const baselineEnvelope = BASELINE_V1.scenarios.read_code_envelope.envelopeTokens
    const allowed = computeAllowedTokens(baselineEnvelope)
    const c = compareEfficiency('read_code_envelope', baselineEnvelope, allowed + 1)

    expect(c.status).toBe('FAIL')
    expect(() => assertEfficiency(c)).toThrow('scenario: read_code_envelope')
  })
})

describe('Harness 4 - Integration against Baseline v1', () => {
  it('all normal scenarios pass purity and efficiency against baseline v1', async () => {
    const fixture = createEfficiencyFixture()
    const rp = fixture.repoPath

    const discRoot = await fixture.engine.discoverRepository(rp)
    const sDiscRoot = serializeDiscovery(discRoot)
    assertPurity(checkDiscoveryPurity('discover_root', discRoot, sDiscRoot))
    assertEfficiency(compareEfficiency('discover_root', BASELINE_V1.scenarios.discover_root.tokens, measureScenario('discover_root', sDiscRoot).tokens))

    const discSrc = await fixture.engine.discoverRepository(rp, ['src'])
    const sDiscSrc = serializeDiscovery(discSrc)
    assertPurity(checkDiscoveryPurity('discover_src', discSrc, sDiscSrc))
    assertEfficiency(compareEfficiency('discover_src', BASELINE_V1.scenarios.discover_src.tokens, measureScenario('discover_src', sDiscSrc).tokens))

    const relBoth = await fixture.engine.getRelationships(rp, ['src/service.ts'], { direction: 'both' })
    const sRelBoth = serializeRelationships(relBoth)
    assertPurity(checkRelationshipsPurity('relationships_both', relBoth, sRelBoth, { expectDetails: false }))
    assertEfficiency(compareEfficiency('relationships_both', BASELINE_V1.scenarios.relationships_both.tokens, measureScenario('relationships_both', sRelBoth).tokens))

    const relIn = await fixture.engine.getRelationships(rp, ['src/service.ts'], { direction: 'in' })
    const sRelIn = serializeRelationships(relIn)
    assertPurity(checkRelationshipsPurity('relationships_in', relIn, sRelIn, { expectDetails: false }))
    assertEfficiency(compareEfficiency('relationships_in', BASELINE_V1.scenarios.relationships_in.tokens, measureScenario('relationships_in', sRelIn).tokens))

    const relOut = await fixture.engine.getRelationships(rp, ['src/service.ts'], { direction: 'out' })
    const sRelOut = serializeRelationships(relOut)
    assertPurity(checkRelationshipsPurity('relationships_out', relOut, sRelOut, { expectDetails: false }))
    assertEfficiency(compareEfficiency('relationships_out', BASELINE_V1.scenarios.relationships_out.tokens, measureScenario('relationships_out', sRelOut).tokens))

    const relDetails = await fixture.engine.getRelationships(rp, ['src/service.ts'], { direction: 'both', details: true })
    const sRelDetails = serializeRelationships(relDetails)
    assertPurity(checkRelationshipsPurity('relationships_details', relDetails, sRelDetails, { expectDetails: true }))
    assertEfficiency(compareEfficiency('relationships_details', BASELINE_V1.scenarios.relationships_details.tokens, measureScenario('relationships_details', sRelDetails).tokens))

    const inspService = await fixture.engine.inspectFiles(rp, ['src/service.ts'])
    const sInspService = serializeInspectFiles(inspService)
    assertPurity(checkInspectPurity('inspect_service', inspService, sInspService, ['src/service.ts']))
    assertEfficiency(compareEfficiency('inspect_service', BASELINE_V1.scenarios.inspect_service.tokens, measureScenario('inspect_service', sInspService).tokens))

    const inspSig = await fixture.engine.inspectFiles(rp, ['src/service.ts'], { signatures: true })
    const sInspSig = serializeInspectFiles(inspSig)
    assertPurity(checkInspectPurity('inspect_signatures', inspSig, sInspSig, ['src/service.ts']))
    assertEfficiency(compareEfficiency('inspect_signatures', BASELINE_V1.scenarios.inspect_signatures.tokens, measureScenario('inspect_signatures', sInspSig).tokens))
  })

  it('navigation_overhead passes efficiency against baseline v1', async () => {
    const fixture = createEfficiencyFixture()
    const rp = fixture.repoPath

    const mDiscRoot = measureScenario('discover_root', serializeDiscovery(await fixture.engine.discoverRepository(rp)))
    const mDiscSrc = measureScenario('discover_src', serializeDiscovery(await fixture.engine.discoverRepository(rp, ['src'])))
    const mRelBoth = measureScenario('relationships_both', serializeRelationships(await fixture.engine.getRelationships(rp, ['src/service.ts'], { direction: 'both' })))
    const mInspService = measureScenario('inspect_service', serializeInspectFiles(await fixture.engine.inspectFiles(rp, ['src/service.ts'])))

    const overhead = computeNavigationOverhead(mDiscRoot, mDiscSrc, mRelBoth, mInspService)
    const comparison = compareEfficiency('navigation_overhead', BASELINE_V1.scenarios.navigation_overhead.tokens, overhead.totalTokens)

    assertEfficiency(comparison)
    expect(comparison.status).toBe('PASS')
    expect(overhead.totalTokens).toBe(BASELINE_V1.scenarios.navigation_overhead.tokens)
  })

  it('read_code_envelope passes efficiency against baseline v1', async () => {
    const fixture = createEfficiencyFixture()
    const rp = fixture.repoPath

    const inspService = await fixture.engine.inspectFiles(rp, ['src/service.ts'])
    const targetId = inspService.files[0].elements.find((e) => e.name === 'DataService')!.children!.find((e) => e.name === 'execute')!.target!
    const [readResult] = await fixture.engine.readCode(rp, [targetId])
    const serialized = serializeReadCode(readResult)

    const overhead = computeReadCodeEnvelopeOverhead(serialized, readResult.source)
    const comparison = compareEfficiency('read_code_envelope', BASELINE_V1.scenarios.read_code_envelope.envelopeTokens, overhead.envelopeTokens)

    assertEfficiency(comparison)
    expect(comparison.status).toBe('PASS')
    expect(overhead.envelopeTokens).toBe(BASELINE_V1.scenarios.read_code_envelope.envelopeTokens)
  })
})
