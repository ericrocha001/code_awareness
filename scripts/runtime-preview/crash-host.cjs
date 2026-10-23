const fs = require('node:fs')
const { RuntimePreviewRunner } = require(process.argv[2])
const { PreviewSessionStore } = require(process.argv[3])
const config = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'))
const authority = { async prepare() {
  return { profile: config.profile, worktree: config.worktree, gitFingerprint: 'controlled-fixture-identity',
    preflight: { status: 'SUPPORTED', selection: config.input.selection, profileRevision: 1 }, guard: async () => {} }
} }
const runner = new RuntimePreviewRunner(new PreviewSessionStore(config.store), authority, config.helper)
runner.start(config.input).then(record => {
  if (record.state !== 'RUNNING') throw new Error('CONTROLLED_START_FAILED')
  process.stdout.write(JSON.stringify({ sessionId: record.sessionId }) + '\n', () => process.exit(91))
}).catch(() => process.exit(92))
