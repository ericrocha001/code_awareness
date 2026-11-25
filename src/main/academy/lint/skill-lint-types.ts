export const LINE_CONVENTION = 'LF_COUNT_PLUS_UNTERMINATED_FINAL' as const
export type LineConvention = typeof LINE_CONVENTION

export type LintCoverage = 'NOT_ANALYZED' | 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'
export type LintHealth = 'INVALID' | 'REVIEW_OPEN' | 'REVIEWED' | 'NO_FINDINGS' | 'UNKNOWN'
export type FindingCategory = 'INVALID' | 'REVIEW' | 'OBSERVATION'
export type FindingPriority = 'TECHNICAL' | 'HIGH' | 'NORMAL' | 'INFO'
export type FindingState = 'OPEN' | 'REVIEWED' | 'RESOLVED'

export interface LintRange {
  startLine: number
  endLine: number
  startOffset: number
  endOffset: number
}

export type MarkdownBlockType =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'blockquote'
  | 'fenced_code'
  | 'indented_code'
  | 'table'
  | 'html'
  | 'frontmatter'

export interface ParsedMarkdownBlock {
  blockIndex: number
  type: MarkdownBlockType
  range: LintRange
  headingIndex?: number
  level?: number
  title?: string
  rawText: string
}

export interface ParsedMarkdownHeading {
  headingIndex: number
  blockIndex: number
  level: number
  title: string
  range: LintRange
}

export interface ParsedMarkdownLink {
  rawTarget: string
  range: LintRange
  kind: 'INLINE' | 'IMAGE' | 'REFERENCE'
}

export interface ParsedMarkdownFile {
  coverage: 'COMPLETE' | 'PARTIAL'
  partialReasons: string[]
  lineCount: number
  frontmatterRange: LintRange | null
  bodyStartOffset: number
  hasNavigationIndex: boolean
  headings: ParsedMarkdownHeading[]
  blocks: ParsedMarkdownBlock[]
  links: ParsedMarkdownLink[]
}

export interface FileMeasure {
  path: string
  bytes: number
  lines: number
  tokens: number
  sha256: string
  isMarkdown: boolean
  coverage: 'COMPLETE' | 'PARTIAL'
}

export interface SectionMeasure {
  path: string
  selector: string
  headingIndex: number
  level: number
  title: string
  range: LintRange
  subtreeRange: LintRange
  ownTokens: number
  ownLines: number
  ownBytes: number
  subtreeTokens: number
  subtreeLines: number
  subtreeBytes: number
}

export interface SkillMeasures {
  lineConvention: LineConvention
  tokenizerId: string
  tokenizerEncoding: string
  nameTokens: number
  descriptionTokens: number
  metadataTokens: number
  frontmatterTokens: number
  bodyTokens: number
  bodyLines: number
  bodyBytes: number
  skillMdTokens: number
  skillMdLines: number
  skillMdBytes: number
  resourcesTokens: number
  resourcesBytes: number
  packageTokens: number
  packageBytes: number
  resourceCount: number
  files: FileMeasure[]
  sections: SectionMeasure[]
}

export interface ScriptCandidate {
  path: string
  sha256: string
  detectionReason: 'EXTENSION' | 'SHEBANG'
  extension?: string
  shebang?: string
}

export interface ProseBlockFact {
  path: string
  blockIndex: number
  selector: string
  range: LintRange
  tokens: number
  normalizedHash: string
}

export interface LocalLinkFact {
  path: string
  target: string
  range: LintRange
}

export interface ExternalRefFact {
  path: string
  origin: string
  range: LintRange
}

export interface FileOutlineEntry {
  selector: string
  kind: 'HEADING' | 'BLOCK'
  blockType: MarkdownBlockType
  headingIndex?: number
  blockIndex: number
  level?: number
  title?: string
  range: LintRange
  subtreeRange?: LintRange
  ownTokens?: number
  ownLines?: number
  subtreeTokens?: number
  subtreeLines?: number
  tokens?: number
}

export interface FileOutlineFact {
  path: string
  coverage: 'COMPLETE' | 'PARTIAL'
  hasNavigationIndex: boolean
  entries: FileOutlineEntry[]
}

export type FindingMagnitude = Record<string, number>

export interface SkillLintFindingReview {
  reviewId: string
  rationale: string
  author: string
  createdAt: string
  skillVersion: number
  evidenceFingerprint: string
}

