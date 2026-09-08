/*
-T ---
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