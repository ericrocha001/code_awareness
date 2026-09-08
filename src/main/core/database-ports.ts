/*
-T ---
*/

import type { ActionLog, CheckpointCatalogRecord, Campaign } from '../../shared/types'

export interface ActionLogPort {
  insertAction(action: Omit<ActionLog, 'id'>): void
  getActions(repoPath: string, limit?: number): ActionLog[]
  getActionsByDateRange(repoPath: string, startDate: number, endDate: number): ActionLog[]
}

export interface CheckpointCatalogPort {
  insertCheckpointCatalog(repoPath: string, record: Omit<CheckpointCatalogRecord, 'repoPath'>): void
  getCheckpointsCatalog(repoPath: string): CheckpointCatalogRecord[]
  getCheckpointCatalog(repoPath: string, checkpointId: string): CheckpointCatalogRecord | null
  updateCheckpointCatalog(
    repoPath: string,
    checkpointId: string,
    patch: Partial<Omit<CheckpointCatalogRecord, 'id' | 'repoPath'>>
  ): void
  deleteCheckpointCatalog(repoPath: string, checkpointId: string): void
  getContentCheckpoints(repoPath: string): CheckpointCatalogRecord[]
  archiveCheckpointCatalog(repoPath: string, checkpointId: string): void
  setCheckpointCampaignLinks(repoPath: string, checkpointId: string, campaignIds: string[]): void
  getCheckpointCampaignIds(repoPath: string, checkpointId: string): string[]
  getCheckpointCampaignIdsMap(repoPath: string): Record<string, string[]>
  getCampaignCheckpointIds(repoPath: string, campaignId: string): string[]
}

export interface CampaignPort {
  insertCampaign(repoPath: string, campaign: Campaign): void
  getCampaigns(repoPath: string): Campaign[]
  getCampaign(repoPath: string, campaignId: string): Campaign | null
  getCampaignBySlug(repoPath: string, slug: string): Campaign | null
  updateCampaign(repoPath: string, campaignId: string, patch: Partial<Omit<Campaign, 'id'>>): void
}
