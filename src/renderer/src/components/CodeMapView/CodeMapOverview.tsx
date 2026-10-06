import React from 'react'
import './CodeMapOverview.css'
import { Network, Tags, Layers3, ShieldCheck, FileText, Clock3, CalendarDays, RefreshCw, Eye, GitBranch } from 'lucide-react'
import type { CodeMapRepository } from '../../../../shared/types'

interface CodeMapOverviewProps {
  repository: CodeMapRepository | null
  repositoryName?: string
  fileCount: number
  elementCount: number
  modifiedCount: number
  neverIndexed: boolean
  lastSyncAt: string | null
}

function formatDate(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString('pt-BR')
}

const dimensions = [
  { icon: Network, title: 'Relacionamentos', description: 'Dependências entre arquivos e símbolos.' },
  { icon: Tags, title: 'Tags e Metadados', description: 'Organização contextual do repositório.' },
  { icon: Layers3, title: 'Estrutura de Elementos', description: 'Classes, funções, interfaces e outros símbolos.' },
  { icon: ShieldCheck, title: 'Integridade', description: 'Verificação da consistência do índice.' }
]

export const CodeMapOverview: React.FC<CodeMapOverviewProps> = ({ repository, repositoryName, fileCount, elementCount, modifiedCount, neverIndexed, lastSyncAt }) => (
  <div className="cmv-overview">
    <section className="cmv-overview-map">
      <div className="cmv-topology" aria-hidden="true">
        <svg viewBox="0 0 600 230" preserveAspectRatio="xMidYMid meet">
          <defs><radialGradient id="cmv-topology-glow"><stop stopColor="currentColor" stopOpacity=".2" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></radialGradient></defs>
          <ellipse cx="300" cy="115" rx="245" ry="110" fill="url(#cmv-topology-glow)" />
          <g className="cmv-topology-orbits" fill="none"><ellipse cx="300" cy="115" rx="118" ry="75" /><ellipse cx="300" cy="115" rx="175" ry="99" /><path d="M55 120 Q300 -65 545 130 M80 185 Q300 12 530 45 M70 70 Q300 235 540 185" /></g>
          <g className="cmv-topology-links" fill="none"><path d="M65 120 L150 82 L210 34 L300 115 L395 44 L485 80 L545 130 M150 82 L180 168 L300 115 L415 171 L485 80 M65 120 L180 168 L120 205 M210 34 L415 171 L530 198 M180 168 L395 44" /></g>
          {[[65,120],[150,82],[210,34],[180,168],[120,205],[395,44],[415,171],[485,80],[545,130],[530,198]].map(([cx,cy], index) => <circle key={index} cx={cx} cy={cy} r={index % 3 === 0 ? 6 : 3.5} className={index % 2 ? 'cmv-topology-node--blue' : ''} />)}
        </svg>
        <span className="cmv-topology-eye"><Eye size={72} strokeWidth={1.25} /></span>
        <span className="cmv-topology-label cmv-topology-label--files"><FileText size={13} />Arquivos</span>
        <span className="cmv-topology-label cmv-topology-label--symbols"><Network size={13} />Símbolos</span>
        <span className="cmv-topology-label cmv-topology-label--relations"><GitBranch size={13} />Relacionamentos</span>
      </div>
      <h2 className="cmv-overview-title" title={repository?.name ?? repositoryName}>{repository?.name ?? repositoryName ?? 'Repositório'}</h2>
      <p className="cmv-overview-subtitle">{neverIndexed ? 'Indexe o repositório para conhecer sua estrutura.' : 'Repositório indexado e mapeado'}</p>
      <div className="cmv-overview-stats">
        {[{ icon: FileText, value: fileCount, label: 'arquivos' }, { icon: Layers3, value: elementCount, label: 'elementos' }, { icon: Clock3, value: modifiedCount, label: 'pendentes' }].map(({ icon: Icon, value, label }) => (
          <div key={label} className={`cmv-overview-stat${label === 'pendentes' && modifiedCount > 0 ? ' cmv-overview-stat--pending' : ''}`}><span className="cmv-overview-stat-icon"><Icon size={24} /></span><span><strong className="cmv-overview-stat-value">{value.toLocaleString('pt-BR')}</strong><small className="cmv-overview-stat-label">{label}</small></span></div>
        ))}
      </div>
      <div className="cmv-overview-times">
        <div><CalendarDays size={22} /><span><small>Última indexação</small><strong>{neverIndexed ? 'Nunca indexado' : formatDate(repository?.lastIndexedAt, 'Nunca indexado')}</strong></span></div>
        <div><RefreshCw size={22} /><span><small>Última sincronização</small><strong>{formatDate(lastSyncAt ?? repository?.lastIndexedAt, 'Nunca sincronizado')}</strong></span></div>
      </div>
    </section>
    <section className="cmv-intelligence">
      <header><Layers3 size={21} /><div><h3>Structural Intelligence</h3><p>Conhecimento estrutural do seu código.</p></div></header>
      <div className="cmv-intelligence-grid">{dimensions.map(({ icon: Icon, title, description }) => <div key={title}><Icon size={23} /><h4>{title}</h4><p>{description}</p></div>)}</div>
    </section>
  </div>
)
