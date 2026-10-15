import { expect, it } from 'vitest'
import { estimateWorktreeCreation } from './worktree-creation'
it('exposes filesystem estimates and rejects missing, future or copied/restored directory evidence', () => {
  const now = Date.parse('2026-10-14T00:00:00Z'), born = now - 600000
  expect(estimateWorktreeCreation(born, born + 100, true, now)).toEqual({ at: new Date(born).toISOString(), quality: 'ESTIMATED', source: 'ADMIN_DIRECTORY_BIRTHTIME' })
  expect(estimateWorktreeCreation(born, born, false, now).source).toBe('CHECKOUT_AND_ADMIN_BIRTHTIME')
  for (const [admin, checkout] of [[0, born], [NaN, born], [now + 1, born], [born, now]])
    expect(estimateWorktreeCreation(admin, checkout, true, now)).toEqual({ at: null, quality: 'UNKNOWN', source: null })
})
