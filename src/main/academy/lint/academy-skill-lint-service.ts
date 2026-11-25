import type {
  AcademySkillScope,
  AcademySkillStatus,
  AcademySkillSummary,
  AcademySkillVersion,
  AcademySkillVersionMetadata
} from '../../../shared/types/academy-types'
import { getCanonicalTokenizer, type TokenizerPort } from '../../core/tokenizer'
import { AcademyError } from '../academy-package'
import type { AcademyStore } from '../academy-store'
import { canonicalJson } from '../publication/openai-plugin-model'
import {
  analyzePackageFacts,
  compareMagnitude,
  compareReports,
  deriveLintHealth,
  projectReportFindings
} from './skill-lint-engine'
import {
  findingInvolvesChangedPaths,
  getMagnitudeDimensions,
  ruleCatalogPressure
} from './skill-lint-rules'
import {
  SKILL_LINT_PARAMS,
  SKILL_LINT_RULESET,
  STAGNATION_RECOMMENDATION_NOTICE
} from './skill-lint-ruleset'
import {
  LINE_CONVENTION,
  type EfficiencyItem,
  type FindingCategory,
  type FindingPersistenceInfo,
  type LintCounts,
  type LintCoverage,
  type LintHealth,
  type PackageFacts,
  type RecurrenceSignal,
  type SkillLintFinding,
  type StagnationNotice
} from './skill-lint-types'
import { sha256Hex } from './skill-measures'

export function encodeLintCursor(sig: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, sig, offset }), 'utf8').toString('base64url')
}

export function decodeLintCursor(cursor: string, expectedSig: string): number {
  if (typeof cursor !== 'string' || !cursor || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new AcademyError('LINT_CURSOR_STALE', 'Invalid or stale lint cursor')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new AcademyError('LINT_CURSOR_STALE', 'Invalid lint cursor encoding')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AcademyError('LINT_CURSOR_STALE', 'Invalid lint cursor payload')
  }
  const obj = parsed as Record<string, unknown>
  if (
    obj.v !== 1 ||
    obj.sig !== expectedSig ||
    typeof obj.offset !== 'number' ||
    !Number.isSafeInteger(obj.offset) ||
    obj.offset < 0
  ) {
    throw new AcademyError('LINT_CURSOR_STALE', 'Lint cursor does not match current snapshot or filters')
  }
  return obj.offset
}

export function normalizePageLimit(limit: unknown, fallback = 20, max = 50): number {
  if (limit === undefined) return fallback
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new AcademyError('INVALID_ARGUMENT', `limit must be an integer between 1 and ${max}`)
  }
  return limit
}

export function buildMeasuresDelta(
  prevFacts: PackageFacts | null,
  currFacts: PackageFacts | null,
  predecessorVersion: number | null
): EfficiencyItem['delta'] {
  if (predecessorVersion === null) {
    return { predecessorVersion: null, comparable: false, reason: 'INITIAL_VERSION' }
  }
  if (!prevFacts || !currFacts) {
    return { predecessorVersion, comparable: false, reason: 'CONTENT_UNAVAILABLE' }
  }
  if (
    prevFacts.ruleSetVersion !== currFacts.ruleSetVersion ||
    prevFacts.tokenizerId !== currFacts.tokenizerId
  ) {
    return { predecessorVersion, comparable: false, reason: 'POLICY_OR_TOKENIZER_CHANGED' }
  }
  return {
    predecessorVersion,
    comparable: true,
    metadataTokensDelta: currFacts.measures.metadataTokens - prevFacts.measures.metadataTokens,
    bodyTokensDelta: currFacts.measures.bodyTokens - prevFacts.measures.bodyTokens,
    bodyLinesDelta: currFacts.measures.bodyLines - prevFacts.measures.bodyLines,
    packageTokensDelta: currFacts.measures.packageTokens - prevFacts.measures.packageTokens,
    packageBytesDelta: currFacts.measures.packageBytes - prevFacts.measures.packageBytes
  }
}

export function toEfficiencyMeasures(facts: PackageFacts): NonNullable<EfficiencyItem['measures']> {
  return {
    metadataTokens: facts.measures.metadataTokens,
    bodyTokens: facts.measures.bodyTokens,
    bodyLines: facts.measures.bodyLines,
    skillMdTokens: facts.measures.skillMdTokens,
    resourcesTokens: facts.measures.resourcesTokens,
    packageTokens: facts.measures.packageTokens,
    packageBytes: facts.measures.packageBytes,
    resourceCount: facts.measures.resourceCount
  }
}

function changedFilePathsBetween(prev: PackageFacts, curr: PackageFacts): Set<string> {
  const prevFiles = new Map(prev.measures.files.map(f => [f.path, f.sha256]))
  const currFiles = new Map(curr.measures.files.map(f => [f.path, f.sha256]))
  const changed = new Set<string>()
  for (const [path, hash] of currFiles) {
    if (prevFiles.get(path) !== hash) changed.add(path)
  }
  for (const path of prevFiles.keys()) {
    if (!currFiles.has(path)) changed.add(path)
  }
  return changed
}

