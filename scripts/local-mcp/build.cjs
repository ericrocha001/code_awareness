const { buildSync } = require('esbuild')
const { resolve } = require('node:path')

buildSync({
  entryPoints: [resolve(__dirname, 'launcher.cjs')],
  outfile: resolve(__dirname, '../../out/local-mcp/launcher.cjs'),
  bundle: true, platform: 'node', target: 'node20', format: 'cjs', logLevel: 'silent'
})
