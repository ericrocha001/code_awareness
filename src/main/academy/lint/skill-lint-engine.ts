import type { AcademyPackage, AcademySkillSummary } from '../../../shared/types/academy-types'
import type { TokenizerPort } from '../../core/tokenizer'
import { AcademyError, hashAcademyPackage, normalizeAcademyPackage, parseSkillMetadata } from '../academy-package'
import {
  CAPABILITY_LIMITATION_NOTICE,
  SKILL_LINT_RULESET,
  detectScriptCandidate
} from './skill-lint-ruleset'
import {
  evaluateLocalPackageRules,
  extractExternalOrigin,
  getMagnitudeDimensions,
  isNonLocalReference,
  normalizeProseText,
  resolveLocalTarget,
  ruleCapabilitySurfaceChange,
  ruleCatalogPressure,
  ruleDescriptionCollision
} from './skill-lint-rules'
import {
  LINE_CONVENTION,
  type ExternalRefFact,
  type FileOutlineEntry,
  type FileOutlineFact,
  type FindingMagnitude,
  type InlinePathMentionFact,
  type LintComparisonResult,
  type LintCounts,
  type LintCoverage,
  type LintHealth,
  type LintReviewRecord,
  type LocalLinkFact,
  type PackageFacts,
  type ProseBlockFact,
  type ScriptCandidate,
  type SkillLintFinding
} from './skill-lint-types'
import { measurePackage, sha256Hex } from './skill-measures'

export const FACTS_SCHEMA_VERSION = 2

const PRIORITY_ORDER: Record<SkillLintFinding['priority'], number> = {
  TECHNICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  INFO: 3
}

