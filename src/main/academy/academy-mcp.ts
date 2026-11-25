import type { AcademyHistoryOptions, AcademyPackage, AcademySkillScope, AcademySkillStatus } from '../../shared/types/academy-types'
import type { AgentAuthority } from '../continuum/agent-authority'
import type { McpToolDefinition, McpToolResult } from '../mcp/channel-mcp-adapter'
import type { AcademyService } from './academy-service'
import { AcademyError } from './academy-package'
import { academyImpactFreshnessSchema, academyImpactSchema } from './academy-impact-schema'
import { projectAcademyGitStatus } from './git/academy-git-sync-service'
import type { FindingCategory, LintHealth } from './lint/skill-lint-types'

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
  tool('reintroduce_academy_global_skill', 'Explicitly reintroduce a deleted GLOBAL skill with the same stable identity and a new content version. Activation alone never restores a tombstone.', { type: 'object', properties: { skillId: id, expectedVersion: version, confirmed: { const: true } }, required: ['skillId', 'expectedVersion', 'confirmed'], additionalProperties: false }),
  tool('review_academy_manifest_conflict', 'Read durable base/local/remote manifest and asset conflict evidence and a CAS token.', { type: 'object', properties: {}, additionalProperties: false }),
  tool('resolve_academy_manifest_conflict', 'Explicitly choose reviewed local or remote authored manifest/assets under CAS. Version fields remain governed by the local release ledger.', { type: 'object', properties: { token: id, choice: { enum: ['LOCAL', 'REMOTE'] }, confirmed: { const: true } }, required: ['token', 'choice', 'confirmed'], additionalProperties: false }),
  tool('cutover_academy_local_authority', 'Review and migrate a clean, confirmed Git Academy to local SQLite authority. Refuses outstanding drafts, candidate branches and unverified remote history. Preserves private local skills and releases.', { type: 'object', properties: { confirmed: { const: true } }, required: ['confirmed'], additionalProperties: false }),
  tool('approve_academy_publications', 'Approve several reviewed GLOBAL skills for public Git publication and plugin inclusion in one explicit authorization. Every item names skillId and the reviewed expectedVersion; all-or-nothing under version CAS. Unlisted skills, PROJECT and PRIVATE skills are never touched.', { type: 'object', properties: { items: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { skillId: id, expectedVersion: version }, required: ['skillId', 'expectedVersion'], additionalProperties: false } }, confirmed: { const: true } }, required: ['items', 'confirmed'], additionalProperties: false }),
  tool('approve_academy_publication', 'Explicitly approve one GLOBAL skill for its first public Git publication and plugin inclusion. Activation alone never grants eligibility. Requires reviewed content version and operator authorization.', { type: 'object', properties: { skillId: id, expectedVersion: version, confirmed: { const: true } }, required: ['skillId', 'expectedVersion', 'confirmed'], additionalProperties: false }),
  tool('delete_academy_global_skill', 'Explicitly delete a GLOBAL skill using a durable identity tombstone, preserving all versions. This is distinct from disable.', { type: 'object', properties: { skillId: id, expectedVersion: version, confirmed: { const: true } }, required: ['skillId', 'expectedVersion', 'confirmed'], additionalProperties: false }),
  tool('get_academy_git_status', 'Read remote observation, confirmed source SHA, workspace state and publication blockers. Offline and unobserved states never establish synchronization.', { type: 'object', properties: {}, additionalProperties: false }),
  tool('get_academy_git_draft', 'Read a private workspace package and its commit token for a subsequent Save. This does not read or change an official version.', { type: 'object', properties: { name: id }, required: ['name'], additionalProperties: false }),
  tool('update_academy_from_git', 'Fetch and ingest verified first-parent transitions of the configured publication branch. Preserves drafts and history. Never pushes or merges a GitHub PR.', { type: 'object', properties: {}, additionalProperties: false }),
  tool('publish_academy_git_drafts', 'Publish reviewed local Academy commits with normal fast-forward push. Supply the workspace and remote SHA from get_academy_git_status. Protected branches remain pending review; never creates or merges a PR.', { type: 'object', properties: { confirmed: { const: true }, localHead: id, remoteHead: id }, required: ['confirmed', 'localHead', 'remoteHead'], additionalProperties: false }),
  tool('verify_academy_change_impact', 'Read-only advisory freshness of an impact snapshot: CURRENT/STALE/UNKNOWN with observed reasons. Supply candidateHash to compare a changed candidate without resending its package. Without it, candidate mode checks only the previous content identity. No lock or atomic guarantee until update; expectedVersion protects only the source.', academyImpactFreshnessSchema),
  tool('analyze_academy_change_impact', 'Read-only package change evidence and possible DIRECT consumers from ACTIVE canonical Skills. Mentions are not dependencies or compatibility verdicts. Use changes/consumers/evidence offsets and consumerId for bounded detail. Candidate mode requires expectedVersion plus complete package; retrospective mode requires baseVersion and targetVersion.', academyImpactSchema),
  tool('list_academy_skills', 'List ACTIVE and DISABLED canonical skills by default, including stateRevision for activation CAS. Discovery does not mean installation. ARCHIVED is a legacy input alias for DISABLED. Opt in with includeEfficiency:true, limit, or cursor for paged efficiency measures and predecessor deltas without changing the legacy array default.', {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ACTIVE', 'DISABLED', 'ARCHIVED'] },
      includeEfficiency: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      cursor: { type: 'string', minLength: 1 }
    },
    additionalProperties: false
  }),
  tool('set_academy_skill_enabled', 'Set activation with independent stateRevision CAS. Returns persisted status and stateRevision; local reconciliation is scheduled separately. Does not publish an installed plugin.', { type: 'object', properties: { skillId: id, enabled: { type: 'boolean' }, expectedStateRevision: version }, required: ['skillId', 'enabled', 'expectedStateRevision'], additionalProperties: false }),
  tool('get_academy_skill', 'Read one canonical Academy skill package by stable skill id, or use view (manifest, resource, outline, section, search) for selective snapshot-bound acquisition without transmitting full bodies.', {
    type: 'object',
    properties: {
      skillId: id,
      view: { type: 'string', enum: ['package', 'manifest', 'resource', 'outline', 'section', 'search'] },
      version: { ...version, maximum: Number.MAX_SAFE_INTEGER },
      path: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      expectedPackageHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      includeDescendants: { type: 'boolean' },
      query: { type: 'string', minLength: 1, maxLength: 200 },
      caseSensitive: { type: 'boolean' },
      textOffset: { type: 'integer', minimum: 0 },
      textLimit: { type: 'integer', minimum: 1, maximum: 12288 },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 100 }
    },
    required: ['skillId'],
    additionalProperties: false
  }),
  tool('list_academy_changes', 'Discover immutable Academy skill version events globally in descending persistence order (createdAt DESC, skillId ASC, version DESC) without reading packages. Intersecting filters narrow results: skillId, query (case-insensitive literal substring on current skillName, not body), after/before (inclusive ISO 8601 UTC-normalized persistence timestamps), origin, limit (default 20, max 50), and cursor. skillName reflects the current canonical skill name; previousVersion is the actual persisted predecessor of that skill regardless of date filters. contentState/previousContentState distinguish tombstone deletion and reintroduction. Cursor binds filters, order and limit; visibility matches Academy catalog permissions and does not guarantee an immutable snapshot across pages. Inspect deltas with get_academy_change_diff or read a full package with get_academy_skill_history.', {
    type: 'object',
    properties: {
      skillId: id,
      query: { type: 'string', minLength: 1 },
      after: { type: 'string', format: 'date-time', minLength: 1 },
      before: { type: 'string', format: 'date-time', minLength: 1 },
      origin: { type: 'string', enum: ['IMPORT', 'FILESYSTEM', 'UI', 'MCP', 'LOCAL_CLI', 'GIT'] },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      cursor: { type: 'string', minLength: 1 }
    },
    additionalProperties: false
  }),
  tool('get_academy_change_diff', 'Read a selective literal file/frontmatter diff between two immutable versions of one Academy skill without scanning the catalog or consumers. Distinct from get_academy_skill_history (full package or version list) and analyze_academy_change_impact (consumer reach analysis). baseVersion defaults to the persisted predecessor (or null when targetVersion is the first version, reporting creation additions). Reverse baseVersion > targetVersion is valid for rollback inspection; tombstone/reintroduction transitions expose baseContentState/targetContentState without inventing text diffs when hashes match. Optional path selects one file (SKILL.md or canonical artifact). Change pagination uses offset/limit (default 10, max 50; use offset:N, limit:1 to isolate one block); literal text pagination within each block uses textOffset/textLimit (default 400, max 4000) preserving exact UTF-16/CRLF boundaries via total, nextOffset, and content.totalCharacters/nextOffset.', {
    type: 'object',
    properties: {
      skillId: id,
      targetVersion: { ...version, maximum: Number.MAX_SAFE_INTEGER },
      baseVersion: { ...version, maximum: Number.MAX_SAFE_INTEGER },
      path: { type: 'string', minLength: 1 },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      textOffset: { type: 'integer', minimum: 0 },
      textLimit: { type: 'integer', minimum: 1, maximum: 4000 }
    },
    required: ['skillId', 'targetVersion'],
    additionalProperties: false
  }),
  tool('get_academy_skill_history', 'Read immutable Academy versions. Prefer metadataOnly:true to discover versions without packages, then version:n to retrieve exactly one literal package. These selectors are mutually exclusive, including metadataOnly:false. With only skillId, intentionally returns the complete legacy history in descending version order. Optional includeEfficiency, limit, and cursor require metadataOnly:true.', {
    type: 'object',
    properties: {
      skillId: id,
      metadataOnly: { type: 'boolean' },
      version: { ...version, maximum: Number.MAX_SAFE_INTEGER },
      includeEfficiency: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      cursor: { type: 'string', minLength: 1 }
    },
    required: ['skillId'],
    not: { required: ['metadataOnly', 'version'] },
    additionalProperties: false
  }),
  tool('create_academy_skill', 'After CRS cutover, save GLOBAL locally with version CAS and catalogRevision. Content and eligibility persist atomically: the new skill is APPROVED for the public plugin only when the operator previously enabled auto-include for new GLOBAL skills in Academy (not changeable through MCP); otherwise it stays PRIVATE and the result states the reason and approval action. keepPrivate:true opts this skill out. PROJECT is never published. Before cutover, preserves legacy Git drafts.', { type: 'object', properties: { expectedDraftCommitSha: id, package: packageSchema, scope: { type: 'string', enum: ['GLOBAL', 'PROJECT'] }, projectIds: { type: 'array', items: id, uniqueItems: true }, keepPrivate: { type: 'boolean' } }, required: ['package', 'scope'], additionalProperties: false }),
  tool('update_academy_skill', 'Save canonical content with expectedVersion CAS. After CRS cutover, GLOBAL persists offline in SQLite; synchronization and distribution are separate. Legacy drafts remain until reviewed cutover.', { type: 'object', properties: { expectedDraftCommitSha: id, skillId: id, expectedVersion: version, package: packageSchema, scope: { type: 'string', enum: ['GLOBAL', 'PROJECT'] }, projectIds: { type: 'array', items: id, uniqueItems: true } }, required: ['skillId', 'expectedVersion', 'package'], additionalProperties: false }),
  tool('get_academy_skill_delivery_status', 'Inspect the compact, version-aware delivery and convergence status of one Academy skill without downloading packages or scanning the filesystem.', { type: 'object', properties: { skillId: id, expectedVersion: version }, required: ['skillId'], additionalProperties: false }),
  tool('archive_academy_skill', 'Legacy alias: disable a skill preserving history. expectedVersion protects content only; prefer set_academy_skill_enabled with stateRevision CAS.', { type: 'object', properties: { skillId: id, expectedVersion: version }, required: ['skillId', 'expectedVersion'], additionalProperties: false }),
  tool('restore_academy_skill', 'Legacy alias: enable a skill preserving history. expectedVersion protects content only; prefer set_academy_skill_enabled with stateRevision CAS.', { type: 'object', properties: { skillId: id, expectedVersion: version }, required: ['skillId', 'expectedVersion'], additionalProperties: false }),
  tool('list_academy_conflicts', 'List distinct unresolved conflicts as metadata without packages. Review one conflict for content and diff.', { type: 'object', properties: {}, additionalProperties: false }),
  tool('review_academy_conflict', 'Inspect conflict evidence, current filesystem and diff of divergent or supplied reconciled content. Returns a precondition token for explicit resolution.', { type: 'object', properties: { conflictId: id, reconciledPackage: packageSchema }, required: ['conflictId'], additionalProperties: false }),
  tool('preview_academy_conflict_batch', 'Read-only classification of historical/equivalent conflicts eligible for canonical resolution.', { type: 'object', properties: {}, additionalProperties: false }),
  tool('resolve_academy_conflict_batch', 'Resolve only certified historical/equivalent conflicts after confirmation of the exact preview.', { type: 'object', properties: { token: id, confirmed: { type: 'boolean', const: true } }, required: ['token', 'confirmed'], additionalProperties: false }),
  tool('resolve_academy_conflict', 'Keep canonical content or explicitly adopt reviewed divergent content as a new canonical version. Requires confirmation and a current review token.', { type: 'object', properties: { conflictId: id, resolution: { type: 'string', enum: ['CANONICAL', 'DIVERGENT'] }, reconciledPackage: packageSchema, token: id, confirmed: { type: 'boolean', const: true } }, required: ['conflictId', 'resolution', 'token', 'confirmed'], additionalProperties: false }),
  tool('get_openai_plugin_publication', 'Inspect the Academy Skills OpenAI publication profile, drift, and current release state.', { type: 'object', properties: {}, additionalProperties: false }),
  tool('prepare_openai_plugin_release', 'After CRS cutover, prepare an immutable eligible local snapshot offline in a worker; Git freshness and manual upload remain separate. Before cutover, LATEST uses verified Git input. REBUILD reproduces a historical verified Git source when its material is available. Never uploads.', { type: 'object', properties: { mode: { type: 'string', enum: ['LATEST', 'REBUILD'] }, sourceCommitSha: id, force: { type: 'boolean' } }, additionalProperties: false }),
  tool('get_openai_plugin_release', 'Read one immutable OpenAI plugin release and its delta.', { type: 'object', properties: { releaseId: id }, required: ['releaseId'], additionalProperties: false }),
  tool('confirm_openai_plugin_upload', 'Record that one exact READY_TO_UPLOAD artifact was manually submitted to OpenAI. This does not verify runtime availability.', { type: 'object', properties: { releaseId: id, artifactHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['releaseId', 'artifactHash'], additionalProperties: false }),
  {
    ...tool(
      'get_academy_skill_lint',
      'Read-only deterministic Skill Linter diagnostics, derived lintHealth, coverage, persistence/stagnation and capability review priority. Provide skillId (optional version) for a focal report, or omit skillId for a paged catalog summary (default ACTIVE; only skills in the page are analyzed).',
      {
        type: 'object',
        properties: {
          skillId: id,
          version: { ...version, maximum: Number.MAX_SAFE_INTEGER },
          status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] },
          scope: { type: 'string', enum: ['GLOBAL', 'PROJECT'] },
          ruleId: { type: 'string', minLength: 1 },
          category: { type: 'string', enum: ['INVALID', 'REVIEW', 'OBSERVATION'] },
          state: { type: 'string', enum: ['OPEN', 'REVIEWED'] },
          lintHealth: { type: 'string', enum: ['INVALID', 'REVIEW_OPEN', 'REVIEWED', 'NO_FINDINGS', 'UNKNOWN'] },
          includeInventory: { type: 'boolean' },
          deepen: { type: 'array', items: { type: 'string', enum: ['DESCRIPTION_TERMS', 'CATALOG_PRESSURE'] }, uniqueItems: true },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          cursor: { type: 'string', minLength: 1 }
        },
        additionalProperties: false
      }
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  tool(
    'review_academy_skill_lint',
    'Authenticated optional editorial review decision (RECORD or REVOKE) for a REVIEW lint finding bound to skillId, expectedVersion, findingId, and evidenceFingerprint. Does not change skill version or distribution.',
    {
      type: 'object',
      properties: {
        skillId: id,
        expectedVersion: version,
        findingId: id,
        evidenceFingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        action: { type: 'string', enum: ['RECORD', 'REVOKE'] },
        rationale: { type: 'string', minLength: 1, maxLength: 500 }
      },
      required: ['skillId', 'expectedVersion', 'findingId', 'evidenceFingerprint', 'action'],
      additionalProperties: false
    }
  ),
  tool(
    'edit_academy_skill',
    'Focal atomic package edit (replace by oldText or snapshot selector, add, remove, move) bound to expectedVersion and expectedPackageHash. Supports read-only PREVIEW (focal diff, measures delta, lint delta) and APPLY (canonical saveSkill receipt). Requires local SQLite authority for GLOBAL skills.',
    {
      type: 'object',
      properties: {
        skillId: id,
        expectedVersion: version,
        expectedPackageHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        mode: { type: 'string', enum: ['PREVIEW', 'APPLY'] },
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['replace', 'add', 'remove', 'move'] },
              path: { type: 'string', minLength: 1 },
              toPath: { type: 'string', minLength: 1 },
              oldText: { type: 'string', minLength: 1 },
              newText: { type: 'string' },
              selector: { type: 'string', minLength: 1 },
              content: { type: 'string' }
            },
            required: ['op'],
            additionalProperties: false
          }
        }
      },
      required: ['skillId', 'expectedVersion', 'expectedPackageHash', 'mode', 'edits'],
      additionalProperties: false
    }
  )
]