export class AcademySkillLintService {
  constructor(
    readonly store: AcademyStore,
    private readonly tokenizer: TokenizerPort = getCanonicalTokenizer()
  ) {}

  get ruleSetVersion(): string {
    return SKILL_LINT_RULESET.ruleSetVersion
  }

  get tokenizerId(): string {
    return this.tokenizer.id
  }

  getCachedFactsOnly(packageHash: string): PackageFacts | null {
    return this.store.lint.getFacts(packageHash, this.ruleSetVersion, this.tokenizer.id)
  }

  factsForVersionMeta(
    skillId: string,
    meta: Pick<AcademySkillVersionMetadata, 'version' | 'packageHash' | 'contentState'>,
    memo?: Map<string, PackageFacts>
  ): { coverage: LintCoverage; facts: PackageFacts | null } {
    if (meta.contentState === 'DELETED') {
      return { coverage: 'UNAVAILABLE', facts: null }
    }
    const memoHit = memo?.get(meta.packageHash)
    if (memoHit) return { coverage: memoHit.coverage, facts: memoHit }

    const cached = this.getCachedFactsOnly(meta.packageHash)
    if (cached) {
      memo?.set(meta.packageHash, cached)
      return { coverage: cached.coverage, facts: cached }
    }

    try {
      const versionRecord = this.store.history(skillId, { version: meta.version }) as AcademySkillVersion
      if (versionRecord.contentState === 'DELETED') {
        return { coverage: 'UNAVAILABLE', facts: null }
      }
      const facts = analyzePackageFacts(versionRecord.package, this.tokenizer, versionRecord.packageHash)
      this.store.lint.putFacts(facts)
      memo?.set(versionRecord.packageHash, facts)
      return { coverage: facts.coverage, facts }
    } catch {
      return { coverage: 'UNAVAILABLE', facts: null }
    }
  }

  factsFor(
    skillId: string,
    version?: number,
    memo?: Map<string, PackageFacts>
  ): { version: number; packageHash: string; coverage: LintCoverage; facts: PackageFacts | null } {
    const historyMeta = this.store.history(skillId, { metadataOnly: true })
    const target =
      version !== undefined
        ? historyMeta.find(item => item.version === version)
        : historyMeta[0]
    if (!target) {
      throw new AcademyError('VERSION_NOT_FOUND', `Skill ${skillId} version ${version ?? 'current'} not found`)
    }
    const { coverage, facts } = this.factsForVersionMeta(skillId, target, memo)
    return {
      version: target.version,
      packageHash: target.packageHash,
      coverage,
      facts
    }
  }

  computeRecurrence(
    currentVersion: number,
    currentPackageHash: string,
    baseVersion: number | null,
    basePackageHash: string | null,
    olderMetaDescending: AcademySkillVersionMetadata[]
  ): RecurrenceSignal {
    const windowSlice = olderMetaDescending.slice(0, SKILL_LINT_PARAMS.recurrenceWindowVersions)
    if (basePackageHash !== null && basePackageHash === currentPackageHash && baseVersion !== null) {
      return {
        state: 'NO_CHANGE',
        matchedVersion: baseVersion,
        packageHash: currentPackageHash,
        windowVersions: windowSlice.length
      }
    }
    const match = windowSlice.find(
      item =>
        item.version !== baseVersion &&
        item.version < currentVersion &&
        item.contentState !== 'DELETED' &&
        item.packageHash === currentPackageHash
    )
    if (match) {
      return {
        state: 'CYCLE_DETECTED',
        matchedVersion: match.version,
        packageHash: currentPackageHash,
        windowVersions: windowSlice.length,
        note: 'Hash matches an earlier version in accessible skill history; verify whether rollback is intentional.'
      }
    }
    return { state: 'NONE', windowVersions: windowSlice.length }
  }

