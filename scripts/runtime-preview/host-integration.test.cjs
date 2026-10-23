const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')

test('optional preview compiler failure does not prevent the existing host supervisor from launching', () => {
  let supervisor, invocation, warning
  const source = fs.readFileSync(path.resolve('scripts/dev-supervisor.cjs'), 'utf8')
  vm.runInNewContext(source, {
    __dirname: path.resolve('scripts'),
    process: { platform: 'win32', env: { CODE_AWARENESS_PREVIEW_NATIVE_BUILD: 'stale-inherited-build' }, on() {} },
    console: { warn: value => { warning = value } },
    require(name) {
      if (name === 'node:path') return path
      if (name === 'node:child_process') return { spawn: (...args) => { invocation = args } }
      if (name === './dev-supervisor-core.cjs') return { createDevSupervisor: options => { supervisor = options; return options }, createDevRuntimeEnvironment: env => env }
      if (name === './runtime-preview/build.cjs') return { build: () => { throw Error('CONTROLLED_COMPILER_UNAVAILABLE') } }
      throw Error('UNEXPECTED_IMPORT:' + name)
    }
  })
  supervisor.spawnRuntime({ port: 1234, token: 'fixture-only' })
  assert.equal(invocation[1].join(' '), '/d /s /c npm.cmd run dev:runtime')
  assert.equal(invocation[2].env.CODE_AWARENESS_PREVIEW_NATIVE_BUILD, '')
  assert.equal(invocation[2].shell, false)
  assert.equal(warning, '[Runtime Preview] PREVIEW_HELPER_UNAVAILABLE')
})
