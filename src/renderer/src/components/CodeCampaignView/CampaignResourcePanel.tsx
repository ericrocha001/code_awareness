/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar o modal data-driven de recursos da campanha (Instruções, Resultados, Ambos).
2. Emitir as intenções de copiar/exportar contexto via callbacks, sem executar as ações.

Mapa de Relacionamentos do Script

1. campaignResources.ts
   - Tipo: Dependência Direta
   - Relação: Fornece a lista CAMPAIGN_RESOURCES que dirige a renderização.
   - Criticidade: Alta

2. CodeCampaignView.tsx
   - Tipo: Dependência Inversa
   - Relação: Fornece a campanha e os handlers de copiar/exportar contexto.
   - Criticidade: Alta

3. CampaignResourcePanel.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos do modal (prefixo crp-).
   - Criticidade: Alta

4. campaignContextUtils.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece o tipo CampaignContextMode dos modos suportados.
   - Criticidade: Alta

5. lucide-react
   - Tipo: Dependência Direta
   - Relação: Fornece os ícones dos botões e do cabeçalho.
   - Criticidade: Média

Invariantes do Script

1. O painel é puramente apresentacional — nunca executa copiar/exportar, apenas emite via onCopyContext/onExportContext.
2. A renderização é data-driven pela lista CAMPAIGN_RESOURCES — o painel não define recursos manualmente.
3. Quando isOpen é false, o painel retorna null (não renderiza nada).
4. O painel nunca renderiza uma campanha sem nome — o cabeçalho sempre exibe campaign.name.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { X, Copy, Download } from 'lucide-react'
import { Campaign } from '../../../../shared/types'
import { CampaignContextMode } from './campaignContextUtils'
import { CAMPAIGN_RESOURCES } from './campaignResources'
import './CampaignResourcePanel.css'

interface CampaignResourcePanelProps {
  isOpen: boolean
  onClose: () => void
  campaign: Campaign
  onCopyContext: (campaignId: string, mode: CampaignContextMode) => void
  onExportContext: (campaignId: string, mode: CampaignContextMode) => void
}

export const CampaignResourcePanel: React.FC<CampaignResourcePanelProps> = ({
  isOpen,
  onClose,
  campaign,
  onCopyContext,
  onExportContext
}) => {
  if (!isOpen) {
    return null
  }

  return (
    <div className="crp-overlay" onClick={onClose}>
      <div className="crp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="crp-header">
          <span className="crp-title">Recursos da campanha: {campaign.name}</span>
          <button className="crp-close" onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </div>
        <div className="crp-body">
          {CAMPAIGN_RESOURCES.map((resource) => (
            <div key={resource.id} className="crp-resource">
              <span className="crp-resource-name">
                <Copy size={16} />
                {resource.name}
              </span>
              <div className="crp-resource-actions">
                {resource.modes.map((mode) => (
                  <React.Fragment key={mode}>
                    <button
                      className="crp-btn"
                      onClick={() => onCopyContext(campaign.id, mode)}
                    >
                      <Copy size={14} />
                      Copiar
                    </button>
                    <button
                      className="crp-btn"
                      onClick={() => onExportContext(campaign.id, mode)}
                    >
                      <Download size={14} />
                      Exportar
                    </button>
                  </React.Fragment>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}