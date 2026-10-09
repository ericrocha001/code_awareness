import type { AcademyPackage, AcademySkillScope } from '../../shared/types/academy-types'
import type { McpToolDefinition, McpToolResult } from '../mcp/channel-mcp-adapter'
import type { AcademyService } from './academy-service'

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
  tool('list_academy_skills', 'List canonical Academy skills and their current status, scope and version.', { type: 'object', properties: { status: { type: 'string', enum: ['ACTIVE', 'ARCHIVED'] } }, additionalProperties: false }),
  tool('get_academy_skill', 'Read one canonical Academy skill package by stable skill id.', { type: 'object', properties: { skillId: id }, required: ['skillId'], additionalProperties: false }),
  tool('get_academy_skill_history', 'List immutable versions of one Academy skill.', { type: 'object', properties: { skillId: id }, required: ['skillId'], additionalProperties: false }),
  tool('create_academy_skill', 'Create a canonical Academy skill and project it through the managed synchronization pipeline.', { type: 'object', properties: { package: packageSchema, scope: { type: 'string', enum: ['GLOBAL', 'PROJECT'] }, projectIds: { type: 'array', items: id, uniqueItems: true } }, required: ['package', 'scope'], additionalProperties: false }),
  tool('update_academy_skill', 'Create a new immutable Academy skill version. expectedVersion is required for optimistic concurrency.', { type: 'object', properties: { skillId: id, expectedVersion: version, package: packageSchema, scope: { type: 'string', enum: ['GLOBAL', 'PROJECT'] }, projectIds: { type: 'array', items: id, uniqueItems: true } }, required: ['skillId', 'expectedVersion', 'package'], additionalProperties: false }),
  tool('archive_academy_skill', 'Archive a canonical Academy skill without deleting its history.', { type: 'object', properties: { skillId: id, expectedVersion: version }, required: ['skillId', 'expectedVersion'], additionalProperties: false }),
  tool('restore_academy_skill', 'Restore an archived Academy skill, preserving its immutable history.', { type: 'object', properties: { skillId: id, expectedVersion: version }, required: ['skillId', 'expectedVersion'], additionalProperties: false }),
  tool('list_academy_conflicts', 'List distinct unresolved conflicts as metadata without packages. Review one conflict for content and diff.', { type: 'object', properties: {}, additionalProperties: false }),
  tool('review_academy_conflict', 'Inspect conflict evidence, current filesystem and diff of divergent or supplied reconciled content. Returns a precondition token for explicit resolution.', { type: 'object', properties: { conflictId: id, reconciledPackage: packageSchema }, required: ['conflictId'], additionalProperties: false }),
  tool('preview_academy_conflict_batch', 'Read-only classification of historical/equivalent conflicts eligible for canonical resolution.', { type: 'object', properties: {}, additionalProperties: false }),
  tool('resolve_academy_conflict_batch', 'Resolve only certified historical/equivalent conflicts after confirmation of the exact preview.', { type: 'object', properties: { token: id, confirmed: { type: 'boolean', const: true } }, required: ['token', 'confirmed'], additionalProperties: false }),
  tool('resolve_academy_conflict', 'Keep canonical content or explicitly adopt reviewed divergent content as a new canonical version. Requires confirmation and a current review token.', { type: 'object', properties: { conflictId: id, resolution: { type: 'string', enum: ['CANONICAL', 'DIVERGENT'] }, reconciledPackage: packageSchema, token: id, confirmed: { type: 'boolean', const: true } }, required: ['conflictId', 'resolution', 'token', 'confirmed'], additionalProperties: false }),
  tool('get_openai_plugin_publication', 'Inspect the Academy Skills OpenAI publication profile, drift, and current release state.', { type: 'object', properties: {}, additionalProperties: false }),
  tool('prepare_openai_plugin_release', 'Prepare one complete validated Academy Skills ZIP from canonical GLOBAL and ACTIVE Skills.', { type: 'object', properties: {}, additionalProperties: false }),
  tool('get_openai_plugin_release', 'Read one immutable OpenAI plugin release and its delta.', { type: 'object', properties: { releaseId: id }, required: ['releaseId'], additionalProperties: false }),
  tool('confirm_openai_plugin_upload', 'Record that one exact READY_TO_UPLOAD artifact was manually submitted to OpenAI. This does not verify runtime availability.', { type: 'object', properties: { releaseId: id, artifactHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['releaseId', 'artifactHash'], additionalProperties: false })
]

