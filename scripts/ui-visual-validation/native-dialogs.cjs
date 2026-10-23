const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { localPath } = require('./evidence.cjs')

const fail = code => Object.assign(new Error(code), { code })
const reasons = new Set(['UNSUPPORTED_PLATFORM', 'DIALOG_NOT_FOUND', 'OWNER_MISMATCH', 'CONTROL_UNAVAILABLE', 'DIALOG_TIMEOUT', 'CANCEL_FAILED', 'HELPER_FAILED'])

function fixtureRegistry(temporary, definitions) {
  if (!Array.isArray(definitions) || !definitions.length) throw fail('FIXTURE_INVALID')
  const root = localPath(path.join(temporary, 'native-dialogs'))
  fs.mkdirSync(root, { mode: 0o700 })
  const fixtures = new Map()
  for (const item of definitions) {
    if (!item || typeof item.name !== 'string' || /[\\/:\x00-\x1f<>"|?*]/.test(item.name) || /[. ]$/.test(item.name) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(item.name) || !/\.(md|txt|webp|zip)$/i.test(item.name) || !['OPEN', 'SAVE'].includes(item.type) || fixtures.has(item.name)) throw fail('FIXTURE_INVALID')
    fixtures.set(item.name, { type: item.type, path: path.join(root, item.name) })
  }
  return {
    root,
    get(name, type, action) {
      const item = fixtures.get(name)
      if (!item || (type && item.type !== type)) throw fail('PATH_UNAUTHORIZED')
      const target = localPath(item.path)
      if (fs.realpathSync(root) !== root || path.dirname(target) !== root) throw fail('PATH_UNAUTHORIZED')
      if (action === 'CONFIRM') {
        if (type === 'OPEN' && !fs.statSync(target).isFile()) throw fail('FIXTURE_INVALID')
        if (type === 'SAVE' && fs.existsSync(target)) throw fail('FIXTURE_EXISTS')
      }
      return target
    }
  }
}

function startHelper(request) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'native-dialogs.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise(resolve => child.once('close', resolve))
  let output = '', timer
  const done = new Promise((resolve, reject) => {
    timer = setTimeout(() => { child.kill(); reject(fail('DIALOG_TIMEOUT')) }, request.timeout + 5000)
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 8192) { child.kill(); reject(fail('HELPER_FAILED')) } })
    child.stderr.resume()
    child.once('error', error => reject(fail(error.code === 'ENOENT' ? 'UNSUPPORTED_PLATFORM' : 'HELPER_FAILED')))
    child.once('close', code => {
      clearTimeout(timer)
      try {
        const result = JSON.parse(output.replace(/^\uFEFF/, '').trim())
        if (code !== 0 || !result.ok) {
          const error = fail(reasons.has(result.reason) ? result.reason : 'HELPER_FAILED')
          if (result.pid === request.pid && result.owner === request.owner) error.proof = { ownershipValidated: result.ownershipValidated === true, dialog: result.dialog, method: result.method, stage: result.stage }
          throw error
        }
        if (result.pid !== request.pid || result.owner !== request.owner || result.ownershipValidated !== true || !/^\d+$/.test(result.dialog)) throw fail('OWNER_MISMATCH')
        resolve(result)
      } catch (error) { reject(reasons.has(error.code) ? error : fail('HELPER_FAILED')) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request))
  }).finally(() => clearTimeout(timer))
  return { child, done, exited }
}

function createController({ window, temporary, definitions, records }) {
  const fixtures = fixtureRegistry(temporary, definitions)
  const handle = window.getNativeWindowHandle()
  const owner = (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString()
  const helpers = new Set()
  let busy = false, closed = false
  return {
    fixture: name => fixtures.get(name),
    async run({ type, action = 'CONFIRM', fixture, timeout = 8000 }, trigger) {
      const record = { operation: action, type, pid: process.pid, owner, ownershipValidated: false, result: 'FAIL' }
      records.push(record)
      let helper, deadline, acquired = false
      try {
        if (process.platform !== 'win32') throw fail('UNSUPPORTED_PLATFORM')
        if (closed || busy || !['OPEN', 'SAVE'].includes(type) || !['CONFIRM', 'CANCEL'].includes(action) || !Number.isInteger(timeout) || timeout < 500 || timeout > 15000 || typeof trigger !== 'function') throw fail('OPERATION_INVALID')
        const target = fixtures.get(fixture, type, action)
        busy = true
        acquired = true
        window.showInactive()
        helper = startHelper({ pid: process.pid, owner, type, action, target, root: fixtures.root, timeout })
        helper.record = record
        helpers.add(helper)
        const nativeResult = Promise.resolve().then(() => trigger())
        const [proof, response] = await Promise.race([
          Promise.all([helper.done, nativeResult]),
          new Promise((_, reject) => { deadline = setTimeout(() => reject(fail('DIALOG_TIMEOUT')), timeout + 5000) })
        ])
        Object.assign(record, { dialog: proof.dialog, ownershipValidated: true, method: proof.method })
        const selected = type === 'OPEN' ? response?.filePaths : response?.filePath ? [response.filePath] : []
        if (action === 'CANCEL') {
          if (response?.canceled !== true || selected?.length) throw fail('CANCEL_FAILED')
          record.result = 'CANCELLED'
        } else {
          if (response?.canceled !== false || selected?.length !== 1 || path.resolve(selected[0]) !== target) throw fail('DIALOG_RESULT_MISMATCH')
          record.result = 'CONFIRMED'
        }
        return response
      } catch (error) {
        if (error.proof) Object.assign(record, error.proof)
        record.reason = closed ? 'ABANDONED' : error.code || 'HELPER_FAILED'
        throw fail(record.reason)
      } finally {
        clearTimeout(deadline)
        if (helper) {
          if (helper.child.exitCode === null && !helper.child.signalCode) helper.child.kill()
          await helper.exited
          record.helperStopped = true
          helpers.delete(helper)
        }
        if (acquired) busy = false
      }
    },
    async dispose() {
      closed = true
      for (const helper of helpers) {
        helper.record.result = 'ABANDONED'
        helper.record.reason = 'ABANDONED'
        helper.child.kill()
      }
      await Promise.allSettled([...helpers].map(helper => helper.done))
      await Promise.all([...helpers].map(async helper => { await helper.exited; helper.record.helperStopped = true }))
      helpers.clear()
    }
  }
}

module.exports = { createController, fixtureRegistry, startHelper }
