import type {
  DiscoverRepositoryResult,
  GetRelationshipsResult,
  InspectFilesResult,
  FileOutlineElement,
  ReadCodeResult,
  GetReferencesResult,
  GetSymbolDependenciesResult,
  GetSymbolHierarchyResult
} from '../../../shared/types/context-navigation-types'
import { getCanonicalTokenizer, type TokenizerPort } from '../tokenizer'

export interface ScenarioMeasurement {
  readonly name: string
  readonly tokens: number
  readonly characters: number
}

export interface MeasurementReport {
  readonly measurements: ScenarioMeasurement[]
  readonly totalTokens: number
  readonly totalCharacters: number
}

export interface NavigationOverhead {
  readonly discoverRootTokens: number
  readonly discoverSrcTokens: number
  readonly relationshipsBothTokens: number
  readonly inspectServiceTokens: number
  readonly totalTokens: number
  readonly totalCharacters: number
}

export interface ReadCodeEnvelopeOverhead {
  readonly serializedTokens: number
  readonly sourceTokens: number
  readonly envelopeTokens: number
}

export interface PurityViolation {
  readonly scenario: string
  readonly invariant: string
  readonly evidence: string
}

export class PurityError extends Error {
  constructor(readonly violations: readonly PurityViolation[]) {
    const summary = violations.map((v) => `[${v.scenario}] Invariant "${v.invariant}" violated: ${v.evidence}`).join('\n')
    super(`Purity violations detected:\n${summary}`)
    this.name = 'PurityError'
  }
}

export function assertPurity(violations: readonly PurityViolation[]): void {
  if (violations.length > 0) {
    throw new PurityError(violations)
  }
}

export function measureScenario(
  name: string,
  serializedOutput: string,
  tokenizer: TokenizerPort = getCanonicalTokenizer()
): ScenarioMeasurement {
  return {
    name,
    tokens: tokenizer.count(serializedOutput),
    characters: serializedOutput.length
  }
}

export function aggregateMeasurements(measurements: readonly ScenarioMeasurement[]): MeasurementReport {
  let totalTokens = 0
  let totalCharacters = 0
  for (const measurement of measurements) {
    totalTokens += measurement.tokens
    totalCharacters += measurement.characters
  }
  return {
    measurements: [...measurements],
    totalTokens,
    totalCharacters
  }
}

export function computeNavigationOverhead(
  discoverRoot: ScenarioMeasurement,
  discoverSrc: ScenarioMeasurement,
  relationshipsBoth: ScenarioMeasurement,
  inspectService: ScenarioMeasurement
): NavigationOverhead {
  const totalTokens = discoverRoot.tokens + discoverSrc.tokens + relationshipsBoth.tokens + inspectService.tokens
  const totalCharacters = discoverRoot.characters + discoverSrc.characters + relationshipsBoth.characters + inspectService.characters
  return {
    discoverRootTokens: discoverRoot.tokens,
    discoverSrcTokens: discoverSrc.tokens,
    relationshipsBothTokens: relationshipsBoth.tokens,
    inspectServiceTokens: inspectService.tokens,
    totalTokens,
    totalCharacters
  }
}

export function computeReadCodeEnvelopeOverhead(
  serializedOutput: string,
  literalSource: string,
  tokenizer: TokenizerPort = getCanonicalTokenizer()
): ReadCodeEnvelopeOverhead {
  const serializedTokens = tokenizer.count(serializedOutput)
  const sourceTokens = tokenizer.count(literalSource)
  const envelopeTokens = serializedTokens - sourceTokens
  if (envelopeTokens < 0) {
    throw new Error(`Read Code Envelope Overhead cannot be negative (got ${envelopeTokens}: serialized=${serializedTokens}, source=${sourceTokens})`)
  }
  return {
    serializedTokens,
    sourceTokens,
    envelopeTokens
  }
}

