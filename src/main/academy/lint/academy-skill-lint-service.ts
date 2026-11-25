import type {
  AcademySkillScope,
  AcademySkillStatus,
  AcademySkillVersion,
  AcademySkillVersionMetadata
} from '../../../shared/types/academy-types'
import { getCanonicalTokenizer, type TokenizerPort } from '../../core/tokenizer'
import { AcademyError } from '../academy-package'
import type { AcademyStore } from '../academy-store'
import { canonicalJson } from '../publication/openai-plugin-model'
import { analyzePackageFacts } from './skill-lint-engine'
import { SKILL_LINT_RULESET } from './skill-lint-ruleset'
import {
  LINE_CONVENTION,
  type EfficiencyItem,
  type LintCoverage,
  type PackageFacts
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
