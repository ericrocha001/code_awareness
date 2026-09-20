import type { D1Database } from '@cloudflare/workers-types'

export interface LinkCloudflareIdentityOptions {
  issuer: string
  subject: string
  canonicalUserId: string
  nowIso?: string
}

export async function linkCloudflareIdentity(
  db: D1Database,
  options: LinkCloudflareIdentityOptions
): Promise<{ linked: boolean; canonicalUserId: string }> {
  const { issuer, subject, canonicalUserId } = options
  const nowIso = options.nowIso ?? new Date().toISOString()

  const user = await db
    .prepare('SELECT id FROM users WHERE id = ?')
    .bind(canonicalUserId)
    .first<{ id: string }>()

  if (!user) {
    throw new Error(`Canonical user ${canonicalUserId} does not exist.`)
  }

  const existing = await db
    .prepare('SELECT user_id AS userId FROM external_identities WHERE issuer = ? AND subject = ?')
    .bind(issuer, subject)
    .first<{ userId: string }>()

  if (existing) {
    if (existing.userId === canonicalUserId) {
      return { linked: true, canonicalUserId }
    }
    throw new Error(`External identity (${issuer}, ${subject}) is already linked to a different canonical user ${existing.userId}`)
  }

  await db
    .prepare('INSERT INTO external_identities (issuer, subject, user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind(issuer, subject, canonicalUserId, nowIso)
    .run()

  return { linked: true, canonicalUserId }
}