export function checkDiscoveryPurity(
  scenario: string,
  result: DiscoverRepositoryResult,
  serialized: string
): PurityViolation[] {
  const violations: PurityViolation[] = []

  for (const directory of result.directories) {
    const seen = new Set<string>()
    for (const child of directory.children) {
      if (seen.has(child)) {
        violations.push({ scenario, invariant: 'no_duplicate_children', evidence: `Duplicate child: ${child} in ${directory.relativePath}` })
      }
      seen.add(child)

      const slashIndex = child.indexOf('/')
      if (slashIndex >= 0 && slashIndex !== child.length - 1) {
        violations.push({ scenario, invariant: 'immediate_children_only', evidence: `Child contains internal slash: ${child} in ${directory.relativePath}` })
      }
    }
  }

  if (/export\s+(?:function|class|interface|type|const|let|var)\b|import\s+.*from/.test(serialized)) {
    violations.push({ scenario, invariant: 'no_source_code', evidence: 'Serialized output contains source code declarations' })
  }
  if (/t:[A-Za-z0-9_-]{11}|target:[a-z0-9_-]+:full/i.test(serialized)) {
    violations.push({ scenario, invariant: 'no_code_targets', evidence: 'Serialized output contains CodeTarget identifiers' })
  }
  if (/"(?:elementId|location|granularity|tokenCount|language|byteOffset|startByte|endByte)"/.test(serialized)) {
    violations.push({ scenario, invariant: 'no_ast_metadata', evidence: 'Serialized output contains AST or internal metadata fields' })
  }
  if (/^(?:OUT|IN)$/m.test(serialized)) {
    violations.push({ scenario, invariant: 'no_relationships_sections', evidence: 'Serialized output contains relationships direction headers' })
  }

  return violations
}

export function checkRelationshipsPurity(
  scenario: string,
  result: GetRelationshipsResult,
  serialized: string,
  options?: { expectDetails?: boolean }
): PurityViolation[] {
  const violations: PurityViolation[] = []

  for (const file of result.files) {
    if (file.out?.some((edge) => edge.relativePath === file.relativePath)) {
      violations.push({ scenario, invariant: 'no_self_edge', evidence: `File has self-edge in OUT: ${file.relativePath}` })
    }
    if (file.in?.some((edge) => edge.relativePath === file.relativePath)) {
      violations.push({ scenario, invariant: 'no_self_edge', evidence: `File has self-edge in IN: ${file.relativePath}` })
    }

    if (file.out) {
      const seen = new Set<string>()
      for (const edge of file.out) {
        if (seen.has(edge.relativePath)) {
          violations.push({ scenario, invariant: 'no_duplicate_edges', evidence: `Duplicate OUT edge: ${edge.relativePath} in ${file.relativePath}` })
        }
        seen.add(edge.relativePath)
        if (options?.expectDetails === false && edge.type !== undefined) {
          violations.push({ scenario, invariant: 'no_unsolicited_details', evidence: `Unsolicited edge type in default OUT: ${edge.type}` })
        }
        if (options?.expectDetails === true && edge.type === undefined) {
          violations.push({ scenario, invariant: 'expected_details_present', evidence: `Missing edge type in detailed OUT: ${edge.relativePath}` })
        }
      }
    }

    if (file.in) {
      const seen = new Set<string>()
      for (const edge of file.in) {
        if (seen.has(edge.relativePath)) {
          violations.push({ scenario, invariant: 'no_duplicate_edges', evidence: `Duplicate IN edge: ${edge.relativePath} in ${file.relativePath}` })
        }
        seen.add(edge.relativePath)
        if (options?.expectDetails === false && edge.type !== undefined) {
          violations.push({ scenario, invariant: 'no_unsolicited_details', evidence: `Unsolicited edge type in default IN: ${edge.type}` })
        }
        if (options?.expectDetails === true && edge.type === undefined) {
          violations.push({ scenario, invariant: 'expected_details_present', evidence: `Missing edge type in detailed IN: ${edge.relativePath}` })
        }
      }
    }
  }

  if (/export\s+(?:function|class|interface|type|const|let|var)\b|import\s+.*from/.test(serialized)) {
    violations.push({ scenario, invariant: 'no_source_code', evidence: 'Serialized output contains source code declarations' })
  }
  if (/^(?:\s*)(?:class|function|interface|typeAlias|constant|method)\s+/m.test(serialized)) {
    violations.push({ scenario, invariant: 'no_outline_elements', evidence: 'Serialized output contains outline element declarations' })
  }
  if (/t:[A-Za-z0-9_-]{11}|target:[a-z0-9_-]+:full/i.test(serialized)) {
    violations.push({ scenario, invariant: 'no_code_targets', evidence: 'Serialized output contains CodeTarget identifiers' })
  }
  if (/"(?:elementId|location|granularity|tokenCount|language|byteOffset|startByte|endByte)"/.test(serialized)) {
    violations.push({ scenario, invariant: 'no_ast_metadata', evidence: 'Serialized output contains AST or internal metadata fields' })
  }

  return violations
}

