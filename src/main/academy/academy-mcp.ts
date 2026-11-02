import type { AcademyHistoryOptions, AcademyPackage, AcademySkillScope } from '../../shared/types/academy-types'
import type { McpToolDefinition, McpToolResult } from '../mcp/channel-mcp-adapter'
import type { AcademyService } from './academy-service'
import { academyImpactFreshnessSchema, academyImpactSchema } from './academy-impact-schema'
import { projectAcademyGitStatus } from './git/academy-git-sync-service'

const securitySchemes = [{ type: 'oauth2' as const, scopes: [] }]
const tool = (name: string, description: string, inputSchema: Record<string, unknown>): McpToolDefinition => ({ name, description, inputSchema, securitySchemes })
const id = { type: 'string', minLength: 1 }
const version = { type: 'integer', minimum: 1 }
const packageSchema = {
  type: 'object',
  properties: { skillMd: { type: 'string', minLength: 1 }, artifacts: { type: 'object', additionalProperties: { type: 'string' } } },
  required: ['skillMd', 'artifacts'], additionalProperties: false
}

export const ACADEMY_MCP_TOOLS: McpToolDefinition[] = [
  tool('get_academy_git_status', 'Read remote observation, confirmed source SHA, workspace state and publication blockers. Offline and unobserved states never establish synchronization.', { type: 'object', properties: {}, additionalProperties: false }),
  tool('get_academy_git_draft', 'Read a private workspace package and its commit token for a subsequent Save. This does not read or change an official version.', { type: 'object', properties: { name: id }, required: ['name'], additionalProperties: false }),
  tool('update_academy_from_git', 'Fetch and ingest verified first-parent transitions of the configured publication branch. Preserves drafts and history. Never pushes or merges a GitHub PR.', { type: 'object', properties: {}, additionalProperties: false }),
  tool('publish_academy_git_drafts', 'Publish reviewed local Academy commits with normal fast-forward push. Supply the workspace and remote SHA from get_academy_git_status. Protected branches remain pending review; never creates or merges a PR.', { type: 'object', properties: { confirmed: { const: true }, localHead: id, remoteHead: id }, required: ['confirmed', 'localHead', 'remoteHead'], additionalProperties: false }),
  tool('verify_academy_change_impact', 'Read-only advisory freshness of an impact snapshot: CURRENT/STALE/UNKNOWN with observed reasons. Supply candidateHash to compare a changed candidate without resending its package. Without it, candidate mode checks only the previous content identity. No lock or atomic guarantee until update; expectedVersion protects only the source.', academyImpactFreshnessSchema),
  tool('analyze_academy_change_impact', 'Read-only package change evidence and possible DIRECT consumers from ACTIVE canonical Skills. Mentions are not dependencies or compatibility verdicts. Use changes/consumers/evidence offsets and consumerId for bounded detail. Candidate mode requires expectedVersion plus complete package; retrospective mode requires baseVersion and targetVersion.', academyImpactSchema),
  tool('list_academy_skills', 'List ACTIVE and DISABLED canonical skills by default, including stateRevision for activation CAS. Discovery does not mean installation. ARCHIVED is a legacy input alias for DISABLED.', { type: 'object', properties: { status: { type: 'string', enum: ['ACTIVE', 'DISABLED', 'ARCHIVED'] } }, additionalProperties: false }),
  tool('set_academy_skill_enabled', 'Set activation with independent stateRevision CAS. Returns persisted status and stateRevision; local reconciliation is scheduled separately. Does not publish an installed plugin.', { type: 'object', properties: { skillId: id, enabled: { type: 'boolean' }, expectedStateRevision: version }, required: ['skillId', 'enabled', 'expectedStateRevision'], additionalProperties: false }),
  tool('get_academy_skill', 'Read one canonical Academy skill package by stable skill id.', { type: 'object', properties: { skillId: id }, required: ['skillId'], additionalProperties: false }),
  tool('get_academy_skill_history', 'Read immutable Academy versions. Prefer metadataOnly:true to discover versions without packages, then version:n to retrieve exactly one literal package. These selectors are mutually exclusive, including metadataOnly:false. With only skillId, intentionally returns the complete legacy history in descending version order.', { type: 'object', properties: { skillId: id, metadataOnly: { type: 'boolean' }, version: { ...version, maximum: Number.MAX_SAFE_INTEGER } }, required: ['skillId'], not: { required: ['metadataOnly', 'version'] }, additionalProperties: false }),
  tool('create_academy_skill', 'Save GLOBAL content as a private Git draft (DRAFT_SAVED), without official numbering or distribution until confirmed on main. PROJECT retains SQLite persistence.', { type: 'object', properties: { expectedDraftCommitSha: id, package: packageSchema, scope: { type: 'string', enum: ['GLOBAL', 'PROJECT'] }, projectIds: { type: 'array', items: id, uniqueItems: true } }, required: ['package', 'scope'], additionalProperties: false }),
  tool('update_academy_skill', 'Save GLOBAL content as a private Git commit (DRAFT_SAVED). expectedVersion guards the official base; expectedDraftCommitSha guards the workspace. Official numbering advances only after confirmed main ingestion. PROJECT retains its current contract.', { type: 'object', properties: { expectedDraftCommitSha: id, skillId: id, expectedVersion: version, package: packageSchema, scope: { type: 'string', enum: ['GLOBAL', 'PROJECT'] }, projectIds: { type: 'array', items: id, uniqueItems: true } }, required: ['skillId', 'expectedVersion', 'package'], additionalProperties: false }),
  tool('get_academy_skill_delivery_status', 'Inspect the compact, version-aware delivery and convergence status of one Academy skill without downloading packages or scanning the filesystem.', { type: 'object', properties: { skillId: id, expectedVersion: version }, required: ['skillId'], additionalProperties: false }),
  tool('archive_academy_skill', 'Legacy alias: disable a skill preserving history. expectedVersion protects content only; prefer set_academy_skill_enabled with stateRevision CAS.', { type: 'object', properties: { skillId: id, expectedVersion: version }, required: ['skillId', 'expectedVersion'], additionalProperties: false }),
  tool('restore_academy_skill', 'Legacy alias: enable a skill preserving history. expectedVersion protects content only; prefer set_academy_skill_enabled with stateRevision CAS.', { type: 'object', properties: { skillId: id, expectedVersion: version }, required: ['skillId', 'expectedVersion'], additionalProperties: false }),
  tool('list_academy_conflicts', 'List distinct unresolved conflicts as metadata without packages. Review one conflict for content and diff.', { type: 'object', properties: {}, additionalProperties: false }),
  tool('review_academy_conflict', 'Inspect conflict evidence, current filesystem and diff of divergent or supplied reconciled content. Returns a precondition token for explicit resolution.', { type: 'object', properties: { conflictId: id, reconciledPackage: packageSchema }, required: ['conflictId'], additionalProperties: false }),
  tool('preview_academy_conflict_batch', 'Read-only classification of historical/equivalent conflicts eligible for canonical resolution.', { type: 'object', properties: {}, additionalProperties: false }),
  tool('resolve_academy_conflict_batch', 'Resolve only certified historical/equivalent conflicts after confirmation of the exact preview.', { type: 'object', properties: { token: id, confirmed: { type: 'boolean', const: true } }, required: ['token', 'confirmed'], additionalProperties: false }),
  tool('resolve_academy_conflict', 'Keep canonical content or explicitly adopt reviewed divergent content as a new canonical version. Requires confirmation and a current review token.', { type: 'object', properties: { conflictId: id, resolution: { type: 'string', enum: ['CANONICAL', 'DIVERGENT'] }, reconciledPackage: packageSchema, token: id, confirmed: { type: 'boolean', const: true } }, required: ['conflictId', 'resolution', 'token', 'confirmed'], additionalProperties: false }),
  tool('get_openai_plugin_publication', 'Inspect the Academy Skills OpenAI publication profile, drift, and current release state.', { type: 'object', properties: {}, additionalProperties: false }),
  tool('prepare_openai_plugin_release', 'Prepare a deterministic ZIP from the verified publication branch, including locally disabled Skills. LATEST requires remote observation; REBUILD requires a previously verified SHA and reports cached confirmation. Never uploads.', { type: 'object', properties: { mode: { type: 'string', enum: ['LATEST', 'REBUILD'] }, sourceCommitSha: id }, additionalProperties: false }),
  tool('get_openai_plugin_release', 'Read one immutable OpenAI plugin release and its delta.', { type: 'object', properties: { releaseId: id }, required: ['releaseId'], additionalProperties: false }),
  tool('confirm_openai_plugin_upload', 'Record that one exact READY_TO_UPLOAD artifact was manually submitted to OpenAI. This does not verify runtime availability.', { type: 'object', properties: { releaseId: id, artifactHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['releaseId', 'artifactHash'], additionalProperties: false })
]

export async function executeAcademyTool(service: AcademyService, name: string, args: unknown): Promise<McpToolResult> {
  try {
    const values = objectArgs(args)
    let result: unknown
    switch (name) {
      case 'get_academy_git_status': if (!service.gitSync) throw new Error('GIT_SYNC_NOT_CONFIGURED'); result = projectAcademyGitStatus(service.gitSync.getStatus()); break
      case 'get_academy_git_draft': result = await service.gitSync?.getDraft(string(values.name, 'name')); break
      case 'update_academy_from_git': if (!service.gitSync) throw new Error('GIT_SYNC_NOT_CONFIGURED'); result = projectAcademyGitStatus(await service.gitSync.syncNow()); break
      case 'publish_academy_git_drafts': if (values.confirmed !== true) throw new Error('PUBLICATION_AUTHORIZATION_REQUIRED'); if (!service.gitSync) throw new Error('GIT_SYNC_NOT_CONFIGURED'); result = projectAcademyGitStatus(await service.gitSync.publish({ localHead: string(values.localHead, 'localHead'), remoteHead: string(values.remoteHead, 'remoteHead') })); break
      case 'verify_academy_change_impact': result = service.verifyChangeImpact(args); break
      case 'analyze_academy_change_impact': result = service.analyzeChangeImpact(args); break
      case 'list_academy_skills': result = service.list(optionalEnum(values.status, ['ACTIVE', 'DISABLED', 'ARCHIVED']) as 'ACTIVE' | 'DISABLED' | 'ARCHIVED' | undefined); break
      case 'set_academy_skill_enabled': {
        if (Object.keys(values).some(key => !['skillId', 'enabled', 'expectedStateRevision'].includes(key)) || typeof values.enabled !== 'boolean') throw new Error('INVALID_ARGUMENT')
        result = await service.setEnabled(string(values.skillId, 'skillId'), values.enabled, integer(values.expectedStateRevision, 'expectedStateRevision'))
        break
      }
      case 'get_academy_skill': result = service.get(string(values.skillId, 'skillId')); break
      case 'get_academy_skill_history': {
        const { skillId, ...options } = values
        result = service.history(string(skillId, 'skillId'), options as AcademyHistoryOptions)
        break
      }
      case 'get_academy_skill_delivery_status': result = service.getDeliveryStatus(string(values.skillId, 'skillId'), values.expectedVersion === undefined ? undefined : integer(values.expectedVersion, 'expectedVersion')); break
      case 'create_academy_skill': result = await service.saveNewSkill({ package: pkg(values.package), scope: enumValue(values.scope, ['GLOBAL', 'PROJECT'], 'scope') as AcademySkillScope, projectIds: strings(values.projectIds), expectedDraftCommitSha: values.expectedDraftCommitSha as string | undefined, origin: 'MCP' }); break
      case 'update_academy_skill': result = await service.saveSkill({ skillId: string(values.skillId, 'skillId'), expectedVersion: integer(values.expectedVersion, 'expectedVersion'), package: pkg(values.package), scope: optionalEnum(values.scope, ['GLOBAL', 'PROJECT']) as AcademySkillScope | undefined, projectIds: values.projectIds === undefined ? undefined : strings(values.projectIds), expectedDraftCommitSha: values.expectedDraftCommitSha as string | undefined, origin: 'MCP' }); break
      case 'archive_academy_skill': result = await service.archive(string(values.skillId, 'skillId'), integer(values.expectedVersion, 'expectedVersion')); break
      case 'restore_academy_skill': result = await service.restore(string(values.skillId, 'skillId'), integer(values.expectedVersion, 'expectedVersion')); break
      case 'list_academy_conflicts': result = service.store.conflictSummaries(); break
      case 'review_academy_conflict': result = await service.reviewConflict(string(values.conflictId, 'conflictId'), values.reconciledPackage === undefined ? undefined : pkg(values.reconciledPackage)); break
      case 'preview_academy_conflict_batch': result = await service.previewConflictBatch(); break
      case 'resolve_academy_conflict_batch': result = await service.resolveConflictBatch(string(values.token, 'token'), values.confirmed === true); break
      case 'resolve_academy_conflict': result = await service.resolveConflict(string(values.conflictId, 'conflictId'), enumValue(values.resolution, ['CANONICAL', 'DIVERGENT'], 'resolution') as 'CANONICAL' | 'DIVERGENT', values.reconciledPackage === undefined ? undefined : pkg(values.reconciledPackage), { token: string(values.token, 'token'), confirmed: values.confirmed === true }); break
      case 'get_openai_plugin_publication': result = service.getOpenAiPublicationState(); break
      case 'prepare_openai_plugin_release': {
        const mode = values.mode === undefined ? 'LATEST' : enumValue(values.mode, ['LATEST', 'REBUILD'], 'mode')
        const request = mode === 'LATEST' ? { mode: 'LATEST' as const } : { mode: 'REBUILD' as const, sourceCommitSha: string(values.sourceCommitSha, 'sourceCommitSha') }
        result = await service.prepareOpenAiRelease(request); break
      }
      case 'get_openai_plugin_release': result = service.getOpenAiRelease(string(values.releaseId, 'releaseId')); break
      case 'confirm_openai_plugin_upload': result = service.confirmOpenAiUpload(string(values.releaseId, 'releaseId'), sha256(values.artifactHash)); break
      default: throw new Error('METHOD_NOT_FOUND')
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  } catch (error) {
    const value = error as { code?: string; message?: string; details?: unknown }
    return { content: [{ type: 'text', text: JSON.stringify({ error: value.code ?? value.message ?? String(error), details: value.details }) }], isError: true }
  }
}

function objectArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ARGUMENTS')
  return value as Record<string, unknown>
}
function string(value: unknown, name: string): string { if (typeof value !== 'string' || !value) throw new Error(`INVALID_${name.toUpperCase()}`); return value }
function sha256(value: unknown): string { const result = string(value, 'artifactHash'); if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('INVALID_ARTIFACT_HASH'); return result }
function integer(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`INVALID_${name.toUpperCase()}`); return Number(value) }
function enumValue(value: unknown, allowed: string[], name: string): string { if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`INVALID_${name.toUpperCase()}`); return value }
function optionalEnum(value: unknown, allowed: string[]): string | undefined { return value === undefined ? undefined : enumValue(value, allowed, 'ENUM') }
function strings(value: unknown): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) throw new Error('INVALID_PROJECT_IDS'); return [...new Set(value)] }
function pkg(value: unknown): AcademyPackage {
  const object = objectArgs(value)
  if (typeof object.skillMd !== 'string' || !object.artifacts || typeof object.artifacts !== 'object' || Array.isArray(object.artifacts) || Object.values(object.artifacts).some((item) => typeof item !== 'string')) throw new Error('INVALID_PACKAGE')
  return { skillMd: object.skillMd, artifacts: object.artifacts as Record<string, string> }
}
