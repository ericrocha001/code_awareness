const { test } = require('node:test')
const assert = require('node:assert/strict')
const { validateEndpoint, sameBinding } = require('./bootstrap.cjs')
const { stableDestination, install } = require('./install.cjs')
const { mkdtempSync, rmSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const current = () => ({ status: 'RUNNING', protocol: 'code-awareness-mcp-bootstrap/v1',
  endpoint: 'http://127.0.0.1:12345/mcp', instanceId: 'instance', projectId: 'project',
  bindingId: 'binding', observedAt: new Date().toISOString() })

test('discovery accepts only fresh, explicit loopback identity and the expected project', () => {
  assert.equal(validateEndpoint(current(), 'project').projectId, 'project')
  for (const change of [
    { endpoint: 'https://example.com/mcp' }, { endpoint: 'http://127.0.0.1:65536/mcp' },
    { endpoint: 'http://localhost:1234/mcp' }, { endpoint: 'http://127.0.0.1:1234/mcp?redirect=true' },
    { instanceId: '' }, { bindingId: 'bad\r\nheader' }, { projectId: null },
    { status: 'UNAVAILABLE' }, { protocol: 'wrong' }, { observedAt: 'invalid' },
    { observedAt: new Date(Date.now() - 20000).toISOString() }
  ]) assert.throws(() => validateEndpoint({ ...current(), ...change }))
  assert.throws(() => validateEndpoint(current(), 'other'), { code: 'MCP_PROJECT_MISMATCH' })
})

test('restart, port reuse and project transitions never preserve a session binding', () => {
  const initial = current()
  assert.equal(sameBinding(initial, current()), true)
  for (const key of ['endpoint', 'instanceId', 'projectId', 'bindingId']) {
    assert.equal(sameBinding(initial, { ...initial, [key]: 'other' }), false)
  }
})

test('global launcher installation refuses ephemeral worktree paths', () => {
  assert.throws(() => stableDestination(join(tmpdir(), '.codex', 'worktrees', 'test', 'mcp')), /EPHEMERAL/)
  assert.equal(stableDestination(join(tmpdir(), 'CodeAwareness', 'mcp', 'v1')), join(tmpdir(), 'CodeAwareness', 'mcp', 'v1'))
})

test('installed bundle starts outside the checkout without node_modules and fails closed without a profile', () => {
  const directory = mkdtempSync(join(tmpdir(), 'local-mcp-installed-'))
  try {
    const receipt = install(directory)
    const child = spawnSync(process.execPath, [receipt.launcher, '--profile', join(directory, 'missing-profile')], {
      cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 15000
    })
    assert.equal(child.status, 1)
    assert.equal(child.stdout, '')
    assert.match(child.stderr, /PROFILE_NOT_FOUND/)
    assert.equal(child.stderr.includes('MODULE_NOT_FOUND'), false)
    assert.equal(receipt.codex.includes(receipt.launcher.replaceAll('\\', '\\\\')), true)
    assert.deepEqual(receipt.antigravity.mcpServers['code-awareness-local'].args, [receipt.launcher])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