const allowedNavigableKinds = new Set(['class', 'function', 'method', 'interface', 'enum', 'typeAlias', 'constant'])

export function checkInspectPurity(
  scenario: string,
  result: InspectFilesResult,
  serialized: string,
  requestedPaths: readonly string[]
): PurityViolation[] {
  const violations: PurityViolation[] = []
  const requestedSet = new Set(requestedPaths)

  for (const file of result.files) {
    if (!requestedSet.has(file.relativePath)) {
      violations.push({ scenario, invariant: 'no_unsolicited_files', evidence: `Unsolicited file in inspect output: ${file.relativePath}` })
    }

    function checkElement(element: FileOutlineElement) {
      if (!allowedNavigableKinds.has(element.kind)) {
        violations.push({ scenario, invariant: 'only_navigable_kinds', evidence: `Disallowed kind in outline: ${element.kind} (${element.name})` })
      }
      if (element.target && !/^t:[A-Za-z0-9_-]{11}$/.test(element.target)) {
        violations.push({ scenario, invariant: 'valid_code_target_format', evidence: `Invalid CodeTarget format: ${element.target}` })
      }
      const raw = element as Record<string, unknown>
      for (const forbiddenKey of ['elementId', 'parentElementId', 'location', 'granularity', 'byteOffset', 'sizeBytes', 'source']) {
        if (raw[forbiddenKey] !== undefined) {
          violations.push({ scenario, invariant: 'no_internal_metadata', evidence: `Internal metadata property "${forbiddenKey}" exposed on ${element.name}` })
        }
      }
      if (element.children) {
        for (const child of element.children) {
          checkElement(child)
        }
      }
    }

    for (const element of file.elements) {
      checkElement(element)
    }
  }

  if (/^(?:OUT|IN)$/m.test(serialized)) {
    violations.push({ scenario, invariant: 'no_relationships_sections', evidence: 'Serialized output contains relationships direction headers' })
  }
  if (/"(?:elementId|location|granularity|tokenCount|language|byteOffset|startByte|endByte)"/.test(serialized)) {
    violations.push({ scenario, invariant: 'no_ast_metadata', evidence: 'Serialized output contains AST or internal metadata fields' })
  }
  if (/^import\b|[{}]|\breturn\b|\bconst\s+\w+\s*=/m.test(serialized)) {
    violations.push({ scenario, invariant: 'no_source_bodies', evidence: 'Serialized output contains source code statements or implementation bodies' })
  }

  return violations
}

