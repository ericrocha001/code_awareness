import { posix } from 'node:path'
import type { AcademySkillSummary } from '../../../shared/types/academy-types'
import { canonicalJson } from '../publication/openai-plugin-model'
import {
  CAPABILITY_LIMITATION_NOTICE,
  POLICY_SOURCES,
  SKILL_LINT_PARAMS,
  SKILL_LINT_RULESET,
  isMarkdownPath
} from './skill-lint-ruleset'
import type {
  FindingMagnitude,
  LintRange,
  PackageFacts,
  ProseBlockFact,
  SkillLintFinding
} from './skill-lint-types'
import { sha256Hex } from './skill-measures'

export function makeFindingId(ruleId: string, anchor: string): string {
  return `${ruleId}:${sha256Hex(anchor).slice(0, 16)}`
}

export function makeEvidenceFingerprint(
  ruleId: string,
  anchor: string,
  canonicalFact: Record<string, unknown>
): string {
  return sha256Hex(canonicalJson({ ruleId, anchor, fact: canonicalFact }))
}

export function normalizeProseText(rawText: string): string {
  return rawText
    .split(/\r?\n/)
    .map(line => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join(' ')
}

export function extractExternalOrigin(rawTarget: string): string | null {
  try {
    const parsed = new URL(rawTarget)
    if (!parsed.host) return null
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}

export function isNonLocalReference(rawTarget: string): boolean {
  if (!rawTarget) return true
  if (rawTarget.startsWith('#') || rawTarget.startsWith('//')) return true
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(rawTarget)
}

function isDynamicOrPlaceholderTarget(rawTarget: string): boolean {
  if (rawTarget.startsWith('/')) return true
  return /[{}$<> *]/.test(rawTarget)
}

export function resolveLocalTarget(
  sourcePath: string,
  rawTarget: string
): { status: 'SKIP' } | { status: 'OUTSIDE'; resolvedPath: string } | { status: 'CANDIDATE'; resolvedPath: string } {
  if (isNonLocalReference(rawTarget)) return { status: 'SKIP' }
  if (isDynamicOrPlaceholderTarget(rawTarget)) return { status: 'SKIP' }
  const clean = rawTarget.split('#')[0].split('?')[0]
  if (!clean) return { status: 'SKIP' }
  let decoded: string
  try {
    decoded = decodeURIComponent(clean)
  } catch {
    return { status: 'SKIP' }
  }
  if (!decoded || decoded.includes('\0') || decoded.startsWith('/')) return { status: 'SKIP' }
  const sourceDir = sourcePath === 'SKILL.md' ? '' : posix.dirname(sourcePath)
  const joined = sourceDir && sourceDir !== '.' ? `${sourceDir}/${decoded}` : decoded
  const normalized = posix.normalize(joined).replace(/\/+$/, '')
  if (!normalized || normalized === '.') return { status: 'CANDIDATE', resolvedPath: 'SKILL.md' }
  if (normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)) {
    return { status: 'OUTSIDE', resolvedPath: normalized }
  }
  return { status: 'CANDIDATE', resolvedPath: normalized }
}

export function ruleFormatCompatibility(facts: PackageFacts): SkillLintFinding[] {
  const findings: SkillLintFinding[] = []
  if (!facts.metadata.frontmatterValid) {
    const anchor = `SKILL.md#frontmatter:${facts.metadata.validationErrorCode ?? 'INVALID_METADATA'}`
    const canonicalFact = {
      code: facts.metadata.validationErrorCode ?? 'INVALID_METADATA',
      message: facts.metadata.validationErrorMessage ?? 'Invalid package or frontmatter'
    }
    findings.push({
      findingId: makeFindingId('FORMAT_COMPATIBILITY', anchor),
      ruleId: 'FORMAT_COMPATIBILITY',
      ruleSetVersion: SKILL_LINT_RULESET.ruleSetVersion,
      category: 'INVALID',
      priority: 'TECHNICAL',
      obligation: 'ACADEMY_CANONICAL',
      path: 'SKILL.md',
      fact: canonicalFact,
      policy: { source: 'Academy canonical package validation' },
      action: 'Fix canonical frontmatter or package path validation errors before persisting.',
      evidenceFingerprint: makeEvidenceFingerprint('FORMAT_COMPATIBILITY', anchor, canonicalFact)
    })
    return findings
  }

  const name = facts.metadata.name ?? ''
  if (name.length > SKILL_LINT_PARAMS.agentSkillsNameMax) {
    const anchor = 'SKILL.md#frontmatter:name'
    const canonicalFact = { field: 'name', length: name.length }
    findings.push({
      findingId: makeFindingId('FORMAT_COMPATIBILITY', anchor),
      ruleId: 'FORMAT_COMPATIBILITY',
      ruleSetVersion: SKILL_LINT_RULESET.ruleSetVersion,
      category: 'REVIEW',
      priority: 'NORMAL',
      obligation: 'EXTERNAL_SPECIFICATION',
      path: 'SKILL.md',
      fact: { ...canonicalFact, limit: SKILL_LINT_PARAMS.agentSkillsNameMax },
      policy: { source: POLICY_SOURCES.agentSkillsSpec, threshold: SKILL_LINT_PARAMS.agentSkillsNameMax },
      action: `Shorten frontmatter name to <= ${SKILL_LINT_PARAMS.agentSkillsNameMax} characters for Agent Skills specification compatibility.`,
      magnitude: { chars: name.length },
      evidenceFingerprint: makeEvidenceFingerprint('FORMAT_COMPATIBILITY', anchor, canonicalFact)
    })
  }

  const description = facts.metadata.description ?? ''
  if (description.length > SKILL_LINT_PARAMS.agentSkillsDescriptionMax) {
    const anchor = 'SKILL.md#frontmatter:description'
    const canonicalFact = { field: 'description', length: description.length }
    findings.push({
      findingId: makeFindingId('FORMAT_COMPATIBILITY', anchor),
      ruleId: 'FORMAT_COMPATIBILITY',
      ruleSetVersion: SKILL_LINT_RULESET.ruleSetVersion,
      category: 'REVIEW',
      priority: 'NORMAL',
      obligation: 'EXTERNAL_SPECIFICATION',
      path: 'SKILL.md',
      fact: { ...canonicalFact, limit: SKILL_LINT_PARAMS.agentSkillsDescriptionMax },
      policy: { source: POLICY_SOURCES.agentSkillsSpec, threshold: SKILL_LINT_PARAMS.agentSkillsDescriptionMax },
      action: `Condense frontmatter description to <= ${SKILL_LINT_PARAMS.agentSkillsDescriptionMax} characters for Agent Skills specification compatibility.`,
      magnitude: { chars: description.length },
      evidenceFingerprint: makeEvidenceFingerprint('FORMAT_COMPATIBILITY', anchor, canonicalFact)
    })
  }

  return findings
}

export function ruleMetadataReview(facts: PackageFacts): SkillLintFinding[] {
  const { metadataTokens, nameTokens, descriptionTokens } = facts.measures
  if (metadataTokens < SKILL_LINT_PARAMS.metadataTokensReview) return []
  const anchor = 'SKILL.md#frontmatter'
  const canonicalFact = { metadataTokens, nameTokens, descriptionTokens }
  return [
    {
      findingId: makeFindingId('METADATA_REVIEW', anchor),
      ruleId: 'METADATA_REVIEW',
      ruleSetVersion: SKILL_LINT_RULESET.ruleSetVersion,
      category: 'REVIEW',
      priority: 'NORMAL',
      path: 'SKILL.md',
      fact: { ...canonicalFact, threshold: SKILL_LINT_PARAMS.metadataTokensReview },
      policy: { source: POLICY_SOURCES.bestPractices, threshold: SKILL_LINT_PARAMS.metadataTokensReview },
      action: 'Condense name and description while preserving activation triggers.',
      magnitude: { tokens: metadataTokens },
      evidenceFingerprint: makeEvidenceFingerprint('METADATA_REVIEW', anchor, canonicalFact)
    }
  ]
}

export function ruleRootContextReview(facts: PackageFacts): SkillLintFinding[] {
  const { bodyTokens, bodyLines, sections } = facts.measures
  if (
    bodyTokens < SKILL_LINT_PARAMS.rootBodyTokensReview &&
    bodyLines < SKILL_LINT_PARAMS.rootBodyLinesReview
  ) {
    return []
  }
  const anchor = 'SKILL.md#body'
  const topSections = sections
    .filter(section => section.path === 'SKILL.md')
    .sort((a, b) => b.ownTokens - a.ownTokens || a.headingIndex - b.headingIndex)
    .slice(0, 5)
    .map(section => ({
      selector: section.selector,
      title: section.title,
      ownTokens: section.ownTokens,
      ownLines: section.ownLines
    }))
  const canonicalFact = { bodyTokens, bodyLines }
  return [
    {
      findingId: makeFindingId('ROOT_CONTEXT_REVIEW', anchor),
      ruleId: 'ROOT_CONTEXT_REVIEW',
      ruleSetVersion: SKILL_LINT_RULESET.ruleSetVersion,
      category: 'REVIEW',
      priority: 'NORMAL',
      path: 'SKILL.md',
      fact: {
        ...canonicalFact,
        thresholds: {
          tokens: SKILL_LINT_PARAMS.rootBodyTokensReview,
          lines: SKILL_LINT_PARAMS.rootBodyLinesReview
        },
        topSections
      },
      policy: {
        source: POLICY_SOURCES.bestPractices,
        threshold: {
          tokens: SKILL_LINT_PARAMS.rootBodyTokensReview,
          lines: SKILL_LINT_PARAMS.rootBodyLinesReview
        }
      },
      action: 'Compress redundant instructions or shard into thematic references only if cohesive.',
      magnitude: { tokens: bodyTokens, lines: bodyLines },
      evidenceFingerprint: makeEvidenceFingerprint('ROOT_CONTEXT_REVIEW', anchor, canonicalFact)
    }
  ]
}

export function ruleDuplicates(facts: PackageFacts): SkillLintFinding[] {
  const groups = new Map<string, ProseBlockFact[]>()
  for (const block of facts.proseBlocks) {
    if (block.tokens < SKILL_LINT_PARAMS.duplicateMinTokens) continue
    const list = groups.get(block.normalizedHash) ?? []
    list.push(block)
    groups.set(block.normalizedHash, list)
  }

  const findings: SkillLintFinding[] = []
  for (const [normalizedHash, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.length < 2) continue
    const sorted = [...group].sort(
      (a, b) => a.path.localeCompare(b.path) || a.range.startOffset - b.range.startOffset
    )
    const paths = [...new Set(sorted.map(item => item.path))]
    const ruleId = paths.length === 1 ? 'EXACT_DUPLICATE' : 'CROSS_FILE_DUPLICATE'
    const anchor = normalizedHash
    const occurrences = sorted.map(item => ({
      path: item.path,
      range: item.range,
      selector: item.selector,
      tokens: item.tokens
    }))
    const canonicalFact = {
      normalizedHash,
      occurrenceCount: sorted.length,
      paths,
      tokensPerOccurrence: sorted.map(item => item.tokens)
    }
    findings.push({
      findingId: makeFindingId(ruleId, anchor),
      ruleId,
      ruleSetVersion: SKILL_LINT_RULESET.ruleSetVersion,
      category: 'REVIEW',
      priority: 'NORMAL',
      path: sorted[0].path,
      range: sorted[0].range,
      selector: sorted[0].selector,
      occurrences,
      fact: canonicalFact,
      policy: { threshold: SKILL_LINT_PARAMS.duplicateMinTokens },
      action: 'Verify duplicate prose occurrences and consolidate authority if appropriate (not a guarantee of token savings or semantic equivalence).',
      magnitude: { occurrences: sorted.length },
      evidenceFingerprint: makeEvidenceFingerprint(ruleId, anchor, canonicalFact)
    })
  }
  return findings
}

export function ruleLocalReferences(facts: PackageFacts): SkillLintFinding[] {
  const filePaths = new Set(facts.measures.files.map(file => file.path))
  const foldedPaths = new Map<string, string>()
  const dirPrefixes = new Set<string>()
  for (const filePath of filePaths) {
    foldedPaths.set(filePath.toLowerCase(), filePath)
    const parts = filePath.split('/')
    for (let i = 1; i < parts.length; i++) {
      dirPrefixes.add(parts.slice(0, i).join('/'))
    }
  }

  const brokenGroups = new Map<
    string,
    {
      sourcePath: string
      target: string
      resolvedPath: string
      reason: 'OUTSIDE_PACKAGE' | 'NOT_FOUND'
      caseInsensitiveMatch?: string
      occurrences: Array<{ path: string; range: LintRange }>
    }
  >()

  const resolvedMdEdges = new Map<string, Set<string>>()

  for (const link of facts.localLinks) {
    const resolved = resolveLocalTarget(link.path, link.target)
    if (resolved.status === 'SKIP') continue

    if (resolved.status === 'OUTSIDE') {
      const key = `${link.path}\0${link.target}`
      const existing = brokenGroups.get(key)
      if (existing) {
        existing.occurrences.push({ path: link.path, range: link.range })
      } else {
        brokenGroups.set(key, {
          sourcePath: link.path,
          target: link.target,
          resolvedPath: resolved.resolvedPath,
          reason: 'OUTSIDE_PACKAGE',
          occurrences: [{ path: link.path, range: link.range }]
        })
      }
      continue
    }

    const exists = filePaths.has(resolved.resolvedPath) || dirPrefixes.has(resolved.resolvedPath)
    if (!exists) {
      const key = `${link.path}\0${link.target}`
      const caseMatch = foldedPaths.get(resolved.resolvedPath.toLowerCase())
      const existing = brokenGroups.get(key)
      if (existing) {
        existing.occurrences.push({ path: link.path, range: link.range })
      } else {
        brokenGroups.set(key, {
          sourcePath: link.path,
          target: link.target,
          resolvedPath: resolved.resolvedPath,
          reason: 'NOT_FOUND',
          ...(caseMatch ? { caseInsensitiveMatch: caseMatch } : {}),
          occurrences: [{ path: link.path, range: link.range }]
        })
      }
      continue
    }

    if (
      isMarkdownPath(link.path) &&
      isMarkdownPath(resolved.resolvedPath) &&
      filePaths.has(resolved.resolvedPath)
    ) {
      const targets = resolvedMdEdges.get(link.path) ?? new Set<string>()
      targets.add(resolved.resolvedPath)
      resolvedMdEdges.set(link.path, targets)
    }
  }

  const findings: SkillLintFinding[] = []

  for (const [, group] of [...brokenGroups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const anchor = `${group.sourcePath}::${group.target}`
    const canonicalFact = {
      sourcePath: group.sourcePath,
      target: group.target,
      resolvedPath: group.resolvedPath,
      reason: group.reason,
      ...(group.caseInsensitiveMatch ? { caseInsensitiveMatch: group.caseInsensitiveMatch } : {}),
      occurrenceCount: group.occurrences.length
    }
    findings.push({
      findingId: makeFindingId('LOCAL_REFERENCE_BROKEN', anchor),
      ruleId: 'LOCAL_REFERENCE_BROKEN',
      ruleSetVersion: SKILL_LINT_RULESET.ruleSetVersion,
      category: 'REVIEW',
      priority: 'NORMAL',
      path: group.sourcePath,
      range: group.occurrences[0].range,
      ...(group.occurrences.length > 1 ? { occurrences: group.occurrences } : {}),
      fact: canonicalFact,
      policy: { source: POLICY_SOURCES.bestPractices },
      action: group.caseInsensitiveMatch
        ? `Update link target to match existing canonical path '${group.caseInsensitiveMatch}'.`
        : 'Fix or remove the broken local package reference, or add the missing resource.',
      evidenceFingerprint: makeEvidenceFingerprint('LOCAL_REFERENCE_BROKEN', anchor, canonicalFact)
    })
  }

  // BFS from SKILL.md for REFERENCE_CHAIN_REVIEW
  const shortestPath = new Map<string, string[]>([['SKILL.md', ['SKILL.md']]])
  const queue: string[] = ['SKILL.md']
  while (queue.length > 0) {
    const current = queue.shift()!
    const currentPath = shortestPath.get(current)!
    const neighbors = [...(resolvedMdEdges.get(current) ?? [])].sort()
    for (const next of neighbors) {
      if (!shortestPath.has(next)) {
        shortestPath.set(next, [...currentPath, next])
        queue.push(next)
      }
    }
  }

  const isNodeInCycle = (start: string): boolean => {
    const seen = new Set<string>()
    const stack = [...(resolvedMdEdges.get(start) ?? [])]
    while (stack.length > 0) {
      const node = stack.pop()!
      if (node === start) return true
      if (seen.has(node)) continue
      seen.add(node)
      for (const nxt of resolvedMdEdges.get(node) ?? []) stack.push(nxt)
    }
    return false
  }

  for (const [targetPath, chain] of [...shortestPath.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const depth = chain.length - 1
    if (targetPath === 'SKILL.md' || depth < 2) continue
    const inCycle = isNodeInCycle(targetPath)
    const anchor = targetPath
    const canonicalFact = { path: targetPath, depth, chain, inCycle }
    findings.push({
      findingId: makeFindingId('REFERENCE_CHAIN_REVIEW', anchor),
      ruleId: 'REFERENCE_CHAIN_REVIEW',
      ruleSetVersion: SKILL_LINT_RULESET.ruleSetVersion,
      category: 'REVIEW',
      priority: 'NORMAL',
      path: targetPath,
      fact: canonicalFact,
      policy: { source: POLICY_SOURCES.bestPractices, threshold: 1 },
      action: 'Consider linking this resource directly from SKILL.md so it is not only reachable via an indirect chain.',
      magnitude: { depth },
      evidenceFingerprint: makeEvidenceFingerprint('REFERENCE_CHAIN_REVIEW', anchor, canonicalFact)
    })
  }

  return findings
}

export function ruleLongReferenceNavigation(facts: PackageFacts): SkillLintFinding[] {
  const findings: SkillLintFinding[] = []
  for (const file of facts.measures.files) {
    if (file.path === 'SKILL.md' || !file.isMarkdown) continue
    if (file.coverage !== 'COMPLETE') continue
    if (file.lines <= SKILL_LINT_PARAMS.longReferenceLines) continue
    const outline = facts.outlines[file.path]
    if (!outline || outline.hasNavigationIndex) continue

    const anchor = file.path
    const canonicalFact = { path: file.path, lines: file.lines, hasNavigationIndex: false }
    findings.push({
      findingId: makeFindingId('LONG_REFERENCE_NAVIGATION_REVIEW', anchor),
      ruleId: 'LONG_REFERENCE_NAVIGATION_REVIEW',
      ruleSetVersion: SKILL_LINT_RULESET.ruleSetVersion,
      category: 'REVIEW',
      priority: 'NORMAL',
      path: file.path,
      fact: { ...canonicalFact, threshold: SKILL_LINT_PARAMS.longReferenceLines },
      policy: { source: POLICY_SOURCES.bestPractices, threshold: SKILL_LINT_PARAMS.longReferenceLines },
      action: 'Add a table of contents / summary index near the top of the file or split into focused thematic references.',
      magnitude: { lines: file.lines },
      evidenceFingerprint: makeEvidenceFingerprint('LONG_REFERENCE_NAVIGATION_REVIEW', anchor, canonicalFact)
    })
  }
  return findings
}

export function normalizeDescriptionForCollision(description: string): string {
  return description
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?]+$/g, '')
}

export function scopesOverlap(
  a: Pick<AcademySkillSummary, 'scope' | 'projectIds'>,
  b: Pick<AcademySkillSummary, 'scope' | 'projectIds'>
): boolean {
  if (a.scope === 'GLOBAL' || b.scope === 'GLOBAL') return true
  const setA = new Set(a.projectIds)
  return b.projectIds.some(id => setA.has(id))
}

function significantTerms(description: string): Set<string> {
  const tokens = description.toLowerCase().match(/[a-z0-9_-]{4,}/g) ?? []
  return new Set(tokens)
}

export function ruleDescriptionCollision(
  targetSkill: Pick<AcademySkillSummary, 'id' | 'scope' | 'projectIds' | 'status'> & { description: string },
  activeCatalog: AcademySkillSummary[],
  includeTerms = false
): SkillLintFinding[] {
  if (targetSkill.status !== 'ACTIVE') return []
  const normalizedTarget = normalizeDescriptionForCollision(targetSkill.description)
  if (!normalizedTarget) return []

  const colliding = activeCatalog
    .filter(
      other =>
        other.id !== targetSkill.id &&
        other.status === 'ACTIVE' &&
        scopesOverlap(targetSkill, other) &&
        normalizeDescriptionForCollision(other.description) === normalizedTarget
    )
    .sort((a, b) => a.id.localeCompare(b.id))

  const findings: SkillLintFinding[] = []
  if (colliding.length > 0) {
    const involvedIds = [targetSkill.id, ...colliding.map(c => c.id)].sort()
    const anchor = involvedIds.join(',')
    const canonicalFact = {
      normalizedDescription: normalizedTarget,
      collidingSkills: colliding.map(c => ({ skillId: c.id, name: c.name, scope: c.scope }))
    }
    findings.push({
      findingId: makeFindingId('DESCRIPTION_COLLISION', anchor),
      ruleId: 'DESCRIPTION_COLLISION',
      ruleSetVersion: SKILL_LINT_RULESET.ruleSetVersion,
      category: 'REVIEW',
      priority: 'NORMAL',
      path: 'SKILL.md',
      fact: canonicalFact,
      policy: { source: POLICY_SOURCES.bestPractices },
      action: 'Differentiate activation criteria in the descriptions so overlapping skills do not share identical triggers.',
      magnitude: { collidingCount: colliding.length },
      evidenceFingerprint: makeEvidenceFingerprint('DESCRIPTION_COLLISION', anchor, canonicalFact)
    })
  }

  if (includeTerms) {
    const targetTerms = significantTerms(targetSkill.description)
    const lexicalOverlaps: Array<{ skillId: string; name: string; sharedTerms: string[] }> = []
    for (const other of activeCatalog) {
      if (other.id === targetSkill.id || other.status !== 'ACTIVE' || !scopesOverlap(targetSkill, other)) continue
      const otherTerms = significantTerms(other.description)
      const shared = [...targetTerms].filter(term => otherTerms.has(term)).sort()
      if (shared.length > 0) {
        lexicalOverlaps.push({ skillId: other.id, name: other.name, sharedTerms: shared.slice(0, 12) })
      }
    }
    if (lexicalOverlaps.length > 0) {
      const anchor = `terms:${targetSkill.id}`
      const canonicalFact = {
        mode: 'DESCRIPTION_TERMS',
        comparisons: lexicalOverlaps.sort((a, b) => a.skillId.localeCompare(b.skillId))
      }
      findings.push({
        findingId: makeFindingId('DESCRIPTION_COLLISION', anchor),
        ruleId: 'DESCRIPTION_COLLISION',
        ruleSetVersion: SKILL_LINT_RULESET.ruleSetVersion,
        category: 'OBSERVATION',
        priority: 'INFO',
        path: 'SKILL.md',
        fact: canonicalFact,
        policy: { source: POLICY_SOURCES.bestPractices },
        action: 'Inspect shared trigger vocabulary if disambiguation between overlapping skills is needed.',
        evidenceFingerprint: makeEvidenceFingerprint('DESCRIPTION_COLLISION', anchor, canonicalFact)
      })
    }
  }

  return findings
}

export function ruleCapabilitySurfaceChange(
  baseFacts: PackageFacts | null,
  targetFacts: PackageFacts
): SkillLintFinding[] {
  const baseScripts = new Map((baseFacts?.scripts ?? []).map(script => [script.path, script]))
  const baseOrigins = new Set((baseFacts?.externalRefs ?? []).map(ref => ref.origin))
  const findings: SkillLintFinding[] = []

  for (const script of [...targetFacts.scripts].sort((a, b) => a.path.localeCompare(b.path))) {
    const prev = baseScripts.get(script.path)
    if (prev && prev.sha256 === script.sha256) continue
    const changeKind = prev ? 'MODIFIED_SCRIPT' : 'ADDED_SCRIPT'
    const anchor = `script:${script.path}`
    const canonicalFact = {
      changeKind,
      path: script.path,
      sha256: script.sha256,
      detectionReason: script.detectionReason,
      ...(script.extension ? { extension: script.extension } : {}),
      ...(script.shebang ? { shebang: script.shebang } : {})
    }
    findings.push({
      findingId: makeFindingId('CAPABILITY_SURFACE_CHANGE', anchor),
      ruleId: 'CAPABILITY_SURFACE_CHANGE',
      ruleSetVersion: SKILL_LINT_RULESET.ruleSetVersion,
      category: 'REVIEW',
      priority: 'HIGH',
      path: script.path,
      fact: { ...canonicalFact, limitation: CAPABILITY_LIMITATION_NOTICE },
      policy: { source: 'Academy capability surface review' },
      action: 'Verify purpose, effective permissions, execution context, and dependencies before using this script.',
      evidenceFingerprint: makeEvidenceFingerprint('CAPABILITY_SURFACE_CHANGE', anchor, canonicalFact)
    })
  }

  const newOriginRefs = new Map<string, { path: string; range: LintRange }>()
  for (const ref of targetFacts.externalRefs) {
    if (baseOrigins.has(ref.origin)) continue
    if (!newOriginRefs.has(ref.origin)) {
      newOriginRefs.set(ref.origin, { path: ref.path, range: ref.range })
    }
  }

  for (const [origin, loc] of [...newOriginRefs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const anchor = `origin:${origin}`
    const canonicalFact = {
      changeKind: 'ADDED_EXTERNAL_ORIGIN',
      origin,
      path: loc.path
    }
    findings.push({
      findingId: makeFindingId('CAPABILITY_SURFACE_CHANGE', anchor),
      ruleId: 'CAPABILITY_SURFACE_CHANGE',
      ruleSetVersion: SKILL_LINT_RULESET.ruleSetVersion,
      category: 'REVIEW',
      priority: 'HIGH',
      path: loc.path,
      range: loc.range,
      fact: { ...canonicalFact, limitation: CAPABILITY_LIMITATION_NOTICE },
      policy: { source: 'Academy capability surface review' },
      action: 'Verify purpose, authorization, and external destination trust before relying on this reference.',
      evidenceFingerprint: makeEvidenceFingerprint('CAPABILITY_SURFACE_CHANGE', anchor, canonicalFact)
    })
  }

  return findings
}

export function ruleCatalogPressure(
  targetSkill: Pick<AcademySkillSummary, 'id' | 'scope' | 'projectIds'> | null,
  activeCatalog: AcademySkillSummary[],
  tokenCountFn: (text: string) => number
): SkillLintFinding {
  const relevant = targetSkill
    ? activeCatalog.filter(item => item.status === 'ACTIVE' && scopesOverlap(targetSkill, item))
    : activeCatalog.filter(item => item.status === 'ACTIVE')

  let totalTokens = 0
  for (const item of relevant) {
    totalTokens += tokenCountFn(item.name) + tokenCountFn(item.description)
  }

  const anchor = targetSkill ? `catalog:${targetSkill.scope}:${targetSkill.id}` : 'catalog:active'
  const canonicalFact = {
    activeSkillCount: relevant.length,
    metadataTokensTotal: totalTokens,
    clientBudget: 'UNAVAILABLE'
  }
  return {
    findingId: makeFindingId('CATALOG_PRESSURE', anchor),
    ruleId: 'CATALOG_PRESSURE',
    ruleSetVersion: SKILL_LINT_RULESET.ruleSetVersion,
    category: 'OBSERVATION',
    priority: 'INFO',
    path: 'SKILL.md',
    fact: canonicalFact,
    policy: { source: POLICY_SOURCES.bestPractices },
    action: 'Informational catalog footprint; client runtime budget is unavailable so no truncation risk is inferred.',
    magnitude: { tokens: totalTokens, skills: relevant.length },
    evidenceFingerprint: makeEvidenceFingerprint('CATALOG_PRESSURE', anchor, canonicalFact)
  }
}

export function evaluateLocalPackageRules(facts: PackageFacts): SkillLintFinding[] {
  const formatFindings = ruleFormatCompatibility(facts)
  if (!facts.metadata.frontmatterValid) {
    return formatFindings
  }
  return [
    ...formatFindings,
    ...ruleMetadataReview(facts),
    ...ruleRootContextReview(facts),
    ...ruleDuplicates(facts),
    ...ruleLocalReferences(facts),
    ...ruleLongReferenceNavigation(facts)
  ]
}

export function getMagnitudeDimensions(ruleId: string): string[] {
  switch (ruleId) {
    case 'METADATA_REVIEW':
      return ['tokens']
    case 'ROOT_CONTEXT_REVIEW':
      return ['tokens', 'lines']
    case 'LONG_REFERENCE_NAVIGATION_REVIEW':
      return ['lines']
    case 'FORMAT_COMPATIBILITY':
      return ['chars']
    case 'EXACT_DUPLICATE':
    case 'CROSS_FILE_DUPLICATE':
      return ['occurrences']
    case 'REFERENCE_CHAIN_REVIEW':
      return ['depth']
    case 'DESCRIPTION_COLLISION':
      return ['collidingCount']
    default:
      return []
  }
}

export function findingInvolvesChangedPaths(finding: SkillLintFinding, changedPaths: Set<string>): boolean {
  if (changedPaths.has(finding.path)) return true
  if (finding.occurrences?.some(occ => changedPaths.has(occ.path))) return true
  return false
}

export const PACKAGE_LOCAL_RULES_VERSION_NOTE: Record<string, FindingMagnitude> = {}
