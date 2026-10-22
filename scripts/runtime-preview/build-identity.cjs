const path = require('node:path')
const { configuration, hash } = require('./cooperation.cjs')
function buildIdentity(component) {
  const config = configuration()
  if (!config) return { name: 'runtime-preview-build-disabled' }
  const inputs = new Map()
  return {
    name: 'runtime-preview-build-identity', enforce: 'pre',
    config: () => ({ build: { watch: null } }),
    configResolved(resolved) { if (resolved.build.watch) throw new Error('AUTOMATIC_ELECTRON_RESTART_FORBIDDEN') },
    transform(code, id) {
      const artifact = config.artifacts.find(a => a.component === component && path.resolve(config.worktree, a.path).toLowerCase() === path.resolve(id.split('?')[0]).toLowerCase())
      if (artifact) inputs.set(artifact.path, hash(code))
      return null
    },
    renderChunk: { order: 'post', handler(code, chunk) {
      const sources = {}
      for (const artifact of config.artifacts.filter(a => a.component === component)) {
        const absolute = path.resolve(config.worktree, artifact.path)
        if (Object.keys(chunk.modules).some(file => path.resolve(file).toLowerCase() === absolute.toLowerCase()) && inputs.has(artifact.path)) sources[artifact.path] = inputs.get(artifact.path)
      }
      if (!Object.keys(sources).length) return null
      const identity = JSON.stringify({ component, artifactDigest: hash(code), sources })
      return { code: `;(globalThis.__RUNTIME_PREVIEW_BUILDS__??=[]).push(${identity});\n` + code, map: null }
    } }
  }
}
module.exports = { buildIdentity }