export function checkReadCodePurity(
  scenario: string,
  result: readonly ReadCodeResult[],
  serialized: string,
  requestedTargetIds: readonly string[]
): PurityViolation[] {
  const violations: PurityViolation[] = []

  if (result.length !== requestedTargetIds.length) {
    violations.push({ scenario, invariant: 'exact_target_count', evidence: `Expected ${requestedTargetIds.length} results, got ${result.length}` })
  }

  for (let i = 0; i < result.length; i++) {
    const entry = result[i]
    const expectedTarget = requestedTargetIds[i]
    if (entry.targetId !== expectedTarget) {
      violations.push({ scenario, invariant: 'target_order_and_identity', evidence: `Result at index ${i} has target ${entry.targetId}, expected ${expectedTarget}` })
    }
    if (!entry.relativePath) {
      violations.push({ scenario, invariant: 'valid_relative_path', evidence: `Missing relativePath for target ${entry.targetId}` })
    }
    if (!entry.source || !entry.source.length) {
      violations.push({ scenario, invariant: 'non_empty_source', evidence: `Empty source for target ${entry.targetId}` })
    }
    const raw = entry as Record<string, unknown>
    for (const forbiddenKey of ['elementId', 'location', 'granularity', 'byteOffset', 'sizeBytes', 'durationMs', 'timings', 'tokenCount']) {
      if (raw[forbiddenKey] !== undefined) {
        violations.push({ scenario, invariant: 'no_internal_metadata', evidence: `Internal metadata property "${forbiddenKey}" exposed on read result ${entry.targetId}` })
      }
    }
  }

  if (/^(?:OUT|IN)$/m.test(serialized)) {
    violations.push({ scenario, invariant: 'no_relationships_sections', evidence: 'Serialized output contains relationships direction headers' })
  }
  if (/"(?:durationMs|timings|tokenCount)"/.test(serialized)) {
    violations.push({ scenario, invariant: 'no_telemetry', evidence: 'Serialized output contains telemetry metadata' })
  }

  return violations
}

export function checkReferencesPurity(
  scenario: string,
  result: GetReferencesResult,
  serialized: string,
  requestedTargetIds: readonly string[]
): PurityViolation[] {
  const violations: PurityViolation[] = []
  if (result.targets.length !== requestedTargetIds.length) {
    violations.push({ scenario, invariant: 'exact_target_count', evidence: `Expected ${requestedTargetIds.length} targets, got ${result.targets.length}` })
  }
  for (let index = 0; index < result.targets.length; index++) {
    const entry = result.targets[index]
    if (entry.target !== requestedTargetIds[index]) {
      violations.push({ scenario, invariant: 'target_order_and_identity', evidence: `Target at index ${index} is ${entry.target}, expected ${requestedTargetIds[index]}` })
    }
    for (const key of Object.keys(entry)) {
      if (!['target', 'references'].includes(key)) {
        violations.push({ scenario, invariant: 'target_projection_only', evidence: `Unexpected target property: ${key}` })
      }
    }
    for (const reference of entry.references) {
      for (const key of Object.keys(reference)) {
        if (!['relativePath', 'kind', 'line', 'sourceTarget'].includes(key)) {
          violations.push({ scenario, invariant: 'reference_projection_only', evidence: `Unexpected reference property: ${key}` })
        }
      }
      if (!reference.relativePath || reference.line < 1) {
        violations.push({ scenario, invariant: 'public_location', evidence: `Invalid location for ${entry.target}` })
      }
    }
  }
  if (/\b[0-9a-f]{16}\b|(?:sourceFileId|sourceElementId|targetElementId|repositoryId|referenceId|startByte|endByte|column|durationMs|timings|tokenCount)=?/i.test(serialized)) {
    violations.push({ scenario, invariant: 'no_internal_metadata', evidence: 'Serialized references contain internal metadata' })
  }
  if (/\b(?:file|line|kind|sourceTarget)=/.test(serialized)) {
    violations.push({ scenario, invariant: 'compact_positional_format', evidence: 'Serialized references contain redundant labels' })
  }
  if (/\b(?:import|export|return|const|let|var|function|class)\b.*[{}=]/.test(serialized)) {
    violations.push({ scenario, invariant: 'no_source_code', evidence: 'Serialized references contain source code' })
  }
  return violations
}