export function sortFindings(findings: SkillLintFinding[]): SkillLintFinding[] {
  return [...findings].sort(
    (a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      a.path.localeCompare(b.path) ||
      (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) ||
      a.findingId.localeCompare(b.findingId)
  )
}

export function analyzePackageFacts(
  inputPkg: AcademyPackage,
  tokenizer: TokenizerPort,
  precomputedHash?: string
): PackageFacts {
  let pkg = inputPkg
  let packageHash = precomputedHash ?? ''
  let frontmatterValid = true
  let name: string | null = null
  let description: string | null = null
  let validationErrorCode: string | undefined
  let validationErrorMessage: string | undefined

  try {
    pkg = normalizeAcademyPackage(inputPkg)
    const meta = parseSkillMetadata(pkg.skillMd)
    name = meta.name
    description = meta.description
    if (!packageHash) packageHash = hashAcademyPackage(pkg)
  } catch (err) {
    frontmatterValid = false
    if (err instanceof AcademyError) {
      validationErrorCode = err.code
      validationErrorMessage = err.message
    } else {
      validationErrorCode = 'INVALID_PACKAGE'
      validationErrorMessage = err instanceof Error ? err.message : String(err)
    }
    if (!packageHash) {
      const rawArtifacts = inputPkg?.artifacts && typeof inputPkg.artifacts === 'object' ? inputPkg.artifacts : {}
      const keys = Object.keys(rawArtifacts).sort()
      packageHash = sha256Hex(
        JSON.stringify({
          skillMd: typeof inputPkg?.skillMd === 'string' ? inputPkg.skillMd : '',
          artifacts: keys.map(k => [k, rawArtifacts[k]])
        })
      )
    }
    pkg = {
      skillMd: typeof inputPkg?.skillMd === 'string' ? inputPkg.skillMd : '',
      artifacts:
        inputPkg?.artifacts && typeof inputPkg.artifacts === 'object' && !Array.isArray(inputPkg.artifacts)
          ? Object.fromEntries(
              Object.entries(inputPkg.artifacts).filter(([, v]) => typeof v === 'string')
            )
          : {}
    }
  }

  const hashPrefix = packageHash.slice(0, 12)
  const { measures, parsedMarkdown } = measurePackage(pkg, packageHash, { name, description }, tokenizer)

  const outlines: Record<string, FileOutlineFact> = {}
  const proseBlocks: ProseBlockFact[] = []
  const localLinks: LocalLinkFact[] = []
  const inlinePathMentions: InlinePathMentionFact[] = []
  const externalRefs: ExternalRefFact[] = []
  const scripts: ScriptCandidate[] = []
  const packageFileSet = new Set(measures.files.map(f => f.path))

  const sectionByFileAndBlock = new Map<string, (typeof measures.sections)[number]>()
  for (const section of measures.sections) {
    sectionByFileAndBlock.set(`${section.path}#h${section.headingIndex}`, section)
  }

  let overallCoverage: 'COMPLETE' | 'PARTIAL' = 'COMPLETE'
  const allEntries: Array<[string, string]> = [
    ['SKILL.md', pkg.skillMd],
    ...Object.entries(pkg.artifacts).sort(([a], [b]) => a.localeCompare(b))
  ]

  for (const [filePath, content] of allEntries) {
    const parsed = parsedMarkdown.get(filePath)
    if (parsed) {
      if (parsed.coverage === 'PARTIAL') overallCoverage = 'PARTIAL'
      const entries: FileOutlineEntry[] = []
      for (const block of parsed.blocks) {
        if (block.type === 'heading' && block.headingIndex !== undefined) {
          const section = sectionByFileAndBlock.get(`${filePath}#h${block.headingIndex}`)
          entries.push({
            selector: `${hashPrefix}:${filePath}#h${block.headingIndex}`,
            kind: 'HEADING',
            blockType: block.type,
            headingIndex: block.headingIndex,
            blockIndex: block.blockIndex,
            level: block.level,
            title: block.title,
            range: block.range,
            subtreeRange: section?.subtreeRange,
            ownTokens: section?.ownTokens,
            ownLines: section?.ownLines,
            subtreeTokens: section?.subtreeTokens,
            subtreeLines: section?.subtreeLines
          })
        } else {
          const blockTokens = tokenizer.count(block.rawText)
          const selector = `${hashPrefix}:${filePath}#b${block.blockIndex}`
          entries.push({
            selector,
            kind: 'BLOCK',
            blockType: block.type,
            blockIndex: block.blockIndex,
            range: block.range,
            tokens: blockTokens
          })
          if (block.type === 'paragraph' || block.type === 'list' || block.type === 'blockquote') {
            const normalized = normalizeProseText(block.rawText)
            if (normalized) {
              proseBlocks.push({
                path: filePath,
                blockIndex: block.blockIndex,
                selector,
                range: block.range,
                tokens: blockTokens,
                normalizedHash: sha256Hex(normalized)
              })
            }
          }
        }
      }

      outlines[filePath] = {
        path: filePath,
        coverage: parsed.coverage,
        hasNavigationIndex: parsed.hasNavigationIndex,
        entries
      }

      for (const link of parsed.links) {
        if (isNonLocalReference(link.rawTarget)) {
          const origin = extractExternalOrigin(link.rawTarget)
          if (origin) {
            externalRefs.push({ path: filePath, origin, range: link.range })
          }
        } else {
          localLinks.push({ path: filePath, target: link.rawTarget, range: link.range })
        }
      }

      if (filePath === 'SKILL.md') {
        for (const span of parsed.inlineCodeSpans) {
          if (/\s/.test(span.text) || span.text.includes('\\')) continue
          const resolved = resolveLocalTarget('SKILL.md', span.text)
          if (resolved.status !== 'CANDIDATE') continue
          if (resolved.resolvedPath === 'SKILL.md') continue
          if (!packageFileSet.has(resolved.resolvedPath)) continue
          inlinePathMentions.push({
            path: 'SKILL.md',
            target: span.text,
            resolvedPath: resolved.resolvedPath,
            range: span.range
          })
        }
      }
    }

    if (filePath !== 'SKILL.md') {
      const detected = detectScriptCandidate(filePath, content)
      if (detected) {
        const measure = measures.files.find(f => f.path === filePath)
        scripts.push({
          path: filePath,
          sha256: measure?.sha256 ?? sha256Hex(content),
          detectionReason: detected.detectionReason,
          ...(detected.extension ? { extension: detected.extension } : {}),
          ...(detected.shebang ? { shebang: detected.shebang } : {})
        })
      }
    }
  }

  const facts: PackageFacts = {
    schemaVersion: FACTS_SCHEMA_VERSION,
    packageHash,
    ruleSetVersion: SKILL_LINT_RULESET.ruleSetVersion,
    tokenizerId: tokenizer.id,
    tokenizerEncoding: tokenizer.encoding,
    lineConvention: LINE_CONVENTION,
    coverage: overallCoverage,
    metadata: {
      name,
      description,
      frontmatterValid,
      ...(validationErrorCode ? { validationErrorCode } : {}),
      ...(validationErrorMessage ? { validationErrorMessage } : {})
    },
    measures,
    outlines,
    proseBlocks,
    localLinks,
    inlinePathMentions,
    externalRefs,
    scripts,
    localFindings: []
  }

  facts.localFindings = sortFindings(evaluateLocalPackageRules(facts))
  return facts
}

export function isReviewValidForFinding(
  review: LintReviewRecord,
  finding: SkillLintFinding
): boolean {
  if (finding.category !== 'REVIEW') return false
  if (review.revokedAt !== null) return false
  if (review.findingId !== finding.findingId) return false
  if (review.ruleSetVersion !== finding.ruleSetVersion) return false

  const dims = getMagnitudeDimensions(finding.ruleId)
  if (dims.length > 0 && finding.magnitude && review.magnitude) {
    for (const dim of dims) {
      const currentVal = finding.magnitude[dim]
      const recordedVal = review.magnitude[dim]
      if (typeof currentVal !== 'number' || typeof recordedVal !== 'number') return false
      if (currentVal > recordedVal) return false
    }
    return true
  }

  return review.evidenceFingerprint === finding.evidenceFingerprint
}

export function applyReviewsToFindings(
  findings: SkillLintFinding[],
  reviews: LintReviewRecord[]
): SkillLintFinding[] {
  const byFindingId = new Map<string, LintReviewRecord[]>()
  for (const review of reviews) {
    if (review.revokedAt !== null) continue
    const list = byFindingId.get(review.findingId) ?? []
    list.push(review)
    byFindingId.set(review.findingId, list)
  }

  return findings.map(finding => {
    if (finding.category !== 'REVIEW') return finding
    const candidates = (byFindingId.get(finding.findingId) ?? []).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    )
    const valid = candidates.find(review => isReviewValidForFinding(review, finding))
    if (!valid) {
      return { ...finding, state: 'OPEN' as const }
    }
    return {
      ...finding,
      state: 'REVIEWED' as const,
      review: {
        reviewId: valid.id,
        rationale: valid.rationale,
        author: valid.author,
        createdAt: valid.createdAt,
        skillVersion: valid.skillVersion,
        evidenceFingerprint: valid.evidenceFingerprint
      }
    }
  })
}

