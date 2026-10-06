import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TransportEnvelope } from './artifact-envelope'
import { serializeEnvelope } from './artifact-envelope'

export const INBOX_RELATIVE_PATH = '.code-awareness/continuum/inbox'
export const REJECTED_RELATIVE_PATH = '.code-awareness/continuum/rejected'

export interface InboxReceipt {
  artifactId: string
  filePath: string
}

export interface PendingItem {
  filename: string
  filePath: string
}

export class ArtifactInbox {
  private readonly inboxDir: string
  private readonly rejectedDir: string

  constructor(repositoryRoot: string) {
    this.inboxDir = join(repositoryRoot, INBOX_RELATIVE_PATH)
    this.rejectedDir = join(repositoryRoot, REJECTED_RELATIVE_PATH)
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  // ── Write (publish) ──────────────────────────────────────────────────────

  write(envelope: TransportEnvelope): InboxReceipt {
    this.ensureDir(this.inboxDir)

    const finalName = `${envelope.artifactId}.json`
    const finalPath = join(this.inboxDir, finalName)
    const tmpPath = join(this.inboxDir, `${randomUUID()}.tmp`)

    const content = serializeEnvelope(envelope)

    writeFileSync(tmpPath, content, { encoding: 'utf8', flag: 'wx' })
    renameSync(tmpPath, finalPath)

    return { artifactId: envelope.artifactId, filePath: finalPath }
  }

  // ── Read (consume) ───────────────────────────────────────────────────────

  listPending(): PendingItem[] {
    if (!existsSync(this.inboxDir)) return []

    return readdirSync(this.inboxDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({
        filename: entry.name,
        filePath: join(this.inboxDir, entry.name)
      }))
  }

  read(item: PendingItem): string {
    return readFileSync(item.filePath, { encoding: 'utf8' })
  }

  // ── Acknowledge (post-ingestion) ─────────────────────────────────────────

  acknowledge(item: PendingItem): void {
    try {
      rmSync(item.filePath)
    } catch {
      // File may have already been removed; not an error state.
    }
  }

  // ── Reject (permanent failure) ───────────────────────────────────────────

  reject(item: PendingItem): void {
    this.ensureDir(this.rejectedDir)
    const destPath = join(this.rejectedDir, item.filename)
    try {
      renameSync(item.filePath, destPath)
    } catch {
      // If rename fails (e.g. cross-device), fall back to copy+delete.
      const content = readFileSync(item.filePath)
      writeFileSync(destPath, content)
      rmSync(item.filePath)
    }
  }

  // ── Existence checks ─────────────────────────────────────────────────────

  exists(artifactId: string): boolean {
    return existsSync(join(this.inboxDir, `${artifactId}.json`))
  }

  getInboxDir(): string {
    return this.inboxDir
  }
}
