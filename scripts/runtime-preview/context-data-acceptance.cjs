const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { spawn } = require('node:child_process'), assert = require('node:assert/strict'), { createHash } = require('node:crypto')
const root = process.cwd(), output = path.join(root, '.code-awareness/active-context-b')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  child.on('exit', code => { process.exitCode = code ?? 1 })
} else {
  const { app, clipboard } = require('electron'), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-data-proof-'))
  for (const key of ['appData', 'userData', 'sessionData', 'home', 'temp']) { const file = path.join(directory, key); fs.mkdirSync(file); app.setPath(key, file) }
  app.setName('Preview Private Corpus Acceptance'); app.enableSandbox()
  app.whenReady().then(() => {
    const evidenceRoot = path.join(output, 'acceptance-snapshot'), identity = JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'identity.json')))
    const get = name => require(path.join(evidenceRoot, 'bundle', name + '.js'))
    const sessions = new (get('work-orchestration/runtime-preview/session-store').PreviewSessionStore)(path.join(identity.directory, 'sessions'))
    const records = sessions.list().filter(record => record.state === 'RUNNING'); assert.equal(records.length, 1)
    const record = records[0]; assert.equal(record.context.data.policy, 'REPOSITORY_SNAPSHOT'); assert.equal(record.selection.repositoryId, record.context.data.repositoryId)
    const entries = ['artifact-store', 'continuum-service', 'artifact-metadata'], pkg = require(path.join(root, 'package.json'))
    const external = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(name => !['mdast-util-from-markdown', 'micromark-extension-gfm', 'mdast-util-gfm', 'mdast-util-to-string'].includes(name))
    const bundle = path.join(output, 'data-bundle')
    require('esbuild').buildSync({ entryPoints: entries.map(file => 'src/main/continuum/' + file + '.ts'), outdir: bundle, platform: 'node', format: 'cjs', bundle: true, external, logLevel: 'silent' })
    const userData = path.join(sessions.runtime(record.sessionId), 'userData')
    const file = get('work-orchestration/runtime-preview/context-data').previewCorpusPath(userData, record.selection.repositoryId)
    assert.equal(fs.realpathSync(file).toLowerCase(), path.resolve(file).toLowerCase())
    const { ArtifactStore } = require(path.join(bundle, 'artifact-store.js')), { ContinuumService } = require(path.join(bundle, 'continuum-service.js'))
    const { parseArtifactMarkdown } = require(path.join(bundle, 'artifact-metadata.js'))
    const store = new ArtifactStore(file, record.selection.repositoryId)
    try {
      const service = new ContinuumService(store), first = service.list({ limit: 1 }).artifacts[0]; assert.ok(first)
      const original = service.get(first.artifactId), parsed = parseArtifactMarkdown(original.rawMarkdown)
      const tags = Array.isArray(original.metadata.tags) ? original.metadata.tags : []
      const rawMarkdown = '---\n' + JSON.stringify({ ...original.metadata, tags: [...tags, 'unit-b-private-only'] }) + '\n---\n' + parsed.body
      const changed = service.update(original.artifactId, original.revision, rawMarkdown)
      assert.equal(changed.revision, original.revision + 1)
      const current = service.get(original.artifactId); assert.ok(current.metadata.tags.includes('unit-b-private-only'))
      clipboard.writeText(current.rawMarkdown); assert.equal(clipboard.readText(), current.rawMarkdown)
      const markdownFile = path.join(output, 'snapshot-private-export.md'); fs.writeFileSync(markdownFile, current.rawMarkdown)
      assert.deepEqual(fs.readFileSync(markdownFile), Buffer.from(current.rawMarkdown))
      const visual = service.list({ kind: 'VISUAL_REFERENCE', limit: 1 }).artifacts[0]; assert.ok(visual)
      const media = service.getVisual(visual.artifactId), visualFile = path.join(output, 'snapshot-private-export.webp'); fs.writeFileSync(visualFile, media.data)
      assert.deepEqual(fs.readFileSync(visualFile), media.data)
      fs.writeFileSync(path.join(output, 'snapshot-data-proof.json'), JSON.stringify({ scope: 'PRODUCTION_SERVICES_OVER_REAL_PREVIEW_COPY_WITH_NATIVE_CLIPBOARD', sessionId: record.sessionId, selection: record.selection,
        dataOrigin: record.context.data, artifactId: original.artifactId, originalRevision: original.revision, privateRevision: current.revision, tag: 'unit-b-private-only',
        markdown: { bytes: fs.statSync(markdownFile).size, digest: hash(fs.readFileSync(markdownFile)), clipboardMatched: true }, media: { artifactId: visual.artifactId, bytes: media.data.length, digest: hash(media.data) } }, null, 2))
    } finally { store.close() }
    console.log('Real preview private corpus tag/copy/export PASS'); app.exit(0)
  }).catch(error => { console.error(error.stack); app.exit(1) })
}
