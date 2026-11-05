const { buildSync } = require('esbuild')
const { resolve } = require('node:path')
buildSync({ entryPoints: [resolve(__dirname, '../../src/main/session-context/native-hook-command.ts')],
  outfile: resolve(__dirname, '../../out/session-context/native-hook.cjs'), bundle: true, platform: 'node', target: 'node20', format: 'cjs' })
