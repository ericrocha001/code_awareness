const { createHash } = require('node:crypto')
const qualifiedVersions = new Set(['0.166.0-alpha.6', '0.167.0-alpha.3.2'])
const isQualifiedCodexHookVersion = version => qualifiedVersions.has(version)
const events = ['SessionStart', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd']
function summarizeHookList(response, expected) {
  const unknown = reasonCode => ({ state: 'UNKNOWN', reasonCode, expected: 7, matched: 0, trusted: 0, issues: [] })
  if (!Array.isArray(expected) || expected.length !== 7 || new Set(expected.map(h => h.key)).size !== 7 || new Set(expected.map(h => h.event)).size !== 7 || expected.some(h => typeof h.key !== 'string' || !events.includes(h.event))) return unknown('HOOK_SCOPE_UNAVAILABLE')
  if (!Array.isArray(response?.data) || response.data.length > 16) return unknown('INVALID_HOOK_RESPONSE')
  if (response.data.some(entry => !Array.isArray(entry?.hooks) || entry.errors?.length || entry.warnings?.length) || response.data.reduce((count, entry) => count + entry.hooks.length, 0) > 128) return unknown('HOOK_INVENTORY_INCOMPLETE')
  const hooks = response.data.flatMap(entry => entry.hooks), selected = [], issues = []
  let trusted = 0, stale = false
  for (const handler of expected) {
    const matches = hooks.filter(hook => hook?.key === handler.key)
    if (matches.length > 1) return unknown('HOOK_SCOPE_AMBIGUOUS')
    if (!matches.length) { issues.push({ eventType: handler.event, reasonCode: 'HOOK_NOT_LISTED' }); continue }
    const hook = matches[0], eventName = handler.event[0].toLowerCase() + handler.event.slice(1)
    if (hook.eventName !== eventName || !/^sha256:[a-f0-9]{64}$/.test(hook.currentHash) || typeof hook.enabled !== 'boolean' || !['trusted','untrusted','modified','managed'].includes(hook.trustStatus) || hook.trustStatus === 'managed' && hook.isManaged !== true) return unknown('INVALID_HOOK_RESPONSE')
    selected.push([handler.key, hook.currentHash])
    if (!hook.enabled) issues.push({ eventType: handler.event, reasonCode: 'HOOK_DISABLED' })
    else if (hook.trustStatus === 'trusted' || hook.trustStatus === 'managed') trusted++
    else {
      stale ||= hook.trustStatus === 'modified'
      issues.push({ eventType: handler.event, reasonCode: hook.trustStatus === 'modified' ? 'HOOK_HASH_CHANGED' : 'HOOK_UNTRUSTED' })
    }
  }
  const missing = selected.length !== 7
  return { state: missing ? 'UNKNOWN' : trusted === 7 ? 'TRUSTED' : trusted ? 'PARTIAL' : 'UNTRUSTED',
    reasonCode: missing ? 'HOOK_SCOPE_UNAVAILABLE' : stale ? 'HOOK_HASH_CHANGED' : trusted === 7 ? 'HASH_TRUST_OBSERVED' : 'HOOK_AUTHORIZATION_INCOMPLETE',
    expected: 7, matched: selected.length, trusted, issues, stale,
    hashDigest: createHash('sha256').update(JSON.stringify(selected.sort((a, b) => a[0].localeCompare(b[0])))).digest('hex') }
}
module.exports = { summarizeHookList, isQualifiedCodexHookVersion }
