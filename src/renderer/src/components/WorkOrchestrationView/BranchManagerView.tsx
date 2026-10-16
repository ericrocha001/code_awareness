import React from 'react'
import type { BranchPullRequests } from '../../../../shared/types/github-pr-types'
import { PR_STATE_LABEL, PR_DIRECTION_LABEL } from './work-orchestration-labels'

export interface BranchManagerViewProps {
  branch: string
  pullRequests: BranchPullRequests
  onNavigatePr?: (pr: { htmlUrl: string; prNumber: number }) => void
}

function PrRow({ pr, direction }: { pr: { prNumber: number; title: string; htmlUrl: string; createdAt: string; state: string }; direction: 'origin' | 'destination' }) {
  const date = new Date(pr.createdAt).toLocaleDateString('pt-BR')
  return (
    <li className="wo-pr-row">
      <a className="wo-pr-link" href={pr.htmlUrl} target="_blank" rel="noreferrer" onClick={() => {}}>
        <span className="wo-pr-number" aria-label={`PR #${pr.prNumber}`}>
          #{pr.prNumber}
        </span>
        <span className="wo-pr-title">{pr.title}</span>
        <span className="wo-pr-directions">
          <span className="wo-pr-direction wo-pr-direction-origin">{PR_DIRECTION_LABEL[direction]}</span>
          <span className="wo-pr-state">{PR_STATE_LABEL[pr.state]}</span>
        </span>
        <span className="wo-pr-date">{date}</span>
      </a>
    </li>
  )
}

export function BranchManagerView({ branch, pullRequests, onNavigatePr }: BranchManagerViewProps) {
  const { origin, destination } = pullRequests

  return (
    <section className="wo-pr-history" aria-label={`PRs para ${branch}`}>
      <div className="wo-pr-section-header">
        <h3 className="wo-pr-section-title">PRs e entregas</h3>
      </div>

      <div className="wo-pr-groups">
        <div className="wo-pr-group">
          <h4 className="wo-pr-group-title">
            <span className="wo-pr-group-icon">→</span>
            PRs enviados desta branch
          </h4>
          {origin.length === 0 ? (
            <p className="wo-pr-empty">Nenhum PR originado desta branch com cobertura ativa no GitHub.</p>
          ) : (
            <ul className="wo-pr-list">
              {origin.map(pr => (
                <PrRow key={pr.prNumber} pr={{ prNumber: pr.prNumber, title: pr.title, htmlUrl: pr.htmlUrl, createdAt: pr.createdAt, state: pr.state }} direction="origin" />
              ))}
            </ul>
          )}
        </div>

        <div className="wo-pr-group">
          <h4 className="wo-pr-group-title">
            <span className="wo-pr-group-icon">←</span>
            PRs destinados a esta branch
          </h4>
          {destination.length === 0 ? (
            <p className="wo-pr-empty">Nenhum PR recebido nesta branch.</p>
          ) : (
            <ul className="wo-pr-list">
              {destination.map(pr => (
                <PrRow key={pr.prNumber} pr={{ prNumber: pr.prNumber, title: pr.title, htmlUrl: pr.htmlUrl, createdAt: pr.createdAt, state: pr.state }} direction="destination" />
              ))}
            </ul>
          )}
        </div>
      </div>

      {origin.length === 0 && destination.length === 0 && (
        <p className="wo-pr-empty">Sem PRs registradas neste momento; a verificação remota está indisponível.</p>
      )}
    </section>
  )
}
