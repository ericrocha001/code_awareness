import { describe, expect, it } from 'vitest'
import { diagnosticBootstrapAllowed } from './adapters'
import type { PreviewPreflight } from '../../../shared/types/runtime-preview-types'
import type { PreviewProfile } from '../preview-profile'

describe('diagnostic bootstrap authorization', () => {
  const profile = { adapter: { version: 1 } } as PreviewProfile
  const check = (status: PreviewPreflight['status'], reasons: string[], adapter = profile) => diagnosticBootstrapAllowed({ status, diagnostics: reasons.map(reasonCode => ({ reasonCode, message: reasonCode })) } as PreviewPreflight, adapter)
  it('permits only the explicit unresolved runtime checks of an adapter', () => {
    expect(check('UNKNOWN', ['ABI_UNVERIFIED', 'RUNTIME_COMPATIBILITY_UNVERIFIED'])).toBe(true)
    expect(check('UNKNOWN', ['DEPENDENCY_MATERIALIZATION_UNVERIFIABLE'])).toBe(true)
  })
  it.each(['SECURITY_ISOLATION_UNAVAILABLE', 'DEPENDENCY_MISMATCH', 'DEPENDENCIES_MISSING', 'PROFILE_APPROVAL_REQUIRED', 'DEPENDENCY_VERSION_UNVERIFIABLE', 'DEPENDENCY_WORKSPACE_UNVERIFIABLE'])('never bypasses %s', reason => {
    expect(check('UNKNOWN', ['ABI_UNVERIFIED', reason])).toBe(false)
  })
  it('does not turn a bare unknown or legacy profile into permission to execute', () => {
    expect(check('UNKNOWN', [])).toBe(false)
    expect(check('UNKNOWN', ['ABI_UNVERIFIED'], {} as PreviewProfile)).toBe(false)
    expect(check('MISSING', ['ABI_UNVERIFIED'])).toBe(false)
    expect(check('INCOMPATIBLE', ['ABI_UNVERIFIED'])).toBe(false)
  })
})
