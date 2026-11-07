const IDENTITY_PATH = '.academy/identities.json'

function validateAcademyIdentities(value, paths, previous) {
  const fail = code => { throw Object.assign(new Error(code), { code }) }
  if (!value || value.schema !== 2 || !Array.isArray(value.skills)) fail('ACADEMY_IDENTITY_SCHEMA')
  const ids = new Set(), names = new Set(), present = new Set()
  for (const entry of value.skills) {
    if (!entry || typeof entry.skillId !== 'string' || !entry.skillId.trim() || !/^skills\/[a-z0-9][a-z0-9_-]*$/.test(entry.path) || !['PRESENT', 'REMOVED'].includes(entry.state)) fail('ACADEMY_IDENTITY_INVALID')
    if (ids.has(entry.skillId) || names.has(entry.path.toLowerCase())) fail('ACADEMY_IDENTITY_COLLISION')
    ids.add(entry.skillId); names.add(entry.path.toLowerCase())
    if (entry.state === 'PRESENT') present.add(entry.path)
    else if (!/^[a-f0-9]{64}$/.test(entry.baseHash) || !Number.isSafeInteger(entry.revision) || entry.revision < 1) fail('ACADEMY_TOMBSTONE_INVALID')
  }
  const actual = new Set(paths)
  if (present.size !== actual.size || [...actual].some(path => !present.has(path))) fail('ACADEMY_IDENTITY_TREE_MISMATCH')
  if (previous) for (const entry of previous.skills) {
    if (!ids.has(entry.skillId)) fail('ACADEMY_TOMBSTONE_REQUIRED')
  }
  return value
}

module.exports = { IDENTITY_PATH, validateAcademyIdentities }
