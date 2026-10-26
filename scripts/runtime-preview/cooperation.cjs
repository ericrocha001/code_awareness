const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const prefix = '/__runtime_preview__'
function configuration() {
  if (!process.env.PREVIEW_SESSION_ID) return null
  const config = JSON.parse(fs.readFileSync(process.env.PREVIEW_SESSION_CONFIG, 'utf8'))
  if (config.sessionId !== process.env.PREVIEW_SESSION_ID || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('PREVIEW_CONFIGURATION_INVALID')
  if (fs.realpathSync(process.cwd()).toLowerCase() !== config.worktree.toLowerCase()) throw new Error('WRONG_CHECKOUT')
  return config
}
function vitePreviewPlugin() {
  const config = configuration()
  if (!config) return { name: 'runtime-preview-disabled' }
  const observed = new Map(), loaded = new Map(), inputs = new Map()
  let viteRoot = config.worktree
  const files = config.artifacts.filter(a => ['WEB', 'ELECTRON_RENDERER'].includes(a.component))
  const selected = id => files.find(a => path.resolve(config.worktree, a.path).toLowerCase() === path.resolve(id.split('?')[0]).toLowerCase())
  const capture = { name: 'runtime-preview-input-capture', enforce: 'pre', transform(code, id) {
    const artifact = selected(id)
    if (artifact) inputs.set(artifact.path, hash(code))
    return null
  } }
  const instrument = {
    name: 'runtime-preview-cooperation', enforce: 'post',
    config: () => ({ cacheDir: path.join(config.directory, 'vite-cache'), server: { host: '127.0.0.1', port: config.port, strictPort: true, cors: false } }),
    configResolved(resolved) {
      viteRoot = resolved.root
      if (resolved.server.port !== config.port || !resolved.server.strictPort || resolved.server.host !== '127.0.0.1' || (resolved.server.hmr && resolved.server.hmr.port && resolved.server.hmr.port !== config.port)) throw new Error('ENDPOINT_CONFIGURATION_INCOMPATIBLE')
      const options = resolved.optimizeDeps?.esbuildOptions ?? {}
      const nativeOptimizer = Object.keys(options).every(key => key === 'preserveSymlinks' && options[key] === false)
      fs.writeFileSync(path.join(config.directory, 'dependency-cache-policy.json'), JSON.stringify({ schemaVersion: 1, nativeOptimizer }), { mode: 0o600 })
    },
    transform(code, id) {
      const artifact = selected(id)
      if (!artifact) return null
      const sourceDigest = inputs.get(artifact.path), transformDigest = hash(code)
      if (!sourceDigest) throw new Error('SOURCE_TRANSFORM_UNVERIFIABLE')
      observed.set(artifact.path, { ...artifact, sourceDigest, transformDigest, servedDigest: null })
      const report = JSON.stringify({ path: artifact.path, sourceDigest, transformDigest })
      if (artifact.component === 'ELECTRON_RENDERER') {
        fs.writeFileSync(path.join(config.directory, 'renderer-transforms.json'), JSON.stringify([...observed.values()].filter(a => a.component === 'ELECTRON_RENDERER')))
        return { code: code + `\n;window.__runtimePreview?.initialized(${report});\n`, map: null }
      }
      return { code: code + `\n;fetch(${JSON.stringify(prefix + '/loaded')},{method:'POST',headers:{'Content-Type':'application/json','X-Preview-Token':${JSON.stringify(config.token)}},body:JSON.stringify(${report})}).catch(()=>{});\n`, map: null }
    },
    handleHotUpdate(context) {
      const artifact = selected(context.file)
      if (artifact) { loaded.delete(artifact.path); observed.delete(artifact.path) }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url, 'http://127.0.0.1')
        const artifact = files.find(a => url.pathname === '/' + path.relative(viteRoot, path.resolve(config.worktree, a.path)).replace(/\\/g, '/'))
        if (artifact) {
          const chunks = []; let size = 0
          const write = res.write.bind(res), end = res.end.bind(res)
          const capture = chunk => { if (chunk) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length; if (size <= 2097152) chunks.push(bytes) } }
          res.write = (chunk, ...args) => { capture(chunk); return write(chunk, ...args) }
          res.end = (chunk, ...args) => {
            capture(chunk)
            const current = observed.get(artifact.path)
            if (current && res.statusCode === 200 && size <= 2097152) current.servedDigest = hash(Buffer.concat(chunks))
            return end(chunk, ...args)
          }
        }
        if (!url.pathname.startsWith(prefix + '/')) return next()
        res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json')
        if (req.headers['x-preview-token'] !== config.token) { res.statusCode = 403; return res.end('{}') }
        if (url.pathname === prefix + '/evidence' && req.method === 'GET') {
          let electron = null
          const evidencePath = path.join(config.directory, 'electron-evidence.json')
          if (config.kind === 'ELECTRON' && fs.existsSync(evidencePath) && fs.statSync(evidencePath).size < 65536) {
            try { electron = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) } catch { }
          }
          return res.end(JSON.stringify({
          schemaVersion: 1, sessionId: config.sessionId, challenge: req.headers['x-preview-challenge'], pid: process.pid,
          worktree: config.worktree, profile: config.profile, runtime: process.versions.node, abi: process.versions.modules,
          artifacts: [...observed.values()].map(a => ({ ...a, loaded: a.component === 'ELECTRON_RENDERER' ? !!electron?.rendererModules?.some(m => m.path === a.path && m.transformDigest === a.transformDigest && m.sourceDigest === a.sourceDigest) : loaded.get(a.path)?.transformDigest === a.transformDigest })), electron
          }))
        }
        if (url.pathname === prefix + '/loaded' && req.method === 'POST' && (!req.headers.origin || req.headers.origin === `http://127.0.0.1:${config.port}`)) {
          let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 8192) req.destroy() })
          req.on('end', () => {
            try {
              const report = JSON.parse(body), current = observed.get(report.path)
              if (!current || current.component === 'ELECTRON_RENDERER' || report.sourceDigest !== current.sourceDigest || report.transformDigest !== current.transformDigest) { res.statusCode = 409; return res.end('{}') }
              loaded.set(report.path, report); res.end('{}')
            } catch { res.statusCode = 400; res.end('{}') }
          }); return
        }
        res.statusCode = 404; res.end('{}')
      })
    }
  }
  return [capture, instrument]
}
function startCooperativeWeb(config) {
  if (config.artifacts.length !== 1 || config.artifacts[0].component !== 'WEB') throw new Error('NODE_WEB_SCOPE_UNSUPPORTED')
  const artifact = config.artifacts[0], source = path.resolve(config.worktree, artifact.path)
  let current = null, loaded = null
  const http = require('node:http')
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(fs.readFileSync(path.join(path.dirname(source), 'index.html'))) }
    if (req.url === '/feature.js') {
      const code = fs.readFileSync(source, 'utf8'), sourceDigest = hash(code), transformDigest = hash(code)
      const report = JSON.stringify({ path: artifact.path, sourceDigest, transformDigest })
      const body = code + `\n;fetch('${prefix}/loaded',{method:'POST',headers:{'X-Preview-Token':${JSON.stringify(config.token)}},body:JSON.stringify(${report})}).catch(()=>{});\n`
      current = { ...artifact, sourceDigest, transformDigest, servedDigest: hash(body) }
      res.setHeader('Content-Type', 'application/javascript'); return res.end(body)
    }
    if (req.headers['x-preview-token'] !== config.token) { res.statusCode = 403; return res.end('{}') }
    res.setHeader('Content-Type', 'application/json')
    if (req.url === prefix + '/evidence') return res.end(JSON.stringify({ schemaVersion: 1, sessionId: config.sessionId, challenge: req.headers['x-preview-challenge'], pid: process.pid,
      worktree: config.worktree, profile: config.profile, runtime: process.versions.node, abi: process.versions.modules,
      artifacts: current ? [{ ...current, loaded: loaded === current.transformDigest }] : [], electron: null }))
    if (req.url === prefix + '/loaded' && req.method === 'POST') {
      let body = ''; req.on('data', bytes => { body += bytes; if (body.length > 8192) req.destroy() })
      req.on('end', () => {
        try { const value = JSON.parse(body); if (current && value.path === current.path && value.sourceDigest === current.sourceDigest && value.transformDigest === current.transformDigest) loaded = value.transformDigest; else res.statusCode = 409 } catch { res.statusCode = 400 }
        res.end('{}')
      }); return
    }
    res.statusCode = 404; res.end('{}')
  })
  server.listen({ host: '127.0.0.1', port: config.port, exclusive: true })
}
module.exports = { configuration, vitePreviewPlugin, startCooperativeWeb, hash, prefix }
