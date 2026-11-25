import { describe, expect, it } from 'vitest'
import { getCanonicalTokenizer } from '../../core/tokenizer'
import type { AcademySkillSummary } from '../../../shared/types/academy-types'
import { analyzePackageFacts, projectReportFindings } from './skill-lint-engine'
import { extractExternalOrigin } from './skill-lint-rules'
import { detectScriptCandidate } from './skill-lint-ruleset'

const tok = getCanonicalTokenizer()

describe('skill-lint-rules (U2 pure)', () => {
  it('enforces FORMAT_COMPATIBILITY distinctions and allows large cohesive skills as REVIEW', () => {
    const longBody = Array.from({ length: 520 }, (_, i) => `Line ${i + 1} with cohesive instructions.`).join('\n')
    const facts = analyzePackageFacts(
      {
        skillMd: `---\nname: ${'a'.repeat(70)}\ndescription: Short valid desc\n---\n${longBody}\n`,
        artifacts: {}
      },
      tok
    )
    const fmt = facts.localFindings.find(f => f.ruleId === 'FORMAT_COMPATIBILITY')
    expect(fmt).toBeDefined()
    expect(fmt!.category).toBe('REVIEW')
    expect(fmt!.obligation).toBe('EXTERNAL_SPECIFICATION')

    const root = facts.localFindings.find(f => f.ruleId === 'ROOT_CONTEXT_REVIEW')
    expect(root).toBeDefined()
    expect(root!.category).toBe('REVIEW')
    expect(facts.localFindings.some(f => f.category === 'INVALID')).toBe(false)

    // Invalid candidate in preview -> INVALID ACADEMY_CANONICAL
    const invalidFacts = analyzePackageFacts({ skillMd: 'no frontmatter here', artifacts: {} }, tok)
    const invalidFmt = invalidFacts.localFindings.find(f => f.ruleId === 'FORMAT_COMPATIBILITY')
    expect(invalidFmt).toBeDefined()
    expect(invalidFmt!.category).toBe('INVALID')
    expect(invalidFmt!.priority).toBe('TECHNICAL')
    expect(invalidFmt!.obligation).toBe('ACADEMY_CANONICAL')
  })

  it('detects prose duplicates across files while excluding code, tables, and headings', () => {
    const prose =
      'Always verify repository state and inspect the exact configuration file before applying any local edit to target resources in this workspace.'
    const code = '```ts\nconst repeated = "Always verify repository state and inspect the exact configuration file before applying any local edit to target resources in this workspace.";\n```'
    const facts = analyzePackageFacts(
      {
        skillMd: `---\nname: dup-skill\ndescription: Duplicate check\n---\n# Section\n\n${prose}\n\n${code}\n`,
        artifacts: {
          'references/a.md': `# Section\n\n${prose}\n\n${code}\n`,
          'references/b.md': `${prose}\n`
        }
      },
      tok
    )
    const dupFindings = facts.localFindings.filter(
      f => f.ruleId === 'EXACT_DUPLICATE' || f.ruleId === 'CROSS_FILE_DUPLICATE'
    )
    expect(dupFindings).toHaveLength(1)
    expect(dupFindings[0].ruleId).toBe('CROSS_FILE_DUPLICATE')
    expect(dupFindings[0].occurrences).toHaveLength(3)
    expect(JSON.stringify(dupFindings[0])).not.toContain('const repeated')
  })

  it('resolves local links accurately, handles cycles/chains, and skips dynamic/external links', () => {
    const facts = analyzePackageFacts(
      {
        skillMd: [
          '---',
          'name: link-skill',
          'description: Link graph check',
          '---',
          '[ok](references/a.md)',
          '[missing](references/Missing.md)',
          '[outside](../secret.txt)',
          '[ext](https://example.com/docs)',
          '[dyn](references/${VAR}.md)',
          '[anchor](#local)'
        ].join('\n'),
        artifacts: {
          'references/a.md': '[to-b](b.md)\n[back-to-root](../SKILL.md)\n',
          'references/b.md': '[to-a](a.md)\n',
          'references/missing.md': 'Exists with lowercase name'
        }
      },
      tok
    )

    const broken = facts.localFindings.filter(f => f.ruleId === 'LOCAL_REFERENCE_BROKEN')
    expect(broken).toHaveLength(2)
    const caseBroken = broken.find(b => b.fact.target === 'references/Missing.md')
    expect(caseBroken?.fact.caseInsensitiveMatch).toBe('references/missing.md')
    const outBroken = broken.find(b => b.fact.target === '../secret.txt')
    expect(outBroken?.fact.reason).toBe('OUTSIDE_PACKAGE')

    const chains = facts.localFindings.filter(f => f.ruleId === 'REFERENCE_CHAIN_REVIEW')
    expect(chains).toHaveLength(1)
    expect(chains[0].path).toBe('references/b.md')
    expect(chains[0].fact.depth).toBe(2)
    expect(chains[0].fact.inCycle).toBe(true)
  })

  it('checks LONG_REFERENCE_NAVIGATION_REVIEW only when coverage is COMPLETE and no index exists', () => {
    const longNoIndex = Array.from({ length: 105 }, (_, i) => `Paragraph line ${i + 1}.`).join('\n')
    const longWithIndex = `# Table of Contents\n\n- [A](#a)\n\n${longNoIndex}`
    const longPartial = `${longNoIndex}\n\n<div>html makes coverage partial</div>\n`

    const facts = analyzePackageFacts(
      {
        skillMd: '---\nname: nav-skill\ndescription: Nav check\n---\n[a](references/no-index.md)\n',
        artifacts: {
          'references/no-index.md': longNoIndex,
          'references/with-index.md': longWithIndex,
          'references/partial.md': longPartial
        }
      },
      tok
    )
    const nav = facts.localFindings.filter(f => f.ruleId === 'LONG_REFERENCE_NAVIGATION_REVIEW')
    expect(nav.map(n => n.path)).toEqual(['references/no-index.md'])
  })

  it('detects DESCRIPTION_COLLISION only in overlapping scopes and does not claim catalog truncation', () => {
    const pkg = {
      skillMd: '---\nname: target\ndescription: Inspect deployment status quickly.\n---\n# Body\n',
      artifacts: {}
    }
    const facts = analyzePackageFacts(pkg, tok)
    const baseTime = '2026-11-25T00:00:00Z'
    const targetSkill: AcademySkillSummary = {
      id: 's1',
      name: 'target',
      description: 'Inspect deployment status quickly.',
      status: 'ACTIVE',
      stateRevision: 1,
      scope: 'PROJECT',
      currentVersion: 1,
      projectIds: ['proj-1'],
      createdAt: baseTime,
      updatedAt: baseTime
    }
    const isolatedOther: AcademySkillSummary = {
      ...targetSkill,
      id: 's2',
      name: 'isolated',
      projectIds: ['proj-2']
    }
    const overlappingOther: AcademySkillSummary = {
      ...targetSkill,
      id: 's3',
      name: 'overlap',
      description: '  inspect   deployment status quickly! ',
      scope: 'GLOBAL',
      projectIds: []
    }

    const isolatedReport = projectReportFindings(facts, {
      targetSkill,
      activeCatalog: [targetSkill, isolatedOther],
      includeCatalogPressure: true,
      tokenCountFn: text => tok.count(text)
    })
    expect(isolatedReport.findings.some(f => f.ruleId === 'DESCRIPTION_COLLISION')).toBe(false)
    const pressure = isolatedReport.findings.find(f => f.ruleId === 'CATALOG_PRESSURE')
    expect(pressure?.fact.clientBudget).toBe('UNAVAILABLE')

    const overlapReport = projectReportFindings(facts, {
      targetSkill,
      activeCatalog: [targetSkill, isolatedOther, overlappingOther]
    })
    expect(overlapReport.findings.some(f => f.ruleId === 'DESCRIPTION_COLLISION')).toBe(true)
  })

  it('detects scripts by extension or shebang, rejects data/docs under scripts/, and sanitizes secret URLs', () => {
    expect(detectScriptCandidate('scripts/run.py', 'print(1)')).toEqual({
      detectionReason: 'EXTENSION',
      extension: '.py'
    })
    expect(detectScriptCandidate('bin/helper', '#!/usr/bin/env bash\necho hi')).toEqual({
      detectionReason: 'SHEBANG',
      shebang: '#!/usr/bin/env bash'
    })
    expect(detectScriptCandidate('scripts/config.json', '{"a":1}')).toBeNull()
    expect(detectScriptCandidate('scripts/README.md', '# Docs')).toBeNull()
    expect(detectScriptCandidate('assets/blob.xyz', 'binary-like')).toBeNull()

    expect(extractExternalOrigin('https://user:pass@x.example:8443/p?token=SECRET123#frag')).toBe(
      'https://x.example:8443'
    )

    const baseFacts = analyzePackageFacts(
      {
        skillMd: '---\nname: cap\ndescription: Cap check\n---\n# Base\n',
        artifacts: { 'scripts/old.sh': '#!/bin/sh\necho old\n' }
      },
      tok
    )
    const nextFacts = analyzePackageFacts(
      {
        skillMd:
          '---\nname: cap\ndescription: Cap check\n---\n[api](https://user:pass@x.example/p?token=SECRET123)\n',
        artifacts: {
          'scripts/old.sh': '#!/bin/sh\necho old\n',
          'scripts/new.py': 'print("hi")',
          'scripts/data.json': '{}',
          'bin/exec': '#!/usr/bin/env node\nconsole.log(1)'
        }
      },
      tok
    )

    const projected = projectReportFindings(nextFacts, {
      targetSkill: null,
      activeCatalog: [],
      baseFacts
    })
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain('SECRET123')
    expect(serialized).not.toContain('pass@')
    const capFindings = projected.findings.filter(f => f.ruleId === 'CAPABILITY_SURFACE_CHANGE')
    expect(capFindings).toHaveLength(3)
    expect(capFindings.every(f => f.priority === 'HIGH' && f.category === 'REVIEW')).toBe(true)
    expect(capFindings.some(f => f.path === 'scripts/old.sh')).toBe(false)
    expect(capFindings.some(f => f.path === 'scripts/data.json')).toBe(false)
    expect(projected.capabilityNotice).toContain('does not audit content security')
  })
})
