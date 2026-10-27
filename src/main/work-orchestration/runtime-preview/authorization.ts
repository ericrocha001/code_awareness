import { BrowserWindow, dialog } from 'electron'
import type { PreviewProfile } from '../preview-profile'
import type { RepositoryPreviewContextProvisioner } from './context-data'
import type { StandbyPolicy } from './standby-policy'

export async function confirmPreviewProfile(window: BrowserWindow, profile: PreviewProfile, provisioner: Pick<RepositoryPreviewContextProvisioner, 'quote'>, policy?: StandbyPolicy): Promise<boolean> {
  if (window.isDestroyed()) return false
  const quote = provisioner.quote(profile)
  if (policy) {
    const response = await dialog.showMessageBox(window, { type: 'warning', title: 'Confiar neste repositório para Runtime Preview',
      message: 'Autorizar preparação antecipada das Worktrees explicitamente escolhidas deste repositório?',
      detail: `Repositório: ${profile.repositoryId}\nExecuta código das Worktrees com corpus privado sanitizado. Não é sandbox de segurança total.\nExecutável: ${profile.command.executable}\nRuntime: ${profile.runtimeVersion}; ABI: ${profile.dependencies.abi}\nDados: ${quote?.dataPolicy}; limite: ${quote?.maxBytes} bytes.\nUm slot. Ocioso até ${policy.idleMs / 1000} s. RAM privada: ${policy.maxPrivateBytes} bytes; working set: ${policy.maxWorkingSetBytes} bytes. CPU: ${policy.maxCpuPercent}% da máquina por intervalo de ${policy.sampleMs / 1000} s. Memória livre mínima: ${policy.minAvailableBytes} bytes.\nExpiração, pressão, mudança de identidade ou revogação encerram o preview. Após descarte, abrir exige preparação fria. Não autoriza Git, instalação ou shell genérico. Mudança material exige nova revisão. Revogue em Work Orchestration.`,
      buttons: ['Cancelar', 'Confiar com estes limites'], defaultId: 0, cancelId: 0, noLink: true })
    return response.response === 1
  }
  const data = quote ? `\nDados privados: ${quote.dataPolicy}\nFinalidade: testar o checkout selecionado com corpus isolado.\nOrigem: ${quote.dataPolicy === 'EMPTY' ? 'corpus vazio, sem leitura do canônico' : 'Continuum do host, somente o repositório ' + quote.repositoryId}\nEstimativa SQLite (inclui mídia): ${quote.estimatedBytes} bytes; ${quote.artifacts} Artifacts.\nLimites: ${quote.maxBytes} bytes; ${quote.maxArtifacts} Artifacts.\nSem credenciais, identidade de instalação ou sincronização reversa. A cópia será descartada no encerramento.` : ''
  const response = await dialog.showMessageBox(window, { type: 'warning', title: 'Aprovar perfil de preview',
    message: `Revisar e aprovar ${profile.profileId} revisão ${profile.revision}?`,
    detail: `Repositório: ${profile.repositoryId}\nRuntime: ${profile.runtime} ${profile.runtimeVersion}\nComando: ${profile.command.executable} ${profile.command.args.join(' ')}\nCwd relativo: ${profile.command.cwd}\nModo: ${profile.security.mode}\nGarantias exigidas: ${JSON.stringify(profile.security.requirements)}\nDestinos: ${profile.network.destinations.join(', ')}\nRede aberta consentida: ${profile.network.openNetworkConsent}${data}\nPerfil operacional não é sandbox. Esta aprovação não reduz requisitos nem inicia processos.`,
    buttons: ['Cancelar', 'Aprovar esta revisão e política'], defaultId: 0, cancelId: 0, noLink: true })
  return response.response === 1
}