export function checkSymbolDependenciesPurity(
  scenario: string,
  result: GetSymbolDependenciesResult,
  serialized: string,
  requestedSourceTargetIds: readonly string[]
): PurityViolation[] {
  const violations: PurityViolation[] = []
  if (result.sources.length !== requestedSourceTargetIds.length) {
    violations.push({ scenario, invariant: 'exact_source_count', evidence: `Expected ${requestedSourceTargetIds.length} sources, got ${result.sources.length}` })
  }
  for (let index = 0; index < result.sources.length; index++) {
    const entry = result.sources[index]
    if (entry.source !== requestedSourceTargetIds[index]) {
      violations.push({ scenario, invariant: 'source_order_and_identity', evidence: `Source at index ${index} is ${entry.source}, expected ${requestedSourceTargetIds[index]}` })
    }
    for (const key of Object.keys(entry)) {
      if (!['source', 'dependencies'].includes(key)) {
        violations.push({ scenario, invariant: 'source_projection_only', evidence: `Unexpected source property: ${key}` })
      }
    }
    const identities = new Set<string>()
    for (const dependency of entry.dependencies) {
      for (const key of Object.keys(dependency)) {
        if (!['target', 'kind', 'relativePath'].includes(key)) {
          violations.push({ scenario, invariant: 'dependency_projection_only', evidence: `Unexpected dependency property: ${key}` })
        }
      }
      if (!dependency.target || !dependency.relativePath) {
        violations.push({ scenario, invariant: 'navigable_dependency', evidence: `Invalid dependency for ${entry.source}` })
      }
      const identity = `${dependency.target}\0${dependency.kind}`
      if (identities.has(identity)) {
        violations.push({ scenario, invariant: 'deduplicated_target_and_kind', evidence: `Duplicate dependency ${dependency.kind} ${dependency.target}` })
      }
      identities.add(identity)
    }
  }
  if (/\b[0-9a-f]{16}\b|(?:sourceFileId|sourceElementId|targetElementId|repositoryId|referenceId|startByte|endByte|line|column|durationMs|timings|tokenCount)=?/i.test(serialized)) {
    violations.push({ scenario, invariant: 'no_internal_metadata', evidence: 'Serialized dependencies contain internal metadata' })
  }
  if (/\b(?:target|kind|relativePath)=/.test(serialized)) {
    violations.push({ scenario, invariant: 'compact_positional_format', evidence: 'Serialized dependencies contain redundant labels' })
  }
  if (/\b(?:import|export|return|const|let|var|function|class)\b.*[{}=]/.test(serialized)) {
    violations.push({ scenario, invariant: 'no_source_code', evidence: 'Serialized dependencies contain source code' })
  }
  return violations
}