export interface SkillLintFinding {
  findingId: string
  ruleId: string
  ruleSetVersion: string
  category: FindingCategory
  priority: FindingPriority
  obligation?: 'ACADEMY_CANONICAL' | 'EXTERNAL_SPECIFICATION'
  path: string
  range?: LintRange
  selector?: string
  occurrences?: Array<{ path: string; range: LintRange; selector?: string; tokens?: number }>
  fact: Record<string, unknown>
  policy: { source?: string; threshold?: number | Record<string, number> }
  action: string
  magnitude?: FindingMagnitude
  evidenceFingerprint: string
  state?: 'OPEN' | 'REVIEWED'
  review?: SkillLintFindingReview
  deltaStatus?: 'INTRODUCED' | 'WORSENED' | 'PERSISTENT'
  improved?: boolean
}

export interface PackageFacts {
  schemaVersion: number
  packageHash: string
  ruleSetVersion: string
  tokenizerId: string
  tokenizerEncoding: string
  lineConvention: LineConvention
  coverage: 'COMPLETE' | 'PARTIAL'
  metadata: {
    name: string | null
    description: string | null
    frontmatterValid: boolean
    validationErrorCode?: string
    validationErrorMessage?: string
  }
  measures: SkillMeasures
  outlines: Record<string, FileOutlineFact>
  proseBlocks: ProseBlockFact[]
  localLinks: LocalLinkFact[]
  externalRefs: ExternalRefFact[]
  scripts: ScriptCandidate[]
  localFindings: SkillLintFinding[]
}

export interface LintCounts {
  invalid: number
  openReview: number
  reviewed: number
  observations: number
  total: number
}

export interface LintReviewRecord {
  id: string
  skillId: string
  findingId: string
  ruleId: string
  ruleSetVersion: string
  evidenceFingerprint: string
  magnitude: FindingMagnitude | null
  skillVersion: number
  rationale: string
  author: string
  createdAt: string
  revokedAt: string | null
  revokedBy: string | null
}

export type MagnitudeDelta = 'REDUCED' | 'UNCHANGED' | 'INCREASED' | 'NOT_COMPARABLE'
export type TrajectorySignal = 'RESOLVED' | 'IMPROVING' | 'REGRESSING' | 'NO_PROGRESS' | 'UNKNOWN'

export interface FindingPersistenceInfo {
  findingId: string
  firstObservedVersion: number
  currentVersion: number
  observedTransitions: number
  unchangedTransitions: number
  magnitudeDelta: MagnitudeDelta
  seriesCoverage: 'COMPLETE' | 'PARTIAL'
  trajectory: TrajectorySignal
  dimensions?: Record<string, MagnitudeDelta>
}

export interface StagnationNotice {
  findingIds: string[]
  unchangedTransitions: number
  message: string
}

export type RecurrenceSignal =
  | { state: 'NONE'; windowVersions: number }
  | { state: 'NO_CHANGE'; matchedVersion: number; packageHash: string; windowVersions: number }
  | { state: 'CYCLE_DETECTED'; matchedVersion: number; packageHash: string; windowVersions: number; note: string }

export interface EfficiencyItem {
  skillId: string
  name?: string
  version: number
  packageHash: string
  coverage: LintCoverage
  ruleSetVersion: string
  tokenizerId: string
  lineConvention: LineConvention
  measures: {
    metadataTokens: number
    bodyTokens: number
    bodyLines: number
    skillMdTokens: number
    resourcesTokens: number
    packageTokens: number
    packageBytes: number
    resourceCount: number
  } | null
  delta?: {
    predecessorVersion: number | null
    comparable: boolean
    reason?: string
    metadataTokensDelta?: number
    bodyTokensDelta?: number
    bodyLinesDelta?: number
    packageTokensDelta?: number
    packageBytesDelta?: number
  }
}

export interface LintComparisonResult {
  comparable: boolean
  reason?: string
  introduced: SkillLintFinding[]
  worsened: SkillLintFinding[]
  resolved: SkillLintFinding[]
  persistent: SkillLintFinding[]
  measuresDelta: {
    comparable: boolean
    reason?: string
    metadataTokensDelta?: number
    bodyTokensDelta?: number
    bodyLinesDelta?: number
    packageTokensDelta?: number
    packageBytesDelta?: number
  } | null
}
