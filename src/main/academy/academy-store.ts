import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'
import type { AcademyConflict, AcademyCreateInput, AcademyDestination, AcademyDistributionState, AcademyDistributionStatus, AcademyDistributionTarget, AcademyGitProfile, AcademyGitSyncState, AcademyMarketplaceState, AcademyMarketplaceTakeoverStatus, AcademyOpenAiDeletionSemantics, AcademyOpenAiPluginProfile, AcademyOpenAiRelease, AcademyOpenAiReleaseStatus, AcademyPackage, AcademyPluginPackageRevision, AcademySkillDetail, AcademySkillScope, AcademySkillStatus, AcademySkillSummary, AcademySkillVersion, AcademyUpdateInput, AcademyVersionOrigin } from '../../shared/types/academy-types'
import { AcademyError, hashAcademyPackage, normalizeAcademyPackage, parseSkillMetadata } from './academy-package'

type Row = Record<string, any>

export class AcademyStore {
  private readonly db: Database.Database

  constructor(readonly databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new Database(databasePath)
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS academy_skills (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE','ARCHIVED')),
        scope TEXT NOT NULL CHECK(scope IN ('GLOBAL','PROJECT')),
        current_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS academy_active_name ON academy_skills(lower(name)) WHERE status = 'ACTIVE';
      CREATE TABLE IF NOT EXISTS academy_versions (
        skill_id TEXT NOT NULL REFERENCES academy_skills(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, skill_md TEXT NOT NULL, artifacts_json TEXT NOT NULL,
        package_hash TEXT NOT NULL, origin TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(skill_id, version)
      );
      CREATE TABLE IF NOT EXISTS academy_destinations (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        reconciliation_status TEXT NOT NULL DEFAULT 'PENDING', last_error TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS academy_skill_projects (
        skill_id TEXT NOT NULL REFERENCES academy_skills(id) ON DELETE CASCADE,
        destination_id TEXT NOT NULL REFERENCES academy_destinations(id) ON DELETE CASCADE,
        PRIMARY KEY(skill_id, destination_id)
      );
      CREATE TABLE IF NOT EXISTS academy_projections (
        skill_id TEXT NOT NULL REFERENCES academy_skills(id) ON DELETE CASCADE,
        destination_id TEXT NOT NULL REFERENCES academy_destinations(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, package_hash TEXT NOT NULL, projected_at TEXT NOT NULL, skill_name TEXT,
        PRIMARY KEY(skill_id, destination_id)
      );
      CREATE TABLE IF NOT EXISTS academy_conflicts (
        id TEXT PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES academy_skills(id) ON DELETE CASCADE,
        origin TEXT NOT NULL, base_version INTEGER, current_version INTEGER NOT NULL,
        divergent_package_json TEXT, divergent_hash TEXT NOT NULL, project_id TEXT, projection_path TEXT,
        status TEXT NOT NULL DEFAULT 'OPEN', created_at TEXT NOT NULL, resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS academy_distribution_states (
        skill_id TEXT NOT NULL REFERENCES academy_skills(id) ON DELETE CASCADE,
        destination_id TEXT NOT NULL REFERENCES academy_destinations(id) ON DELETE CASCADE,
        target TEXT NOT NULL CHECK(target IN ('FILESYSTEM_NATIVE','CLAUDE_CODE')),
        canonical_version INTEGER NOT NULL, canonical_hash TEXT NOT NULL,
        distributed_version INTEGER, distributed_hash TEXT,
        status TEXT NOT NULL CHECK(status IN ('CURRENT','PENDING','DRIFTED','MISSING','ERROR')),
        error_code TEXT, error_message TEXT, checked_at TEXT NOT NULL,
        exposure_name TEXT, link_mechanism TEXT,
        PRIMARY KEY(skill_id, destination_id, target)
      );
      CREATE TABLE IF NOT EXISTS academy_openai_plugin_profile (
        id TEXT PRIMARY KEY CHECK(id='academy-skills'), name TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL, description TEXT NOT NULL, author_json TEXT NOT NULL,
        interface_json TEXT NOT NULL, logo_path TEXT, published_version TEXT NOT NULL,
        deletion_semantics TEXT NOT NULL CHECK(deletion_semantics IN ('UNKNOWN','PROVEN_REPLACE','OVERLAY_NO_DELETE','INCONCLUSIVE')),
        deletion_semantics_evidence TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS academy_openai_plugin_releases (
        id TEXT PRIMARY KEY, plugin_version TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
        reference_release_id TEXT REFERENCES academy_openai_plugin_releases(id),
        snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL, delta_json TEXT NOT NULL,
        manifest_json TEXT, artifact_path TEXT, artifact_hash TEXT,
        status TEXT NOT NULL CHECK(status IN ('READY_TO_UPLOAD','STALE','UPLOADED_UNVERIFIED','VERIFIED','SUPERSEDED','BLOCKED')),
        blocked_reason TEXT, baseline INTEGER NOT NULL DEFAULT 0,
        upload_confirmation_json TEXT, verification_evidence TEXT
      );
      CREATE INDEX IF NOT EXISTS academy_openai_releases_created ON academy_openai_plugin_releases(created_at DESC);
      CREATE TABLE IF NOT EXISTS academy_plugin_package_revisions (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL UNIQUE,
        content_fingerprint TEXT NOT NULL UNIQUE,
        skill_snapshot_hash TEXT NOT NULL,
        profile_fingerprint TEXT NOT NULL,
        asset_hash TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        delta_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS academy_package_revisions_created ON academy_plugin_package_revisions(created_at DESC);
      CREATE TABLE IF NOT EXISTS academy_marketplace_state (
        id TEXT PRIMARY KEY CHECK(id='academy-marketplace-state'),
        takeover_status TEXT NOT NULL CHECK(takeover_status IN ('TAKEOVER_PROVEN','TAKEOVER_UNSUPPORTED','INCONCLUSIVE')),
        observed_plugin_id TEXT,
        evidence TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS academy_git_profile (
        id TEXT PRIMARY KEY CHECK(id='academy-git-profile'),
        repository_catalog_id TEXT NOT NULL,
        github_repository_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        last_snapshot_hash TEXT,
        last_commit_sha TEXT,
        last_pushed_commit_sha TEXT,
        sync_state TEXT NOT NULL CHECK(sync_state IN ('UNCONFIGURED','SYNCED','DIRTY','SYNCING','PUSH_PENDING','LOCAL_DRIFT','REMOTE_DIVERGED','ERROR')),
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
    `)
    const projectionColumns = this.db.prepare('PRAGMA table_info(academy_projections)').all() as Row[]
    if (!projectionColumns.some((column) => column.name === 'skill_name')) this.db.exec('ALTER TABLE academy_projections ADD COLUMN skill_name TEXT')
  }

  close(): void { this.db.close() }

  create(input: AcademyCreateInput): AcademySkillDetail {
    const pkg = normalizeAcademyPackage(input.package)
    const metadata = parseSkillMetadata(pkg.skillMd)
    const id = randomUUID()
    const now = new Date().toISOString()
    const hash = hashAcademyPackage(pkg)
    try {
      this.db.transaction(() => {
        this.db.prepare('INSERT INTO academy_skills VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(id, metadata.name, metadata.description, 'ACTIVE', input.scope, now, now)
        this.insertVersion(id, 1, pkg, hash, input.origin, now)
        this.replaceProjects(id, input.projectIds ?? [])
      })()
    } catch (error: any) {
      if (String(error?.message).includes('academy_active_name')) throw new AcademyError('DUPLICATE_SKILL_NAME', `Active skill already exists: ${metadata.name}`)
      throw error
    }
    return this.get(id)
  }

  update(input: AcademyUpdateInput): AcademySkillDetail {
    const pkg = normalizeAcademyPackage(input.package)
    const metadata = parseSkillMetadata(pkg.skillMd)
    const now = new Date().toISOString()
    try {
      this.db.transaction(() => {
        const row = this.skillRow(input.skillId)
        if (row.current_version !== input.expectedVersion) throw new AcademyError('VERSION_CONFLICT', 'Skill changed since it was read', { expectedVersion: input.expectedVersion, currentVersion: row.current_version })
        if (row.status !== 'ACTIVE') throw new AcademyError('SKILL_ARCHIVED')
        const version = row.current_version + 1
        this.db.prepare('UPDATE academy_skills SET name=?, description=?, scope=?, current_version=?, updated_at=? WHERE id=?').run(metadata.name, metadata.description, input.scope ?? row.scope, version, now, input.skillId)
        this.insertVersion(input.skillId, version, pkg, hashAcademyPackage(pkg), input.origin, now)
        if (input.projectIds) this.replaceProjects(input.skillId, input.projectIds)
      })()
    } catch (error: any) {
      if (String(error?.message).includes('academy_active_name')) throw new AcademyError('DUPLICATE_SKILL_NAME', `Active skill already exists: ${metadata.name}`)
      throw error
    }
    return this.get(input.skillId)
  }

  list(status?: AcademySkillStatus): AcademySkillSummary[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM academy_skills WHERE status=? ORDER BY lower(name)').all(status) as Row[]
      : this.db.prepare('SELECT * FROM academy_skills ORDER BY lower(name)').all() as Row[]
    return rows.map((row) => this.summary(row))
  }

  findByName(name: string): AcademySkillDetail | null {
    const row = this.db.prepare("SELECT id FROM academy_skills WHERE lower(name)=lower(?) ORDER BY status='ACTIVE' DESC LIMIT 1").get(name) as Row | undefined
    return row ? this.get(row.id) : null
  }

  get(id: string): AcademySkillDetail {
    const row = this.skillRow(id)
    return { ...this.summary(row), current: this.getVersion(id, row.current_version) }
  }

  history(id: string): AcademySkillVersion[] {
    this.skillRow(id)
    return (this.db.prepare('SELECT * FROM academy_versions WHERE skill_id=? ORDER BY version DESC').all(id) as Row[]).map(versionFromRow)
  }

  archive(id: string, expectedVersion: number): AcademySkillDetail {
    return this.setStatus(id, expectedVersion, 'ARCHIVED')
  }

  restore(id: string, expectedVersion: number): AcademySkillDetail {
    return this.setStatus(id, expectedVersion, 'ACTIVE')
  }

  upsertDestination(path: string, name: string, enabled = true): AcademyDestination {
    const now = new Date().toISOString()
    const existing = this.db.prepare('SELECT id FROM academy_destinations WHERE path=?').get(path) as Row | undefined
    const id = existing?.id ?? randomUUID()
    this.db.prepare(`INSERT INTO academy_destinations(id,path,name,enabled,reconciliation_status,last_error,updated_at)
      VALUES(?,?,?,?, 'PENDING', NULL, ?) ON CONFLICT(path) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, updated_at=excluded.updated_at`).run(id, path, name, enabled ? 1 : 0, now)
    return this.getDestination(id)
  }

  listDestinations(): AcademyDestination[] {
    return (this.db.prepare('SELECT * FROM academy_destinations ORDER BY lower(name), path').all() as Row[]).map(destinationFromRow)
  }

  setDestinationEnabled(id: string, enabled: boolean): AcademyDestination {
    const result = this.db.prepare("UPDATE academy_destinations SET enabled=?, reconciliation_status='PENDING', updated_at=? WHERE id=?").run(enabled ? 1 : 0, new Date().toISOString(), id)
    if (!result.changes) throw new AcademyError('DESTINATION_NOT_FOUND')
    return this.getDestination(id)
  }

  markDestination(id: string, status: 'PENDING' | 'SYNCED' | 'ERROR', error: string | null): void {
    this.db.prepare('UPDATE academy_destinations SET reconciliation_status=?, last_error=?, updated_at=? WHERE id=?').run(status, error, new Date().toISOString(), id)
  }

  getProjection(skillId: string, destinationId: string): { version: number; packageHash: string; skillName: string | null } | null {
    const row = this.db.prepare('SELECT version, package_hash, skill_name FROM academy_projections WHERE skill_id=? AND destination_id=?').get(skillId, destinationId) as Row | undefined
    return row ? { version: row.version, packageHash: row.package_hash, skillName: row.skill_name } : null
  }

  setProjection(skillId: string, destinationId: string, version: number, packageHash: string, skillName: string): void {
    this.db.prepare(`INSERT INTO academy_projections(skill_id,destination_id,version,package_hash,projected_at,skill_name) VALUES(?,?,?,?,?,?) ON CONFLICT(skill_id,destination_id)
      DO UPDATE SET version=excluded.version, package_hash=excluded.package_hash, projected_at=excluded.projected_at, skill_name=excluded.skill_name`).run(skillId, destinationId, version, packageHash, new Date().toISOString(), skillName)
  }

  removeProjection(skillId: string, destinationId: string): void {
    this.db.prepare('DELETE FROM academy_projections WHERE skill_id=? AND destination_id=?').run(skillId, destinationId)
  }

  getDistributionState(skillId: string, destinationId: string, target: AcademyDistributionTarget): AcademyDistributionState | null {
    const row = this.db.prepare(`SELECT ds.*, s.name skill_name, d.name destination_name
      FROM academy_distribution_states ds JOIN academy_skills s ON s.id=ds.skill_id
      JOIN academy_destinations d ON d.id=ds.destination_id
      WHERE ds.skill_id=? AND ds.destination_id=? AND ds.target=?`).get(skillId, destinationId, target) as Row | undefined
    return row ? distributionStateFromRow(row) : null
  }

  listDistributionStates(skillId?: string): AcademyDistributionState[] {
    const sql = `SELECT ds.*, s.name skill_name, d.name destination_name
      FROM academy_distribution_states ds JOIN academy_skills s ON s.id=ds.skill_id
      JOIN academy_destinations d ON d.id=ds.destination_id`
    const rows = skillId
      ? this.db.prepare(`${sql} WHERE ds.skill_id=? ORDER BY ds.target, lower(d.name)`).all(skillId) as Row[]
      : this.db.prepare(`${sql} ORDER BY ds.target, lower(d.name), lower(s.name)`).all() as Row[]
    return rows.map(distributionStateFromRow)
  }

  setDistributionState(input: {
    skillId: string
    destinationId: string
    target: AcademyDistributionTarget
    canonicalVersion: number
    canonicalHash: string
    distributedVersion: number | null
    distributedHash: string | null
    status: AcademyDistributionStatus
    errorCode: string | null
    errorMessage: string | null
    exposureName: string | null
    linkMechanism: 'SYMLINK' | 'JUNCTION' | null
  }): void {
    this.db.prepare(`INSERT INTO academy_distribution_states(
      skill_id,destination_id,target,canonical_version,canonical_hash,distributed_version,distributed_hash,status,
      error_code,error_message,checked_at,exposure_name,link_mechanism
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(skill_id,destination_id,target) DO UPDATE SET
      canonical_version=excluded.canonical_version, canonical_hash=excluded.canonical_hash,
      distributed_version=excluded.distributed_version, distributed_hash=excluded.distributed_hash,
      status=excluded.status, error_code=excluded.error_code, error_message=excluded.error_message,
      checked_at=excluded.checked_at, exposure_name=excluded.exposure_name, link_mechanism=excluded.link_mechanism`).run(
      input.skillId, input.destinationId, input.target, input.canonicalVersion, input.canonicalHash,
      input.distributedVersion, input.distributedHash, input.status, input.errorCode, input.errorMessage,
      new Date().toISOString(), input.exposureName, input.linkMechanism
    )
  }

  removeDistributionState(skillId: string, destinationId: string, target: AcademyDistributionTarget): void {
    this.db.prepare('DELETE FROM academy_distribution_states WHERE skill_id=? AND destination_id=? AND target=?').run(skillId, destinationId, target)
  }

  getOpenAiPluginProfile(): AcademyOpenAiPluginProfile | null {
    const row = this.db.prepare('SELECT * FROM academy_openai_plugin_profile WHERE id=?').get('academy-skills') as Row | undefined
    return row ? openAiProfileFromRow(row) : null
  }

  createOpenAiPluginProfile(input: Omit<AcademyOpenAiPluginProfile, 'createdAt' | 'updatedAt'>): AcademyOpenAiPluginProfile {
    if (input.name !== 'academy-skills') throw new AcademyError('OPENAI_PLUGIN_IDENTITY_IMMUTABLE')
    if (this.getOpenAiPluginProfile()) throw new AcademyError('OPENAI_PLUGIN_PROFILE_EXISTS')
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO academy_openai_plugin_profile(
      id,name,display_name,description,author_json,interface_json,logo_path,published_version,
      deletion_semantics,deletion_semantics_evidence,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'academy-skills', input.name, input.displayName, input.description, JSON.stringify(input.author),
      JSON.stringify(input.openAiInterface), input.logoPath, input.publishedVersion,
      input.deletionSemantics, input.deletionSemanticsEvidence, now, now
    )
    return this.getOpenAiPluginProfile()!
  }

  setOpenAiDeletionSemantics(value: AcademyOpenAiDeletionSemantics, evidence: string | null): AcademyOpenAiPluginProfile {
    if (!this.getOpenAiPluginProfile()) throw new AcademyError('OPENAI_PLUGIN_PROFILE_MISSING')
    this.db.prepare('UPDATE academy_openai_plugin_profile SET deletion_semantics=?, deletion_semantics_evidence=?, updated_at=? WHERE id=?')
      .run(value, evidence, new Date().toISOString(), 'academy-skills')
    return this.getOpenAiPluginProfile()!
  }

  setOpenAiPublishedVersion(version: string): AcademyOpenAiPluginProfile {
    if (!this.getOpenAiPluginProfile()) throw new AcademyError('OPENAI_PLUGIN_PROFILE_MISSING')
    this.db.prepare('UPDATE academy_openai_plugin_profile SET published_version=?, updated_at=? WHERE id=?')
      .run(version, new Date().toISOString(), 'academy-skills')
    return this.getOpenAiPluginProfile()!
  }

  setOpenAiInterface(openAiInterface: Record<string, unknown>): AcademyOpenAiPluginProfile {
    if (!this.getOpenAiPluginProfile()) throw new AcademyError('OPENAI_PLUGIN_PROFILE_MISSING')
    this.db.prepare('UPDATE academy_openai_plugin_profile SET interface_json=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(openAiInterface), new Date().toISOString(), 'academy-skills')
    return this.getOpenAiPluginProfile()!
  }

  getPluginPackageRevisionByFingerprint(contentFingerprint: string): AcademyPluginPackageRevision | null {
    const row = this.db.prepare('SELECT * FROM academy_plugin_package_revisions WHERE content_fingerprint=?').get(contentFingerprint) as Row | undefined
    return row ? pluginPackageRevisionFromRow(row) : null
  }

  getCurrentPluginPackageRevision(): AcademyPluginPackageRevision | null {
    const row = this.db.prepare('SELECT * FROM academy_plugin_package_revisions ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as Row | undefined
    return row ? pluginPackageRevisionFromRow(row) : null
  }

  listPluginPackageRevisions(): AcademyPluginPackageRevision[] {
    return (this.db.prepare('SELECT * FROM academy_plugin_package_revisions ORDER BY created_at ASC, rowid ASC').all() as Row[])
      .map(pluginPackageRevisionFromRow)
  }

  getPluginPackageRevisionSnapshot(id: string): AcademyOpenAiRelease['snapshot'] {
    const row = this.db.prepare('SELECT snapshot_json FROM academy_plugin_package_revisions WHERE id=?').get(id) as Row | undefined
    if (!row) throw new AcademyError('ACADEMY_PACKAGE_REVISION_NOT_FOUND')
    return JSON.parse(row.snapshot_json)
  }

  insertPluginPackageRevision(revision: AcademyPluginPackageRevision, snapshot: AcademyOpenAiRelease['snapshot']): AcademyPluginPackageRevision {
    this.db.prepare(`INSERT INTO academy_plugin_package_revisions(
      id,version,content_fingerprint,skill_snapshot_hash,profile_fingerprint,asset_hash,snapshot_json,delta_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      revision.id, revision.version, revision.contentFingerprint, revision.skillSnapshotHash,
      revision.profileFingerprint, revision.assetHash, JSON.stringify(snapshot), JSON.stringify(revision.delta), revision.createdAt
    )
    return this.getPluginPackageRevisionByFingerprint(revision.contentFingerprint)!
  }

  replaceCurrentPluginPackageRevision(
    expectedVersion: string,
    revision: AcademyPluginPackageRevision,
    snapshot: AcademyOpenAiRelease['snapshot']
  ): AcademyPluginPackageRevision {
    this.db.transaction(() => {
      const current = this.db.prepare('SELECT id,version FROM academy_plugin_package_revisions ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as Row | undefined
      const matching = this.db.prepare('SELECT id FROM academy_plugin_package_revisions WHERE version=?').all(expectedVersion) as Row[]
      if (!current || current.version !== expectedVersion || matching.length !== 1) {
        throw new AcademyError('ACADEMY_PACKAGE_REVISION_REPAIR_UNSAFE')
      }
      this.db.prepare('DELETE FROM academy_plugin_package_revisions WHERE id=? OR content_fingerprint=?')
        .run(current.id, revision.contentFingerprint)
      this.db.prepare(`INSERT INTO academy_plugin_package_revisions(
        id,version,content_fingerprint,skill_snapshot_hash,profile_fingerprint,asset_hash,snapshot_json,delta_json,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        revision.id, revision.version, revision.contentFingerprint, revision.skillSnapshotHash,
        revision.profileFingerprint, revision.assetHash, JSON.stringify(snapshot), JSON.stringify(revision.delta), revision.createdAt
      )
    })()
    return this.getPluginPackageRevisionByFingerprint(revision.contentFingerprint)!
  }

  getMarketplaceState(): AcademyMarketplaceState {
    const row = this.db.prepare('SELECT * FROM academy_marketplace_state WHERE id=?').get('academy-marketplace-state') as Row | undefined
    if (!row) {
      return {
        takeoverStatus: 'INCONCLUSIVE', mode: 'PENDING_EVIDENCE', observedPluginId: null,
        evidence: 'Takeover probe has not been recorded.', updatedAt: new Date(0).toISOString()
      }
    }
    return marketplaceStateFromRow(row)
  }

  saveMarketplaceTakeoverState(input: {
    takeoverStatus: AcademyMarketplaceTakeoverStatus
    observedPluginId: string | null
    evidence: string
  }): AcademyMarketplaceState {
    if (!input.evidence.trim()) throw new AcademyError('MARKETPLACE_EVIDENCE_REQUIRED')
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO academy_marketplace_state(id,takeover_status,observed_plugin_id,evidence,updated_at)
      VALUES('academy-marketplace-state',?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET takeover_status=excluded.takeover_status,
        observed_plugin_id=excluded.observed_plugin_id,evidence=excluded.evidence,updated_at=excluded.updated_at`)
      .run(input.takeoverStatus, input.observedPluginId, input.evidence, now)
    return this.getMarketplaceState()
  }

  insertOpenAiRelease(release: AcademyOpenAiRelease): AcademyOpenAiRelease {
    this.db.prepare(`INSERT INTO academy_openai_plugin_releases(
      id,plugin_version,created_at,reference_release_id,snapshot_json,snapshot_hash,delta_json,
      manifest_json,artifact_path,artifact_hash,status,blocked_reason,baseline,upload_confirmation_json,verification_evidence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      release.id, release.pluginVersion, release.createdAt, release.referenceReleaseId,
      JSON.stringify(release.snapshot), release.snapshotHash, JSON.stringify(release.delta),
      release.manifest ? JSON.stringify(release.manifest) : null, release.artifactPath, release.artifactHash,
      release.status, release.blockedReason, release.baseline ? 1 : 0,
      release.uploadConfirmation ? JSON.stringify(release.uploadConfirmation) : null, release.verificationEvidence
    )
    return this.getOpenAiRelease(release.id)
  }

  getOpenAiRelease(id: string): AcademyOpenAiRelease {
    const row = this.db.prepare('SELECT * FROM academy_openai_plugin_releases WHERE id=?').get(id) as Row | undefined
    if (!row) throw new AcademyError('OPENAI_RELEASE_NOT_FOUND')
    return openAiReleaseFromRow(row)
  }

  listOpenAiReleases(): AcademyOpenAiRelease[] {
    return (this.db.prepare('SELECT * FROM academy_openai_plugin_releases ORDER BY created_at DESC, rowid DESC').all() as Row[]).map(openAiReleaseFromRow)
  }

  transitionOpenAiRelease(id: string, expected: AcademyOpenAiReleaseStatus[], status: AcademyOpenAiReleaseStatus, values: {
    uploadConfirmation?: AcademyOpenAiRelease['uploadConfirmation']
    verificationEvidence?: string | null
  } = {}): AcademyOpenAiRelease {
    const release = this.getOpenAiRelease(id)
    if (!expected.includes(release.status)) throw new AcademyError('OPENAI_RELEASE_INVALID_STATE', `${release.status} cannot transition to ${status}`)
    this.db.prepare(`UPDATE academy_openai_plugin_releases SET status=?,
      upload_confirmation_json=COALESCE(?,upload_confirmation_json), verification_evidence=COALESCE(?,verification_evidence)
      WHERE id=?`).run(status, values.uploadConfirmation ? JSON.stringify(values.uploadConfirmation) : null, values.verificationEvidence ?? null, id)
    return this.getOpenAiRelease(id)
  }

  materializeBlockedOpenAiRelease(id: string, values: {
    manifest: Record<string, unknown>
    artifactPath: string
    artifactHash: string
    status: Extract<AcademyOpenAiReleaseStatus, 'READY_TO_UPLOAD' | 'STALE'>
  }): AcademyOpenAiRelease {
    const release = this.getOpenAiRelease(id)
    if (release.status !== 'BLOCKED') throw new AcademyError('OPENAI_RELEASE_INVALID_STATE')
    this.db.prepare(`UPDATE academy_openai_plugin_releases SET
      manifest_json=?, artifact_path=?, artifact_hash=?, status=?, blocked_reason=NULL
      WHERE id=?`).run(JSON.stringify(values.manifest), values.artifactPath, values.artifactHash, values.status, id)
    return this.getOpenAiRelease(id)
  }

  markOpenAiReadyReleasesStaleExcept(snapshotHash: string): number {
    return this.db.prepare("UPDATE academy_openai_plugin_releases SET status='STALE' WHERE status='READY_TO_UPLOAD' AND snapshot_hash<>?").run(snapshotHash).changes
  }

  supersedeOpenAiPublishedReleases(exceptId: string): void {
    this.db.prepare("UPDATE academy_openai_plugin_releases SET status='SUPERSEDED' WHERE id<>? AND status IN ('UPLOADED_UNVERIFIED','VERIFIED')").run(exceptId)
  }

  getGitProfile(): AcademyGitProfile | null {
    const row = this.db.prepare('SELECT * FROM academy_git_profile WHERE id=?').get('academy-git-profile') as Row | undefined
    return row ? gitProfileFromRow(row) : null
  }

  saveGitProfile(profile: Omit<AcademyGitProfile, 'updatedAt'>): AcademyGitProfile {
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO academy_git_profile(
      id, repository_catalog_id, github_repository_id, branch,
      last_snapshot_hash, last_commit_sha, last_pushed_commit_sha,
      sync_state, last_error, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      repository_catalog_id = excluded.repository_catalog_id,
      github_repository_id = excluded.github_repository_id,
      branch = excluded.branch,
      last_snapshot_hash = excluded.last_snapshot_hash,
      last_commit_sha = excluded.last_commit_sha,
      last_pushed_commit_sha = excluded.last_pushed_commit_sha,
      sync_state = excluded.sync_state,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
    `).run(
      'academy-git-profile',
      profile.repositoryCatalogId,
      profile.githubRepositoryId,
      profile.branch,
      profile.lastSnapshotHash ?? null,
      profile.lastCommitSha ?? null,
      profile.lastPushedCommitSha ?? null,
      profile.syncState,
      profile.lastError ?? null,
      now
    )
    return this.getGitProfile()!
  }

  updateGitSyncState(input: {
    syncState: AcademyGitSyncState
    lastSnapshotHash?: string | null
    lastCommitSha?: string | null
    lastPushedCommitSha?: string | null
    lastError?: string | null
  }): AcademyGitProfile {
    const current = this.getGitProfile()
    if (!current) throw new AcademyError('GIT_PROFILE_NOT_CONFIGURED', 'Academy Git profile is not configured')
    const now = new Date().toISOString()
    this.db.prepare(`UPDATE academy_git_profile SET
      sync_state = ?,
      last_snapshot_hash = CASE WHEN ? IS NOT NULL THEN ? ELSE last_snapshot_hash END,
      last_commit_sha = CASE WHEN ? IS NOT NULL THEN ? ELSE last_commit_sha END,
      last_pushed_commit_sha = CASE WHEN ? IS NOT NULL THEN ? ELSE last_pushed_commit_sha END,
      last_error = ?,
      updated_at = ?
      WHERE id = 'academy-git-profile'
    `).run(
      input.syncState,
      input.lastSnapshotHash !== undefined ? 1 : null,
      input.lastSnapshotHash ?? null,
      input.lastCommitSha !== undefined ? 1 : null,
      input.lastCommitSha ?? null,
      input.lastPushedCommitSha !== undefined ? 1 : null,
      input.lastPushedCommitSha ?? null,
      input.lastError !== undefined ? input.lastError : current.lastError,
      now
    )
    return this.getGitProfile()!
  }

  clearGitProfile(): void {
    this.db.prepare('DELETE FROM academy_git_profile WHERE id=?').run('academy-git-profile')
  }


  isAssigned(skillId: string, destinationId: string): boolean {
    const skill = this.skillRow(skillId)
    return skill.scope === 'GLOBAL' || Boolean(this.db.prepare('SELECT 1 FROM academy_skill_projects WHERE skill_id=? AND destination_id=?').get(skillId, destinationId))
  }

  createConflict(skillId: string, origin: AcademyVersionOrigin, baseVersion: number | null, pkg: AcademyPackage | null, divergentHash: string, projectId: string | null, projectionPath: string | null): AcademyConflict {
    const id = randomUUID()
    const current = this.skillRow(skillId)
    this.db.prepare('INSERT INTO academy_conflicts VALUES(?,?,?,?,?,?,?,?,?,\'OPEN\',?,NULL)').run(id, skillId, origin, baseVersion, current.current_version, pkg ? JSON.stringify(normalizeAcademyPackage(pkg)) : null, divergentHash, projectId, projectionPath, new Date().toISOString())
    return this.getConflict(id)
  }

  listConflicts(): AcademyConflict[] {
    return (this.db.prepare(`SELECT c.*, s.name skill_name FROM academy_conflicts c JOIN academy_skills s ON s.id=c.skill_id WHERE c.status='OPEN' ORDER BY c.created_at DESC`).all() as Row[]).map(conflictFromRow)
  }

  resolveConflict(id: string): void {
    const result = this.db.prepare("UPDATE academy_conflicts SET status='RESOLVED', resolved_at=? WHERE id=? AND status='OPEN'").run(new Date().toISOString(), id)
    if (!result.changes) throw new AcademyError('CONFLICT_NOT_FOUND')
  }

  private getConflict(id: string): AcademyConflict {
    const row = this.db.prepare('SELECT c.*, s.name skill_name FROM academy_conflicts c JOIN academy_skills s ON s.id=c.skill_id WHERE c.id=?').get(id) as Row | undefined
    if (!row) throw new AcademyError('CONFLICT_NOT_FOUND')
    return conflictFromRow(row)
  }

  private getDestination(id: string): AcademyDestination {
    const row = this.db.prepare('SELECT * FROM academy_destinations WHERE id=?').get(id) as Row | undefined
    if (!row) throw new AcademyError('DESTINATION_NOT_FOUND')
    return destinationFromRow(row)
  }

  private setStatus(id: string, expectedVersion: number, status: AcademySkillStatus): AcademySkillDetail {
    try {
      this.db.transaction(() => {
        const row = this.skillRow(id)
        if (row.current_version !== expectedVersion) throw new AcademyError('VERSION_CONFLICT', 'Skill changed since it was read', { expectedVersion, currentVersion: row.current_version })
        this.db.prepare('UPDATE academy_skills SET status=?, updated_at=? WHERE id=?').run(status, new Date().toISOString(), id)
      })()
    } catch (error: any) {
      if (String(error?.message).includes('academy_active_name')) throw new AcademyError('DUPLICATE_SKILL_NAME')
      throw error
    }
    return this.get(id)
  }

  private insertVersion(skillId: string, version: number, pkg: AcademyPackage, hash: string, origin: AcademyVersionOrigin, createdAt: string): void {
    this.db.prepare('INSERT INTO academy_versions VALUES(?,?,?,?,?,?,?)').run(skillId, version, pkg.skillMd, JSON.stringify(pkg.artifacts), hash, origin, createdAt)
  }

  private replaceProjects(skillId: string, projectIds: string[]): void {
    this.db.prepare('DELETE FROM academy_skill_projects WHERE skill_id=?').run(skillId)
    const insert = this.db.prepare('INSERT INTO academy_skill_projects VALUES(?,?)')
    for (const projectId of [...new Set(projectIds)]) {
      if (!this.db.prepare('SELECT 1 FROM academy_destinations WHERE id=?').get(projectId)) throw new AcademyError('DESTINATION_NOT_FOUND', `Unknown destination: ${projectId}`)
      insert.run(skillId, projectId)
    }
  }

  private skillRow(id: string): Row {
    const row = this.db.prepare('SELECT * FROM academy_skills WHERE id=?').get(id) as Row | undefined
    if (!row) throw new AcademyError('SKILL_NOT_FOUND')
    return row
  }

  private getVersion(skillId: string, version: number): AcademySkillVersion {
    const row = this.db.prepare('SELECT * FROM academy_versions WHERE skill_id=? AND version=?').get(skillId, version) as Row | undefined
    if (!row) throw new AcademyError('VERSION_NOT_FOUND')
    return versionFromRow(row)
  }

  private summary(row: Row): AcademySkillSummary {
    const projects = this.db.prepare('SELECT destination_id FROM academy_skill_projects WHERE skill_id=? ORDER BY destination_id').all(row.id) as Row[]
    return { id: row.id, name: row.name, description: row.description, status: row.status, scope: row.scope, currentVersion: row.current_version, projectIds: projects.map((entry) => entry.destination_id), createdAt: row.created_at, updatedAt: row.updated_at }
  }
}

function versionFromRow(row: Row): AcademySkillVersion {
  return { skillId: row.skill_id, version: row.version, package: { skillMd: row.skill_md, artifacts: JSON.parse(row.artifacts_json) }, packageHash: row.package_hash, origin: row.origin, createdAt: row.created_at }
}
function destinationFromRow(row: Row): AcademyDestination {
  return { id: row.id, path: row.path, name: row.name, enabled: Boolean(row.enabled), reconciliationStatus: row.reconciliation_status, lastError: row.last_error, updatedAt: row.updated_at }
}
function conflictFromRow(row: Row): AcademyConflict {
  return { id: row.id, skillId: row.skill_id, skillName: row.skill_name, origin: row.origin, baseVersion: row.base_version, currentVersion: row.current_version, divergentPackage: row.divergent_package_json ? JSON.parse(row.divergent_package_json) : null, divergentHash: row.divergent_hash, projectId: row.project_id, projectionPath: row.projection_path, status: row.status, createdAt: row.created_at, resolvedAt: row.resolved_at }
}
function distributionStateFromRow(row: Row): AcademyDistributionState {
  return {
    skillId: row.skill_id, skillName: row.skill_name, destinationId: row.destination_id, destinationName: row.destination_name,
    target: row.target, canonicalVersion: row.canonical_version, canonicalHash: row.canonical_hash,
    distributedVersion: row.distributed_version, distributedHash: row.distributed_hash, status: row.status,
    errorCode: row.error_code, errorMessage: row.error_message, checkedAt: row.checked_at,
    exposureName: row.exposure_name, linkMechanism: row.link_mechanism
  }
}

function openAiProfileFromRow(row: Row): AcademyOpenAiPluginProfile {
  return {
    name: row.name, displayName: row.display_name, description: row.description,
    author: JSON.parse(row.author_json), openAiInterface: JSON.parse(row.interface_json),
    logoPath: row.logo_path, publishedVersion: row.published_version,
    deletionSemantics: row.deletion_semantics, deletionSemanticsEvidence: row.deletion_semantics_evidence,
    createdAt: row.created_at, updatedAt: row.updated_at
  }
}

function openAiReleaseFromRow(row: Row): AcademyOpenAiRelease {
  return {
    id: row.id, pluginVersion: row.plugin_version, createdAt: row.created_at,
    referenceReleaseId: row.reference_release_id, snapshot: JSON.parse(row.snapshot_json),
    snapshotHash: row.snapshot_hash, delta: JSON.parse(row.delta_json),
    manifest: row.manifest_json ? JSON.parse(row.manifest_json) : null,
    artifactPath: row.artifact_path, artifactHash: row.artifact_hash,
    status: row.status, blockedReason: row.blocked_reason, baseline: Boolean(row.baseline),
    uploadConfirmation: row.upload_confirmation_json ? JSON.parse(row.upload_confirmation_json) : null,
    verificationEvidence: row.verification_evidence
  }
}

function pluginPackageRevisionFromRow(row: Row): AcademyPluginPackageRevision {
  return {
    id: row.id,
    version: row.version,
    contentFingerprint: row.content_fingerprint,
    skillSnapshotHash: row.skill_snapshot_hash,
    profileFingerprint: row.profile_fingerprint,
    assetHash: row.asset_hash,
    delta: JSON.parse(row.delta_json),
    createdAt: row.created_at
  }
}

function marketplaceStateFromRow(row: Row): AcademyMarketplaceState {
  const takeoverStatus = row.takeover_status as AcademyMarketplaceTakeoverStatus
  return {
    takeoverStatus,
    mode: takeoverStatus === 'TAKEOVER_PROVEN' ? 'GIT_MANAGED' : takeoverStatus === 'TAKEOVER_UNSUPPORTED' ? 'SOURCE_AVAILABLE' : 'PENDING_EVIDENCE',
    observedPluginId: row.observed_plugin_id,
    evidence: row.evidence,
    updatedAt: row.updated_at
  }
}

function gitProfileFromRow(row: Row): AcademyGitProfile {
  return {
    repositoryCatalogId: row.repository_catalog_id,
    githubRepositoryId: row.github_repository_id,
    branch: row.branch,
    lastSnapshotHash: row.last_snapshot_hash,
    lastCommitSha: row.last_commit_sha,
    lastPushedCommitSha: row.last_pushed_commit_sha,
    syncState: row.sync_state,
    lastError: row.last_error,
    updatedAt: row.updated_at
  }
}
