export interface WorktreeCreationEstimate {
  at: string | null
  quality: 'ESTIMATED' | 'UNKNOWN'
  source: 'ADMIN_DIRECTORY_BIRTHTIME' | 'CHECKOUT_AND_ADMIN_BIRTHTIME' | null
}
