#!/usr/bin/env node
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)

function printUsage() {
  console.log(`
Usage:
  node scripts/run-data-migration.mjs --generate-migration-sql --legacy-owner <AUTH0_SUB> [--canonical-id <UUID>]
  node scripts/run-data-migration.mjs --generate-link-cf-sql --cf-issuer <CF_ISSUER> --cf-subject <CF_SUB> --canonical-id <UUID>
  node scripts/run-data-migration.mjs --help
`)
}

function getArg(name) {
  const idx = args.indexOf(name)
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1]
  return null
}

if (args.includes('--help') || args.length === 0) {
  printUsage()
  process.exit(0)
}

const nowIso = new Date().toISOString()
const legacyIssuer = getArg('--legacy-issuer') || 'https://code-awareness.us.auth0.com/'

if (args.includes('--generate-migration-sql')) {
  const legacyOwner = getArg('--legacy-owner')
  if (!legacyOwner) {
    console.error('Error: --legacy-owner is required')
    process.exit(1)
  }
  const canonicalId = getArg('--canonical-id') || randomUUID()
  const safeOwner = legacyOwner.replace(/'/g, "''")
  const safeIssuer = legacyIssuer.replace(/'/g, "''")

  console.log(`-- ==========================================================`)
  console.log(`-- Step 1: Pre-migration verification`)
  console.log(`-- Run this first to record baseline counts:`)
  console.log(`SELECT 'before_installations' AS metric, COUNT(*) AS count FROM installations;`)
  console.log(`SELECT 'before_users' AS metric, COUNT(*) AS count FROM users;`)
  console.log(`SELECT 'before_enrollments' AS metric, COUNT(*) AS count FROM pending_enrollments;`)
  console.log(``)
  console.log(`-- Step 2: Atomic migration transaction`)
  console.log(`INSERT OR IGNORE INTO users (id, created_at) VALUES ('${canonicalId}', '${nowIso}');`)
  console.log(`INSERT OR IGNORE INTO external_identities (issuer, subject, user_id, created_at) VALUES ('${safeIssuer}', '${safeOwner}', '${canonicalId}', '${nowIso}');`)
  console.log(`UPDATE installations SET owner_user_id = '${canonicalId}' WHERE owner_user_id = '${safeOwner}';`)
  console.log(`UPDATE pending_enrollments SET claimed_by_user_id = '${canonicalId}' WHERE claimed_by_user_id = '${safeOwner}';`)
  console.log(`DELETE FROM users WHERE id = '${safeOwner}';`)
  console.log(``)
  console.log(`-- Step 3: Post-migration verification`)
  console.log(`-- Verify installations count is identical and foreign keys are valid:`)
  console.log(`SELECT 'after_installations' AS metric, COUNT(*) AS count FROM installations;`)
  console.log(`SELECT 'after_users' AS metric, COUNT(*) AS count FROM users;`)
  console.log(`SELECT 'after_external_identities' AS metric, COUNT(*) AS count FROM external_identities;`)
  console.log(`PRAGMA foreign_key_check;`)
  console.log(`-- ==========================================================`)
  console.log(`-- Canonical User ID generated: ${canonicalId}`)
  process.exit(0)
}

if (args.includes('--generate-link-cf-sql')) {
  const cfIssuer = getArg('--cf-issuer')
  const cfSubject = getArg('--cf-subject')
  const canonicalId = getArg('--canonical-id')

  if (!cfIssuer || !cfSubject || !canonicalId) {
    console.error('Error: --cf-issuer, --cf-subject, and --canonical-id are required')
    process.exit(1)
  }

  const safeIssuer = cfIssuer.replace(/'/g, "''")
  const safeSubject = cfSubject.replace(/'/g, "''")
  const safeCanonical = canonicalId.replace(/'/g, "''")

  console.log(`-- ==========================================================`)
  console.log(`-- Link Cloudflare Access Identity to Canonical User`)
  console.log(`INSERT OR IGNORE INTO external_identities (issuer, subject, user_id, created_at)`)
  console.log(`VALUES ('${safeIssuer}', '${safeSubject}', '${safeCanonical}', '${nowIso}');`)
  console.log(``)
  console.log(`-- Verify the link:`)
  console.log(`SELECT * FROM external_identities WHERE issuer = '${safeIssuer}' AND subject = '${safeSubject}';`)
  console.log(`-- ==========================================================`)
  process.exit(0)
}

printUsage()
process.exit(1)