export function checkSymbolHierarchyPurity(
  scenario: string,
  result: GetSymbolHierarchyResult,
  serialized: string,
  requestedTargetIds: readonly string[]
): PurityViolation[] {
  const violations: PurityViolation[] = []
  if (result.targets.length !== requestedTargetIds.length) {
    violations.push({ scenario, invariant: 'exact_target_count', evidence: `Expected ${requestedTargetIds.length} targets, got ${result.targets.length}` })
  }
  for (let index = 0; index < result.targets.length; index++) {
    const entry = result.targets[index]
    if (entry.target !== requestedTargetIds[index]) {
      violations.push({ scenario, invariant: 'target_order_and_identity', evidence: `Target at index ${index} is ${entry.target}, expected ${requestedTargetIds[index]}` })
    }
    for (const key of Object.keys(entry)) {
      if (!['target', 'up', 'down'].includes(key)) {
        violations.push({ scenario, invariant: 'target_projection_only', evidence: `Unexpected target property: ${key}` })
      }
    }
    for (const direction of ['up', 'down'] as const) {
      const identities = new Set<string>()
      for (const relation of entry[direction] ?? []) {
        for (const key of Object.keys(relation)) {
          if (!['kind', 'target', 'relativePath'].includes(key)) {
            violations.push({ scenario, invariant: 'hierarchy_projection_only', evidence: `Unexpected ${direction} relation property: ${key}` })
          }
        }
        if (!['extends', 'implements'].includes(relation.kind) || !relation.target || !relation.relativePath) {
          violations.push({ scenario, invariant: 'direct_navigable_hierarchy', evidence: `Invalid ${direction} relation for ${entry.target}` })
        }
        const identity = `${direction}\0${relation.kind}\0${relation.target}`
        if (identities.has(identity)) {
          violations.push({ scenario, invariant: 'deduplicated_direction_kind_target', evidence: `Duplicate ${direction} relation ${relation.kind} ${relation.target}` })
        }
        identities.add(identity)
      }
    }
  }
  if (/\b[0-9a-f]{16}\b|(?:sourceId|targetId|elementId|repositoryId|startByte|endByte|line|column|durationMs|timings|tokenCount)=?/i.test(serialized)) {
    violations.push({ scenario, invariant: 'no_internal_metadata', evidence: 'Serialized hierarchy contains internal metadata' })
  }
  if (/\b(?:target|kind|relativePath)=/.test(serialized)) {
    violations.push({ scenario, invariant: 'compact_positional_format', evidence: 'Serialized hierarchy contains redundant labels' })
  }
  if (/\b(?:import|export|return|const|let|var|function|class)\b.*[{}=]/.test(serialized)) {
    violations.push({ scenario, invariant: 'no_source_code', evidence: 'Serialized hierarchy contains source code' })
  }
  return violations
}

export class ContextEfficiencyHarness {
  private readonly measurements: ScenarioMeasurement[] = []

  constructor(private readonly tokenizer: TokenizerPort = getCanonicalTokenizer()) {}

  measure(name: string, serializedOutput: string): ScenarioMeasurement {
    const measurement = measureScenario(name, serializedOutput, this.tokenizer)
    this.measurements.push(measurement)
    return measurement
  }

  getMeasurements(): readonly ScenarioMeasurement[] {
    return [...this.measurements]
  }

  report(): MeasurementReport {
    return aggregateMeasurements(this.measurements)
  }
}

export interface EfficiencyComparison {
  readonly scenario: string
  readonly baselineTokens: number
  readonly currentTokens: number
  readonly allowedTokens: number
  readonly delta: number
  readonly deltaPercent: number
  readonly status: 'PASS' | 'FAIL'
}

export function computeAllowedTokens(baselineTokens: number): number {
  return Math.max(baselineTokens + 32, Math.ceil(baselineTokens * 1.2))
}

export function compareEfficiency(
  scenario: string,
  baselineTokens: number,
  currentTokens: number
): EfficiencyComparison {
  const allowedTokens = computeAllowedTokens(baselineTokens)
  const delta = currentTokens - baselineTokens
  const deltaPercent = baselineTokens > 0 ? (delta / baselineTokens) * 100 : 0
  return {
    scenario,
    baselineTokens,
    currentTokens,
    allowedTokens,
    delta,
    deltaPercent,
    status: currentTokens <= allowedTokens ? 'PASS' : 'FAIL'
  }
}

export function formatRegressionMessage(c: EfficiencyComparison): string {
  const sign = (n: number): string => (n >= 0 ? '+' : '')
  return [
    'Context efficiency regression',
    '',
    `scenario: ${c.scenario}`,
    `baseline: ${c.baselineTokens} tokens`,
    `current:  ${c.currentTokens} tokens`,
    `allowed:  ${c.allowedTokens} tokens`,
    `delta:    ${sign(c.delta)}${c.delta} (${sign(c.deltaPercent)}${c.deltaPercent.toFixed(1)}%)`
  ].join('\n')
}

export function assertEfficiency(comparison: EfficiencyComparison): void {
  if (comparison.status === 'FAIL') {
    throw new Error(formatRegressionMessage(comparison))
  }
}
