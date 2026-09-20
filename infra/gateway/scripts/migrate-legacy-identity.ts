import type { D1Database } from '@cloudflare/workers-types'

export interface MigrateLegacyIdentityOptions {
  legacyIssuer?: string
  nowIso?: string
  generateCanonicalId?: () => string
}

export interface MigrationInspection {
  legacyOwners: string[]
  installationsCount: number
  enrollmentsCount: number
}

export interface MigrationResult {
  migrated: Array<{
    legacySubject: string
    canonicalUserId: string
  }>
  installationsCountBefore: number
  installationsCountAfter: number
  enrollmentsCountBefore: number
  enrollmentsCountAfter: number
  externalIdentitiesCountAfter: number
}

export async function inspectLegacyOwners(db: D1Database): Promise<MigrationInspection> {
  const usersResult = await db
    .prepare(
      `SELECT DISTINCT u.id AS id
       FROM users u
       WHERE u.id NOT IN (SELECT user_id FROM external_identities)
         AND (
           u.id IN (SELECT owner_user_id FROM installations)
           OR u.id IN (SELECT claimed_by_user_id FROM pending_enrollments WHERE claimed_by_user_id IS NOT NULL)
         )`
    )
    .all<{ id: string }>()

  const legacyOwners = (usersResult.results ?? []).map((r) => r.id)

  const instCountResult = await db
    .prepare('SELECT COUNT(*) AS total FROM installations')
    .first<{ total: number }>()

  const enrollCountResult = await db
    .prepare('SELECT COUNT(*) AS total FROM pending_enrollments')
    .first<{ total: number }>()

  return {
    legacyOwners,
    installationsCount: instCountResult?.total ?? 0,
    enrollmentsCount: enrollCountResult?.total ?? 0
  }
}

export async function executeLegacyIdentityMigration(
  db: D1Database,
  options: MigrateLegacyIdentityOptions = {}
): Promise<MigrationResult> {
  const legacyIssuer = options.legacyIssuer ?? 'https://code-awareness.us.auth0.com/'
  const nowIso = options.nowIso ?? new Date().toISOString()
  const generateId = options.generateCanonicalId ?? (() => crypto.randomUUID())

  const before = await inspectLegacyOwners(db)

  const migrated: Array<{ legacySubject: string; canonicalUserId: string }> = []

  for (const legacySubject of before.legacyOwners) {
    const canonicalUserId = generateId()

    await db.batch([
      db
        .prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)')
        .bind(canonicalUserId, nowIso),
      db
        .prepare(
          'INSERT OR IGNORE INTO external_identities (issuer, subject, user_id, created_at) VALUES (?, ?, ?, ?)'
        )
        .bind(legacyIssuer, legacySubject, canonicalUserId, nowIso),
      db
        .prepare('UPDATE installations SET owner_user_id = ? WHERE owner_user_id = ?')
        .bind(canonicalUserId, legacySubject),
      db
        .prepare('UPDATE pending_enrollments SET claimed_by_user_id = ? WHERE claimed_by_user_id = ?')
        .bind(canonicalUserId, legacySubject),
      db
        .prepare('DELETE FROM users WHERE id = ?')
        .bind(legacySubject)
    ])

    migrated.push({ legacySubject, canonicalUserId })
  }

  const instCountAfter = await db
    .prepare('SELECT COUNT(*) AS total FROM installations')
    .first<{ total: number }>()

  const enrollCountAfter = await db
    .prepare('SELECT COUNT(*) AS total FROM pending_enrollments')
    .first<{ total: number }>()

  const extCountAfter = await db
    .prepare('SELECT COUNT(*) AS total FROM external_identities')
    .first<{ total: number }>()

  return {
    migrated,
    installationsCountBefore: before.installationsCount,
    installationsCountAfter: instCountAfter?.total ?? 0,
    enrollmentsCountBefore: before.enrollmentsCount,
    enrollmentsCountAfter: enrollCountAfter?.total ?? 0,
    externalIdentitiesCountAfter: extCountAfter?.total ?? 0
  }
}

export function generateLegacyIdentityMigrationSql(
  legacyOwners: string[],
  options: MigrateLegacyIdentityOptions = {}
): string {
  const legacyIssuer = options.legacyIssuer ?? 'https://code-awareness.us.auth0.com/'
  const nowIso = options.nowIso ?? new Date().toISOString()
  const generateId = options.generateCanonicalId ?? (() => crypto.randomUUID())

  const statements: string[] = []

  for (const owner of legacyOwners) {
    const canonicalId = generateId()
    const safeOwner = owner.replace(/'/g, "''")
    const safeIssuer = legacyIssuer.replace(/'/g, "''")

    statements.push(`-- Migrate legacy owner: ${safeOwner}`)
    statements.push(`INSERT OR IGNORE INTO users (id, created_at) VALUES ('${canonicalId}', '${nowIso}');`)
    statements.push(
      `INSERT OR IGNORE INTO external_identities (issuer, subject, user_id, created_at) VALUES ('${safeIssuer}', '${safeOwner}', '${canonicalId}', '${nowIso}');`
    )
    statements.push(`UPDATE installations SET owner_user_id = '${canonicalId}' WHERE owner_user_id = '${safeOwner}';`)
    statements.push(
      `UPDATE pending_enrollments SET claimed_by_user_id = '${canonicalId}' WHERE claimed_by_user_id = '${safeOwner}';`
    )
    statements.push(`DELETE FROM users WHERE id = '${safeOwner}';`)
  }

  return statements.join('\n')
}
