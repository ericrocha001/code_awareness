const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { connect } = require('./client.cjs')
const { readDescriptor } = require('./discovery.cjs')

async function validationConnection(cwd, profile) {
  const descriptor = readDescriptor(profile, { directory: 'local-agent-channel', protocol: 'code-awareness-local/v1' })
  const send = (domain, action, args) => connect(descriptor, { domain, action, args }, { timeoutMs: action === 'snapshot' ? 12000 : 2000 })
  const status = await send('continuum', 'status', {})
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value
  const root = fs.realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 2000 }).trim())
  const worktree = status.worktrees?.find(tree => {
    try { return normalize(fs.realpathSync(tree.path)) === normalize(root) } catch { return false }
  })
  if (!worktree || !status.repository?.repositoryId) throw Object.assign(new Error('WORKTREE_UNLINKED'), { code: 'WORKTREE_UNLINKED' })
  const identity = { repositoryId: status.repository.repositoryId, worktreeId: worktree.worktreeId, generation: worktree.generation }
  return { identity, snapshot: () => send('validation', 'snapshot', identity), register: (receiptId, association) => send('validation', 'register', { ...identity, receiptId, ...(association ? { association } : {}) }) }
}

async function registerReceipt(id, { cwd = process.cwd(), profile, association } = {}) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_RECEIPT_ID')
  const connection = await validationConnection(cwd, profile)
  return connection.register(id, association)
}
module.exports = { validationConnection, registerReceipt }
