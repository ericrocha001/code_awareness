import React from 'react'
import { Map, FileText, Layers3, Clock3, Search } from 'lucide-react'

interface CodeMapAwarenessHeaderProps {
  repositoryName: string
  fileCount: number
  elementCount: number
  modifiedCount: number
  searchValue: string
  onSearchChange: (value: string) => void
  searchRef: React.Ref<HTMLInputElement>
  summary: string
  health: React.ReactNode
  controls: React.ReactNode
}

export function CodeMapAwarenessHeader({ repositoryName, fileCount, elementCount, modifiedCount, searchValue, onSearchChange, searchRef, summary, health, controls }: CodeMapAwarenessHeaderProps) {
  return (
    <header className="cmv-awareness-header">
      <div className="cmv-awareness-top">
        <div className="cmv-awareness-identity">
          <span className="cmv-awareness-icon"><Map size={32} aria-hidden="true" /></span>
          <div><h1>Code Map</h1><p>Consciência estrutural do repositório <strong title={repositoryName}>{repositoryName}</strong></p></div>
        </div>
        <div className="cmv-awareness-stats" aria-label="Resumo do repositório">
          <div><FileText size={19} aria-hidden="true" /><span><strong>{fileCount.toLocaleString('pt-BR')}</strong><small>arquivos</small></span></div>
          <div><Layers3 size={19} aria-hidden="true" /><span><strong>{elementCount.toLocaleString('pt-BR')}</strong><small>elementos</small></span></div>
          <div className={modifiedCount > 0 ? 'cmv-awareness-stat--pending' : undefined}><Clock3 size={19} aria-hidden="true" /><span><strong>{modifiedCount.toLocaleString('pt-BR')}</strong><small>pendentes</small></span></div>
        </div>
        <div className="cmv-awareness-health">{health}</div>
      </div>
      <div className="cmv-awareness-search-row">
        <label className="cmv-awareness-search"><Search size={18} aria-hidden="true" /><input ref={searchRef} value={searchValue} onChange={event => onSearchChange(event.target.value)} aria-label="Buscar arquivos, símbolos e elementos estruturais" placeholder="Buscar arquivos, símbolos e elementos estruturais..." /></label>
        <div className="cmv-awareness-controls">{controls}</div>
      </div>
      <span className="cmv-search-summary" aria-live="polite">{summary}</span>
    </header>
  )
}
