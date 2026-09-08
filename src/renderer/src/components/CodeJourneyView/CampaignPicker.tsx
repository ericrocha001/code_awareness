/*
-T ---
*/

import React, { useState, useRef, useMemo, useEffect } from 'react'
import { Flag, Check, X, Search } from 'lucide-react'
import { Campaign } from '../../../../shared/types'
import { Popover } from '../shared/Popover/Popover'
import { getCampaignColor } from './checkpointUtils'
import './CampaignPicker.css'

interface CampaignPickerProps {
  campaigns: Campaign[]
  selectedCampaignIds: string[]
  onChange: (ids: string[]) => void
  variant?: 'compact' | 'field'
}

export const CampaignPicker: React.FC<CampaignPickerProps> = ({
  campaigns,
  selectedCampaignIds,
  onChange,
  variant = 'compact'
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const anchorRef = useRef<HTMLElement | null>(null)

  const selectedCampaigns = useMemo(() => {
    return selectedCampaignIds
      .map(id => campaigns.find(c => c.id === id))
      .filter((c): c is Campaign => c !== undefined)
  }, [campaigns, selectedCampaignIds])

  // Lista filtrada por nome (ignora maiúsculas); termo só de espaços não filtra nada
  const filteredCampaigns = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return campaigns
    return campaigns.filter(c => c.name.toLowerCase().includes(q))
  }, [campaigns, searchQuery])

  // Zera a busca ao fechar o popover (clique fora, ESC ou "Limpar seleção")
  useEffect(() => {
    if (!isOpen) setSearchQuery('')
  }, [isOpen])

  const handleBadgeClick = (e: React.SyntheticEvent<HTMLElement>) => {
    e.stopPropagation()
    anchorRef.current = e.currentTarget
    setIsOpen(prev => !prev)
  }

  const handleOptionClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const newIds = selectedCampaignIds.includes(id)
      ? selectedCampaignIds.filter(existing => existing !== id)
      : [...selectedCampaignIds, id]
    onChange(newIds)
  }

  const handleClearClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setIsOpen(false)
    onChange([])
  }

  return (
    <>
      <div
        className={`cpk-badge-multi ${selectedCampaigns.length === 0 ? 'cpk-badge-multi--empty' : ''}`}
        onClick={handleBadgeClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleBadgeClick(e)
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        aria-label="Selecionar campanhas"
      >
        {selectedCampaigns.length > 0 ? (
          selectedCampaigns.map(campaign => (
            <div key={campaign.id} className={`cpk-badge cpk-badge--${variant} ${campaign.status === 'completed' ? 'cpk-badge--completed' : 'cpk-badge--active'}`}>
              <Flag size={variant === 'field' ? 12 : 12} />
              <span>{campaign.name}</span>
            </div>
          ))
        ) : (
          <div className={`cpk-badge cpk-badge--${variant} cpk-badge--empty`}>
            <X size={variant === 'field' ? 12 : 12} />
            <span>Vincular campanha</span>
          </div>
        )}
      </div>

      <Popover
        open={isOpen}
        anchorRef={anchorRef}
        onClose={() => setIsOpen(false)}
        placement="bottom-start"
        offset={4}
      >
        <div className="cpk-dropdown">
          <div className="cpk-search">
            <Search size={14} className="cpk-search-icon" />
            <input
              className="cpk-search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar campanha..."
              aria-label="Buscar campanha"
              autoFocus
            />
          </div>
          <div className="cpk-dropdown-list">
            <button
              type="button"
              className="cpk-clear-btn"
              onClick={handleClearClick}
            >
              <X size={14} />
              <span>Limpar seleção</span>
            </button>
            
            {filteredCampaigns.map(c => {
              const isActive = selectedCampaignIds.includes(c.id)
              const color = getCampaignColor(c.status)
              return (
                <button
                  type="button"
                  key={c.id}
                  className={`cpk-option ${isActive ? 'cpk-option--active' : ''}`}
                  onClick={(e) => handleOptionClick(e, c.id)}
                >
                  <Flag size={14} style={{ color }} />
                  <span className="cpk-option-name" style={{ color }}>{c.name}</span>
                  <Check size={14} className={`cpk-option-check ${isActive ? 'cpk-option-check--active' : ''}`} />
                </button>
              )
            })}
            {filteredCampaigns.length === 0 && searchQuery.trim() && (
              <div className="cpk-empty">Nenhuma campanha encontrada</div>
            )}
          </div>
        </div>
      </Popover>
    </>
  )
}
