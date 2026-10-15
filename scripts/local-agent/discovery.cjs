const fs = require('node:fs')
const path = require('node:path')
const { desktopUserData } = require('../../src/shared/desktop-profile.cjs')

function unavailable(stage, reason) {
  return Object.assign(new Error('APP_UNAVAILABLE'), { code: 'APP_UNAVAILABLE', stage, reason })
}

function ioReason(error, missing) {
  if (['EACCES', 'EPERM'].includes(error.code)) return 'ACCESS_DENIED'
  if (error.code === 'ENOENT') return missing
  return 'IO_ERROR'
}

function readDescriptor(profileOverride, channel, { platform = process.platform, env = process.env, filesystem = fs } = {}) {
  if (!profileOverride && (platform !== 'win32' || !env.APPDATA)) {
    throw Object.assign(new Error('PROFILE_REQUIRED'), { code: 'PROFILE_REQUIRED', stage: 'profile', reason: 'APPDATA_UNAVAILABLE' })
  }
  const profile = profileOverride || desktopUserData(env.APPDATA)
  try {
    if (!filesystem.statSync(profile).isDirectory()) throw unavailable('profile', 'PROFILE_INVALID')
  } catch (error) {
    if (error.code === 'APP_UNAVAILABLE') throw error
    throw unavailable('profile', ioReason(error, 'PROFILE_NOT_FOUND'))
  }
  let raw
  try { raw = filesystem.readFileSync(path.join(profile, channel.directory, 'endpoint.json'), 'utf8') }
  catch (error) { throw unavailable('descriptor', ioReason(error, 'DESCRIPTOR_NOT_FOUND')) }
  let descriptor
  try { descriptor = JSON.parse(raw) } catch { throw unavailable('descriptor', 'DESCRIPTOR_INVALID') }
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) ||
      typeof descriptor.endpoint !== 'string' || !descriptor.endpoint || typeof descriptor.token !== 'string' || !descriptor.token) {
    throw unavailable('descriptor', 'DESCRIPTOR_INVALID')
  }
  if (descriptor.protocol !== channel.protocol) throw unavailable('descriptor', 'PROTOCOL_INCOMPATIBLE')
  if (platform === 'win32' && !/^\\\\\.\\pipe\\code-awareness-continuum-[a-f0-9]{48}$/.test(descriptor.endpoint)) {
    throw unavailable('descriptor', 'ENDPOINT_INVALID')
  }
  return descriptor
}

function publicError(error) {
  return { code: error.code || 'INVALID_ARGUMENT', ...(error.stage ? { stage: error.stage } : {}), ...(error.reason ? { reason: error.reason } : {}) }
}

module.exports = { readDescriptor, unavailable, publicError }
