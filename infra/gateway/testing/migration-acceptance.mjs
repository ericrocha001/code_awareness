import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { executeLegacyIdentityMigration } from '../scripts/migrate-legacy-identity.ts'
import { linkCloudflareIdentity } from '../scripts/link-cloudflare-identity.ts'

test('Data Migration: parameter-driven migration converts legacy owners to canonical identity with full integrity', async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response(null); } }',
      compatibilityDate: '2026-09-11',
      d1Databases: ['REGISTRY']
    })
  )

  try {
    const db = await mf.getD1Database('REGISTRY')

    const s1 = await readFile('migrations/0001_installations.sql', 'utf8')
    const s2 = await readFile('migrations/0002_enrollment.sql', 'utf8')
    const s3 = await readFile('migrations/0003_external_identities.sql', 'utf8')
    for (const statement of (s1 + '\n' + s2 + '\n' + s3).split(';').map((v) => v.trim()).filter(Boolean)) {
      await db.prepare(statement).run()
    }

    const legacyUserA = 'google-oauth2|104362835673150614751'
    const legacyUserB = 'auth0|second-developer-456'
    const nowIso = new Date().toISOString()

    await db.prepare('INSERT INTO users VALUES (?, ?)').bind(legacyUserA, nowIso).run()
    await db.prepare('INSERT INTO users VALUES (?, ?)').bind(legacyUserB, nowIso).run()

    const inst1 = randomUUID()
    const inst2 = randomUUID()
    const inst3 = randomUUID()
    const hash1 = 'a'.repeat(64)
    const hash2 = 'b'.repeat(64)
    const hash3 = 'c'.repeat(64)

    await db.prepare('INSERT INTO installations VALUES (?, ?, ?, ?, ?, ?)').bind(inst1, legacyUserA, hash1, nowIso, null, 'ACTIVE').run()
    await db.prepare('INSERT INTO installations VALUES (?, ?, ?, ?, ?, ?)').bind(inst2, legacyUserA, hash2, nowIso, null, 'REVOKED').run()
    await db.prepare('INSERT INTO installations VALUES (?, ?, ?, ?, ?, ?)').bind(inst3, legacyUserB, hash3, nowIso, null, 'ACTIVE').run()

    const enroll1 = randomUUID()
    await db.prepare('INSERT INTO pending_enrollments VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
      enroll1, inst1, hash1, 's'.repeat(64), nowIso, nowIso, 'CLAIMED', legacyUserA
    ).run()

    const instBefore = await db.prepare('SELECT * FROM installations ORDER BY id').all()
    const enrollBefore = await db.prepare('SELECT * FROM pending_enrollments ORDER BY enrollment_id').all()

    assert.equal(instBefore.results.length, 3)
    assert.equal(enrollBefore.results.length, 1)

    const migrationResult = await executeLegacyIdentityMigration(db, {
      legacyIssuer: 'https://code-awareness.us.auth0.com/'
    })

    assert.equal(migrationResult.migrated.length, 2)
    assert.equal(migrationResult.installationsCountBefore, 3)
    assert.equal(migrationResult.installationsCountAfter, 3)
    assert.equal(migrationResult.enrollmentsCountBefore, 1)
    assert.equal(migrationResult.enrollmentsCountAfter, 1)
    assert.equal(migrationResult.externalIdentitiesCountAfter, 2)

    const userAMigration = migrationResult.migrated.find((m) => m.legacySubject === legacyUserA)
    const userBMigration = migrationResult.migrated.find((m) => m.legacySubject === legacyUserB)
    assert.ok(userAMigration)
    assert.ok(userBMigration)
    assert.notEqual(userAMigration.canonicalUserId, userBMigration.canonicalUserId)

    const legacyUserCheck = await db.prepare('SELECT * FROM users WHERE id IN (?, ?)').bind(legacyUserA, legacyUserB).all()
    assert.equal(legacyUserCheck.results.length, 0)

    const canonicalUsersCheck = await db.prepare('SELECT * FROM users WHERE id IN (?, ?)').bind(
      userAMigration.canonicalUserId,
      userBMigration.canonicalUserId
    ).all()
    assert.equal(canonicalUsersCheck.results.length, 2)

    const extIdentities = await db.prepare('SELECT * FROM external_identities ORDER BY subject').all()
    assert.equal(extIdentities.results.length, 2)
    const extA = extIdentities.results.find((e) => e.subject === legacyUserA)
    const extB = extIdentities.results.find((e) => e.subject === legacyUserB)
    assert.equal(extA.user_id, userAMigration.canonicalUserId)
    assert.equal(extB.user_id, userBMigration.canonicalUserId)

    const instAfter = await db.prepare('SELECT * FROM installations ORDER BY id').all()
    assert.equal(instAfter.results.length, 3)

    const inst1After = instAfter.results.find((i) => i.id === inst1)
    const inst2After = instAfter.results.find((i) => i.id === inst2)
    const inst3After = instAfter.results.find((i) => i.id === inst3)

    assert.equal(inst1After.owner_user_id, userAMigration.canonicalUserId)
    assert.equal(inst1After.status, 'ACTIVE')
    assert.equal(inst1After.credential_hash, hash1)

    assert.equal(inst2After.owner_user_id, userAMigration.canonicalUserId)
    assert.equal(inst2After.status, 'REVOKED')
    assert.equal(inst2After.credential_hash, hash2)

    assert.equal(inst3After.owner_user_id, userBMigration.canonicalUserId)
    assert.equal(inst3After.status, 'ACTIVE')
    assert.equal(inst3After.credential_hash, hash3)

    const enrollAfter = await db.prepare('SELECT * FROM pending_enrollments WHERE enrollment_id = ?').bind(enroll1).first()
    assert.equal(enrollAfter.claimed_by_user_id, userAMigration.canonicalUserId)

    const fkCheck = await db.prepare('PRAGMA foreign_key_check').all()
    assert.equal(fkCheck.results.length, 0)

    const cfLinkResult = await linkCloudflareIdentity(db, {
      issuer: 'https://team.cloudflareaccess.com',
      subject: 'cf-user-uuid-999',
      canonicalUserId: userAMigration.canonicalUserId
    })
    assert.equal(cfLinkResult.linked, true)

    const cfResolve = await db.prepare('SELECT user_id FROM external_identities WHERE issuer = ? AND subject = ?')
      .bind('https://team.cloudflareaccess.com', 'cf-user-uuid-999').first()
    assert.equal(cfResolve.user_id, userAMigration.canonicalUserId)

    const cfRelink = await linkCloudflareIdentity(db, {
      issuer: 'https://team.cloudflareaccess.com',
      subject: 'cf-user-uuid-999',
      canonicalUserId: userAMigration.canonicalUserId
    })
    assert.equal(cfRelink.linked, true)

    const secondRun = await executeLegacyIdentityMigration(db)
    assert.equal(secondRun.migrated.length, 0)
    assert.equal(secondRun.installationsCountAfter, 3)
    assert.equal(secondRun.enrollmentsCountAfter, 1)
    assert.equal(secondRun.externalIdentitiesCountAfter, 3)
  } finally {
    await mf.dispose()
  }
})
