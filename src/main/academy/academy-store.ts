import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'
import type { AcademyBuildProjection, AcademyGitSnapshotHeader } from '../../shared/types/academy-publication-types'
import type { AcademyGitAuthority, AcademyGitSkillSource, AcademyGitSourceSnapshot } from '../../shared/types/academy-git-source-types'
import type { AcademyGitPublicationState, AcademyHistoryOptions, AcademyHistoryResult, AcademySkillVersionMetadata } from '../../shared/types/academy-types'
import type { AcademyConflict, AcademyCreateInput, AcademyPublicationPreference, AcademyPublicationSource, AcademyDestination, AcademyDistributionState, AcademyDistributionStatus, AcademyDistributionTarget, AcademyGitProfile, AcademyGitSyncState, AcademyMarketplaceState, AcademyMarketplaceTakeoverStatus, AcademyOpenAiDeletionSemantics, AcademyOpenAiPluginProfile, AcademyOpenAiRelease, AcademyOpenAiReleaseStatus, AcademyPackage, AcademyPluginPackageRevision, AcademySkillDetail, AcademySkillScope, AcademySkillStatus, AcademySkillSummary, AcademySkillVersion, AcademyUpdateInput, AcademyVersionOrigin } from '../../shared/types/academy-types'
import { AcademyError, hashAcademyPackage, normalizeAcademyPackage, parseSkillMetadata } from './academy-package'
import { validateAcademyIdentities, type AcademyIdentityCatalog } from '../../shared/academy-identity.cjs'
import { buildOpenAiManifest, canonicalJson, sha256 } from './publication/openai-plugin-model'
import { mergeAcademyPackages } from './git/academy-git-reconciliation'
import { validatePngLogo } from './publication/openai-plugin-validator'

type Row = Record<string, any>

function gitSnapshotHeader(source: AcademyGitSourceSnapshot): AcademyGitSnapshotHeader {
  let manifest: Record<string, any> | null = null
  try { manifest = JSON.parse(Buffer.from(source.authoredFiles['plugin.json'], 'base64').toString('utf8')) } catch { }
  return { repositoryId: source.repositoryId, branch: source.branch, sourceCommitSha: source.sourceCommitSha, managedTreeHash: source.managedTreeHash,
    observedAt: source.observedAt, manifest, entryCount: Object.keys(source.authoredFiles).filter(path => path !== '.academy/identities.json').length,
    snapshot: source.skills.map(skill => {
      const binding = source.canonicalVersions?.[skill.path]
      if (!binding) throw new AcademyError('GIT_SOURCE_VERSION_BINDING_REQUIRED')
      return { skillId: binding.skillId, name: skill.name, academyVersion: binding.version, packageHash: skill.packageHash }
    }).sort((a, b) => a.skillId.localeCompare(b.skillId)) }
}

export class AcademyStore {
  private readonly db: Database.Database
  private ingestingGit = false
  private gitFirstRequired = false
  enforceGitFirst(): void { this.gitFirstRequired = true }
  usesGitFirst(): boolean { return !this.usesLocalAuthority() && (this.gitFirstRequired || Boolean(this.getGitProfile() || this.getGitAuthority())) }

  usesLocalAuthority(): boolean {
    return Boolean((this.db.prepare('SELECT local_authority FROM academy_catalog WHERE id=1').get() as Row).local_authority)
  }

  catalogRevision(): number {
    return (this.db.prepare('SELECT revision FROM academy_catalog WHERE id=1').get() as Row).revision
  }

  readLocalSnapshot<T>(capture: () => T): T { return this.db.transaction(capture).deferred() }

