/*
-T ---
*/

import React from 'react'
import { Pencil, CheckCircle, RotateCcw, Plus, Flag, Copy, Download, MoreVertical, Link } from 'lucide-react'
import { Campaign, CampaignStatus } from '../../../../shared/types'
import { ActionMenu } from '../shared/ActionMenu/ActionMenu'
import { ActionMenuItem } from '../shared/ActionMenu/ActionMenuItem'
import { ActionMenuSeparator } from '../shared/ActionMenu/ActionMenuSeparator'
import { CampaignContextMode } from './campaignContextUtils'
import './CampaignList.css'

interface CampaignListProps {
  campaigns: Campaign[]
  totalCampaigns: number
  searchQuery: string
  onClearSearch: () => void
  isLoading: boolean
  onCreate: () => void
  onEdit: (campaign: Campaign) => void
  onStatusChange: (campaignId: string, status: CampaignStatus) => void
  onCopyContext: (campaignId: string, mode: CampaignContextMode) => void
  onExportContext: (campaignId: string, mode: CampaignContextMode) => void
  onCopyLink: (campaignId: string) => void
}

export const CampaignList: React.FC<CampaignListProps> = ({ campaigns, totalCampaigns, searchQuery, onClearSearch, isLoading, onCreate, onEdit, onStatusChange, onCopyContext, onExportContext, onCopyLink }) => {
  if (isLoading) {
    return <div className="cl-loading">Carregando campanhas...</div>
  }

  // Vazio real: projeto sem campanhas — a busca é irrelevante aqui
  if (totalCampaigns === 0) {
    return (
      <div className="cl-empty">
        <span>Nenhuma campanha encontrada</span>
        <button onClick={onCreate}>Criar Campanha</button>
      </div>
    )
  }

  // Busca sem resultado: há campanhas, mas o filtro não achou nada
  if (campaigns.length === 0) {
    return (
      <div className="cl-list">
        <button className="cl-create-btn" onClick={onCreate}>
          <Plus size={16} />
          Nova Campanha
        </button>
        <div className="cl-no-results">
          <span>
            Nenhuma campanha corresponde a "<strong>{searchQuery}</strong>".
          </span>
          <button className="cl-clear-search-btn" onClick={onClearSearch}>
            Limpar busca
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="cl-list">
      <button className="cl-create-btn" onClick={onCreate}>
        <Plus size={16} />
        Nova Campanha
      </button>
      {campaigns.map((campaign) => {
        const isActive = campaign.status === 'active'

        return (
          <div key={campaign.id} className={`cl-card ${isActive ? 'cl-card-active' : 'cl-card-completed'}`}>
            <span className="cl-flag">
              <Flag size={14} />
            </span>
            <div className="cl-info">
              <span className="cl-name">{campaign.name}</span>
              <span className={`cl-status ${isActive ? 'cl-status-active' : 'cl-status-completed'}`}>
                {isActive ? 'Em andamento' : 'Concluída'}
              </span>
            </div>
            <div className="cl-actions">
              <ActionMenu
                icon={<MoreVertical size={14} />}
                label="Ações"
              >
                <ActionMenuItem icon={<Link size={15} strokeWidth={2} />} onClick={() => onCopyLink(campaign.id)}>
                  Copiar link
                </ActionMenuItem>
                <ActionMenuSeparator />
                <ActionMenuItem icon={<Copy size={15} strokeWidth={2} />} onClick={() => onCopyContext(campaign.id, 'instructions')}>
                  Copiar Instruções
                </ActionMenuItem>
                <ActionMenuItem icon={<Copy size={15} strokeWidth={2} />} onClick={() => onCopyContext(campaign.id, 'results')}>
                  Copiar Resultados
                </ActionMenuItem>
                <ActionMenuItem icon={<Copy size={15} strokeWidth={2} />} onClick={() => onCopyContext(campaign.id, 'both')}>
                  Copiar Instruções + Resultados
                </ActionMenuItem>
                <ActionMenuSeparator />
                <ActionMenuItem icon={<Download size={15} strokeWidth={2} />} onClick={() => onExportContext(campaign.id, 'instructions')}>
                  Exportar Instruções
                </ActionMenuItem>
                <ActionMenuItem icon={<Download size={15} strokeWidth={2} />} onClick={() => onExportContext(campaign.id, 'results')}>
                  Exportar Resultados
                </ActionMenuItem>
                <ActionMenuItem icon={<Download size={15} strokeWidth={2} />} onClick={() => onExportContext(campaign.id, 'both')}>
                  Exportar Instruções + Resultados
                </ActionMenuItem>
                <ActionMenuSeparator />
                <ActionMenuItem icon={<Pencil size={15} strokeWidth={2} />} onClick={() => onEdit(campaign)}>
                  Editar
                </ActionMenuItem>
                <ActionMenuItem
                  icon={isActive ? <CheckCircle size={15} strokeWidth={2} /> : <RotateCcw size={15} strokeWidth={2} />}
                  onClick={() => onStatusChange(campaign.id, isActive ? 'completed' : 'active')}
                >
                  {isActive ? 'Concluir' : 'Reabrir'}
                </ActionMenuItem>
              </ActionMenu>
            </div>
          </div>
        )
      })}
    </div>
  )
}