export function deriveLintHealth(
  coverage: LintCoverage,
  findings: SkillLintFinding[],
  reviews: LintReviewRecord[] = []
): { lintHealth: LintHealth; counts: LintCounts; findings: SkillLintFinding[] } {
  const annotated = findings.some(f => f.state !== undefined)
    ? findings
    : applyReviewsToFindings(findings, reviews)

  let invalid = 0
  let openReview = 0
  let reviewed = 0
  let observations = 0

  for (const finding of annotated) {
    if (finding.category === 'INVALID') invalid++
    else if (finding.category === 'REVIEW') {
      if (finding.state === 'REVIEWED') reviewed++
      else openReview++
    } else if (finding.category === 'OBSERVATION') {
      observations++
    }
  }

  const counts: LintCounts = {
    invalid,
    openReview,
    reviewed,
    observations,
    total: annotated.length
  }

  let lintHealth: LintHealth
  if (invalid > 0) {
    lintHealth = 'INVALID'
  } else if (openReview > 0) {
    lintHealth = 'REVIEW_OPEN'
  } else if (coverage !== 'COMPLETE') {
    lintHealth = 'UNKNOWN'
  } else if (reviewed > 0) {
    lintHealth = 'REVIEWED'
  } else {
    lintHealth = 'NO_FINDINGS'
  }

  return { lintHealth, counts, findings: annotated }
}

