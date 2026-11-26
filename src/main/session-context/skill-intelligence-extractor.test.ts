import { describe, expect, it } from 'vitest'
import {
  extractSkillCallMetadata,
  qualifySkillToolObservation,
  resolveCanonicalSkillTool,
  SKILL_EXTRACTOR_VERSION
} from './skill-intelligence-extractor'

describe('U1 — Skill contract qualification and identity', () => {
  it('accepts exact tool names and confirmed producer prefixes, rejecting substrings and untrusted prefixes', () => {
    expect(resolveCanonicalSkillTool('get_academy_skill')).toBe('get_academy_skill')
    expect(resolveCanonicalSkillTool('mcp__code_awareness__get_academy_skill')).toBe('get_academy_skill')
    expect(resolveCanonicalSkillTool('mcp__code_awareness_local__resources/read')).toBe('resources/read')
    expect(resolveCanonicalSkillTool('mcp__untrusted__get_academy_skill')).toBeNull()
    expect(resolveCanonicalSkillTool('get_academy_skill_custom')).toBeNull()
    expect(resolveCanonicalSkillTool('read_skill_file')).toBeNull()
  })

  it('distinguishes manifest/outline/search from resource/section/package deliveries and preserves selectors', () => {
    const manifestCall = extractSkillCallMetadata('get_academy_skill', JSON.stringify({
      skillId: 'sk-1',
      view: 'manifest',
      version: 2
    }))
    const manifestObs = qualifySkillToolObservation({
      canonicalTool: 'get_academy_skill',
      callArgs: manifestCall,
      hasResult: true,
      rawOutput: JSON.stringify({
        structuredContent: {
          skillId: 'sk-1',
          name: 'deploy-guard',
          scope: 'PROJECT',
          version: 2,
          packageHash: 'a'.repeat(64),
          files: [{ path: 'SKILL.md', bytes: 120 }]
        }
      }),
      sourceSurface: 'native_source_event',
      sourceContract: 'codex-native/v1',
      sourceNamespace: 'ns-1',
      sourceRevision: 1,
      callEventId: 'call-1',
      resultEventId: 'res-1',
      turnId: 'turn-1',
      sessionBindingState: 'BOUND_BY_WITNESS'
    })
    expect(manifestObs?.observationClass).toBe('DISCOVERED_MANIFEST_FETCHED')
    expect(manifestObs?.deliveryGranularity).toBe('MANIFEST')
    expect(manifestObs?.version).toBe(2)
    expect(manifestObs?.versionStatus).toBe('EXACT')
    expect(manifestObs?.extractorVersion).toBe(SKILL_EXTRACTOR_VERSION)

    const sectionCall = extractSkillCallMetadata('get_academy_skill', JSON.stringify({
      skillId: 'sk-1',
      view: 'section',
      version: 2,
      path: 'SKILL.md',
      selector: 'sec-1',
      textOffset: 0,
      textLimit: 200
    }))
    const sectionObs = qualifySkillToolObservation({
      canonicalTool: 'get_academy_skill',
      callArgs: sectionCall,
      hasResult: true,
      rawOutput: JSON.stringify({
        content: [{ type: 'text', text: '{"skillId":"sk-1"}' }],
        structuredContent: {
          skillId: 'sk-1',
          scope: 'GLOBAL',
          version: 2,
          packageHash: 'b'.repeat(64),
          path: 'SKILL.md',
          selector: 'sec-1',
          range: { startLine: 10, endLine: 25, startOffset: 100, endOffset: 300 },
          content: '# Section body',
          offset: 0,
          totalCharacters: 14,
          nextOffset: null
        }
      }),
      sourceSurface: 'native_source_event',
      sourceContract: 'codex-native/v1',
      sourceNamespace: 'ns-1',
      sourceRevision: 1,
      callEventId: 'call-2',
      resultEventId: 'res-2',
      turnId: 'turn-1',
      sessionBindingState: 'BOUND_BY_WITNESS'
    })
    expect(sectionObs?.observationClass).toBe('CONTENT_DELIVERED')
    expect(sectionObs?.deliveryGranularity).toBe('FRAGMENT')
    expect(sectionObs?.resourcePath).toBe('SKILL.md')
    expect(sectionObs?.resourceSelector).toBe('sec-1')
    expect(sectionObs?.resourceRange).toEqual({
      startLine: 10,
      endLine: 25,
      startOffset: 100,
      endOffset: 300,
      offset: 0,
      totalCharacters: 14,
      nextOffset: null,
      textLimit: 200
    })
    expect(sectionObs?.resourceDigest).toBeTruthy()
  })

  it('rejects request-only version, truncated/opaque outputs, arbitrary JSON, and version/hash conflicts', () => {
    const requestOnly = qualifySkillToolObservation({
      canonicalTool: 'get_academy_skill',
      callArgs: { skillId: 'sk-1', declaredVersion: 3 },
      hasResult: true,
      rawOutput: JSON.stringify({ id: 'sk-1', current: { skillMd: '# Hello' } }),
      sourceSurface: 'native_source_event',
      sourceContract: 'codex-native/v1',
      sessionBindingState: 'BOUND_BY_WITNESS'
    })
    expect(requestOnly?.version).toBeNull()
    expect(requestOnly?.versionStatus).toBe('VERSION_UNKNOWN')

    const conflict = qualifySkillToolObservation({
      canonicalTool: 'get_academy_skill',
      callArgs: { skillId: 'sk-1', declaredVersion: 1, declaredPackageHash: 'c'.repeat(64) },
      hasResult: true,
      rawOutput: JSON.stringify({ id: 'sk-1', currentVersion: 2, current: { packageHash: 'd'.repeat(64), skillMd: '# v2' } }),
      sourceSurface: 'native_source_event',
      sourceContract: 'codex-native/v1',
      sessionBindingState: 'BOUND_BY_WITNESS'
    })
    expect(conflict?.version).toBeNull()
    expect(conflict?.versionStatus).toBe('VERSION_UNKNOWN')
    expect(conflict?.gaps).toContain('VERSION_CONFLICT')
    expect(conflict?.gaps).toContain('PACKAGE_HASH_CONFLICT')

    const truncated = qualifySkillToolObservation({
      canonicalTool: 'get_academy_skill',
      callArgs: { skillId: 'sk-1' },
      hasResult: true,
      rawOutput: '{"id":"sk-1","current":{"skillMd":"# trunc...',
      sourceSurface: 'native_source_event',
      sourceContract: 'codex-native/v1',
      sessionBindingState: 'BOUND_BY_WITNESS'
    })
    expect(truncated?.observationClass).toBe('INDETERMINATE')
    expect(truncated?.operationStatus).toBe('UNKNOWN')

    const arbitraryJson = qualifySkillToolObservation({
      canonicalTool: 'get_academy_skill',
      callArgs: { skillId: 'sk-1' },
      hasResult: true,
      rawOutput: JSON.stringify({ ok: true, unrelated: 'data' }),
      sourceSurface: 'native_source_event',
      sourceContract: 'codex-native/v1',
      sessionBindingState: 'BOUND_BY_WITNESS'
    })
    expect(arbitraryJson?.observationClass).toBe('INDETERMINATE')

    const nonSkillResource = qualifySkillToolObservation({
      canonicalTool: 'resources/read',
      callArgs: { uri: 'file:///etc/passwd' },
      hasResult: true,
      rawOutput: 'root:x:0:0',
      sourceSurface: 'native_source_event',
      sourceContract: 'codex-native/v1',
      sessionBindingState: 'BOUND_BY_WITNESS'
    })
    expect(nonSkillResource).toBeNull()
  })
})
