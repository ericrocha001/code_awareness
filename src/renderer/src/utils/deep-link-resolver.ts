/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Resolver uma URL de deep link de campanha contra o projeto ativo e a lista de campanhas.
2. Retornar uma decisão tipada (navegar ou erro) sem realizar side effects.

Mapa de Relacionamentos do Script

1. campaign-reference.ts
   - Tipo: Dependência Direta
   - Relação: Fornece parseCampaignReference para interpretar a URL.
   - Criticidade: Alta

2. shared/types
   - Tipo: Contrato / Interface
   - Relação: Fornece o tipo Campaign.
   - Criticidade: Alta

3. App.tsx / CodeCampaignView.tsx
   - Tipo: Dependência Inversa
   - Relação: Consumidores planejados da decisão de navegação do deep link.
   - Criticidade: Alta

Invariantes do Script

1. A função é pura — sem side effects, sem IPC, sem acesso a DOM/Electron/estado global.
2. Nunca lança — qualquer entrada inválida produz uma decisão de erro.
3. A validade da campanha é determinada pelo campaignId (âncora de estabilidade), nunca pelo nome.
4. A comparação de projeto usa igualdade exata de caminho (activeProject.path === reference.repoPath).
5. A decisão de erro sempre traz uma mensagem legível para exibição ao usuário.

--- FIM ARQUITETURA DO SCRIPT ---
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