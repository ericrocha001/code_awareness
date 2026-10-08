import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorktreeSnapshot } from './git-worktree-ownership'

export interface WorktreeIntegrationPreview {
  previewId: string
  repositoryId: string
  source: { worktreeId: string; generation: string; snapshot: WorktreeSnapshot }
  target: { branch: string; head: string; worktreeId: string | null; snapshot: WorktreeSnapshot | null; generation: string | null }
  mergeBase: string
  sourceCommits: string[]
  mode: 'FF_ONLY' | 'MERGE'
  promotionBlockers: string[]
  expiresAt: string
}

export class GitWorktreeIntegration {
  constructor(private readonly common: string) {}

  save(value: Omit<WorktreeIntegrationPreview, 'previewId' | 'expiresAt'>): WorktreeIntegrationPreview {
    const preview = { ...value, previewId: 'preview-' + randomUUID(), expiresAt: new Date(Date.now() + 600000).toISOString() }
    const directory = join(this.common, 'code-awareness-integration-previews')
    mkdirSync(directory, { recursive: true })
    const files = readdirSync(directory).filter(file => /^preview-[a-f0-9-]{36}\.json$/.test(file))
    let retained = 0
    for (const file of files) {
      const previous = JSON.parse(readFileSync(join(directory, file), 'utf8')) as WorktreeIntegrationPreview
      if (previous.previewId + '.json' !== file) throw new Error('WORKTREE_PREVIEW_STALE')
      if (Date.parse(previous.expiresAt) <= Date.now()) unlinkSync(join(directory, file))
      else retained++
    }
    if (retained >= 100) throw new Error('WORKTREE_PREVIEW_CAPACITY')
    writeFileSync(join(directory, preview.previewId + '.json'), JSON.stringify(preview), { flag: 'wx', mode: 0o600 })
    return preview
  }

  get(previewId: string): WorktreeIntegrationPreview {
    if (!/^preview-[a-f0-9-]{36}$/.test(previewId)) throw new Error('INVALID_ARGUMENT')
    const file = join(this.common, 'code-awareness-integration-previews', previewId + '.json')
    if (!existsSync(file)) throw new Error('WORKTREE_PREVIEW_NOT_FOUND')
    const preview = JSON.parse(readFileSync(file, 'utf8')) as WorktreeIntegrationPreview
    if (preview.previewId !== previewId || Date.parse(preview.expiresAt) <= Date.now()) throw new Error('WORKTREE_PREVIEW_STALE')
    return preview
  }
}
