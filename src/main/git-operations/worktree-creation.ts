import type { WorktreeCreationEstimate } from '../../shared/types/worktree-creation-types'
export function estimateWorktreeCreation(adminBirth: number, checkoutBirth: number, linked: boolean, now: number): WorktreeCreationEstimate {
  if (![adminBirth, checkoutBirth].every(time => Number.isFinite(time) && time > 0 && time <= now) || Math.abs(adminBirth - checkoutBirth) > 300000)
    return { at: null, quality: 'UNKNOWN', source: null }
  return { at: new Date(adminBirth).toISOString(), quality: 'ESTIMATED', source: linked ? 'ADMIN_DIRECTORY_BIRTHTIME' : 'CHECKOUT_AND_ADMIN_BIRTHTIME' }
}
