import { createServer, type Server } from 'node:http'
import { timingSafeEqual, randomUUID } from 'node:crypto'
import { opendir, realpath, writeFile, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { PreviewContextManifest } from './context-contract'
import { previewCapabilities, previewChannelRequest, previewChannelReply, type PreviewChannelRequest } from './channel-contract'

const empty = z.object({}).strict()
const listing = z.object({ path: z.string().max(1024).default('.'), offset: z.number().int().min(0).max(1000).default(0) }).strict()
const scopeMatches = (request: PreviewChannelRequest, context: PreviewContextManifest) => request.scope.sessionId === context.sessionId &&
  ['repositoryId', 'worktreeId', 'generation'].every(key => request.scope[key as keyof typeof request.scope] === context.selection[key as keyof typeof context.selection])
export async function startPreviewChannel(context: PreviewContextManifest, token: string, directory: string,
  readiness: () => Record<string, { state: string; reasonCode?: string }> | undefined) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('PREVIEW_CHANNEL_CONFIGURATION_INVALID')
  const identity = { sessionId: context.sessionId, ...Object.fromEntries(['repositoryId', 'worktreeId', 'generation'].map(key => [key, context.selection[key as keyof typeof context.selection]])),
    ...(context.snapshot ? { build: { captureId: context.snapshot.captureId, buildId: context.snapshot.buildId, runtimeId: context.snapshot.runtimeId } } : {}),
    instanceId: randomUUID(), pid: process.pid, runtime: process.versions.electron ?? process.versions.node, abi: process.versions.modules, source: context.source }
  const root = await realpath(context.snapshot?.sourceDirectory ?? context.worktree), file = join(directory, 'channel.json')
  let active = true
  const sockets = new Set<import('node:net').Socket>()
  const server: Server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store')
    const credential = req.headers['x-preview-channel-token']
    if (req.method !== 'POST' || req.url !== '/' || typeof credential !== 'string' || !/^[a-f0-9]{64}$/.test(credential) ||
      !timingSafeEqual(Buffer.from(credential), Buffer.from(token))) { res.statusCode = 403; res.end('{}'); return }
    let bytes = 0
    const chunks: Buffer[] = []
    try {
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 8192) throw Error('SCOPE_REJECTED'); chunks.push(chunk) }
      const parsed = previewChannelRequest.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (!parsed.success) { res.statusCode = 400; res.end('{}'); return }
      const request = parsed.data
      let result: unknown
      try {
        if (!active || !readiness()) throw Error('SESSION_STALE')
        if (!scopeMatches(request, context)) throw Error('SCOPE_REJECTED')
        if (!previewCapabilities.some(capability => capability.operation === request.operation)) throw Error('CAPABILITY_UNAVAILABLE')
        if (request.operation !== 'checkout.list' && !empty.safeParse(request.input).success) throw Error('SCOPE_REJECTED')
        if (request.operation === 'runtime.identity') result = { kind: 'IDENTITY', identity }
        if (request.operation === 'runtime.liveness') result = { kind: 'LIVENESS', alive: true }
        if (request.operation === 'runtime.capabilities') result = { kind: 'CAPABILITIES', version: 1, capabilities: previewCapabilities, readiness: readiness() }
        if (request.operation === 'checkout.list') {
          const input = listing.safeParse(request.input)
          if (!input.success) throw Error('SCOPE_REJECTED')
          const { path, offset } = input.data
          if (isAbsolute(path) || /[:\\\0]/.test(path) || path.split('/').some(part => part.startsWith('.') && part !== '.' || part === 'node_modules')) throw Error('SCOPE_REJECTED')
          const target = await realpath(resolve(root, path)), scope = relative(root, target)
          if (scope === '..' || scope.startsWith('..' + sep) || isAbsolute(scope)) throw Error('SCOPE_REJECTED')
          const entries: Array<{ name: string; kind: 'FILE' | 'DIRECTORY' }> = []
          let index = 0, more = false
          for await (const entry of await opendir(target)) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) continue
            if (index++ < offset) continue
            if (entries.length === 20) { more = true; break }
            entries.push({ name: entry.name, kind: entry.isDirectory() ? 'DIRECTORY' : 'FILE' })
          }
          result = { kind: 'CHECKOUT', path: relative(root, target).replace(/\\/g, '/') || '.', entries, nextOffset: more && offset < 1000 ? offset + entries.length : null }
        }
        if (!active || !readiness()) throw Error('SESSION_STALE')
        res.end(JSON.stringify(previewChannelReply.parse({ version: 1, requestId: request.requestId, identity, result: { success: true, data: result } })))
      } catch (error) {
        const code = error instanceof Error && ['SESSION_STALE', 'SCOPE_REJECTED', 'CAPABILITY_UNAVAILABLE'].includes(error.message) ? error.message : 'SCOPE_REJECTED'
        res.end(JSON.stringify(previewChannelReply.parse({ version: 1, requestId: request.requestId, identity, result: { success: false, code } })))
      }
    } catch { res.destroy() }
  })
  server.maxConnections = 4; server.requestTimeout = 3000; server.headersTimeout = 3000
  server.on('connection', socket => { sockets.add(socket); socket.setTimeout(3000, () => socket.destroy()); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, accept) })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('PREVIEW_CHANNEL_UNAVAILABLE')
  try { await writeFile(file, JSON.stringify({ version: 1, sessionId: context.sessionId, port: address.port, pid: process.pid }), { flag: 'wx', mode: 0o600 }) }
  catch (error) { server.close(); throw error }
  return async () => {
    active = false
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(accept => server.close(() => accept()))
    await unlink(file).catch(() => {})
  }
}
