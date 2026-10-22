import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { bytesFingerprint } from '../preview-profile'
export function resolvePreviewHelper(config: { packaged: boolean; resources: string; root: string; developmentBuild?: string }) {
  let executable: string, receiptFile: string, selectedBuildId: string | undefined
  if (config.packaged) {
    executable = join(config.resources, 'runtime-preview/preview-owner.exe')
    receiptFile = join(config.resources, 'runtime-preview/build-receipt.json')
  } else {
    if (!config.developmentBuild) throw new Error('PREVIEW_HELPER_NOT_CONFIGURED')
    const selected = JSON.parse(config.developmentBuild)
    if (typeof selected.owner !== 'string' || typeof selected.receipt !== 'string' || !/^[a-f0-9]{64}$/.test(selected.buildId)) throw new Error('PREVIEW_HELPER_BUILD_INVALID')
    executable = resolve(selected.owner); receiptFile = resolve(selected.receipt)
    selectedBuildId = selected.buildId
    if (dirname(executable) !== dirname(receiptFile)) throw new Error('PREVIEW_HELPER_BUILD_INVALID')
  }
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'))
  if (selectedBuildId && receipt.buildId !== selectedBuildId) throw new Error('PREVIEW_HELPER_BUILD_INVALID')
  if (!/^[a-f0-9]{64}$/.test(receipt.buildId) || bytesFingerprint(Buffer.from(JSON.stringify(receipt.inputs))) !== receipt.buildId) throw new Error('PREVIEW_HELPER_BUILD_INVALID')
  if (receipt.version !== 1 || receipt.inputs?.mode !== 'production' || receipt.inputs?.architecture !== 'x64' || receipt.outputs?.['controlled-helper.exe']) throw new Error('PREVIEW_HELPER_BUILD_INVALID')
  const fingerprint = receipt.outputs?.['preview-owner.exe']?.sha256
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || bytesFingerprint(readFileSync(executable)) !== fingerprint) throw new Error('PREVIEW_HELPER_INTEGRITY_MISMATCH')
  return { executable, fingerprint, sdkDirectory: config.packaged ? join(config.resources, 'runtime-preview/sdk') : join(config.root, 'scripts/runtime-preview') }
}
