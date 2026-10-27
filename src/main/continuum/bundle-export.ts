import { app, BrowserWindow, clipboard, dialog } from 'electron'
import { dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { ContextBundle } from './context-bundle'
import type { ContinuumBundleExport } from '../../shared/types/continuum-bundle-types'

export function exportAgentContextBundle(bundle: ContextBundle, intent: ContinuumBundleExport['intent'], assertContext: () => void) {
  return exportContextBundle(bundle, intent, assertContext, BrowserWindow?.getFocusedWindow?.() ?? null)
}

export async function exportContextBundle(bundle: ContextBundle, intent: ContinuumBundleExport['intent'], assertContext: () => void, parent: BrowserWindow | null) {
  assertContext()
  if (!bundle.preview.members.length) throw new Error('BUNDLE_EMPTY')
  if (intent !== 'zip' && bundle.preview.compositionAvailable === false) throw new Error('BUNDLE_LIMIT: composição excede 8 MiB; refine a seleção ou salve ZIP com originais')
  const snapshotId = bundle.preview.snapshotId
  if (intent === 'copy') {
    if (!clipboard?.writeText) throw new Error('INTERACTIVE_SESSION_REQUIRED: native clipboard unavailable')
    clipboard.writeText(bundle.preview.markdown)
    return { outcome: 'copied' as const, snapshotId }
  }
  if (!parent || parent.isDestroyed() || !parent.isVisible()) throw new Error('INTERACTIVE_SESSION_REQUIRED: use Tags e pacotes na janela do aplicativo')
  const extension = intent === 'zip' ? 'zip' : 'md'
  const result = await dialog.showSaveDialog(parent, { title: 'Salvar Context Bundle', defaultPath: join(app.getPath('downloads'), `${bundle.preview.slug || 'selecao'}-context.${extension}`), filters: [{ name: extension === 'zip' ? 'Pacote completo ZIP' : 'Markdown', extensions: [extension] }], properties: ['showOverwriteConfirmation', 'createDirectory', 'dontAddToRecent'] })
  assertContext()
  if (result.canceled) return { outcome: 'cancelled' as const, snapshotId }
  if (!result.filePath || extname(result.filePath).toLowerCase() !== '.' + extension) throw new Error(`INVALID_EXPORT_EXTENSION: .${extension} obrigatório`)
  const data = intent === 'zip' ? await bundle.zip() : Buffer.from(bundle.preview.markdown, 'utf8')
  assertContext()
  const temporary = join(dirname(result.filePath), `.continuum-bundle-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, result.filePath)
  } finally { rmSync(temporary, { force: true }) }
  return { outcome: 'saved' as const, snapshotId }
}

export async function exportQuickContextBundle(bundle: ContextBundle, intent: ContinuumBundleExport['intent'], assertContext: () => void) {
  assertContext()
  if (!bundle.preview.members.length) throw new Error('BUNDLE_EMPTY')
  if (intent !== 'zip' && bundle.preview.compositionAvailable === false) throw new Error('BUNDLE_LIMIT: composição excede 8 MiB; refine a seleção ou salve ZIP com originais')
  const snapshotId = bundle.preview.snapshotId
  if (intent === 'copy') {
    if (!clipboard?.writeText) throw new Error('INTERACTIVE_SESSION_REQUIRED: native clipboard unavailable')
    clipboard.writeText(bundle.preview.markdown)
    return { outcome: 'copied' as const, snapshotId }
  }
  let downloadsDir: string
  try {
    downloadsDir = app.getPath('downloads')
    if (!downloadsDir || !existsSync(downloadsDir)) throw new Error('DOWNLOADS_UNAVAILABLE')
  } catch {
    throw new Error('DOWNLOADS_UNAVAILABLE: pasta de downloads inacessível')
  }
  const extension = intent === 'zip' ? 'zip' : 'md'
  const rawBase = bundle.preview.slug || 'selecao'
  const safeBase = `${rawBase.replace(/[^a-zA-Z0-9._-]/g, '_') || 'context'}-context`
  const data = intent === 'zip' ? await bundle.zip() : Buffer.from(bundle.preview.markdown, 'utf8')
  assertContext()
  const temporary = join(downloadsDir, `.continuum-bundle-${randomUUID()}.tmp`)
  let targetPath = ''
  try {
    writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 })
    assertContext()
    let counter = 0
    let saved = false
    while (!saved) {
      const filename = counter === 0 ? `${safeBase}.${extension}` : `${safeBase}-${counter}.${extension}`
      const candidate = join(downloadsDir, filename)
      if (existsSync(candidate)) {
        counter++
        continue
      }
      try {
        renameSync(temporary, candidate)
        if (!existsSync(candidate) || statSync(candidate).size !== data.length) {
          throw new Error('WRITE_VERIFICATION_FAILED: gravação não confirmada')
        }
        targetPath = candidate
        saved = true
      } catch (err: any) {
        if (err?.code === 'EEXIST' || err?.code === 'EPERM') {
          counter++
          continue
        }
        throw err
      }
    }
  } finally {
    rmSync(temporary, { force: true })
  }
  return { outcome: 'saved' as const, snapshotId, filePath: targetPath }
}
