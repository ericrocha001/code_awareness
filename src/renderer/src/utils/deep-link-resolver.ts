/*
-T ---
*/

import { Campaign } from '../../../shared/types'
import { parseCampaignReference } from './campaign-reference'

export type DeepLinkDecision =
  | { type: 'navigate'; repoPath: string; campaignId: string }
  | { type: 'error'; message: string }

export function resolveDeepLink(
  url: string,
  activeProject: { path: string; name: string } | null,
  campaigns: Campaign[]
): DeepLinkDecision {
  const reference = parseCampaignReference(url)
  if (!reference) {
    return { type: 'error', message: 'Link inválido' }
  }

  if (!activeProject || activeProject.path !== reference.repoPath) {
    return { type: 'error', message: `O projeto ${reference.repoPath} não está aberto` }
  }

  if (!campaigns.some(c => c.id === reference.campaignId)) {
    return { type: 'error', message: `A campanha ${reference.campaignId} não existe no projeto ${reference.repoPath}` }
  }

  return { type: 'navigate', repoPath: reference.repoPath, campaignId: reference.campaignId }
}