export async function executeAcademyTool(service: AcademyService, name: string, args: unknown): Promise<McpToolResult> {
  try {
    const values = objectArgs(args)
    let result: unknown
    switch (name) {
      case 'list_academy_skills': result = service.list(optionalEnum(values.status, ['ACTIVE', 'ARCHIVED']) as 'ACTIVE' | 'ARCHIVED' | undefined); break
      case 'get_academy_skill': result = service.get(string(values.skillId, 'skillId')); break
      case 'get_academy_skill_history': result = service.history(string(values.skillId, 'skillId')); break
      case 'create_academy_skill': result = await service.create({ package: pkg(values.package), scope: enumValue(values.scope, ['GLOBAL', 'PROJECT'], 'scope') as AcademySkillScope, projectIds: strings(values.projectIds), origin: 'MCP' }); break
      case 'update_academy_skill': result = await service.update({ skillId: string(values.skillId, 'skillId'), expectedVersion: integer(values.expectedVersion, 'expectedVersion'), package: pkg(values.package), scope: optionalEnum(values.scope, ['GLOBAL', 'PROJECT']) as AcademySkillScope | undefined, projectIds: values.projectIds === undefined ? undefined : strings(values.projectIds), origin: 'MCP' }); break
      case 'archive_academy_skill': result = await service.archive(string(values.skillId, 'skillId'), integer(values.expectedVersion, 'expectedVersion')); break
      case 'restore_academy_skill': result = await service.restore(string(values.skillId, 'skillId'), integer(values.expectedVersion, 'expectedVersion')); break
      case 'list_academy_conflicts': result = service.store.conflictSummaries(); break
      case 'review_academy_conflict': result = await service.reviewConflict(string(values.conflictId, 'conflictId'), values.reconciledPackage === undefined ? undefined : pkg(values.reconciledPackage)); break
      case 'preview_academy_conflict_batch': result = await service.previewConflictBatch(); break
      case 'resolve_academy_conflict_batch': result = await service.resolveConflictBatch(string(values.token, 'token'), values.confirmed === true); break
      case 'resolve_academy_conflict': result = await service.resolveConflict(string(values.conflictId, 'conflictId'), enumValue(values.resolution, ['CANONICAL', 'DIVERGENT'], 'resolution') as 'CANONICAL' | 'DIVERGENT', values.reconciledPackage === undefined ? undefined : pkg(values.reconciledPackage), { token: string(values.token, 'token'), confirmed: values.confirmed === true }); break
      case 'get_openai_plugin_publication': result = service.getOpenAiPublicationState(); break
      case 'prepare_openai_plugin_release': result = service.prepareOpenAiRelease(); break
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
function integer(value: unknown, name: string): number { if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`INVALID_${name.toUpperCase()}`); return Number(value) }
function enumValue(value: unknown, allowed: string[], name: string): string { if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`INVALID_${name.toUpperCase()}`); return value }
function optionalEnum(value: unknown, allowed: string[]): string | undefined { return value === undefined ? undefined : enumValue(value, allowed, 'ENUM') }
function strings(value: unknown): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) throw new Error('INVALID_PROJECT_IDS'); return [...new Set(value)] }
function pkg(value: unknown): AcademyPackage {
  const object = objectArgs(value)
  if (typeof object.skillMd !== 'string' || !object.artifacts || typeof object.artifacts !== 'object' || Array.isArray(object.artifacts) || Object.values(object.artifacts).some((item) => typeof item !== 'string')) throw new Error('INVALID_PACKAGE')
  return { skillMd: object.skillMd, artifacts: object.artifacts as Record<string, string> }
}