export interface ProjectReportContext {
  targetSkill: (Pick<AcademySkillSummary, 'id' | 'name' | 'status' | 'scope' | 'projectIds'> & { description: string }) | null
  activeCatalog: AcademySkillSummary[]
  baseFacts?: PackageFacts | null
  reviews?: LintReviewRecord[]
  includeDescriptionTerms?: boolean
  includeCatalogPressure?: boolean
  tokenCountFn?: (text: string) => number
}

export function projectReportFindings(
  facts: PackageFacts,
  ctx: ProjectReportContext
): {
  findings: SkillLintFinding[]
  lintHealth: LintHealth
  counts: LintCounts
  capabilityNotice?: string
} {
  const rawFindings: SkillLintFinding[] = [...facts.localFindings]

  if (ctx.targetSkill) {
    rawFindings.push(
      ...ruleDescriptionCollision(
        ctx.targetSkill,
        ctx.activeCatalog,
        ctx.includeDescriptionTerms === true
      )
    )
  }

  if (ctx.baseFacts !== undefined) {
    rawFindings.push(...ruleCapabilitySurfaceChange(ctx.baseFacts, facts))
  }

  if (ctx.includeCatalogPressure && ctx.tokenCountFn) {
    rawFindings.push(ruleCatalogPressure(ctx.targetSkill, ctx.activeCatalog, ctx.tokenCountFn))
  }

  const sorted = sortFindings(rawFindings)
  const { lintHealth, counts, findings } = deriveLintHealth(facts.coverage, sorted, ctx.reviews ?? [])
  const hasCap = findings.some(f => f.ruleId === 'CAPABILITY_SURFACE_CHANGE')
  return {
    findings,
    lintHealth,
    counts,
    ...(hasCap ? { capabilityNotice: CAPABILITY_LIMITATION_NOTICE } : {})
  }
}

export function compareMagnitude(
  ruleId: string,
  baseMag: FindingMagnitude | undefined,
  candMag: FindingMagnitude | undefined
): {
  delta: 'REDUCED' | 'UNCHANGED' | 'INCREASED' | 'NOT_COMPARABLE'
  improved: boolean
  worsened: boolean
  dimensions?: Record<string, 'REDUCED' | 'UNCHANGED' | 'INCREASED' | 'NOT_COMPARABLE'>
} {
  const dims = getMagnitudeDimensions(ruleId)
  if (!dims.length || !baseMag || !candMag) {
    return { delta: 'NOT_COMPARABLE', improved: false, worsened: false }
  }
  const dimensions: Record<string, 'REDUCED' | 'UNCHANGED' | 'INCREASED' | 'NOT_COMPARABLE'> = {}
  let anyIncreased = false
  let anyReduced = false
  let allComparable = true

  for (const dim of dims) {
    const prev = baseMag[dim]
    const next = candMag[dim]
    if (typeof prev !== 'number' || typeof next !== 'number') {
      dimensions[dim] = 'NOT_COMPARABLE'
      allComparable = false
    } else if (next > prev) {
      dimensions[dim] = 'INCREASED'
      anyIncreased = true
    } else if (next < prev) {
      dimensions[dim] = 'REDUCED'
      anyReduced = true
    } else {
      dimensions[dim] = 'UNCHANGED'
    }
  }

  if (!allComparable) {
    return { delta: 'NOT_COMPARABLE', improved: false, worsened: false, dimensions }
  }
  if (anyIncreased && anyReduced) {
    return { delta: 'NOT_COMPARABLE', improved: false, worsened: false, dimensions }
  }
  if (anyIncreased) {
    return { delta: 'INCREASED', improved: false, worsened: true, dimensions }
  }
  if (anyReduced) {
    return { delta: 'REDUCED', improved: true, worsened: false, dimensions }
  }
  return { delta: 'UNCHANGED', improved: false, worsened: false, dimensions }
}

