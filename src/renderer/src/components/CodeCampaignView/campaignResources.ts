/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Definir o tipo CampaignResource (descrição de um recurso de campanha).
2. Exportar a lista CAMPAIGN_RESOURCES usada pelo painel de recursos data-driven.

Mapa de Relacionamentos do Script

1. CampaignResourcePanel.tsx
   - Tipo: Dependência Inversa
   - Relação: Lê CAMPAIGN_RESOURCES para renderizar as linhas do painel.
   - Criticidade: Alta

2. campaignContextUtils.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece o tipo CampaignContextMode usado nos modos suportados.
   - Criticidade: Alta

Invariantes do Script

1. A lista é a única fonte de verdade dos recursos exibidos no painel — adicionar um recurso novo exige apenas uma entrada na lista.
2. Cada recurso possui id, nome, ícone e modos de exportação/cópia suportados.
3. A lista é imutável e data-driven — o painel nunca define recursos manualmente.

--- FIM ARQUITETURA DO SCRIPT ---
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