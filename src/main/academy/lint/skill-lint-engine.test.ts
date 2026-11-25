import { describe, expect, it } from 'vitest'
import { getCanonicalTokenizer, type TokenizerPort } from '../../core/tokenizer'
import { analyzePackageFacts, compareReports, deriveLintHealth } from './skill-lint-engine'
import type { LintReviewRecord, SkillLintFinding } from './skill-lint-types'

const tok = getCanonicalTokenizer()

function makeFinding(overrides: Partial<SkillLintFinding>): SkillLintFinding {
  return {
    findingId: 'ROOT_CONTEXT_REVIEW:1234',
    ruleId: 'ROOT_CONTEXT_REVIEW',
    ruleSetVersion: 'academy-skill-lint@1+test',
    category: 'REVIEW',
    priority: 'NORMAL',
    path: 'SKILL.md',
    fact: {},
    policy: {},
    action: 'Test',
    evidenceFingerprint: 'fp-1',
    ...overrides
  }
}

describe('skill-lint-engine (lintHealth & delta comparison)', () => {
  it('enforces lintHealth precedence and never declares incomplete coverage as NO_FINDINGS or REVIEWED', () => {
    expect(deriveLintHealth('COMPLETE', [])).toMatchObject({ lintHealth: 'NO_FINDINGS' })
    expect(deriveLintHealth('PARTIAL', [])).toMatchObject({ lintHealth: 'UNKNOWN' })
    expect(deriveLintHealth('UNAVAILABLE', [])).toMatchObject({ lintHealth: 'UNKNOWN' })

    const reviewFinding = makeFinding({})
    expect(deriveLintHealth('COMPLETE', [reviewFinding])).toMatchObject({ lintHealth: 'REVIEW_OPEN' })
    expect(deriveLintHealth('PARTIAL', [reviewFinding])).toMatchObject({ lintHealth: 'REVIEW_OPEN' })

    const validReview: LintReviewRecord = {
      id: 'rev-1',
      skillId: 'skill-1',
      findingId: reviewFinding.findingId,
      ruleId: reviewFinding.ruleId,
      ruleSetVersion: reviewFinding.ruleSetVersion,
      evidenceFingerprint: reviewFinding.evidenceFingerprint,
      magnitude: { tokens: 9000, lines: 600 },
      skillVersion: 1,
      rationale: 'Cohesive reference',
      author: 'MCP:tester',
      createdAt: '2026-11-25T00:00:00Z',
      revokedAt: null,
      revokedBy: null
    }

    const withMag = makeFinding({ magnitude: { tokens: 8500, lines: 580 } })
    expect(deriveLintHealth('COMPLETE', [withMag], [validReview])).toMatchObject({
      lintHealth: 'REVIEWED',
      counts: { reviewed: 1, openReview: 0 }
    })
    expect(deriveLintHealth('PARTIAL', [withMag], [validReview])).toMatchObject({
      lintHealth: 'UNKNOWN',
      counts: { reviewed: 1, openReview: 0 }
    })

    // Magnitude increase reopens the review
    const worsened = makeFinding({ magnitude: { tokens: 9500, lines: 580 } })
    expect(deriveLintHealth('COMPLETE', [worsened], [validReview])).toMatchObject({
      lintHealth: 'REVIEW_OPEN',
      counts: { reviewed: 0, openReview: 1 }
    })

    // INVALID outranks REVIEW_OPEN
    const invalid = makeFinding({
      findingId: 'FORMAT_COMPATIBILITY:inv',
      ruleId: 'FORMAT_COMPATIBILITY',
      category: 'INVALID',
      priority: 'TECHNICAL'
    })
    expect(deriveLintHealth('PARTIAL', [withMag, invalid], [])).toMatchObject({
      lintHealth: 'INVALID',
      counts: { invalid: 1, openReview: 1 }
    })
  })

  it('reports IMPROVING for 9000->6000 tokens while REVIEW persists, and does not net A resolved + B introduced', () => {
    const makeBigBody = (lines: number) =>
      `---\nname: big\ndescription: Big skill\n---\n${Array.from({ length: lines }, (_, i) => `Instruction line number ${i} with steady words.`).join('\n')}\n`

    const v1 = analyzePackageFacts({ skillMd: makeBigBody(900), artifacts: {} }, tok)
    const v2 = analyzePackageFacts({ skillMd: makeBigBody(600), artifacts: {} }, tok)
    const cmp = compareReports(v1, v1.localFindings, v2, v2.localFindings)

    expect(cmp.comparable).toBe(true)
    expect(cmp.worsened).toHaveLength(0)
    expect(cmp.persistent).toHaveLength(1)
    expect(cmp.persistent[0].ruleId).toBe('ROOT_CONTEXT_REVIEW')
    expect(cmp.persistent[0].improved).toBe(true)
    expect(cmp.measuresDelta?.bodyTokensDelta).toBeLessThan(0)

    // A resolved + B introduced are reported separately
    const fA = makeFinding({ findingId: 'LOCAL_REFERENCE_BROKEN:a', ruleId: 'LOCAL_REFERENCE_BROKEN' })
    const fB = makeFinding({ findingId: 'LOCAL_REFERENCE_BROKEN:b', ruleId: 'LOCAL_REFERENCE_BROKEN' })
    const cmpDistinct = compareReports(v1, [fA], v2, [fB])
    expect(cmpDistinct.resolved.map(f => f.findingId)).toEqual(['LOCAL_REFERENCE_BROKEN:a'])
    expect(cmpDistinct.introduced.map(f => f.findingId)).toEqual(['LOCAL_REFERENCE_BROKEN:b'])
  })

  it('refuses fabricated regression when tokenizer changes', () => {
    const fakeTok: TokenizerPort = { id: 'fake@1', encoding: 'chars', count: s => s.length }
    const pkg = { skillMd: '---\nname: tok\ndescription: Tok\n---\n# H\nHello\n', artifacts: {} }
    const a = analyzePackageFacts(pkg, tok)
    const b = analyzePackageFacts(pkg, fakeTok)
    const cmp = compareReports(a, a.localFindings, b, b.localFindings)
    expect(cmp.comparable).toBe(false)
    expect(cmp.reason).toBe('POLICY_OR_TOKENIZER_CHANGED')
    expect(cmp.introduced).toEqual([])
    expect(cmp.worsened).toEqual([])
  })
})