export async function executeAcademyTool(
  service: AcademyService,
  name: string,
  args: unknown,
  context?: { authority?: AgentAuthority }
): Promise<McpToolResult> {
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
      case 'list_academy_skills': {
        if (Object.keys(values).some(key => !['status', 'includeEfficiency', 'limit', 'cursor'].includes(key))) {
          throw new AcademyError('INVALID_ARGUMENT')
        }
        const statusRaw = optionalEnum(values.status, ['ACTIVE', 'DISABLED', 'ARCHIVED']) as 'ACTIVE' | 'DISABLED' | 'ARCHIVED' | undefined
        if (values.includeEfficiency === undefined && values.limit === undefined && values.cursor === undefined) {
          result = service.list(statusRaw)
          break
        }
        if (values.includeEfficiency !== undefined && typeof values.includeEfficiency !== 'boolean') {
          throw new AcademyError('INVALID_ARGUMENT')
        }
        if (values.cursor !== undefined && (typeof values.cursor !== 'string' || !values.cursor)) {
          throw new AcademyError('INVALID_ARGUMENT')
        }
        result = service.lint.efficiencyForList({
          status: statusRaw === 'ARCHIVED' ? 'DISABLED' : statusRaw,
          includeEfficiency: values.includeEfficiency,
          limit: values.limit as number | undefined,
          cursor: values.cursor
        })
        break
      }
      case 'set_academy_skill_enabled': {
        if (Object.keys(values).some(key => !['skillId', 'enabled', 'expectedStateRevision'].includes(key)) || typeof values.enabled !== 'boolean') throw new Error('INVALID_ARGUMENT')
        result = await service.setEnabled(string(values.skillId, 'skillId'), values.enabled, integer(values.expectedStateRevision, 'expectedStateRevision'))
        break
      }
      case 'get_academy_skill': {
        const allowed = [
          'skillId', 'view', 'version', 'path', 'selector', 'expectedPackageHash',
          'includeDescendants', 'query', 'caseSensitive', 'textOffset', 'textLimit', 'offset', 'limit'
        ]
        if (Object.keys(values).some(key => !allowed.includes(key))) throw new AcademyError('INVALID_ARGUMENT')
        const view = optionalEnum(values.view, ['package', 'manifest', 'resource', 'outline', 'section', 'search']) as
          | 'package'
          | 'manifest'
          | 'resource'
          | 'outline'
          | 'section'
          | 'search'
          | undefined
        const skillId = string(values.skillId, 'skillId')
        if (!view || view === 'package') {
          if (Object.keys(values).some(key => key !== 'skillId' && key !== 'view')) {
            throw new AcademyError('INVALID_ARGUMENT')
          }
          result = service.get(skillId)
          break
        }
        const expectedPackageHash = values.expectedPackageHash === undefined ? undefined : sha256(values.expectedPackageHash)
        const targetVersion = values.version === undefined ? undefined : integer(values.version, 'version')
        const nonNegInt = (v: unknown) => {
          if (v === undefined) return undefined
          if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new AcademyError('INVALID_ARGUMENT')
          return v
        }
        if (values.includeDescendants !== undefined && typeof values.includeDescendants !== 'boolean') {
          throw new AcademyError('INVALID_ARGUMENT')
        }
        if (values.caseSensitive !== undefined && typeof values.caseSensitive !== 'boolean') {
          throw new AcademyError('INVALID_ARGUMENT')
        }
        if (view === 'manifest') {
          if (
            values.path !== undefined || values.selector !== undefined || values.query !== undefined ||
            values.includeDescendants !== undefined || values.caseSensitive !== undefined ||
            values.textOffset !== undefined || values.textLimit !== undefined ||
            values.offset !== undefined || values.limit !== undefined
          ) {
            throw new AcademyError('INVALID_ARGUMENT')
          }
          result = service.lint.getSkillView({ skillId, view, version: targetVersion, expectedPackageHash })
        } else if (view === 'resource') {
          if (
            targetVersion === undefined || values.path === undefined ||
            values.selector !== undefined || values.query !== undefined ||
            values.includeDescendants !== undefined || values.caseSensitive !== undefined ||
            values.offset !== undefined || values.limit !== undefined
          ) {
            throw new AcademyError('INVALID_ARGUMENT')
          }
          result = service.lint.getSkillView({
            skillId,
            view,
            version: targetVersion,
            path: string(values.path, 'path'),
            expectedPackageHash,
            textOffset: nonNegInt(values.textOffset),
            textLimit: values.textLimit === undefined ? undefined : integer(values.textLimit, 'textLimit')
          })
        } else if (view === 'outline') {
          if (
            targetVersion === undefined || values.path === undefined ||
            values.selector !== undefined || values.query !== undefined ||
            values.includeDescendants !== undefined || values.caseSensitive !== undefined ||
            values.textOffset !== undefined || values.textLimit !== undefined
          ) {
            throw new AcademyError('INVALID_ARGUMENT')
          }
          result = service.lint.getSkillView({
            skillId,
            view,
            version: targetVersion,
            path: string(values.path, 'path'),
            expectedPackageHash,
            offset: nonNegInt(values.offset),
            limit: values.limit === undefined ? undefined : integer(values.limit, 'limit')
          })
        } else if (view === 'section') {
          if (
            targetVersion === undefined || values.path === undefined || values.selector === undefined ||
            values.query !== undefined || values.caseSensitive !== undefined ||
            values.offset !== undefined || values.limit !== undefined
          ) {
            throw new AcademyError('INVALID_ARGUMENT')
          }
          result = service.lint.getSkillView({
            skillId,
            view,
            version: targetVersion,
            path: string(values.path, 'path'),
            selector: string(values.selector, 'selector'),
            expectedPackageHash,
            includeDescendants: values.includeDescendants as boolean | undefined,
            textOffset: nonNegInt(values.textOffset),
            textLimit: values.textLimit === undefined ? undefined : integer(values.textLimit, 'textLimit')
          })
        } else {
          if (
            targetVersion === undefined || values.query === undefined ||
            values.selector !== undefined || values.includeDescendants !== undefined ||
            values.textOffset !== undefined || values.textLimit !== undefined
          ) {
            throw new AcademyError('INVALID_ARGUMENT')
          }
          result = service.lint.getSkillView({
            skillId,
            view,
            version: targetVersion,
            path: values.path === undefined ? undefined : string(values.path, 'path'),
            expectedPackageHash,
            query: string(values.query, 'query'),
            caseSensitive: values.caseSensitive as boolean | undefined,
            offset: nonNegInt(values.offset),
            limit: values.limit === undefined ? undefined : integer(values.limit, 'limit')
          })
        }
        break
      }
      case 'list_academy_changes': result = service.listChanges(values); break
      case 'get_academy_change_diff': result = service.getChangeDiff(values); break
      case 'get_academy_skill_history': {
        if (values.includeEfficiency !== undefined || values.limit !== undefined || values.cursor !== undefined) {
          if (
            Object.keys(values).some(key => !['skillId', 'metadataOnly', 'includeEfficiency', 'limit', 'cursor'].includes(key)) ||
            values.metadataOnly !== true ||
            (values.includeEfficiency !== undefined && typeof values.includeEfficiency !== 'boolean') ||
            (values.cursor !== undefined && (typeof values.cursor !== 'string' || !values.cursor))
          ) {
            throw new AcademyError('INVALID_ARGUMENT')
          }
          result = service.lint.efficiencyForHistory(string(values.skillId, 'skillId'), {
            includeEfficiency: values.includeEfficiency,
            limit: values.limit as number | undefined,
            cursor: values.cursor
          })
          break
        }
        const { skillId, ...options } = values
        result = service.history(string(skillId, 'skillId'), options as AcademyHistoryOptions)
        break
      }
      case 'get_academy_skill_delivery_status': result = service.getDeliveryStatus(string(values.skillId, 'skillId'), values.expectedVersion === undefined ? undefined : integer(values.expectedVersion, 'expectedVersion')); break
      case 'reintroduce_academy_global_skill': result = service.restoreDeletedGlobalSkill(string(values.skillId, 'skillId'), integer(values.expectedVersion, 'expectedVersion'), values.confirmed === true); break
      case 'review_academy_manifest_conflict': result = service.store.reviewManifestConflict(); break
      case 'resolve_academy_manifest_conflict': service.store.resolveManifestConflict(string(values.token, 'token'), enumValue(values.choice, ['LOCAL', 'REMOTE'], 'choice') as 'LOCAL' | 'REMOTE', values.confirmed === true); service.gitSync?.scheduleLocalChange(); result = { state: 'PERSISTED' }; break
      case 'cutover_academy_local_authority': if (!service.gitSync) throw new Error('GIT_SYNC_NOT_CONFIGURED'); result = await service.gitSync.completeLocalCutover(values.confirmed === true); break
      case 'approve_academy_publications': result = service.approvePublicSkills(approvalItems(values.items), values.confirmed === true); break
      case 'approve_academy_publication': result = service.approvePublicSkill(string(values.skillId, 'skillId'), integer(values.expectedVersion, 'expectedVersion'), values.confirmed === true); break
      case 'delete_academy_global_skill': result = service.deleteGlobalSkill(string(values.skillId, 'skillId'), integer(values.expectedVersion, 'expectedVersion'), values.confirmed === true); break
      case 'create_academy_skill': {
        if (values.keepPrivate !== undefined && typeof values.keepPrivate !== 'boolean') throw new Error('INVALID_ARGUMENT')
        const created = await service.saveNewSkill({ package: pkg(values.package), scope: enumValue(values.scope, ['GLOBAL', 'PROJECT'], 'scope') as AcademySkillScope, projectIds: strings(values.projectIds), keepPrivate: values.keepPrivate, expectedDraftCommitSha: values.expectedDraftCommitSha as string | undefined, origin: 'MCP' })
        result = 'id' in created ? { ...created, publication: service.describePublication(created) } : created
        break
      }
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
        if (values.force !== undefined && typeof values.force !== 'boolean') throw new Error('INVALID_ARGUMENT')
        const request = mode === 'LATEST' ? { mode: 'LATEST' as const, force: values.force === true } : { mode: 'REBUILD' as const, sourceCommitSha: string(values.sourceCommitSha, 'sourceCommitSha') }
        result = await service.prepareOpenAiRelease(request); break
      }
      case 'get_openai_plugin_release': result = service.getOpenAiRelease(string(values.releaseId, 'releaseId')); break
      case 'confirm_openai_plugin_upload': result = service.confirmOpenAiUpload(string(values.releaseId, 'releaseId'), sha256(values.artifactHash)); break
      case 'get_academy_skill_lint': {
        const allowed = ['skillId', 'version', 'status', 'scope', 'ruleId', 'category', 'state', 'lintHealth', 'includeInventory', 'deepen', 'limit', 'cursor']
        if (Object.keys(values).some(key => !allowed.includes(key))) throw new AcademyError('INVALID_ARGUMENT')
        if (values.cursor !== undefined && (typeof values.cursor !== 'string' || !values.cursor)) throw new AcademyError('INVALID_ARGUMENT')
        if (values.includeInventory !== undefined && typeof values.includeInventory !== 'boolean') throw new AcademyError('INVALID_ARGUMENT')
        if (values.ruleId !== undefined && (typeof values.ruleId !== 'string' || !values.ruleId)) throw new AcademyError('INVALID_ARGUMENT')
        if (values.deepen !== undefined && (!Array.isArray(values.deepen) || values.deepen.some(d => d !== 'DESCRIPTION_TERMS' && d !== 'CATALOG_PRESSURE'))) {
          throw new AcademyError('INVALID_ARGUMENT')
        }
        const category = optionalEnum(values.category, ['INVALID', 'REVIEW', 'OBSERVATION']) as FindingCategory | undefined
        if (values.skillId !== undefined) {
          result = service.lint.report({
            skillId: string(values.skillId, 'skillId'),
            version: values.version === undefined ? undefined : integer(values.version, 'version'),
            ruleId: values.ruleId,
            category,
            state: optionalEnum(values.state, ['OPEN', 'REVIEWED']) as 'OPEN' | 'REVIEWED' | undefined,
            includeInventory: values.includeInventory,
            deepen: values.deepen as string[] | undefined,
            limit: values.limit as number | undefined,
            cursor: values.cursor
          })
        } else {
          if (values.version !== undefined || values.state !== undefined || values.includeInventory !== undefined || values.deepen !== undefined) {
            throw new AcademyError('INVALID_ARGUMENT')
          }
          result = service.lint.catalog({
            status: optionalEnum(values.status, ['ACTIVE', 'DISABLED']) as AcademySkillStatus | undefined,
            scope: optionalEnum(values.scope, ['GLOBAL', 'PROJECT']) as AcademySkillScope | undefined,
            ruleId: values.ruleId,
            category,
            lintHealth: optionalEnum(values.lintHealth, ['INVALID', 'REVIEW_OPEN', 'REVIEWED', 'NO_FINDINGS', 'UNKNOWN']) as LintHealth | undefined,
            limit: values.limit as number | undefined,
            cursor: values.cursor
          })
        }
        break
      }
      case 'review_academy_skill_lint': {
        const allowed = ['skillId', 'expectedVersion', 'findingId', 'evidenceFingerprint', 'action', 'rationale']
        if (Object.keys(values).some(key => !allowed.includes(key))) throw new AcademyError('INVALID_ARGUMENT')
        const principalId = context?.authority?.principal?.principalId
        if (!principalId || context?.authority?.isActive?.() === false) {
          throw new AcademyError('AUTHENTICATION_REQUIRED', 'Authenticated authority principal is required to record or revoke lint reviews')
        }
        const action = enumValue(values.action, ['RECORD', 'REVOKE'], 'action') as 'RECORD' | 'REVOKE'
        const fp = string(values.evidenceFingerprint, 'evidenceFingerprint')
        if (!/^[a-f0-9]{64}$/.test(fp)) throw new AcademyError('INVALID_EVIDENCE_FINGERPRINT')
        if (action === 'RECORD') {
          result = service.lint.recordReview({
            skillId: string(values.skillId, 'skillId'),
            expectedVersion: integer(values.expectedVersion, 'expectedVersion'),
            findingId: string(values.findingId, 'findingId'),
            evidenceFingerprint: fp,
            rationale: string(values.rationale, 'rationale'),
            author: principalId
          })
        } else {
          result = service.lint.revokeReview({
            skillId: string(values.skillId, 'skillId'),
            expectedVersion: integer(values.expectedVersion, 'expectedVersion'),
            findingId: string(values.findingId, 'findingId'),
            evidenceFingerprint: fp,
            author: principalId
          })
        }
        break
      }
      case 'edit_academy_skill': {
        const allowed = ['skillId', 'expectedVersion', 'expectedPackageHash', 'mode', 'edits']
        if (Object.keys(values).some(key => !allowed.includes(key))) throw new AcademyError('INVALID_ARGUMENT')
        const skillId = string(values.skillId, 'skillId')
        const expectedVersion = integer(values.expectedVersion, 'expectedVersion')
        const expectedPackageHash = sha256(values.expectedPackageHash)
        const mode = enumValue(values.mode, ['PREVIEW', 'APPLY'], 'mode') as 'PREVIEW' | 'APPLY'
        const existingSkill = service.get(skillId)
        if (existingSkill.scope === 'GLOBAL' && service.gitSync && !service.store.usesLocalAuthority()) {
          throw new AcademyError('FOCAL_EDIT_REQUIRES_LOCAL_AUTHORITY', 'Focal edit requires local SQLite authority for GLOBAL skills')
        }
        if (mode === 'PREVIEW') {
          result = service.lint.previewFocalEdit({
            skillId,
            expectedVersion,
            expectedPackageHash,
            edits: values.edits
          })
          break
        }
        const prep = service.lint.prepareFocalEdit({
          skillId,
          expectedVersion,
          expectedPackageHash,
          edits: values.edits
        })
        if (prep.kind === 'NO_CHANGE') {
          result = {
            state: 'NO_CHANGE',
            skillId: prep.skill.id,
            version: prep.skill.currentVersion,
            packageHash: prep.skill.current.packageHash
          }
          break
        }
        if (!prep.editResult.candidateValid) {
          throw new AcademyError(
            prep.editResult.validationError?.code ?? 'INVALID_PACKAGE',
            prep.editResult.validationError?.message ?? 'Invalid candidate package'
          )
        }
        result = await service.saveSkill(
          {
            skillId,
            expectedVersion,
            package: prep.editResult.candidate,
            origin: 'MCP'
          },
          'RECEIPT'
        )
        break
      }
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
function approvalItems(value: unknown): Array<{ skillId: string; expectedVersion: number }> {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error('INVALID_ITEMS')
  return value.map(item => { const entry = objectArgs(item); return { skillId: string(entry.skillId, 'skillId'), expectedVersion: integer(entry.expectedVersion, 'expectedVersion') } })
}
function strings(value: unknown): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) throw new Error('INVALID_PROJECT_IDS'); return [...new Set(value)] }
function pkg(value: unknown): AcademyPackage {
  const object = objectArgs(value)
  if (typeof object.skillMd !== 'string' || !object.artifacts || typeof object.artifacts !== 'object' || Array.isArray(object.artifacts) || Object.values(object.artifacts).some((item) => typeof item !== 'string')) throw new Error('INVALID_PACKAGE')
  return { skillMd: object.skillMd, artifacts: object.artifacts as Record<string, string> }
}
