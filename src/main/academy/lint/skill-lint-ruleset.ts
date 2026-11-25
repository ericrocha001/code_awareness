import { createHash } from 'node:crypto'
import { canonicalJson } from '../publication/openai-plugin-model'

export const SKILL_LINT_PARAMS = Object.freeze({
  metadataTokensReview: 100,
  rootBodyTokensReview: 5000,
  rootBodyLinesReview: 500,
  longReferenceLines: 100,
  duplicateMinTokens: 20,
  agentSkillsNameMax: 64,
  agentSkillsDescriptionMax: 1024,
  stagnationUnchangedTransitions: 2,
  stagnationWindow: 5,
  recurrenceWindowVersions: 50
})

export const SKILL_LINT_DETECTORS = Object.freeze({
  markdown: 'conservative-md/1',
  scripts: 'script-detector/1'
})

const paramDigest = createHash('sha256')
  .update(canonicalJson({ params: SKILL_LINT_PARAMS, detectors: SKILL_LINT_DETECTORS }))
  .digest('hex')
  .slice(0, 12)

export const SKILL_LINT_RULESET = Object.freeze({
  id: 'academy-skill-lint',
  version: 1,
  ruleSetVersion: `academy-skill-lint@1+${paramDigest}`,
  params: SKILL_LINT_PARAMS,
  detectors: SKILL_LINT_DETECTORS
})

export const SCRIPT_EXTENSIONS = new Set([
  '.py',
  '.sh',
  '.ps1',
  '.bat',
  '.cmd',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.rb',
  '.pl'
])

export const CAPABILITY_LIMITATION_NOTICE =
  'The detector covers observed changes to scripts and external references; it does not audit content security, intent, activation, or old scripts; absence of findings does not imply safety.'

export const STAGNATION_RECOMMENDATION_NOTICE =
  'Do not repeat the same strategy; inspect the authority/structure, change approach, or end the intervention with an explicit limitation.'

export const POLICY_SOURCES = Object.freeze({
  agentSkillsSpec: 'https://agentskills.io/specification',
  bestPractices: 'https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices',
  evalSkills: 'https://developers.openai.com/blog/eval-skills',
  androidLint: 'https://developer.android.com/studio/write/lint',
  sonarNewCode: 'https://docs.sonarsource.com/sonarqube-server/user-guide/about-new-code'
})

export function detectScriptCandidate(
  filePath: string,
  content: string
): { detectionReason: 'EXTENSION' | 'SHEBANG'; extension?: string; shebang?: string } | null {
  const lower = filePath.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const slash = lower.lastIndexOf('/')
  const ext = dot > slash ? lower.slice(dot) : ''
  if (ext && SCRIPT_EXTENSIONS.has(ext)) {
    return { detectionReason: 'EXTENSION', extension: ext }
  }
  const stripped = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  if (stripped.startsWith('#!')) {
    const end = stripped.search(/\r?\n/)
    const firstLine = (end >= 0 ? stripped.slice(0, end) : stripped).trim()
    return { detectionReason: 'SHEBANG', shebang: firstLine.slice(0, 120) }
  }
  return null
}

export function isMarkdownPath(filePath: string): boolean {
  if (filePath === 'SKILL.md') return true
  const lower = filePath.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.markdown')
}
