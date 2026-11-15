import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  normalizeConsentProjectId,
  type WebConsentRecord,
  type WebEgressDataClass
} from './web-activation-types'

interface PersistedConsentFile {
  version: 1
  records: WebConsentRecord[]
}

function normalizeSite(site: string): string {
  return site.trim().toLowerCase()
}

function consentKey(site: string, projectId: string, dataClass: WebEgressDataClass): string {
  return `${normalizeSite(site)}::${normalizeConsentProjectId(projectId)}::${dataClass}`
}

export class ConsentStore {
  readonly filePath: string
  private loadedMtimeMs = -1
  private loadedSize = -1
  private records = new Map<string, WebConsentRecord>()

  constructor(storageDirOrFile: string) {
    this.filePath = storageDirOrFile.endsWith('.json')
      ? storageDirOrFile
      : join(storageDirOrFile, 'consents.json')
    this.reloadIfChanged()
  }

  hasConsent(site: string, projectId: string | null | undefined, dataClass: WebEgressDataClass): boolean {
    this.reloadIfChanged()
    const normalizedSite = normalizeSite(site)
    if (!normalizedSite) return false
    return this.records.has(consentKey(normalizedSite, normalizeConsentProjectId(projectId), dataClass))
  }

  listConsents(filter?: {
    site?: string
    projectId?: string | null
    dataClass?: WebEgressDataClass
  }): WebConsentRecord[] {
    this.reloadIfChanged()
    const siteFilter = filter?.site ? normalizeSite(filter.site) : null
    const projectFilter = filter?.projectId !== undefined ? normalizeConsentProjectId(filter.projectId) : null
    const classFilter = filter?.dataClass ?? null

    const out: WebConsentRecord[] = []
    for (const record of this.records.values()) {
      if (siteFilter && record.site !== siteFilter) continue
      if (projectFilter && record.projectId !== projectFilter) continue
      if (classFilter && record.dataClass !== classFilter) continue
      out.push({ ...record })
    }
    return out
  }

  grantConsent(input: {
    site: string
    projectId?: string | null
    dataClass: WebEgressDataClass
    origin?: string
  }): WebConsentRecord {
    this.reloadIfChanged()
    const normalizedSite = normalizeSite(input.site)
    if (!normalizedSite) {
      throw new Error('INVALID_SITE')
    }
    const projectId = normalizeConsentProjectId(input.projectId)
    const record: WebConsentRecord = {
      site: normalizedSite,
      projectId,
      dataClass: input.dataClass,
      ...(input.origin ? { origin: input.origin } : {}),
      grantedAt: new Date().toISOString()
    }
    this.records.set(consentKey(normalizedSite, projectId, input.dataClass), record)
    this.persist()
    return { ...record }
  }

  revokeConsent(filter: {
    site?: string
    projectId?: string | null
    dataClass?: WebEgressDataClass
  }): number {
    this.reloadIfChanged()
    const siteFilter = filter.site ? normalizeSite(filter.site) : null
    const projectFilter = filter.projectId !== undefined ? normalizeConsentProjectId(filter.projectId) : null
    const classFilter = filter.dataClass ?? null

    let removed = 0
    for (const [key, record] of this.records.entries()) {
      if (siteFilter && record.site !== siteFilter) continue
      if (projectFilter && record.projectId !== projectFilter) continue
      if (classFilter && record.dataClass !== classFilter) continue
      this.records.delete(key)
      removed++
    }
    if (removed > 0) {
      this.persist()
    }
    return removed
  }

  private reloadIfChanged(): void {
    if (!existsSync(this.filePath)) {
      this.records.clear()
      this.loadedMtimeMs = -1
      this.loadedSize = -1
      return
    }
    let mtimeMs = -1
    let size = -1
    try {
      const st = statSync(this.filePath)
      mtimeMs = st.mtimeMs
      size = st.size
    } catch {
      return
    }
    if (mtimeMs === this.loadedMtimeMs && size === this.loadedSize) return

    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PersistedConsentFile>
      this.records.clear()
      if (Array.isArray(parsed.records)) {
        for (const item of parsed.records) {
          if (
            item &&
            typeof item.site === 'string' &&
            typeof item.projectId === 'string' &&
            (item.dataClass === 'METADATA' || item.dataClass === 'LITERAL_SOURCE') &&
            typeof item.grantedAt === 'string'
          ) {
            const normalizedSite = normalizeSite(item.site)
            const projectId = normalizeConsentProjectId(item.projectId)
            this.records.set(consentKey(normalizedSite, projectId, item.dataClass), {
              site: normalizedSite,
              projectId,
              dataClass: item.dataClass,
              ...(typeof item.origin === 'string' ? { origin: item.origin } : {}),
              grantedAt: item.grantedAt
            })
          }
        }
      }
      this.loadedMtimeMs = mtimeMs
      this.loadedSize = size
    } catch {
      this.records.clear()
      this.loadedMtimeMs = -1
      this.loadedSize = -1
    }
  }

  private persist(): void {
    const dir = dirname(this.filePath)
    mkdirSync(dir, { recursive: true })
    const payload: PersistedConsentFile = {
      version: 1,
      records: Array.from(this.records.values())
    }
    const tmpPath = join(dir, `.consents-${randomUUID()}.tmp`)
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmpPath, this.filePath)
    try {
      const st = statSync(this.filePath)
      this.loadedMtimeMs = st.mtimeMs
      this.loadedSize = st.size
    } catch {
      this.loadedMtimeMs = -1
      this.loadedSize = -1
    }
  }
}
