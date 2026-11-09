const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { connect } = require('./client.cjs')
const { readDescriptor } = require('./discovery.cjs')

async function validationConnection(cwd, profile) {
  const descriptor = readDescriptor(profile, { directory: 'local-agent-channel', protocol: 'code-awareness-local/v1' })
  const send = async (domain, action, args) => {
    try { return await connect(descriptor, { domain, action, args }, { timeoutMs: action === 'snapshot' || action === 'register' ? 12000 : 2000 }) }
    catch (error) { error.operation = action; throw error }
  }
  const status = await send('continuum', 'status', {})
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value
  let root
  try { root = fs.realpathSync(execFileSync('git', ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 2000 }).trim()) }
  catch { throw Object.assign(new Error('WORKTREE_UNAVAILABLE'), { code: 'WORKTREE_UNAVAILABLE', stage: 'worktree', reason: 'ROOT_UNAVAILABLE', operation: 'worktree' }) }
  const worktree = status.worktrees?.find(tree => {
    try { return normalize(fs.realpathSync(tree.path)) === normalize(root) } catch { return false }
  })
  if (!worktree || !status.repository?.repositoryId) throw Object.assign(new Error('WORKTREE_UNLINKED'), { code: 'WORKTREE_UNLINKED', stage: 'worktree', reason: 'IDENTITY_UNAVAILABLE', operation: 'worktree' })
  const identity = { repositoryId: status.repository.repositoryId, worktreeId: worktree.worktreeId, generation: worktree.generation }
  return { identity, snapshot: () => send('validation', 'snapshot', identity), register: (receiptId, association) => send('validation', 'register', { ...identity, receiptId, ...(association ? { association } : {}) }) }
}

async function registerReceipt(id, { cwd = process.cwd(), profile, association } = {}) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_RECEIPT_ID')
  const connection = await validationConnection(cwd, profile)
  return connection.register(id, association)
}
module.exports = { validationConnection, registerReceipt }
