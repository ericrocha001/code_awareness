import type { PreviewAcceptanceOutcome } from '../../../shared/types/runtime-preview-operations'

export interface AcceptanceScenario {
  id: string
  title: string
  instruction: string
  expected: string
  component: 'WEB' | 'ELECTRON_RENDERER'
}

export interface AcceptancePrompt {
  sessionId: string
  scenario: Pick<AcceptanceScenario, 'id' | 'title' | 'instruction' | 'expected'>
  identity: { repositoryId: string; worktreeId: string; branch: string | null; head: string }
}

export type AcceptanceObserver = (prompt: AcceptancePrompt) => Promise<PreviewAcceptanceOutcome>

export const ACCEPTANCE_SCENARIOS: readonly AcceptanceScenario[] = [{
  id: 'ACADEMY_DOWNLOAD_BUSY',
  title: 'Download de pacote na Academy',
  instruction: 'Na instância de preview, abra Academy e acione uma vez "Baixar ZIP" ou "Baixar pacote".',
  expected: 'O botão mostra atividade, um segundo clique não duplica o trabalho e a ação termina em sucesso ou erro recuperável.',
  component: 'ELECTRON_RENDERER'
}]

export const acceptanceScenario = (id: string) => ACCEPTANCE_SCENARIOS.find(scenario => scenario.id === id)