export function compareReports(
  baseFacts: PackageFacts | null,
  baseFindings: SkillLintFinding[] | null,
  candidateFacts: PackageFacts,
  candidateFindings: SkillLintFinding[]
): LintComparisonResult {
  const measuresDelta = (() => {
    if (!baseFacts) {
      return {
        comparable: true,
        metadataTokensDelta: candidateFacts.measures.metadataTokens,
        bodyTokensDelta: candidateFacts.measures.bodyTokens,
        bodyLinesDelta: candidateFacts.measures.bodyLines,
        packageTokensDelta: candidateFacts.measures.packageTokens,
        packageBytesDelta: candidateFacts.measures.packageBytes
      }
    }
    if (
      baseFacts.ruleSetVersion !== candidateFacts.ruleSetVersion ||
      baseFacts.tokenizerId !== candidateFacts.tokenizerId
    ) {
      return {
        comparable: false,
        reason: 'POLICY_OR_TOKENIZER_CHANGED'
      }
    }
    return {
      comparable: true,
      metadataTokensDelta: candidateFacts.measures.metadataTokens - baseFacts.measures.metadataTokens,
      bodyTokensDelta: candidateFacts.measures.bodyTokens - baseFacts.measures.bodyTokens,
      bodyLinesDelta: candidateFacts.measures.bodyLines - baseFacts.measures.bodyLines,
      packageTokensDelta: candidateFacts.measures.packageTokens - baseFacts.measures.packageTokens,
      packageBytesDelta: candidateFacts.measures.packageBytes - baseFacts.measures.packageBytes
    }
  })()

  if (!baseFacts || !baseFindings) {
    const actionable = candidateFindings.filter(f => f.category !== 'OBSERVATION')
    return {
      comparable: true,
      introduced: actionable.map(f => ({ ...f, deltaStatus: 'INTRODUCED' as const })),
      worsened: [],
      resolved: [],
      persistent: [],
      measuresDelta
    }
  }

  if (
    baseFacts.ruleSetVersion !== candidateFacts.ruleSetVersion ||
    baseFacts.tokenizerId !== candidateFacts.tokenizerId
  ) {
    return {
      comparable: false,
      reason: 'POLICY_OR_TOKENIZER_CHANGED',
      introduced: [],
      worsened: [],
      resolved: [],
      persistent: sortFindings(candidateFindings.filter(f => f.category !== 'OBSERVATION')),
      measuresDelta
    }
  }

  const baseActionable = baseFindings.filter(f => f.category !== 'OBSERVATION')
  const candActionable = candidateFindings.filter(f => f.category !== 'OBSERVATION')

  const baseById = new Map<string, SkillLintFinding[]>()
  for (const f of baseActionable) {
    const list = baseById.get(f.findingId) ?? []
    list.push(f)
    baseById.set(f.findingId, list)
  }
  const candById = new Map<string, SkillLintFinding[]>()
  for (const f of candActionable) {
    const list = candById.get(f.findingId) ?? []
    list.push(f)
    candById.set(f.findingId, list)
  }

  const introduced: SkillLintFinding[] = []
  const worsened: SkillLintFinding[] = []
  const resolved: SkillLintFinding[] = []
  const persistent: SkillLintFinding[] = []

  for (const cand of candActionable) {
    const baseMatches = baseById.get(cand.findingId) ?? []
    const candMatches = candById.get(cand.findingId) ?? []
    if (baseMatches.length === 0) {
      introduced.push({ ...cand, deltaStatus: 'INTRODUCED' })
      continue
    }
    if (baseMatches.length > 1 || candMatches.length > 1) {
      persistent.push({ ...cand, deltaStatus: 'PERSISTENT' })
      continue
    }
    const baseMatch = baseMatches[0]
    const mag = compareMagnitude(cand.ruleId, baseMatch.magnitude, cand.magnitude)
    if (mag.worsened) {
      worsened.push({
        ...cand,
        deltaStatus: 'WORSENED',
        ...(cand.ruleId === 'ROOT_CONTEXT_REVIEW'
          ? { fact: { ...cand.fact, transitionLabel: 'ROOT_GROWTH_REVIEW' } }
          : {})
      })
    } else {
      persistent.push({
        ...cand,
        deltaStatus: 'PERSISTENT',
        ...(mag.improved ? { improved: true } : {})
      })
    }
  }

  for (const base of baseActionable) {
    if (!candById.has(base.findingId)) {
      resolved.push(base)
    }
  }

  return {
    comparable: true,
    introduced: sortFindings(introduced),
    worsened: sortFindings(worsened),
    resolved: sortFindings(resolved),
    persistent: sortFindings(persistent),
    measuresDelta
  }
}
