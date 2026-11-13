import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AcademyImportConfirmationMode,
  AcademyImportConfirmationPreference
} from '../../shared/types/academy-types'

const PREFERENCE_FILENAME = 'import-confirmation-preference.json'

interface PersistedImportConfirmationPreference {
  schemaVersion: 1
  mode: AcademyImportConfirmationMode
  updatedAt: string | null
}

export function importConfirmationPreferencePath(baseDir: string): string {
  return join(baseDir, PREFERENCE_FILENAME)
}

export function readSharedImportConfirmationPreference(baseDir: string): AcademyImportConfirmationPreference {
  const filePath = importConfirmationPreferencePath(baseDir)
  try {
    if (!existsSync(filePath)) {
      return { mode: 'MANUAL', updatedAt: null }
    }
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PersistedImportConfirmationPreference>
    const mode: AcademyImportConfirmationMode = raw?.mode === 'AUTOMATIC' ? 'AUTOMATIC' : 'MANUAL'
    const updatedAt = typeof raw?.updatedAt === 'string' ? raw.updatedAt : null
    return { mode, updatedAt }
  } catch {
    return { mode: 'MANUAL', updatedAt: null }
  }
}

export function writeSharedImportConfirmationPreference(
  baseDir: string,
  mode: AcademyImportConfirmationMode
): AcademyImportConfirmationPreference {
  if (mode !== 'MANUAL' && mode !== 'AUTOMATIC') {
    throw new Error(`INVALID_IMPORT_CONFIRMATION_MODE: ${String(mode)}`)
  }
  mkdirSync(baseDir, { recursive: true })
  const filePath = importConfirmationPreferencePath(baseDir)
  const tmpPath = `${filePath}.${randomUUID()}.tmp`
  const preference: AcademyImportConfirmationPreference = {
    mode,
    updatedAt: new Date().toISOString()
  }
  const payload: PersistedImportConfirmationPreference = {
    schemaVersion: 1,
    mode: preference.mode,
    updatedAt: preference.updatedAt
  }
  try {
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmpPath, filePath)
    return preference
  } catch (error) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // ignore cleanup error
    }
    throw error
  }
}