  computePersistenceAndStagnation(
    skillId: string,
    currentVersion: number,
    currentFacts: PackageFacts,
    currentFindings: SkillLintFinding[],
    immediateBase: { version: number; facts: PackageFacts | null } | null,
    olderHistoryDescending: AcademySkillVersionMetadata[],
    memo: Map<string, PackageFacts>
  ): { persistence: FindingPersistenceInfo[]; stagnationNotice?: StagnationNotice } {
    const actionable = currentFindings.filter(f => f.category !== 'OBSERVATION')
    if (actionable.length === 0 || !immediateBase) {
      return { persistence: [] }
    }

    // Build series nodes: index 0 is current, index 1 is immediate base, indices 2..stagnationWindow use cache-only
    const nodes: Array<{ version: number; facts: PackageFacts | null }> = [
      { version: currentVersion, facts: currentFacts },
      { version: immediateBase.version, facts: immediateBase.facts }
    ]

    const maxExtra = SKILL_LINT_PARAMS.stagnationWindow - 1
    for (const meta of olderHistoryDescending) {
      if (nodes.length - 1 >= SKILL_LINT_PARAMS.stagnationWindow) break
      if (meta.version >= immediateBase.version) continue
      if (meta.contentState === 'DELETED') {
        nodes.push({ version: meta.version, facts: null })
        break
      }
      const cached = memo.get(meta.packageHash) ?? this.getCachedFactsOnly(meta.packageHash)
      if (cached) memo.set(meta.packageHash, cached)
      nodes.push({ version: meta.version, facts: cached })
      if (!cached || nodes.length - 2 >= maxExtra) {
        if (!cached) break
      }
    }

    const activeCatalog = this.store.list('ACTIVE')
    const skillSummary = this.store.list().find(s => s.id === skillId) ?? null
    const nodeFindings = new Map<number, SkillLintFinding[]>()
    nodeFindings.set(currentVersion, currentFindings)

    const getFindingsForNode = (idx: number): SkillLintFinding[] | null => {
      const node = nodes[idx]
      if (!node || !node.facts) return null
      const cached = nodeFindings.get(node.version)
      if (cached) return cached
      const prevNode = nodes[idx + 1]
      const projected = projectReportFindings(node.facts, {
        targetSkill: skillSummary,
        activeCatalog,
        baseFacts: prevNode?.facts ?? undefined
      }).findings
      nodeFindings.set(node.version, projected)
      return projected
    }

    const persistence: FindingPersistenceInfo[] = []
    const stagnantIds: string[] = []
    let maxUnchanged = 0

    for (const finding of actionable) {
      const currentMatches = currentFindings.filter(f => f.findingId === finding.findingId)
      if (currentMatches.length !== 1) {
        persistence.push({
          findingId: finding.findingId,
          firstObservedVersion: currentVersion,
          currentVersion,
          observedTransitions: 0,
          unchangedTransitions: 0,
          magnitudeDelta: 'NOT_COMPARABLE',
          seriesCoverage: 'PARTIAL',
          trajectory: 'UNKNOWN'
        })
        continue
      }

      let firstObservedVersion = currentVersion
      let observedTransitions = 0
      let unchangedTransitions = 0
      let countingConsecutiveUnchanged = true
      let seriesCoverage: 'COMPLETE' | 'PARTIAL' = 'COMPLETE'
      let immediateMagnitudeDelta: FindingPersistenceInfo['magnitudeDelta'] = 'NOT_COMPARABLE'
      let immediateTrajectory: FindingPersistenceInfo['trajectory'] = 'UNKNOWN'
      let immediateDimensions: FindingPersistenceInfo['dimensions']

      let currNodeIdx = 0
      let prevNodeIdx = 1
      let recordedImmediate = false

      while (prevNodeIdx < nodes.length) {
        const currNode = nodes[currNodeIdx]
        const prevNode = nodes[prevNodeIdx]
        if (!currNode.facts || !prevNode.facts) {
          seriesCoverage = 'PARTIAL'
          break
        }
        if (
          currNode.facts.ruleSetVersion !== currentFacts.ruleSetVersion ||
          prevNode.facts.ruleSetVersion !== currentFacts.ruleSetVersion ||
          currNode.facts.tokenizerId !== currentFacts.tokenizerId ||
          prevNode.facts.tokenizerId !== currentFacts.tokenizerId
        ) {
          seriesCoverage = 'PARTIAL'
          break
        }

        const changed = changedFilePathsBetween(prevNode.facts, currNode.facts)
        if (changed.size === 0 || !findingInvolvesChangedPaths(finding, changed)) {
          currNodeIdx = prevNodeIdx
          prevNodeIdx++
          continue
        }

        const currList = getFindingsForNode(currNodeIdx)
        const prevList = getFindingsForNode(prevNodeIdx)
        if (!currList || !prevList) {
          seriesCoverage = 'PARTIAL'
          break
        }
        const currCandidates = currList.filter(f => f.findingId === finding.findingId)
        const prevCandidates = prevList.filter(f => f.findingId === finding.findingId)

        if (currCandidates.length !== 1) {
          seriesCoverage = 'PARTIAL'
          break
        }
        if (prevCandidates.length === 0) {
          break
        }
        if (prevCandidates.length > 1) {
          seriesCoverage = 'PARTIAL'
          break
        }

        const currMatch = currCandidates[0]
        const prevMatch = prevCandidates[0]
        observedTransitions++
        firstObservedVersion = prevNode.version

        const dims = getMagnitudeDimensions(finding.ruleId)
        let transitionUnchanged = false
        if (dims.length > 0) {
          const cmp = compareMagnitude(finding.ruleId, prevMatch.magnitude, currMatch.magnitude)
          if (!recordedImmediate) {
            immediateMagnitudeDelta = cmp.delta
            immediateDimensions = cmp.dimensions
            if (cmp.delta === 'REDUCED') immediateTrajectory = 'IMPROVING'
            else if (cmp.delta === 'INCREASED') immediateTrajectory = 'REGRESSING'
            else if (cmp.delta === 'UNCHANGED') immediateTrajectory = 'NO_PROGRESS'
            else immediateTrajectory = 'UNKNOWN'
            recordedImmediate = true
          }
          transitionUnchanged = cmp.delta === 'UNCHANGED'
        } else {
          const sameFp = prevMatch.evidenceFingerprint === currMatch.evidenceFingerprint
          if (!recordedImmediate) {
            immediateMagnitudeDelta = sameFp ? 'UNCHANGED' : 'NOT_COMPARABLE'
            immediateTrajectory = sameFp ? 'NO_PROGRESS' : 'UNKNOWN'
            recordedImmediate = true
          }
          transitionUnchanged = sameFp
        }

        if (countingConsecutiveUnchanged) {
          if (transitionUnchanged) {
            unchangedTransitions++
          } else {
            countingConsecutiveUnchanged = false
          }
        }

        currNodeIdx = prevNodeIdx
        prevNodeIdx++
      }

      if (observedTransitions === 0) {
        immediateMagnitudeDelta = 'NOT_COMPARABLE'
        immediateTrajectory = 'UNKNOWN'
      }

      if (unchangedTransitions >= SKILL_LINT_PARAMS.stagnationUnchangedTransitions) {
        stagnantIds.push(finding.findingId)
        if (unchangedTransitions > maxUnchanged) maxUnchanged = unchangedTransitions
      }

      persistence.push({
        findingId: finding.findingId,
        firstObservedVersion,
        currentVersion,
        observedTransitions,
        unchangedTransitions,
        magnitudeDelta: immediateMagnitudeDelta,
        seriesCoverage,
        trajectory: immediateTrajectory,
        ...(immediateDimensions ? { dimensions: immediateDimensions } : {})
      })
    }

    return {
      persistence,
      ...(stagnantIds.length > 0
        ? {
            stagnationNotice: {
              findingIds: stagnantIds,
              unchangedTransitions: maxUnchanged,
              message: STAGNATION_RECOMMENDATION_NOTICE
            }
          }
        : {})
    }
  }

