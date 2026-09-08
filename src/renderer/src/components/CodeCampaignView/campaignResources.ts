/*
-T ---
*/

import { CampaignContextMode } from './campaignContextUtils'

export interface CampaignResource {
  id: string
  name: string
  icon: string
  modes: CampaignContextMode[]
}

export const CAMPAIGN_RESOURCES: CampaignResource[] = [
  {
    id: 'instructions',
    name: 'Instruções',
    icon: 'Copy',
    modes: ['instructions']
  },
  {
    id: 'results',
    name: 'Resultados',
    icon: 'Copy',
    modes: ['results']
  },
  {
    id: 'both',
    name: 'Instruções + Resultados',
    icon: 'Copy',
    modes: ['both']
  }
]