  reserveLocalReleaseInput<T extends { buildFingerprint: string }>(version: string, contentFingerprint: string, input: T): T {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT content_fingerprint,sealed_input_json FROM academy_plugin_package_revisions WHERE version=?').get(version) as Row | undefined
      if (!row || row.content_fingerprint !== contentFingerprint) throw new AcademyError('VERSION_REUSE_FOR_DIFFERENT_CONTENT')
      if (row.sealed_input_json) {
        const existing = JSON.parse(row.sealed_input_json) as T
        if (existing.buildFingerprint !== input.buildFingerprint) throw new AcademyError('VERSION_REUSE_FOR_DIFFERENT_CONTENT')
        return existing
      }
      this.db.prepare('UPDATE academy_plugin_package_revisions SET sealed_input_json=? WHERE version=? AND sealed_input_json IS NULL').run(JSON.stringify(input), version)
      return input
    }).immediate()
  }

  private advanceCatalog(): void { this.db.prepare('UPDATE academy_catalog SET revision=revision+1 WHERE id=1').run() }

  enableLocalAuthority(expectedCommit: string): void {
    this.db.transaction(() => {
      const authority = this.getGitAuthority()
      if (!authority || authority.processedCommitSha !== expectedCommit) throw new AcademyError('GIT_SOURCE_CHANGED')
      this.db.prepare('UPDATE academy_catalog SET local_authority=1 WHERE id=1').run()
      const snapshot = this.getGitSnapshot(authority.repositoryId, expectedCommit)
      if (snapshot?.authoredFiles['plugin.json']) this.adoptAuthoredMetadata(snapshot.authoredFiles)
      for (const source of this.getGitSkillSources()) {
        this.recordEligibility(source.skillId, 'GIT_SOURCE', null, false)
        if (!source.available && !this.isDeleted(source.skillId)) this.deleteGlobalSkill(source.skillId, this.get(source.skillId).currentVersion)
      }
    }).immediate()
  }

  publicationEligibility(skillId: string): 'PRIVATE' | 'APPROVED' {
    return (this.db.prepare('SELECT eligibility FROM academy_publication_eligibility WHERE skill_id=?').get(skillId) as Row | undefined)?.eligibility ?? 'PRIVATE'
  }

  private authoredMetadata(files: Record<string, string>): { manifest: Record<string, any>; logo: string | null } | null {
    if (!files['plugin.json']) return null
    const manifest = JSON.parse(Buffer.from(files['plugin.json'], 'base64').toString('utf8'))
    if (manifest.name !== 'academy-skills' || typeof manifest.description !== 'string' || !manifest.author || !manifest.extensions?.['com.openai']?.interface || typeof manifest.extensions['com.openai'].interface.displayName !== 'string') throw new AcademyError('OPENAI_PLUGIN_INVALID_MANIFEST')
    const logo = files['assets/logo.png'] ?? null
    const openAiInterface = manifest.extensions['com.openai'].interface
    if (logo) {
      const errors: string[] = []
      validatePngLogo(Buffer.from(logo, 'base64'), errors)
      if (errors.length) throw new AcademyError('OPENAI_PLUGIN_LOGO_INVALID', errors.join('; '))
      if ([openAiInterface.logo, openAiInterface.composerIcon].some(value => value !== undefined && value !== './assets/logo.png')) throw new AcademyError('OPENAI_PLUGIN_INVALID_LOGO_PATH')
      openAiInterface.logo = './assets/logo.png'; openAiInterface.composerIcon = './assets/logo.png'
    } else if (openAiInterface.logo || openAiInterface.composerIcon) throw new AcademyError('OPENAI_PLUGIN_LOGO_MISSING')
    delete manifest.version
    return { manifest, logo }
  }

  getAuthoredLogo(): Buffer | null {
    const row = this.db.prepare('SELECT authored_json FROM academy_catalog WHERE id=1').get() as Row
    const value = row.authored_json ? JSON.parse(row.authored_json) : null
    return value?.logo ? Buffer.from(value.logo, 'base64') : null
  }

  localAuthoredMetadata() {
    const profile = this.getOpenAiPluginProfile()
    const row = this.db.prepare('SELECT authored_json FROM academy_catalog WHERE id=1').get() as Row
    const authored = row.authored_json ? JSON.parse(row.authored_json) : null
    if (!profile) return authored as { manifest: Record<string, any>; logo: string | null } | null
    const manifest = buildOpenAiManifest(profile, '0.0.0') as Record<string, any>
    delete manifest.version
    return { manifest: { ...authored?.manifest, ...manifest }, logo: this.getAuthoredLogo()?.toString('base64') ?? null }
  }

  private adoptAuthoredMetadata(files: Record<string, string>): void {
    const value = this.authoredMetadata(files)
    if (!value) return
    const profile = this.getOpenAiPluginProfile()
    if (profile) this.db.prepare('UPDATE academy_openai_plugin_profile SET display_name=?,description=?,author_json=?,interface_json=?,logo_path=?,updated_at=? WHERE id=?').run(
      value.manifest.extensions['com.openai'].interface.displayName, value.manifest.description, JSON.stringify(value.manifest.author),
      JSON.stringify(value.manifest.extensions['com.openai'].interface), value.logo ? 'sqlite:assets/logo.png' : null, new Date().toISOString(), 'academy-skills')
    this.db.prepare('UPDATE academy_catalog SET authored_json=? WHERE id=1').run(JSON.stringify(value))
    this.advanceCatalog()
  }

  hasManifestConflict(): boolean { return Boolean((this.db.prepare('SELECT metadata_conflict_json FROM academy_catalog WHERE id=1').get() as Row).metadata_conflict_json) }

  reviewManifestConflict() {
    const row = this.db.prepare('SELECT metadata_conflict_json FROM academy_catalog WHERE id=1').get() as Row
    if (!row.metadata_conflict_json) throw new AcademyError('GIT_MANIFEST_CONFLICT_NOT_FOUND')
    const context = JSON.parse(row.metadata_conflict_json)
    return { ...context, current: this.localAuthoredMetadata(), token: sha256(canonicalJson([context, this.localAuthoredMetadata(), this.getGitAuthority()])) }
  }

  resolveManifestConflict(token: string, choice: 'LOCAL' | 'REMOTE', confirmed: boolean): void {
    this.db.transaction(() => {
      const review = this.reviewManifestConflict()
      if (!confirmed || review.token !== token || !['LOCAL', 'REMOTE'].includes(choice)) throw new AcademyError('CONFLICT_STATE_CHANGED')
      if (choice === 'REMOTE') this.adoptAuthoredMetadata(review.remoteFiles)
      this.db.prepare('UPDATE academy_catalog SET metadata_conflict_json=NULL WHERE id=1').run()
    }).immediate()
  }

  isDeleted(skillId: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM academy_tombstones WHERE skill_id=?').get(skillId)) }

  deleteGlobalSkill(skillId: string, expectedVersion: number): void {
    if (!this.usesLocalAuthority()) throw new AcademyError('ACADEMY_CUTOVER_PENDING')
    this.db.transaction(() => {
      const skill = this.get(skillId)
      if (skill.scope !== 'GLOBAL') throw new AcademyError('GLOBAL_SKILL_REQUIRED')
      if (skill.currentVersion !== expectedVersion) throw new AcademyError('VERSION_CONFLICT')
      if (this.isDeleted(skillId)) return
      this.advanceCatalog()
      this.db.prepare('INSERT INTO academy_tombstones VALUES(?,?,?,?)').run(skillId, `skills/${skill.name}`, skill.current.packageHash, this.catalogRevision())
      const now = new Date().toISOString(), nextVersion = skill.currentVersion + 1
      this.insertVersion(skillId, nextVersion, skill.current.package, skill.current.packageHash, this.ingestingGit ? 'GIT' : 'UI', now)
      this.db.prepare("UPDATE academy_versions SET content_state='DELETED' WHERE skill_id=? AND version=?").run(skillId, nextVersion)
      this.db.prepare('UPDATE academy_skills SET current_version=?,updated_at=? WHERE id=?').run(nextVersion, now, skillId)
    }).immediate()
  }

  restoreDeletedGlobalSkill(skillId: string, expectedVersion: number, pkg?: AcademyPackage): AcademySkillDetail {
    return this.db.transaction(() => {
      const skill = this.get(skillId)
      if (skill.scope !== 'GLOBAL' || skill.currentVersion !== expectedVersion || !this.isDeleted(skillId)) throw new AcademyError('VERSION_CONFLICT')
      const value = normalizeAcademyPackage(pkg ?? skill.current.package)
      const metadata = parseSkillMetadata(value.skillMd), now = new Date().toISOString(), version = expectedVersion + 1
      this.insertVersion(skillId, version, value, hashAcademyPackage(value), this.ingestingGit ? 'GIT' : 'UI', now)
      this.db.prepare('UPDATE academy_skills SET name=?,description=?,current_version=?,updated_at=? WHERE id=?').run(metadata.name, metadata.description, version, now, skillId)
      this.db.prepare('DELETE FROM academy_tombstones WHERE skill_id=?').run(skillId)
      this.advanceCatalog()
      return this.get(skillId)
    }).immediate()
  }

  localIdentityCatalog(): AcademyIdentityCatalog {
    const skills: AcademyIdentityCatalog['skills'] = this.list().filter(skill => skill.scope === 'GLOBAL' && this.publicationEligibility(skill.id) === 'APPROVED' && !this.isDeleted(skill.id))
      .map(skill => ({ skillId: skill.id, path: `skills/${skill.name}`, state: 'PRESENT' }))
    for (const row of this.db.prepare('SELECT * FROM academy_tombstones ORDER BY skill_id').all() as Row[]) {
      if (this.publicationEligibility(row.skill_id) === 'APPROVED') skills.push({ skillId: row.skill_id, path: row.path, state: 'REMOVED', baseHash: row.base_hash, revision: row.revision })
    }
    const catalog: AcademyIdentityCatalog = { schema: 2, skills: skills.sort((a, b) => a.skillId.localeCompare(b.skillId)) }
    return validateAcademyIdentities(catalog, skills.filter(skill => skill.state === 'PRESENT').map(skill => skill.path))
  }

  replicatedFingerprint(catalog = this.localIdentityCatalog()): string {
    return sha256(canonicalJson({ skills: catalog.skills.map(entry => ({ ...entry, hash: entry.state === 'PRESENT' ? this.get(entry.skillId).current.packageHash : null })), metadata: this.localAuthoredMetadata() }))
  }

  getConvergenceCheckpoint(): { revision: number; fingerprint: string; repositoryId: string; branch: string; commit: string; managedTreeHash: string; confirmedAt: string } | null {
    const row = this.db.prepare('SELECT state_json FROM academy_convergence_checkpoint WHERE id=1').get() as Row | undefined
    return row ? JSON.parse(row.state_json) : null
  }

  confirmConvergence(snapshot: AcademyGitSourceSnapshot): boolean {
    return this.db.transaction(() => {
      const authority = this.getGitAuthority()
      if (!authority || authority.repositoryId !== snapshot.repositoryId || authority.branch !== snapshot.branch || authority.remoteUrl !== snapshot.remoteUrl || authority.processedCommitSha !== snapshot.sourceCommitSha) return false
      if (!snapshot.identities || this.hasManifestConflict() || this.listConflicts().some(conflict => conflict.origin === 'GIT')) return false
      if (canonicalJson(this.authoredMetadata(snapshot.authoredFiles)) !== canonicalJson(this.localAuthoredMetadata())) return false
      const profile = this.getOpenAiPluginProfile()
      if (profile && snapshot.authoredFiles['plugin.json'] && JSON.parse(Buffer.from(snapshot.authoredFiles['plugin.json'], 'base64').toString('utf8')).version !== (this.getCurrentPluginPackageRevision()?.version ?? profile.publishedVersion)) return false
      const remoteCatalog = { ...snapshot.identities, skills: [...snapshot.identities.skills].sort((a, b) => a.skillId.localeCompare(b.skillId)) }
      if (canonicalJson(remoteCatalog) !== canonicalJson(this.localIdentityCatalog())) return false
      for (const skill of snapshot.skills) {
        const entry = snapshot.identities.skills.find(entry => entry.path === skill.path && entry.state === 'PRESENT')
        if (!entry || this.get(entry.skillId).current.packageHash !== skill.packageHash) return false
      }
      const checkpoint = { revision: this.catalogRevision(), fingerprint: this.replicatedFingerprint(), repositoryId: snapshot.repositoryId,
        branch: snapshot.branch, commit: snapshot.sourceCommitSha, managedTreeHash: snapshot.managedTreeHash, confirmedAt: snapshot.observedAt }
      this.db.prepare('INSERT INTO academy_convergence_checkpoint VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json').run(JSON.stringify(checkpoint))
      return true
    }).immediate()
  }

  private recordGitConflict(detail: AcademySkillDetail, snapshot: AcademyGitSourceSnapshot, path: string, base: AcademyPackage | null, remote: AcademyPackage | null): void {
    const conflict = this.createConflict(detail.id, 'GIT', null, remote, remote ? hashAcademyPackage(remote) : 'DELETED', null, path)
    this.db.prepare('INSERT OR IGNORE INTO academy_git_conflict_context VALUES(?,?)').run(conflict.id, JSON.stringify({
      repositoryId: snapshot.repositoryId, branch: snapshot.branch, commit: snapshot.sourceCommitSha, revision: this.catalogRevision(),
      localVersion: detail.currentVersion, local: detail.current.package, base, remote, path, localDeleted: this.isDeleted(detail.id)
    }))
  }

  reviewLocalGitConflict(id: string) {
    const conflict = this.getConflict(id)
    const row = this.db.prepare('SELECT context_json FROM academy_git_conflict_context WHERE conflict_id=?').get(id) as Row | undefined
    if (!row || conflict.status !== 'OPEN') throw new AcademyError('GIT_CONFLICT_NOT_FOUND')
    const context = JSON.parse(row.context_json)
    const current = this.get(conflict.skillId)
    const token = sha256(canonicalJson({ context, current: current.current, deleted: this.isDeleted(current.id), head: this.getGitAuthority()?.processedCommitSha }))
    return { conflict, context, current, token }
  }

  resolveLocalGitConflict(id: string, token: string, choice: 'LOCAL' | 'REMOTE', confirmed: boolean) {
    return this.db.transaction(() => {
      const review = this.reviewLocalGitConflict(id)
      if (!confirmed || token !== review.token || !['LOCAL', 'REMOTE'].includes(choice)) throw new AcademyError('CONFLICT_STATE_CHANGED')
      if (choice === 'REMOTE') {
        if (review.conflict.divergentPackage) {
          if (this.isDeleted(review.current.id)) this.restoreDeletedGlobalSkill(review.current.id, review.current.currentVersion, review.conflict.divergentPackage)
          else this.update({ skillId: review.current.id, expectedVersion: review.current.currentVersion, package: review.conflict.divergentPackage, origin: 'GIT' })
        } else this.deleteGlobalSkill(review.current.id, review.current.currentVersion)
      }
      this.resolveConflict(id)
      return this.get(review.current.id)
    }).immediate()
  }

  approvePublicSkill(skillId: string, expectedVersion: number): AcademySkillDetail {
    this.db.transaction(() => {
      const skill = this.get(skillId)
      if (skill.currentVersion !== expectedVersion) throw new AcademyError('VERSION_CONFLICT')
      if (skill.scope !== 'GLOBAL') throw new AcademyError('GLOBAL_SKILL_REQUIRED')
      if (this.publicationEligibility(skillId) === 'APPROVED') return
      this.recordEligibility(skillId, 'MANUAL', null, true)
      this.advanceCatalog()
    }).immediate()
    return this.get(skillId)
  }

  approvePublicSkills(items: Array<{ skillId: string; expectedVersion: number }>): AcademySkillDetail[] {
    if (!items.length || new Set(items.map(item => item.skillId)).size !== items.length) throw new AcademyError('INVALID_ARGUMENT')
    this.db.transaction(() => {
      for (const { skillId, expectedVersion } of items) {
        const skill = this.get(skillId)
        if (skill.currentVersion !== expectedVersion) throw new AcademyError('VERSION_CONFLICT', 'Skill changed since it was reviewed', { skillId })
        if (skill.scope !== 'GLOBAL') throw new AcademyError('GLOBAL_SKILL_REQUIRED')
        if (this.isDeleted(skillId)) throw new AcademyError('SKILL_DELETED_RECONCILIATION_REQUIRED')
        if (this.publicationEligibility(skillId) !== 'APPROVED') this.recordEligibility(skillId, 'MANUAL', null, true)
      }
      this.advanceCatalog()
    }).immediate()
    return items.map(item => this.get(item.skillId))
  }

  private recordEligibility(skillId: string, source: 'MANUAL' | 'AUTO_PREFERENCE' | 'GIT_SOURCE', preferenceRevision: number | null, replace: boolean): void {
    this.db.prepare(`INSERT INTO academy_publication_eligibility(skill_id,eligibility,source,preference_revision,decided_at) VALUES(?,'APPROVED',?,?,?)
      ON CONFLICT(skill_id) DO ${replace ? "UPDATE SET eligibility='APPROVED',source=excluded.source,preference_revision=excluded.preference_revision,decided_at=excluded.decided_at" : 'NOTHING'}`)
      .run(skillId, source, preferenceRevision, new Date().toISOString())
  }

  publicationSource(skillId: string): AcademyPublicationSource | null {
    const row = this.db.prepare("SELECT source FROM academy_publication_eligibility WHERE skill_id=? AND eligibility='APPROVED'").get(skillId) as Row | undefined
    return row ? row.source ?? 'LEGACY' : null
  }

  getPublicationPreference(): AcademyPublicationPreference {
    const row = this.db.prepare('SELECT * FROM academy_publication_preference WHERE id=1').get() as Row | undefined
    return { autoIncludeGlobal: Boolean(row?.auto_include_global), revision: row?.revision ?? 0, authority: row?.authority ?? null, consentVersion: row?.consent_version ?? null, updatedAt: row?.updated_at ?? null }
  }

  setPublicationPreference(enabled: boolean, authority: 'ELECTRON_OPERATOR', consentVersion: string): AcademyPublicationPreference {
    this.db.transaction(() => {
      const current = this.getPublicationPreference()
      if (current.autoIncludeGlobal === enabled) return
      const revision = current.revision + 1, now = new Date().toISOString()
      this.db.prepare(`INSERT INTO academy_publication_preference(id,auto_include_global,revision,authority,consent_version,updated_at) VALUES(1,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET auto_include_global=excluded.auto_include_global,revision=excluded.revision,authority=excluded.authority,consent_version=excluded.consent_version,updated_at=excluded.updated_at`).run(enabled ? 1 : 0, revision, authority, consentVersion, now)
      this.db.prepare('INSERT INTO academy_publication_preference_log(revision,auto_include_global,authority,consent_version,decided_at) VALUES(?,?,?,?,?)').run(revision, enabled ? 1 : 0, authority, consentVersion, now)
    }).immediate()
    return this.getPublicationPreference()
  }

  listPublicationPreferenceLog(): Array<{ revision: number; autoIncludeGlobal: boolean; authority: string; consentVersion: string; decidedAt: string }> {
    return (this.db.prepare('SELECT * FROM academy_publication_preference_log ORDER BY revision').all() as Row[])
      .map(row => ({ revision: row.revision, autoIncludeGlobal: Boolean(row.auto_include_global), authority: row.authority, consentVersion: row.consent_version, decidedAt: row.decided_at }))
  }

  constructor(readonly databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new Database(databasePath)
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('journal_mode = WAL')
    try { this.migrateActivation() } catch (error) { this.db.close(); throw error }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS academy_skills (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE','DISABLED')),
        scope TEXT NOT NULL CHECK(scope IN ('GLOBAL','PROJECT')),
        current_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        state_revision INTEGER NOT NULL DEFAULT 1 CHECK(state_revision >= 1)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS academy_skill_name ON academy_skills(lower(name));
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
        target TEXT NOT NULL CHECK(target IN ('FILESYSTEM_NATIVE','CLAUDE_CODE','ANTIGRAVITY')),
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
      CREATE TABLE IF NOT EXISTS academy_openai_git_builds (
        id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES academy_openai_plugin_releases(id), receipt_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS academy_openai_git_builds_release ON academy_openai_git_builds(release_id);
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
      CREATE TABLE IF NOT EXISTS academy_git_publication (
        destination_key TEXT PRIMARY KEY, state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS academy_git_authority (
        id INTEGER PRIMARY KEY CHECK(id=1), state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS academy_git_snapshots (
        repository_id TEXT NOT NULL, commit_sha TEXT NOT NULL, snapshot_json TEXT NOT NULL,
        PRIMARY KEY(repository_id, commit_sha)
      );
      CREATE TABLE IF NOT EXISTS academy_git_skill_sources (
        repository_id TEXT NOT NULL, path TEXT NOT NULL,
        skill_id TEXT NOT NULL UNIQUE REFERENCES academy_skills(id),
        legacy_baseline_version INTEGER NOT NULL, source_commit_sha TEXT NOT NULL,
        available INTEGER NOT NULL,
        PRIMARY KEY(repository_id, path)
      );
      CREATE TABLE IF NOT EXISTS academy_git_version_sources (
        skill_id TEXT NOT NULL, version INTEGER NOT NULL, commit_sha TEXT NOT NULL,
        managed_tree_hash TEXT NOT NULL, package_hash TEXT NOT NULL,
        PRIMARY KEY(skill_id, version),
        FOREIGN KEY(skill_id,version) REFERENCES academy_versions(skill_id,version)
      );
    `)
    this.migrateDistributionTargets()
    const projectionColumns = this.db.prepare('PRAGMA table_info(academy_projections)').all() as Row[]
    if (!projectionColumns.some((column) => column.name === 'skill_name')) this.db.exec('ALTER TABLE academy_projections ADD COLUMN skill_name TEXT')
    const snapshotColumns = this.db.prepare('PRAGMA table_info(academy_git_snapshots)').all() as Row[]
    for (const column of ['header_json', 'build_projection_json']) if (!snapshotColumns.some(item => item.name === column)) this.db.exec(`ALTER TABLE academy_git_snapshots ADD COLUMN ${column} TEXT`)
    if (!(this.db.prepare('PRAGMA table_info(academy_plugin_package_revisions)').all() as Row[]).some(column => column.name === 'sealed_input_json')) this.db.exec('ALTER TABLE academy_plugin_package_revisions ADD COLUMN sealed_input_json TEXT')
    if (!(this.db.prepare('PRAGMA table_info(academy_versions)').all() as Row[]).some(column => column.name === 'content_state')) this.db.exec("ALTER TABLE academy_versions ADD COLUMN content_state TEXT NOT NULL DEFAULT 'PRESENT' CHECK(content_state IN ('PRESENT','DELETED'))")
    this.db.exec("CREATE INDEX IF NOT EXISTS academy_git_build_source ON academy_openai_git_builds(json_extract(receipt_json,'$.sourceRepositoryId'),json_extract(receipt_json,'$.sourceCommitSha'),json_extract(receipt_json,'$.buildSchema'))")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS academy_catalog (
        id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0,
        local_authority INTEGER NOT NULL DEFAULT 0 CHECK(local_authority IN (0,1))
      );
      INSERT OR IGNORE INTO academy_catalog(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS academy_publication_eligibility (
        skill_id TEXT PRIMARY KEY REFERENCES academy_skills(id),
        eligibility TEXT NOT NULL CHECK(eligibility IN ('PRIVATE','APPROVED'))
      );
      CREATE TABLE IF NOT EXISTS academy_publication_preference (
        id INTEGER PRIMARY KEY CHECK(id=1), auto_include_global INTEGER NOT NULL CHECK(auto_include_global IN (0,1)),
        revision INTEGER NOT NULL, authority TEXT NOT NULL, consent_version TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS academy_publication_preference_log (
        revision INTEGER PRIMARY KEY, auto_include_global INTEGER NOT NULL, authority TEXT NOT NULL,
        consent_version TEXT NOT NULL, decided_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS academy_tombstones (
        skill_id TEXT PRIMARY KEY REFERENCES academy_skills(id), path TEXT NOT NULL,
        base_hash TEXT NOT NULL, revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS academy_convergence_checkpoint (
        id INTEGER PRIMARY KEY CHECK(id=1), state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS academy_git_conflict_context (
        conflict_id TEXT PRIMARY KEY REFERENCES academy_conflicts(id), context_json TEXT NOT NULL
      );
    `)
    const catalogColumns = this.db.prepare('PRAGMA table_info(academy_catalog)').all() as Row[]
    for (const column of ['authored_json', 'metadata_conflict_json']) if (!catalogColumns.some(item => item.name === column)) this.db.exec(`ALTER TABLE academy_catalog ADD COLUMN ${column} TEXT`)
    const eligibilityColumns = this.db.prepare('PRAGMA table_info(academy_publication_eligibility)').all() as Row[]
    for (const [column, type] of [['source', 'TEXT'], ['preference_revision', 'INTEGER'], ['decided_at', 'TEXT']]) if (!eligibilityColumns.some(item => item.name === column)) this.db.exec(`ALTER TABLE academy_publication_eligibility ADD COLUMN ${column} ${type}`)
  }

  private migrateDistributionTargets(): void {
    const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='academy_distribution_states'").get() as Row
    if (schema.sql.includes("'ANTIGRAVITY'")) return
    const indexes = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='academy_distribution_states' AND sql IS NOT NULL").all() as Row[]
    this.db.transaction(() => {
      this.db.exec(schema.sql.replace('academy_distribution_states', 'academy_distribution_states_migration').replace("'FILESYSTEM_NATIVE','CLAUDE_CODE'", "'FILESYSTEM_NATIVE','CLAUDE_CODE','ANTIGRAVITY'"))
      this.db.exec(`
        INSERT INTO academy_distribution_states_migration SELECT * FROM academy_distribution_states;
        DROP TABLE academy_distribution_states;
        ALTER TABLE academy_distribution_states_migration RENAME TO academy_distribution_states;
      `)
      for (const index of indexes) this.db.exec(index.sql)
      if ((this.db.pragma('foreign_key_check') as Row[]).length) throw new Error('ACADEMY_DISTRIBUTION_MIGRATION_INTEGRITY')
    })()
  }

  private migrateActivation(): void {
    const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='academy_skills'").get() as Row | undefined
    if (!schema || !schema.sql.includes("'ARCHIVED'")) return
    this.db.pragma('foreign_keys = OFF')
    try {
      this.db.transaction(() => {
        const currentSchema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='academy_skills'").get() as Row
        if (!currentSchema.sql.includes("'ARCHIVED'")) return
        const collisions = this.db.prepare('SELECT id, name FROM academy_skills WHERE lower(name) IN (SELECT lower(name) FROM academy_skills GROUP BY lower(name) HAVING count(*) > 1) ORDER BY lower(name), id').all()
        if (collisions.length) throw new AcademyError('ACADEMY_NAME_MIGRATION_CONFLICT', 'Resolve duplicate names explicitly by operator before retrying migration; no records were changed.', { skills: collisions })
        const indexes = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='academy_skills' AND sql IS NOT NULL AND name <> 'academy_active_name'").all() as Row[]
        this.db.exec(`
          CREATE TABLE academy_skills_activation (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('ACTIVE','DISABLED')),
            scope TEXT NOT NULL CHECK(scope IN ('GLOBAL','PROJECT')),
            current_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            state_revision INTEGER NOT NULL DEFAULT 1 CHECK(state_revision >= 1)
          );
          INSERT INTO academy_skills_activation SELECT id,name,description,CASE status WHEN 'ARCHIVED' THEN 'DISABLED' ELSE status END,scope,current_version,created_at,updated_at,1 FROM academy_skills;
          DROP TABLE academy_skills;
          ALTER TABLE academy_skills_activation RENAME TO academy_skills;
          CREATE UNIQUE INDEX academy_skill_name ON academy_skills(lower(name));
        `)
        for (const index of indexes) this.db.exec(index.sql)
        if ((this.db.pragma('foreign_key_check') as Row[]).length) throw new AcademyError('ACADEMY_ACTIVATION_MIGRATION_INTEGRITY')
      }).immediate()
    } finally { this.db.pragma('foreign_keys = ON') }
  }

  get isClosed(): boolean { return !this.db.open }

  close(): void {
    if (this.db.open) {
      this.db.close()
    }
  }

  create(input: AcademyCreateInput, importedId?: string): AcademySkillDetail {
    if (importedId && !this.ingestingGit) throw new AcademyError('GIT_IMPORT_REQUIRED')
    if (input.scope === 'GLOBAL' && this.usesGitFirst() && !this.ingestingGit) throw new AcademyError('ACADEMY_CUTOVER_PENDING')
    const pkg = normalizeAcademyPackage(input.package)
    const metadata = parseSkillMetadata(pkg.skillMd)
    const id = importedId ?? randomUUID()
    const now = new Date().toISOString()
    const hash = hashAcademyPackage(pkg)
    try {
      this.db.transaction(() => {
        this.db.prepare('INSERT INTO academy_skills(id,name,description,status,scope,current_version,created_at,updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(id, metadata.name, metadata.description, 'ACTIVE', input.scope, now, now)
        this.insertVersion(id, 1, pkg, hash, input.origin, now)
        this.replaceProjects(id, input.projectIds ?? [])
        if (input.scope === 'GLOBAL') {
          this.advanceCatalog()
          const preference = this.getPublicationPreference()
          if (!importedId && !input.keepPrivate && preference.autoIncludeGlobal && (input.origin === 'UI' || input.origin === 'MCP')) this.recordEligibility(id, 'AUTO_PREFERENCE', preference.revision, true)
        }
      })()
    } catch (error: any) {
      if (String(error?.message).includes('academy_skill_name')) throw new AcademyError('DUPLICATE_SKILL_NAME', `Canonical skill already exists: ${metadata.name}`)
      throw error
    }
    return this.get(id)
  }

  update(input: AcademyUpdateInput): AcademySkillDetail {
    if ((input.scope === 'GLOBAL' || this.get(input.skillId).scope === 'GLOBAL') && this.usesGitFirst() && !this.ingestingGit) throw new AcademyError('ACADEMY_CUTOVER_PENDING')
    const pkg = normalizeAcademyPackage(input.package)
    const metadata = parseSkillMetadata(pkg.skillMd)
    const now = new Date().toISOString()
    try {
      this.db.transaction(() => {
        const row = this.skillRow(input.skillId)
        if (this.isDeleted(input.skillId)) throw new AcademyError('SKILL_DELETED_RECONCILIATION_REQUIRED')
        if (row.current_version !== input.expectedVersion) throw new AcademyError('VERSION_CONFLICT', 'Skill changed since it was read', { expectedVersion: input.expectedVersion, currentVersion: row.current_version })
        const hash = hashAcademyPackage(pkg)
        const samePackage = this.getVersion(input.skillId, row.current_version).packageHash === hash
        const sameScope = (input.scope ?? row.scope) === row.scope
        if (!sameScope && row.scope === 'GLOBAL' && this.publicationEligibility(input.skillId) === 'APPROVED') throw new AcademyError('GIT_SCOPE_CHANGE_REQUIRES_REVIEW')
        if (samePackage && sameScope) {
          if (input.projectIds) this.replaceProjects(input.skillId, input.projectIds)
          return
        }
        const version = row.current_version + 1
        this.db.prepare('UPDATE academy_skills SET name=?, description=?, scope=?, current_version=?, updated_at=? WHERE id=?').run(metadata.name, metadata.description, input.scope ?? row.scope, version, now, input.skillId)
        this.insertVersion(input.skillId, version, pkg, hash, input.origin, now)
        if (input.projectIds) this.replaceProjects(input.skillId, input.projectIds)
        if (!sameScope) this.db.prepare('DELETE FROM academy_publication_eligibility WHERE skill_id=?').run(input.skillId)
        if (row.scope === 'GLOBAL' || input.scope === 'GLOBAL') this.advanceCatalog()
      })()
    } catch (error: any) {
      if (String(error?.message).includes('academy_skill_name')) throw new AcademyError('DUPLICATE_SKILL_NAME', `Canonical skill already exists: ${metadata.name}`)
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
    const row = this.db.prepare('SELECT id FROM academy_skills WHERE lower(name)=lower(?)').get(name) as Row | undefined
    return row ? this.get(row.id) : null
  }

  get(id: string): AcademySkillDetail {
    const row = this.skillRow(id)
    return { ...this.summary(row), current: this.getVersion(id, row.current_version) }
  }

  history(id: string): AcademySkillVersion[]
  history(id: string, options: { metadataOnly: true }): AcademySkillVersionMetadata[]
  history(id: string, options: { version: number }): AcademySkillVersion
  history(id: string, options: AcademyHistoryOptions): AcademyHistoryResult
  history(id: string, options: AcademyHistoryOptions = {}): AcademyHistoryResult {
    this.skillRow(id)
    if (options.version !== undefined) return this.getVersion(id, options.version)
    if (options.metadataOnly) {
      return (this.db.prepare('SELECT skill_id, version, package_hash, origin, created_at, content_state FROM academy_versions WHERE skill_id=? ORDER BY version DESC').all(id) as Row[])
        .map(row => this.withGitSource({ skillId: row.skill_id, version: row.version, packageHash: row.package_hash, origin: row.origin, createdAt: row.created_at, ...(row.content_state === 'DELETED' ? { contentState: 'DELETED' as const } : {}) }))
    }
    return (this.db.prepare('SELECT * FROM academy_versions WHERE skill_id=? ORDER BY version DESC').all(id) as Row[]).map(row => this.withGitSource(versionFromRow(row)))
  }

  readImpactCatalog(skillId: string, baseVersion: number, targetVersion?: number) {
    return this.db.transaction(() => ({
      source: this.get(skillId),
      base: this.getVersion(skillId, baseVersion),
      target: targetVersion === undefined ? undefined : this.getVersion(skillId, targetVersion),
      skills: this.list('ACTIVE').map(skill => this.get(skill.id)),
      destinations: this.listDestinations().map(({ id, enabled }) => ({ id, enabled }))
    }))()
  }

  archive(id: string, expectedVersion: number): AcademySkillDetail {
    return this.setLegacyEnabled(id, expectedVersion, false)
  }

  restore(id: string, expectedVersion: number): AcademySkillDetail {
    return this.setLegacyEnabled(id, expectedVersion, true)
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
    this.db.transaction(() => {
      const profile = this.getOpenAiPluginProfile()
      if (!profile) throw new AcademyError('OPENAI_PLUGIN_PROFILE_MISSING')
      if (canonicalJson(profile.openAiInterface) === canonicalJson(openAiInterface)) return
      this.db.prepare('UPDATE academy_openai_plugin_profile SET interface_json=?, updated_at=? WHERE id=?')
        .run(JSON.stringify(openAiInterface), new Date().toISOString(), 'academy-skills')
      if (this.usesLocalAuthority()) this.advanceCatalog()
    }).immediate()
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
    return this.withGitBuildSource(openAiReleaseFromRow(row))
  }

  listOpenAiReleases(): AcademyOpenAiRelease[] {
    return (this.db.prepare('SELECT * FROM academy_openai_plugin_releases ORDER BY created_at DESC, rowid DESC').all() as Row[]).map(row => this.withGitBuildSource(openAiReleaseFromRow(row)))
  }

  private withGitBuildSource(release: AcademyOpenAiRelease): AcademyOpenAiRelease {
    const local = this.db.prepare('SELECT content_fingerprint,sealed_input_json FROM academy_plugin_package_revisions WHERE version=?').get(release.pluginVersion) as Row | undefined
    if (local?.sealed_input_json && local.content_fingerprint === release.snapshotHash) {
      const input = JSON.parse(local.sealed_input_json)
      return { ...release, localSource: { snapshotId: input.buildFingerprint, contentFingerprint: local.content_fingerprint,
        statementPath: release.artifactPath ? join(dirname(release.artifactPath), 'statement.intoto.json') : null, gitConfirmation: 'UNVERIFIED' } }
    }
    const row = this.db.prepare('SELECT receipt_json FROM academy_openai_git_builds WHERE release_id=? ORDER BY rowid DESC LIMIT 1').get(release.id) as Row | undefined
    return row ? { ...release, source: JSON.parse(row.receipt_json) } : release
  }

  listGitBuildReceipts(releaseId: string): import('../../shared/types/academy-git-source-types').AcademyGitBuildReceipt[] {
    return (this.db.prepare('SELECT receipt_json FROM academy_openai_git_builds WHERE release_id=? ORDER BY rowid').all(releaseId) as Row[]).map(row => JSON.parse(row.receipt_json))
  }

  persistGitBuild(release: AcademyOpenAiRelease, receipt: import('../../shared/types/academy-git-source-types').AcademyGitBuildReceipt, revision?: AcademyPluginPackageRevision): AcademyOpenAiRelease {
    return this.db.transaction(() => {
      if (revision && !this.getPluginPackageRevisionByFingerprint(revision.contentFingerprint)) this.insertPluginPackageRevision(revision, release.snapshot)
      const existing = this.db.prepare('SELECT id FROM academy_openai_plugin_releases WHERE id=?').get(release.id)
      if (!existing) this.insertOpenAiRelease(release)
      else if (this.getOpenAiRelease(release.id).status === 'BLOCKED' && release.artifactPath && release.artifactHash && release.manifest) {
        this.materializeBlockedOpenAiRelease(release.id, { manifest: release.manifest, artifactPath: release.artifactPath, artifactHash: release.artifactHash, status: release.status === 'STALE' ? 'STALE' : 'READY_TO_UPLOAD' })
      }
      if (existing && release.status === 'STALE' && this.getOpenAiRelease(release.id).status === 'READY_TO_UPLOAD') this.transitionOpenAiRelease(release.id, ['READY_TO_UPLOAD'], 'STALE')
      this.db.prepare('INSERT OR IGNORE INTO academy_openai_git_builds VALUES (?,?,?)').run(receipt.id, release.id, JSON.stringify(receipt))
      return { ...this.getOpenAiRelease(release.id), source: receipt }
    }).immediate()
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

  revokeOpenAiReleaseUpload(id: string): AcademyOpenAiRelease {
    return this.db.transaction(() => {
      const release = this.getOpenAiRelease(id)
      if (release.status === 'READY_TO_UPLOAD' || release.status === 'STALE') return release
      if (release.status !== 'UPLOADED_UNVERIFIED' || release.baseline) {
        throw new AcademyError('OPENAI_RELEASE_INVALID_STATE', `${release.status} cannot revoke upload confirmation`)
      }
      this.db.prepare("UPDATE academy_openai_plugin_releases SET status='READY_TO_UPLOAD', upload_confirmation_json=NULL WHERE id=?").run(id)
      const prior = this.db.prepare(`
        SELECT * FROM academy_openai_plugin_releases
        WHERE id<>? AND (status IN ('UPLOADED_UNVERIFIED','VERIFIED','SUPERSEDED') OR baseline=1)
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `).get(id) as Row | undefined
      if (prior) {
        if (prior.status === 'SUPERSEDED') {
          const restoredStatus: AcademyOpenAiReleaseStatus = prior.baseline
            ? 'UPLOADED_UNVERIFIED'
            : prior.verification_evidence
              ? 'VERIFIED'
              : 'UPLOADED_UNVERIFIED'
          this.db.prepare('UPDATE academy_openai_plugin_releases SET status=? WHERE id=?').run(restoredStatus, prior.id)
        }
        if (this.getOpenAiPluginProfile()) {
          this.db.prepare('UPDATE academy_openai_plugin_profile SET published_version=?, updated_at=? WHERE id=?')
            .run(prior.plugin_version, new Date().toISOString(), 'academy-skills')
        }
      }
      return this.getOpenAiRelease(id)
    }).immediate()
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

  getGitPublication(destinationKey: string): AcademyGitPublicationState | null {
    const row = this.db.prepare('SELECT state_json FROM academy_git_publication WHERE destination_key=?').get(destinationKey) as Row | undefined
    return row ? JSON.parse(row.state_json) : null
  }

  saveGitPublication(state: AcademyGitPublicationState): void {
    this.db.prepare('INSERT INTO academy_git_publication VALUES (?, ?) ON CONFLICT(destination_key) DO UPDATE SET state_json=excluded.state_json').run(state.destinationKey, JSON.stringify(state))
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
    if (this.isDeleted(skillId)) return false
    if (!this.usesLocalAuthority() && skill.scope === 'GLOBAL' && this.getGitAuthority() && !this.getGitSkillSources().some(source => source.skillId === skillId && source.available)) return false
    return skill.scope === 'GLOBAL' || Boolean(this.db.prepare('SELECT 1 FROM academy_skill_projects WHERE skill_id=? AND destination_id=?').get(skillId, destinationId))
  }

  createConflict(skillId: string, origin: AcademyVersionOrigin, baseVersion: number | null, pkg: AcademyPackage | null, divergentHash: string, projectId: string | null, projectionPath: string | null): AcademyConflict {
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM academy_conflicts WHERE status='OPEN' AND skill_id=? AND origin=? AND project_id IS ? AND projection_path IS ? AND divergent_hash=? ORDER BY rowid LIMIT 1").get(skillId, origin, projectId, projectionPath, divergentHash) as Row | undefined
      if (existing) return this.getConflict(existing.id)
      const id = randomUUID()
      const current = this.skillRow(skillId)
      this.db.prepare('INSERT INTO academy_conflicts VALUES(?,?,?,?,?,?,?,?,?,\'OPEN\',?,NULL)').run(id, skillId, origin, baseVersion, current.current_version, pkg ? JSON.stringify(normalizeAcademyPackage(pkg)) : null, divergentHash, projectId, projectionPath, new Date().toISOString())
      return this.getConflict(id)
    }).immediate()
  }

  listConflicts(): AcademyConflict[] {
    return this.conflictRows(true).map(conflictFromRow)
  }

  conflictSummaries(): import('../../shared/types/academy-types').AcademyConflictSummary[] {
    return this.conflictRows(false).map((row) => {
      const { divergentPackage: _package, ...conflict } = conflictFromRow(row)
      const version = this.db.prepare('SELECT version FROM academy_versions WHERE skill_id=? AND package_hash=? ORDER BY version DESC LIMIT 1').get(row.skill_id, row.divergent_hash) as Row | undefined
      const historicalVersion = version?.version ?? null
      return { ...conflict, hasDivergentPackage: Boolean(row.has_package), historicalVersion, occurrenceCount: row.occurrences,
        cause: row.divergent_hash === 'DELETED' || row.divergent_hash.includes('SKILL.md not found') || row.divergent_hash.startsWith('INVALID:SKILL_MD_MISSING') ? 'MISSING' : row.divergent_hash.startsWith('INVALID:') ? 'INVALID' : historicalVersion !== null ? 'HISTORICAL' : 'DIVERGENT' }
    })
  }

  private conflictRows(includePackages: boolean): Row[] {
    return this.db.prepare(`SELECT c.id,c.skill_id,c.origin,c.base_version,s.current_version,c.divergent_hash,c.project_id,c.projection_path,c.status,c.created_at,c.resolved_at,s.name skill_name,
      ${includePackages ? 'c.divergent_package_json' : 'NULL divergent_package_json'}, c.divergent_package_json IS NOT NULL has_package,
      (SELECT count(*) FROM academy_conflicts x WHERE x.status='OPEN' AND x.skill_id=c.skill_id AND x.origin=c.origin AND x.project_id IS c.project_id AND x.projection_path IS c.projection_path AND x.divergent_hash=c.divergent_hash) occurrences
      FROM academy_conflicts c JOIN academy_skills s ON s.id=c.skill_id WHERE c.status='OPEN' AND NOT EXISTS
      (SELECT 1 FROM academy_conflicts x WHERE x.status='OPEN' AND x.rowid<c.rowid AND x.skill_id=c.skill_id AND x.origin=c.origin AND x.project_id IS c.project_id AND x.projection_path IS c.projection_path AND x.divergent_hash=c.divergent_hash)
      ORDER BY c.created_at DESC`).all() as Row[]
  }

  resolveConflict(id: string): void {
    const conflict = this.getConflict(id)
    const result = this.db.prepare("UPDATE academy_conflicts SET status='RESOLVED', resolved_at=? WHERE status='OPEN' AND skill_id=? AND origin=? AND project_id IS ? AND projection_path IS ? AND divergent_hash=?").run(new Date().toISOString(), conflict.skillId, conflict.origin, conflict.projectId, conflict.projectionPath, conflict.divergentHash)
    if (!result.changes) throw new AcademyError('CONFLICT_NOT_FOUND')
  }

  getConflict(id: string): AcademyConflict {
    const row = this.db.prepare('SELECT c.*, s.name skill_name FROM academy_conflicts c JOIN academy_skills s ON s.id=c.skill_id WHERE c.id=?').get(id) as Row | undefined
    if (!row) throw new AcademyError('CONFLICT_NOT_FOUND')
    return conflictFromRow(row)
  }

  private getDestination(id: string): AcademyDestination {
    const row = this.db.prepare('SELECT * FROM academy_destinations WHERE id=?').get(id) as Row | undefined
    if (!row) throw new AcademyError('DESTINATION_NOT_FOUND')
    return destinationFromRow(row)
  }

  setEnabled(id: string, enabled: boolean, expectedStateRevision: number): AcademySkillDetail {
    if (typeof id !== 'string' || !id.trim() || typeof enabled !== 'boolean' || !Number.isSafeInteger(expectedStateRevision) || expectedStateRevision < 1) throw new AcademyError('INVALID_ARGUMENT')
    return this.db.transaction(() => {
      const row = this.skillRow(id)
      if (row.state_revision !== expectedStateRevision) throw new AcademyError('STATE_REVISION_CONFLICT', 'Skill activation changed since it was read', { expectedStateRevision, stateRevision: row.state_revision })
      const status = enabled ? 'ACTIVE' : 'DISABLED'
      if (row.status !== status) this.db.prepare('UPDATE academy_skills SET status=?, state_revision=state_revision+1, updated_at=? WHERE id=?').run(status, new Date().toISOString(), id)
      return this.get(id)
    }).immediate()
  }

  private setLegacyEnabled(id: string, expectedVersion: number, enabled: boolean): AcademySkillDetail {
    return this.db.transaction(() => {
      const row = this.skillRow(id)
      if (row.current_version !== expectedVersion) throw new AcademyError('VERSION_CONFLICT', 'Skill changed since it was read', { expectedVersion, currentVersion: row.current_version })
      return this.setEnabled(id, enabled, row.state_revision)
    }).immediate()
  }

  private insertVersion(skillId: string, version: number, pkg: AcademyPackage, hash: string, origin: AcademyVersionOrigin, createdAt: string): void {
    this.db.prepare('INSERT INTO academy_versions(skill_id,version,skill_md,artifacts_json,package_hash,origin,created_at) VALUES(?,?,?,?,?,?,?)').run(skillId, version, pkg.skillMd, JSON.stringify(pkg.artifacts), hash, origin, createdAt)
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
    return this.withGitSource(versionFromRow(row))
  }

  private withGitSource<T extends AcademySkillVersionMetadata>(version: T): T {
    const source = this.getGitVersionSource(version.skillId, version.version)
    return source ? { ...version, gitSource: source } : version
  }

  getGitAuthority(): AcademyGitAuthority | null {
    const row = this.db.prepare('SELECT state_json FROM academy_git_authority WHERE id=1').get() as Row | undefined
    return row ? JSON.parse(row.state_json) : null
  }

  getGitSnapshot(repositoryId: string, commitSha: string): AcademyGitSourceSnapshot | null {
    const row = this.db.prepare('SELECT snapshot_json FROM academy_git_snapshots WHERE repository_id=? AND commit_sha=?').get(repositoryId, commitSha) as Row | undefined
    return row ? JSON.parse(row.snapshot_json) : null
  }

  getGitSnapshotPayload(repositoryId: string, commitSha: string): string | null {
    const row = this.db.prepare('SELECT snapshot_json FROM academy_git_snapshots WHERE repository_id=? AND commit_sha=?').get(repositoryId, commitSha) as Row | undefined
    return row?.snapshot_json ?? null
  }

  readAcademyBootstrap(readGit: () => import('../../shared/types/academy-types').AcademyGitStatusProjection) {
    return this.db.transaction(() => {
      const release = this.db.prepare(`SELECT r.id, r.plugin_version version, r.status,
        (SELECT json_extract(b.receipt_json,'$.sourceCommitSha') FROM academy_openai_git_builds b WHERE b.release_id=r.id ORDER BY b.rowid DESC LIMIT 1) sourceCommitSha
        FROM academy_openai_plugin_releases r ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`).get() as import('../../shared/types/academy-bootstrap-types').AcademyPersistedPublication['release'] | undefined
      return { snapshot: { skills: this.list(), destinations: this.listDestinations(), conflicts: this.conflictSummaries() }, git: readGit(),
        publication: { publishedVersion: this.getOpenAiPluginProfile()?.publishedVersion ?? null, release: release ?? null, marketplace: this.getMarketplaceState() } }
    })()
  }

  getGitSnapshotHeader(repositoryId: string, commitSha: string): AcademyGitSnapshotHeader | null {
    const row = this.db.prepare('SELECT header_json FROM academy_git_snapshots WHERE repository_id=? AND commit_sha=?').get(repositoryId, commitSha) as Row | undefined
    if (!row) return null
    if (row.header_json) return JSON.parse(row.header_json)
    const snapshot = this.getGitSnapshot(repositoryId, commitSha)!
    const header = gitSnapshotHeader(snapshot)
    this.db.prepare('UPDATE academy_git_snapshots SET header_json=? WHERE repository_id=? AND commit_sha=? AND header_json IS NULL').run(JSON.stringify(header), repositoryId, commitSha)
    return header
  }

  getGitBuildProjection(repositoryId: string, commitSha: string): AcademyBuildProjection | null {
    const row = this.db.prepare('SELECT build_projection_json FROM academy_git_snapshots WHERE repository_id=? AND commit_sha=?').get(repositoryId, commitSha) as Row | undefined
    return row?.build_projection_json ? JSON.parse(row.build_projection_json) : null
  }

  saveGitBuildProjection(projection: AcademyBuildProjection): void {
    const header = this.getGitSnapshotHeader(projection.sourceRepositoryId, projection.sourceCommitSha)
    if (!header || header.managedTreeHash !== projection.managedTreeHash) throw new AcademyError('GIT_SOURCE_SNAPSHOT_NOT_VERIFIED')
    this.db.prepare('UPDATE academy_git_snapshots SET build_projection_json=? WHERE repository_id=? AND commit_sha=?').run(JSON.stringify(projection), projection.sourceRepositoryId, projection.sourceCommitSha)
  }

  findGitBuildReceipt(repositoryId: string, commitSha: string): import('../../shared/types/academy-git-source-types').AcademyGitBuildReceipt | null {
    const row = this.db.prepare("SELECT receipt_json FROM academy_openai_git_builds WHERE json_extract(receipt_json,'$.sourceRepositoryId')=? AND json_extract(receipt_json,'$.sourceCommitSha')=? AND json_extract(receipt_json,'$.buildSchema')=1 AND json_extract(receipt_json,'$.zipSha256') IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(repositoryId, commitSha) as Row | undefined
    return row ? JSON.parse(row.receipt_json) : null
  }

  knownPluginVersions(): string[] {
    return (this.db.prepare('SELECT plugin_version version FROM academy_openai_plugin_releases UNION SELECT version FROM academy_plugin_package_revisions').all() as Row[]).map(row => row.version)
  }

  findOpenAiReleaseVersion(version: string): AcademyOpenAiRelease | null {
    const row = this.db.prepare('SELECT * FROM academy_openai_plugin_releases WHERE plugin_version=?').get(version) as Row | undefined
    return row ? this.withGitBuildSource(openAiReleaseFromRow(row)) : null
  }

  findPluginPackageRevisionVersion(version: string): AcademyPluginPackageRevision | null {
    const row = this.db.prepare('SELECT * FROM academy_plugin_package_revisions WHERE version=?').get(version) as Row | undefined
    return row ? pluginPackageRevisionFromRow(row) : null
  }

  getGitSkillSources(): AcademyGitSkillSource[] {
    return (this.db.prepare('SELECT * FROM academy_git_skill_sources ORDER BY path').all() as Row[]).map(row => ({
      repositoryId: row.repository_id, path: row.path, skillId: row.skill_id, legacyBaselineVersion: row.legacy_baseline_version,
      sourceCommitSha: row.source_commit_sha, available: Boolean(row.available)
    }))
  }

  getGitVersionSource(skillId: string, version: number): { sourceCommitSha: string; managedTreeHash: string; packageHash: string } | null {
    const row = this.db.prepare('SELECT * FROM academy_git_version_sources WHERE skill_id=? AND version=?').get(skillId, version) as Row | undefined
    return row ? { sourceCommitSha: row.commit_sha, managedTreeHash: row.managed_tree_hash, packageHash: row.package_hash } : null
  }

  migrationDifferences(snapshot: AcademyGitSourceSnapshot): string[] {
    const differences: string[] = []
    for (const summary of this.list().filter(skill => skill.scope === 'GLOBAL')) {
      const remote = snapshot.skills.find(skill => skill.name === summary.name)
      if (!remote && summary.status === 'DISABLED') continue
      if (!remote || remote.packageHash !== this.get(summary.id).current.packageHash) differences.push(`skills/${summary.name}`)
    }
    for (const remote of snapshot.skills) {
      const existing = this.findByName(remote.name)
      if (existing?.scope === 'PROJECT') differences.push(remote.path)
    }
    return [...new Set(differences)].sort()
  }

  acceptGitSnapshots(snapshots: AcademyGitSourceSnapshot[], expectedCommit: string | null, reviewedMigrationHash?: string): string[] {
    if (!snapshots.length) return []
    return this.db.transaction(() => {
      const authority = this.getGitAuthority()
      if ((authority?.processedCommitSha ?? null) !== expectedCommit) throw new AcademyError('GIT_SOURCE_CHANGED')
      const first = snapshots[0]
      if (!authority && this.migrationDifferences(first).length && reviewedMigrationHash !== this.gitMigrationHash(first)) throw new AcademyError('GIT_MIGRATION_RECONCILIATION_REQUIRED')
      let previous = expectedCommit
      const changed = new Set<string>()
      if (!authority) for (const skill of this.list().filter(skill => skill.scope === 'GLOBAL')) changed.add(skill.id)
      this.ingestingGit = true
      try {
        for (const snapshot of snapshots) {
          if (snapshot.repositoryId !== first.repositoryId || snapshot.remoteUrl !== first.remoteUrl || snapshot.branch !== first.branch ||
            (authority && (snapshot.repositoryId !== authority.repositoryId || snapshot.remoteUrl !== authority.remoteUrl || snapshot.branch !== authority.branch))) throw new AcademyError('GIT_SOURCE_IDENTITY_CHANGED')
          if (previous && snapshot.firstParentSha !== previous) throw new AcademyError('ACADEMY_HISTORY_REWRITTEN')
          const baseSnapshot = previous ? this.getGitSnapshot(snapshot.repositoryId, previous) : null
          if (this.usesLocalAuthority()) {
            const remoteMetadata = this.authoredMetadata(snapshot.authoredFiles)
            const baseMetadata = baseSnapshot ? this.authoredMetadata(baseSnapshot.authoredFiles) : null
            const localMetadata = this.localAuthoredMetadata()
            if (canonicalJson(remoteMetadata) !== canonicalJson(baseMetadata) && canonicalJson(remoteMetadata) !== canonicalJson(localMetadata)) {
              if (canonicalJson(baseMetadata) === canonicalJson(localMetadata)) this.adoptAuthoredMetadata(snapshot.authoredFiles)
              else this.db.prepare('UPDATE academy_catalog SET metadata_conflict_json=? WHERE id=1').run(JSON.stringify({
                repositoryId: snapshot.repositoryId, branch: snapshot.branch, commit: snapshot.sourceCommitSha,
                base: baseMetadata, local: localMetadata, remote: remoteMetadata, remoteFiles: Object.fromEntries(Object.entries(snapshot.authoredFiles).filter(([path]) => path === 'plugin.json' || path.startsWith('assets/')))
              }))
            }
          }
          if (this.usesLocalAuthority() && !snapshot.identities && baseSnapshot && (
            snapshot.skills.some(skill => !baseSnapshot.skills.some(base => base.path === skill.path)) ||
            baseSnapshot.skills.some(skill => !snapshot.skills.some(remote => remote.path === skill.path)))) throw new AcademyError('ACADEMY_IDENTITY_REVIEW_REQUIRED')
          if (baseSnapshot?.identities && !snapshot.identities) throw new AcademyError('ACADEMY_IDENTITY_CATALOG_REQUIRED')
          if (snapshot.identities) validateAcademyIdentities(snapshot.identities, snapshot.skills.map(skill => skill.path), baseSnapshot?.identities)
          const sources = this.getGitSkillSources()
          const canonicalVersions: NonNullable<AcademyGitSourceSnapshot['canonicalVersions']> = {}
          for (const skill of snapshot.skills) {
            if (hashAcademyPackage(skill.package) !== skill.packageHash) throw new AcademyError('GIT_SOURCE_HASH_MISMATCH')
            const stableId = snapshot.identities?.skills.find(entry => entry.path === skill.path && entry.state === 'PRESENT')?.skillId
            let source = sources.find(item => item.repositoryId === snapshot.repositoryId && (stableId ? item.skillId === stableId : item.path === skill.path))
            if (stableId && sources.some(item => item.path === skill.path && item.skillId !== stableId)) throw new AcademyError('GIT_SOURCE_IDENTITY_COLLISION')
            let detail = source ? this.get(source.skillId) : !authority && !previous ? this.findByName(skill.name) : null
            if (stableId && detail && stableId !== detail.id) throw new AcademyError('GIT_SOURCE_IDENTITY_COLLISION')
            if (!detail && stableId && (this.db.prepare('SELECT 1 FROM academy_skills WHERE id=?').get(stableId))) detail = this.get(stableId)
            const legacyBaselineVersion = detail?.currentVersion ?? 0
            let introducedVersion = !detail
            const base = baseSnapshot?.skills.find(item => item.path === source?.path)
            let retainLocal = false
            if (detail && this.usesLocalAuthority()) {
              const localHash = this.isDeleted(detail.id) ? 'DELETED' : detail.current.packageHash
              if (localHash !== skill.packageHash && localHash !== base?.packageHash) {
                retainLocal = true
                if (skill.packageHash !== base?.packageHash) {
                  const merged = base && !this.isDeleted(detail.id) ? mergeAcademyPackages(base.package, detail.current.package, skill.package) : null
                  if (merged) {
                    detail = this.update({ skillId: detail.id, expectedVersion: detail.currentVersion, package: merged, origin: 'GIT' })
                    introducedVersion = true
                  } else this.recordGitConflict(detail, snapshot, skill.path, base?.package ?? null, skill.package)
                }
              }
            }
            if (!detail) detail = this.create({ package: skill.package, scope: 'GLOBAL', origin: 'GIT' }, stableId)
            else if (detail.scope !== 'GLOBAL') throw new AcademyError('GIT_SOURCE_IDENTITY_COLLISION')
            else if (!retainLocal && detail.current.packageHash !== skill.packageHash) {
              detail = this.update({ skillId: detail.id, expectedVersion: detail.currentVersion, package: skill.package, origin: 'GIT' })
              introducedVersion = true
            }
            if (!source || !source.available || introducedVersion) changed.add(detail.id)
            const acceptedVersion = this.db.prepare("SELECT version FROM academy_versions WHERE skill_id=? AND package_hash=? AND content_state='PRESENT' ORDER BY version DESC LIMIT 1").get(detail.id, skill.packageHash) as Row | undefined
            canonicalVersions[skill.path] = { skillId: detail.id, version: acceptedVersion?.version ?? 0 }
            if (source && stableId && source.path !== skill.path) this.db.prepare('UPDATE academy_git_skill_sources SET path=? WHERE repository_id=? AND skill_id=?').run(skill.path, snapshot.repositoryId, stableId)
            this.db.prepare(`INSERT INTO academy_git_skill_sources VALUES(?,?,?,?,?,1) ON CONFLICT(repository_id,path)
              DO UPDATE SET source_commit_sha=excluded.source_commit_sha, available=1`).run(snapshot.repositoryId, skill.path, detail.id, legacyBaselineVersion, introducedVersion || !source ? snapshot.sourceCommitSha : source.sourceCommitSha)
            if ((introducedVersion || this.usesLocalAuthority() && authority) && detail.current.packageHash === skill.packageHash) this.db.prepare('INSERT OR IGNORE INTO academy_git_version_sources VALUES(?,?,?,?,?)').run(detail.id, detail.currentVersion, snapshot.sourceCommitSha, snapshot.managedTreeHash, detail.current.packageHash)
            this.recordEligibility(detail.id, 'GIT_SOURCE', null, false)
          }
          for (const source of sources.filter(item => item.available && item.repositoryId === snapshot.repositoryId && !snapshot.skills.some(skill => snapshot.identities ? snapshot.identities.skills.some(entry => entry.skillId === item.skillId && entry.path === skill.path && entry.state === 'PRESENT') : skill.path === item.path))) {
            if (this.usesLocalAuthority()) {
              const detail = this.get(source.skillId), base = baseSnapshot?.skills.find(skill => skill.path === source.path)
              if (!this.isDeleted(source.skillId) && detail.current.packageHash !== base?.packageHash) {
                this.recordGitConflict(detail, snapshot, source.path, base?.package ?? null, null)
              } else if (!this.isDeleted(source.skillId)) {
                this.deleteGlobalSkill(source.skillId, detail.currentVersion)
                const tombstone = snapshot.identities?.skills.find(entry => entry.skillId === source.skillId && entry.state === 'REMOVED')
                if (tombstone) this.db.prepare('UPDATE academy_tombstones SET path=?,base_hash=?,revision=? WHERE skill_id=?').run(tombstone.path, tombstone.baseHash!, tombstone.revision!, source.skillId)
              }
            }
            this.db.prepare('UPDATE academy_git_skill_sources SET available=0,source_commit_sha=? WHERE repository_id=? AND path=?').run(snapshot.sourceCommitSha, snapshot.repositoryId, source.path)
            changed.add(source.skillId)
          }
          const confirmed = { ...snapshot, canonicalVersions }
          this.db.prepare('INSERT INTO academy_git_snapshots(repository_id,commit_sha,snapshot_json,header_json) VALUES(?,?,?,?)').run(snapshot.repositoryId, snapshot.sourceCommitSha, JSON.stringify(confirmed), JSON.stringify(gitSnapshotHeader(confirmed)))
          previous = snapshot.sourceCommitSha
        }
        const next: AcademyGitAuthority = authority ? { ...authority, processedCommitSha: previous! } : {
          repositoryId: first.repositoryId, remoteUrl: first.remoteUrl, branch: first.branch, processedCommitSha: previous!, baselineCommitSha: first.sourceCommitSha, cutoverAt: new Date().toISOString()
        }
        this.db.prepare('INSERT INTO academy_git_authority VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json').run(JSON.stringify(next))
        if (changed.size) this.db.prepare("UPDATE academy_destinations SET reconciliation_status='PENDING' WHERE enabled=1").run()
        return [...changed]
      } finally { this.ingestingGit = false }
    }).immediate()
  }

  gitMigrationHash(snapshot: AcademyGitSourceSnapshot): string {
    return hashAcademyPackage({ skillMd: '---\nname: migration\ndescription: Review\n---\n', artifacts: {
      'review.json': JSON.stringify({ source: snapshot.sourceCommitSha, skills: this.list().filter(skill => skill.scope === 'GLOBAL').map(skill => ({ id: skill.id, version: skill.currentVersion, hash: this.get(skill.id).current.packageHash, status: skill.status, stateRevision: skill.stateRevision })) })
    } })
  }

  private summary(row: Row): AcademySkillSummary {
    const projects = this.db.prepare('SELECT destination_id FROM academy_skill_projects WHERE skill_id=? ORDER BY destination_id').all(row.id) as Row[]
    const gitManaged = row.scope === 'GLOBAL' && this.getGitAuthority()
    const source = gitManaged ? this.db.prepare('SELECT * FROM academy_git_skill_sources WHERE skill_id=?').get(row.id) as Row | undefined : undefined
    const sourceState: AcademySkillSummary['source'] = gitManaged ? { state: source ? source.available ? 'CONFIRMED' : 'REMOVED' : 'LEGACY_PRIVATE', sourceCommitSha: source?.source_commit_sha ?? null, path: source?.path ?? null } : undefined
    return { id: row.id, name: row.name, description: row.description, status: row.status, stateRevision: row.state_revision, scope: row.scope, currentVersion: row.current_version, projectIds: projects.map((entry) => entry.destination_id), createdAt: row.created_at, updatedAt: row.updated_at, ...(!this.usesGitFirst() && row.scope === 'GLOBAL' ? { ...(this.usesLocalAuthority() ? { catalogRevision: this.catalogRevision() } : {}), publicationEligibility: this.publicationEligibility(row.id), publicationSource: this.publicationSource(row.id) ?? undefined } : {}), ...(sourceState ? { source: sourceState } : {}) }
  }
}

function versionFromRow(row: Row): AcademySkillVersion {
  return { skillId: row.skill_id, version: row.version, package: { skillMd: row.skill_md, artifacts: JSON.parse(row.artifacts_json) }, packageHash: row.package_hash, origin: row.origin, createdAt: row.created_at, ...(row.content_state === 'DELETED' ? { contentState: 'DELETED' as const } : {}) }
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
