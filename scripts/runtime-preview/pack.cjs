const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const { Arch } = require('builder-util')
const { build } = require('./build.cjs')
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
function production(context) {
  if (context.electronPlatformName !== 'win32' || context.arch !== Arch.x64) throw new Error('PREVIEW_HELPER_WINDOWS_X64_REQUIRED')
  return build(false, { root: context.packager.info.projectDir })
}
exports.beforePack = context => {
  const selected = production(context), config = context.packager.config
  const resources = config.extraResources == null ? [] : Array.isArray(config.extraResources) ? config.extraResources : [config.extraResources]
  config.extraResources = [...resources.filter(r => typeof r === 'string' || !['runtime-preview/preview-owner.exe', 'runtime-preview/build-receipt.json'].includes(r.to)),
    { from: selected.owner, to: 'runtime-preview/preview-owner.exe' }, { from: selected.receipt, to: 'runtime-preview/build-receipt.json' }]
}
exports.afterPack = context => {
  const selected = production(context), resources = join(context.appOutDir, 'resources/runtime-preview')
  if (hash(join(resources, 'preview-owner.exe')) !== selected.fingerprint || hash(join(resources, 'build-receipt.json')) !== hash(selected.receipt)) throw new Error('PACKAGED_PREVIEW_HELPER_INTEGRITY_MISMATCH')
}
