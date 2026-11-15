const { buildSync } = require('esbuild')
const { resolve } = require('node:path')
buildSync({ entryPoints: [resolve(__dirname, '../../src/main/session-context/native-hook-command.ts')],
  outfile: resolve(__dirname, '../../out/session-context/native-hook.cjs'), bundle: true, platform: 'node', target: 'node20', format: 'cjs' })

const portable = buildSync({ entryPoints: [resolve(__dirname, '../../src/main/session-context/native-hook-command.ts')], write: false,
  bundle: true, platform: 'node', target: 'node24', format: 'cjs', define: { __CODE_AWARENESS_DISTRIBUTED_CAPTURE__: 'true' } }).outputFiles[0].text
buildSync({ entryPoints: [resolve(__dirname, '../../src/main/session-context/native-hook-catalog-cli.ts')],
  outfile: resolve(__dirname, '../../out/session-context/native-hooks-catalog.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs',
  define: { __CODE_AWARENESS_NATIVE_HOOK_BUNDLE__: JSON.stringify(portable) } })