  report(input: {
    skillId: string
    version?: number
    ruleId?: string
    category?: FindingCategory
    state?: 'OPEN' | 'REVIEWED'
    includeInventory?: boolean
    deepen?: string[]
    limit?: number
    cursor?: string
  }) {
    const limit = normalizePageLimit(input.limit, 20, 50)
    const skill = this.store.get(input.skillId)
    const historyMeta = this.store.history(input.skillId, { metadataOnly: true })
    const targetIdx =
      input.version !== undefined
        ? historyMeta.findIndex(item => item.version === input.version)
        : historyMeta.findIndex(item => item.version === skill.currentVersion)

    if (targetIdx < 0) {
      throw new AcademyError('VERSION_NOT_FOUND', `Skill ${input.skillId} version ${input.version} not found`)
    }

    const targetMeta = historyMeta[targetIdx]
    const baseMeta = targetIdx + 1 < historyMeta.length ? historyMeta[targetIdx + 1] : null
    const memo = new Map<string, PackageFacts>()

    const sig = sha256Hex(
      canonicalJson({
        mode: 'focal_lint',
        skillId: input.skillId,
        version: targetMeta.version,
        packageHash: targetMeta.packageHash,
        ruleId: input.ruleId ?? null,
        category: input.category ?? null,
        state: input.state ?? null,
        includeInventory: input.includeInventory === true,
        deepen: input.deepen ?? [],
        limit,
        ruleSetVersion: this.ruleSetVersion,
        tokenizerId: this.tokenizer.id
      })
    )
    const offset = input.cursor !== undefined ? decodeLintCursor(input.cursor, sig) : 0

    const targetRes = this.factsForVersionMeta(input.skillId, targetMeta, memo)
    const baseRes = baseMeta ? this.factsForVersionMeta(input.skillId, baseMeta, memo) : null

    const identity = {
      skillId: skill.id,
      name: skill.name,
      scope: skill.scope,
      status: skill.status,
      version: targetMeta.version,
      packageHash: targetMeta.packageHash,
      ruleSetVersion: this.ruleSetVersion,
      tokenizerId: this.tokenizer.id,
      lineConvention: LINE_CONVENTION
    }

    const recurrence = this.computeRecurrence(
      targetMeta.version,
      targetMeta.packageHash,
      baseMeta?.version ?? null,
      baseMeta?.packageHash ?? null,
      historyMeta.slice(targetIdx + 1)
    )

    if (!targetRes.facts) {
      return {
        identity,
        coverage: 'UNAVAILABLE' as LintCoverage,
        lintHealth: 'UNKNOWN' as LintHealth,
        counts: { invalid: 0, openReview: 0, reviewed: 0, observations: 0, total: 0 } satisfies LintCounts,
        findings: [] as SkillLintFinding[],
        deltaFromPredecessor: null,
        persistence: [] as FindingPersistenceInfo[],
        recurrence,
        sizeBreakdown: null,
        deepen: ['DESCRIPTION_TERMS', 'CATALOG_PRESSURE']
      }
    }

    const activeCatalog = this.store.list('ACTIVE')
    const reviews = this.store.lint.listActiveReviews(skill.id)
    const projected = projectReportFindings(targetRes.facts, {
      targetSkill: skill,
      activeCatalog,
      baseFacts: baseRes?.facts ?? undefined,
      reviews,
      includeDescriptionTerms: input.deepen?.includes('DESCRIPTION_TERMS'),
      includeCatalogPressure: input.deepen?.includes('CATALOG_PRESSURE'),
      tokenCountFn: text => this.tokenizer.count(text)
    })

    let baseProjectedFindings: SkillLintFinding[] | null = null
    if (baseRes?.facts) {
      baseProjectedFindings = projectReportFindings(baseRes.facts, {
        targetSkill: skill,
        activeCatalog,
        reviews
      }).findings
    }
    const deltaFromPredecessor = compareReports(
      baseRes?.facts ?? null,
      baseProjectedFindings,
      targetRes.facts,
      projected.findings
    )

    const { persistence, stagnationNotice } = this.computePersistenceAndStagnation(
      skill.id,
      targetMeta.version,
      targetRes.facts,
      projected.findings,
      baseMeta ? { version: baseMeta.version, facts: baseRes?.facts ?? null } : null,
      historyMeta.slice(targetIdx + 1),
      memo
    )

    const filtered = projected.findings.filter(f => {
      if (input.ruleId && f.ruleId !== input.ruleId) return false
      if (input.category && f.category !== input.category) return false
      if (input.state && f.state !== input.state) return false
      return true
    })

    let pageItems: SkillLintFinding[]
    let nextOffset: number
    if (offset === 0) {
      const highPriority = filtered.filter(f => f.priority === 'TECHNICAL' || f.priority === 'HIGH')
      const rest = filtered.filter(f => f.priority !== 'TECHNICAL' && f.priority !== 'HIGH')
      if (highPriority.length >= limit) {
        pageItems = highPriority
        nextOffset = highPriority.length
      } else {
        pageItems = [...highPriority, ...rest.slice(0, limit - highPriority.length)]
        nextOffset = pageItems.length
      }
    } else {
      pageItems = filtered.slice(offset, offset + limit)
      nextOffset = offset + pageItems.length
    }

    const nextCursor = nextOffset < filtered.length ? encodeLintCursor(sig, nextOffset) : undefined

    const topSections = [...targetRes.facts.measures.sections]
      .sort((a, b) => b.ownTokens - a.ownTokens || a.path.localeCompare(b.path))
      .slice(0, 5)
      .map(s => ({
        path: s.path,
        selector: s.selector,
        title: s.title,
        ownTokens: s.ownTokens,
        ownLines: s.ownLines,
        subtreeTokens: s.subtreeTokens
      }))
    const topResources = targetRes.facts.measures.files
      .filter(f => f.path !== 'SKILL.md')
      .sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path))
      .slice(0, 5)

    return {
      identity,
      coverage: targetRes.coverage,
      lintHealth: projected.lintHealth,
      counts: projected.counts,
      findings: pageItems,
      totalMatchedFindings: filtered.length,
      ...(nextCursor ? { nextCursor } : {}),
      deltaFromPredecessor,
      persistence,
      ...(stagnationNotice ? { stagnationNotice } : {}),
      recurrence,
      ...(projected.capabilityNotice ? { capabilityNotice: projected.capabilityNotice } : {}),
      sizeBreakdown: {
        measures: toEfficiencyMeasures(targetRes.facts),
        topSections,
        topResources
      },
      ...(input.includeInventory
        ? {
            inventory: {
              scripts: targetRes.facts.scripts,
              externalOrigins: [...new Set(targetRes.facts.externalRefs.map(r => r.origin))].sort()
            }
          }
        : {}),
      deepen: {
        reportDeepen: ['DESCRIPTION_TERMS', 'CATALOG_PRESSURE'],
        navigation: ['get_academy_skill(view:"outline")', 'get_academy_skill(view:"section")']
      }
    }
  }

  catalog(input: {
    status?: AcademySkillStatus
    scope?: AcademySkillScope
    ruleId?: string
    category?: FindingCategory
    lintHealth?: LintHealth
    limit?: number
    cursor?: string
  }) {
    const limit = normalizePageLimit(input.limit, 20, 50)
    const status = input.status ?? 'ACTIVE'
    const skills = this.store
      .list(status)
      .filter(skill => (input.scope ? skill.scope === input.scope : true))
    const hashMap = new Map(
      this.store.currentVersionHashes().map(item => [item.skillId, item] as const)
    )

    const sig = sha256Hex(
      canonicalJson({
        mode: 'catalog_lint',
        status,
        scope: input.scope ?? null,
        ruleId: input.ruleId ?? null,
        category: input.category ?? null,
        lintHealth: input.lintHealth ?? null,
        limit,
        ruleSetVersion: this.ruleSetVersion,
        tokenizerId: this.tokenizer.id,
        snapshot: skills.map(s => {
          const h = hashMap.get(s.id)
          return `${s.id}:${s.currentVersion}:${h?.packageHash ?? ''}:${h?.contentState ?? 'PRESENT'}`
        })
      })
    )
    const offset = input.cursor !== undefined ? decodeLintCursor(input.cursor, sig) : 0
    const slice = skills.slice(offset, offset + limit)
    const memo = new Map<string, PackageFacts>()
    const activeCatalog = status === 'ACTIVE' ? skills : this.store.list('ACTIVE')

    const analyzed = slice.map(skill => {
      const hashInfo = hashMap.get(skill.id)
      const meta: Pick<AcademySkillVersionMetadata, 'version' | 'packageHash' | 'contentState'> = {
        version: skill.currentVersion,
        packageHash: hashInfo?.packageHash ?? '',
        contentState: hashInfo?.contentState ?? 'PRESENT'
      }
      const res = this.factsForVersionMeta(skill.id, meta, memo)
      if (!res.facts) {
        return {
          skillId: skill.id,
          name: skill.name,
          scope: skill.scope,
          status: skill.status,
          version: skill.currentVersion,
          packageHash: meta.packageHash,
          coverage: 'UNAVAILABLE' as LintCoverage,
          lintHealth: 'UNKNOWN' as LintHealth,
          counts: { invalid: 0, openReview: 0, reviewed: 0, observations: 0, total: 0 } satisfies LintCounts,
          topRuleIds: [] as string[],
          findings: [] as SkillLintFinding[]
        }
      }

      const reviews = this.store.lint.listActiveReviews(skill.id)
      const projected = projectReportFindings(res.facts, {
        targetSkill: skill,
        activeCatalog,
        reviews
      })
      return {
        skillId: skill.id,
        name: skill.name,
        scope: skill.scope,
        status: skill.status,
        version: skill.currentVersion,
        packageHash: res.facts.packageHash,
        coverage: res.coverage,
        lintHealth: projected.lintHealth,
        counts: projected.counts,
        topRuleIds: [...new Set(projected.findings.map(f => f.ruleId))].slice(0, 5),
        findings: projected.findings
      }
    })

    const filtered = analyzed
      .filter(entry => {
        if (input.lintHealth && entry.lintHealth !== input.lintHealth) return false
        if (input.ruleId && !entry.findings.some(f => f.ruleId === input.ruleId)) return false
        if (input.category && !entry.findings.some(f => f.category === input.category)) return false
        return true
      })
      .map(({ findings: _omit, ...summary }) => summary)

    const nextOffset = offset + slice.length
    const nextCursor = nextOffset < skills.length ? encodeLintCursor(sig, nextOffset) : undefined
    const catalogPressure = ruleCatalogPressure(null, activeCatalog, text => this.tokenizer.count(text))

    return {
      items: filtered,
      pageAnalyzed: slice.length,
      matched: filtered.length,
      totalInScope: skills.length,
      ...(nextCursor ? { nextCursor } : {}),
      catalogPressure,
      notice:
        'Only skills in the returned page were analyzed; filters apply within the page and do not represent a global ranking or guarantee about unanalyzed skills.',
      ruleSetVersion: this.ruleSetVersion,
      tokenizerId: this.tokenizer.id,
      lineConvention: LINE_CONVENTION
    }
  }

  recordReview(input: {
    skillId: string
    expectedVersion: number
    findingId: string
    evidenceFingerprint: string
    rationale: string
    author: string
  }) {
    const rationale = typeof input.rationale === 'string' ? input.rationale.trim() : ''
    if (!rationale || rationale.length > 500) {
      throw new AcademyError('INVALID_ARGUMENT', 'rationale must be 1..500 characters')
    }
    const skill = this.store.get(input.skillId)
    if (skill.currentVersion !== input.expectedVersion) {
      throw new AcademyError('VERSION_CONFLICT', 'Skill changed since it was read', {
        expectedVersion: input.expectedVersion,
        currentVersion: skill.currentVersion
      })
    }

    const report = this.report({ skillId: input.skillId, version: input.expectedVersion, limit: 50 })
    const factsRes = this.factsFor(input.skillId, input.expectedVersion)
    if (!factsRes.facts) {
      throw new AcademyError('FINDING_STALE', 'Skill version content unavailable for review')
    }

    const activeCatalog = this.store.list('ACTIVE')
    const projected = projectReportFindings(factsRes.facts, {
      targetSkill: skill,
      activeCatalog,
      reviews: this.store.lint.listActiveReviews(skill.id)
    })
    const targetFinding = projected.findings.find(f => f.findingId === input.findingId)
    if (!targetFinding) {
      throw new AcademyError('FINDING_STALE', `Finding ${input.findingId} not present in version ${input.expectedVersion}`)
    }
    if (targetFinding.category !== 'REVIEW') {
      throw new AcademyError('FINDING_NOT_REVIEWABLE', `Finding ${input.findingId} has category ${targetFinding.category}`)
    }
    if (targetFinding.evidenceFingerprint !== input.evidenceFingerprint) {
      throw new AcademyError('FINDING_STALE', 'Finding evidenceFingerprint does not match current version', {
        expectedFingerprint: input.evidenceFingerprint,
        currentFingerprint: targetFinding.evidenceFingerprint
      })
    }

    const inserted = this.store.lint.insertReview({
      skillId: skill.id,
      findingId: targetFinding.findingId,
      ruleId: targetFinding.ruleId,
      ruleSetVersion: targetFinding.ruleSetVersion,
      evidenceFingerprint: targetFinding.evidenceFingerprint,
      magnitude: targetFinding.magnitude ?? null,
      skillVersion: input.expectedVersion,
      rationale,
      author: input.author
    })

    const updatedHealth = deriveLintHealth(
      factsRes.coverage,
      projected.findings.map(({ state: _s, review: _r, ...rest }) => rest),
      this.store.lint.listActiveReviews(skill.id)
    )

    return {
      state: 'PERSISTED' as const,
      reviewId: inserted.id,
      skillId: skill.id,
      version: input.expectedVersion,
      findingId: targetFinding.findingId,
      lintHealth: updatedHealth.lintHealth,
      counts: updatedHealth.counts,
      previousLintHealth: report.lintHealth
    }
  }

  revokeReview(input: {
    skillId: string
    expectedVersion: number
    findingId: string
    evidenceFingerprint: string
    author: string
  }) {
    const skill = this.store.get(input.skillId)
    if (skill.currentVersion !== input.expectedVersion) {
      throw new AcademyError('VERSION_CONFLICT', 'Skill changed since it was read', {
        expectedVersion: input.expectedVersion,
        currentVersion: skill.currentVersion
      })
    }
    const revokedCount = this.store.lint.revokeReviews(skill.id, input.findingId, input.author)
    if (revokedCount === 0) {
      throw new AcademyError('REVIEW_NOT_FOUND', `No active review found for finding ${input.findingId}`)
    }
    const updatedReport = this.report({ skillId: skill.id, version: input.expectedVersion, limit: 50 })
    return {
      state: 'PERSISTED' as const,
      revokedCount,
      skillId: skill.id,
      version: input.expectedVersion,
      findingId: input.findingId,
      lintHealth: updatedReport.lintHealth,
      counts: updatedReport.counts
    }
  }

  efficiencyForList(input: {
    status?: AcademySkillStatus
    scope?: AcademySkillScope
    includeEfficiency?: boolean
    limit?: number
    cursor?: string
  }): {
    items: Array<{
      id: string
      name: string
      description: string
      status: AcademySkillStatus
      stateRevision: number
      scope: AcademySkillScope
      currentVersion: number
      projectIds: string[]
      createdAt: string
      updatedAt: string
      efficiency: EfficiencyItem
    }>
    nextCursor?: string
    ruleSetVersion: string
    tokenizerId: string
    lineConvention: typeof LINE_CONVENTION
  } {
    const limit = normalizePageLimit(input.limit, 20, 50)
    const includeEfficiency = input.includeEfficiency === true
    const skills = this.store
      .list(input.status)
      .filter(skill => (input.scope ? skill.scope === input.scope : true))
    const hashMap = new Map(
      this.store.currentVersionHashes().map(item => [item.skillId, item] as const)
    )
    const sig = sha256Hex(
      canonicalJson({
        mode: 'list_efficiency',
        status: input.status ?? null,
        scope: input.scope ?? null,
        includeEfficiency,
        limit,
        ruleSetVersion: this.ruleSetVersion,
        tokenizerId: this.tokenizer.id,
        snapshot: skills.map(s => {
          const h = hashMap.get(s.id)
          return `${s.id}:${s.currentVersion}:${h?.packageHash ?? ''}:${h?.contentState ?? 'PRESENT'}`
        })
      })
    )
    const offset = input.cursor !== undefined ? decodeLintCursor(input.cursor, sig) : 0
    const slice = skills.slice(offset, offset + limit)
    const memo = new Map<string, PackageFacts>()

    const items = slice.map(skill => {
      const hashInfo = hashMap.get(skill.id)
      const packageHash = hashInfo?.packageHash ?? ''
      if (!includeEfficiency) {
        return {
          ...skill,
          efficiency: {
            skillId: skill.id,
            version: skill.currentVersion,
            packageHash,
            coverage: 'NOT_ANALYZED' as LintCoverage,
            ruleSetVersion: this.ruleSetVersion,
            tokenizerId: this.tokenizer.id,
            lineConvention: LINE_CONVENTION,
            measures: null
          }
        }
      }

      const versions = this.store.history(skill.id, { metadataOnly: true })
      const currMeta = versions.find(v => v.version === skill.currentVersion) ?? versions[0]
      const currIndex = versions.findIndex(v => v.version === currMeta.version)
      const prevMeta = currIndex >= 0 && currIndex + 1 < versions.length ? versions[currIndex + 1] : null

      const currRes = this.factsForVersionMeta(skill.id, currMeta, memo)
      const prevRes = prevMeta ? this.factsForVersionMeta(skill.id, prevMeta, memo) : null

      return {
        ...skill,
        efficiency: {
          skillId: skill.id,
          version: currMeta.version,
          packageHash: currMeta.packageHash,
          coverage: currRes.coverage,
          ruleSetVersion: this.ruleSetVersion,
          tokenizerId: this.tokenizer.id,
          lineConvention: LINE_CONVENTION,
          measures: currRes.facts ? toEfficiencyMeasures(currRes.facts) : null,
          delta: buildMeasuresDelta(
            prevRes?.facts ?? null,
            currRes.facts,
            prevMeta ? prevMeta.version : null
          )
        }
      }
    })

    const nextOffset = offset + slice.length
    const nextCursor = nextOffset < skills.length ? encodeLintCursor(sig, nextOffset) : undefined

    return {
      items,
      ...(nextCursor ? { nextCursor } : {}),
      ruleSetVersion: this.ruleSetVersion,
      tokenizerId: this.tokenizer.id,
      lineConvention: LINE_CONVENTION
    }
  }

  efficiencyForHistory(
    skillId: string,
    input: {
      includeEfficiency?: boolean
      limit?: number
      cursor?: string
    }
  ): {
    skillId: string
    items: Array<AcademySkillVersionMetadata & { efficiency: EfficiencyItem }>
    nextCursor?: string
    ruleSetVersion: string
    tokenizerId: string
    lineConvention: typeof LINE_CONVENTION
  } {
    const limit = normalizePageLimit(input.limit, 20, 50)
    const includeEfficiency = input.includeEfficiency === true
    const versions = this.store.history(skillId, { metadataOnly: true })
    const sig = sha256Hex(
      canonicalJson({
        mode: 'history_efficiency',
        skillId,
        includeEfficiency,
        limit,
        ruleSetVersion: this.ruleSetVersion,
        tokenizerId: this.tokenizer.id,
        versions: versions.map(v => `${v.version}:${v.packageHash}:${v.contentState ?? 'PRESENT'}`)
      })
    )
    const offset = input.cursor !== undefined ? decodeLintCursor(input.cursor, sig) : 0
    const slice = versions.slice(offset, offset + limit)
    const memo = new Map<string, PackageFacts>()

    const items = slice.map((meta, idx) => {
      if (!includeEfficiency) {
        return {
          ...meta,
          efficiency: {
            skillId,
            version: meta.version,
            packageHash: meta.packageHash,
            coverage: 'NOT_ANALYZED' as LintCoverage,
            ruleSetVersion: this.ruleSetVersion,
            tokenizerId: this.tokenizer.id,
            lineConvention: LINE_CONVENTION,
            measures: null
          }
        }
      }
      const globalIdx = offset + idx
      const prevMeta = globalIdx + 1 < versions.length ? versions[globalIdx + 1] : null
      const currRes = this.factsForVersionMeta(skillId, meta, memo)
      const prevRes = prevMeta ? this.factsForVersionMeta(skillId, prevMeta, memo) : null

      return {
        ...meta,
        efficiency: {
          skillId,
          version: meta.version,
          packageHash: meta.packageHash,
          coverage: currRes.coverage,
          ruleSetVersion: this.ruleSetVersion,
          tokenizerId: this.tokenizer.id,
          lineConvention: LINE_CONVENTION,
          measures: currRes.facts ? toEfficiencyMeasures(currRes.facts) : null,
          delta: buildMeasuresDelta(
            prevRes?.facts ?? null,
            currRes.facts,
            prevMeta ? prevMeta.version : null
          )
        }
      }
    })

    const nextOffset = offset + slice.length
    const nextCursor = nextOffset < versions.length ? encodeLintCursor(sig, nextOffset) : undefined

    return {
      skillId,
      items,
      ...(nextCursor ? { nextCursor } : {}),
      ruleSetVersion: this.ruleSetVersion,
      tokenizerId: this.tokenizer.id,
      lineConvention: LINE_CONVENTION
    }
  }
}
