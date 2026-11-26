import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { FACTS_SCHEMA_VERSION } from './skill-lint-engine'
import type { FindingMagnitude, LintReviewRecord, PackageFacts } from './skill-lint-types'

type Row = Record<string, any>

export class AcademyLintRepository {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS academy_lint_facts (
        package_hash TEXT NOT NULL,
        rule_set_version TEXT NOT NULL,
        tokenizer_id TEXT NOT NULL,
        facts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(package_hash, rule_set_version, tokenizer_id)
      );
      CREATE TABLE IF NOT EXISTS academy_lint_reviews (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL REFERENCES academy_skills(id) ON DELETE CASCADE,
        finding_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        rule_set_version TEXT NOT NULL,
        evidence_fingerprint TEXT NOT NULL,
        magnitude_json TEXT,
        skill_version INTEGER NOT NULL,
        rationale TEXT NOT NULL,
        author TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_by TEXT
      );
      CREATE INDEX IF NOT EXISTS academy_lint_reviews_skill_finding
        ON academy_lint_reviews(skill_id, finding_id);
    `)
  }

  getFacts(packageHash: string, ruleSetVersion: string, tokenizerId: string): PackageFacts | null {
    try {
      const row = this.db
        .prepare(
          'SELECT facts_json FROM academy_lint_facts WHERE package_hash=? AND rule_set_version=? AND tokenizer_id=?'
        )
        .get(packageHash, ruleSetVersion, tokenizerId) as Row | undefined
      if (!row || typeof row.facts_json !== 'string') return null
      const parsed = JSON.parse(row.facts_json) as PackageFacts
      if (parsed.schemaVersion !== FACTS_SCHEMA_VERSION) return null
      return parsed
    } catch {
      return null
    }
  }

  putFacts(facts: PackageFacts): void {
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO academy_lint_facts
           (package_hash, rule_set_version, tokenizer_id, facts_json, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          facts.packageHash,
          facts.ruleSetVersion,
          facts.tokenizerId,
          JSON.stringify(facts),
          new Date().toISOString()
        )
    } catch {
      // Cache failure must never block reads or mutations
    }
  }

  listActiveReviews(skillId: string): LintReviewRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM academy_lint_reviews
         WHERE skill_id=? AND revoked_at IS NULL
         ORDER BY created_at DESC`
      )
      .all(skillId) as Row[]
    return rows.map(rowToReview)
  }

  insertReview(input: {
    skillId: string
    findingId: string
    ruleId: string
    ruleSetVersion: string
    evidenceFingerprint: string
    magnitude: FindingMagnitude | null
    skillVersion: number
    rationale: string
    author: string
  }): LintReviewRecord {
    const id = `lintrev-${randomUUID()}`
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO academy_lint_reviews
         (id, skill_id, finding_id, rule_id, rule_set_version, evidence_fingerprint, magnitude_json, skill_version, rationale, author, created_at, revoked_at, revoked_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
      )
      .run(
        id,
        input.skillId,
        input.findingId,
        input.ruleId,
        input.ruleSetVersion,
        input.evidenceFingerprint,
        input.magnitude ? JSON.stringify(input.magnitude) : null,
        input.skillVersion,
        input.rationale,
        input.author,
        createdAt
      )
    return {
      id,
      skillId: input.skillId,
      findingId: input.findingId,
      ruleId: input.ruleId,
      ruleSetVersion: input.ruleSetVersion,
      evidenceFingerprint: input.evidenceFingerprint,
      magnitude: input.magnitude,
      skillVersion: input.skillVersion,
      rationale: input.rationale,
      author: input.author,
      createdAt,
      revokedAt: null,
      revokedBy: null
    }
  }

  revokeReviews(skillId: string, findingId: string, revokedBy: string): number {
    const result = this.db
      .prepare(
        `UPDATE academy_lint_reviews
         SET revoked_at=?, revoked_by=?
         WHERE skill_id=? AND finding_id=? AND revoked_at IS NULL`
      )
      .run(new Date().toISOString(), revokedBy, skillId, findingId)
    return result.changes
  }
}

function rowToReview(row: Row): LintReviewRecord {
  return {
    id: row.id,
    skillId: row.skill_id,
    findingId: row.finding_id,
    ruleId: row.rule_id,
    ruleSetVersion: row.rule_set_version,
    evidenceFingerprint: row.evidence_fingerprint,
    magnitude: row.magnitude_json ? (JSON.parse(row.magnitude_json) as FindingMagnitude) : null,
    skillVersion: row.skill_version,
    rationale: row.rationale,
    author: row.author,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null,
    revokedBy: row.revoked_by ?? null
  }
}
