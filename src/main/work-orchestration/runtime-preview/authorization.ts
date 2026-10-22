import { BrowserWindow, dialog } from 'electron'
import type { PreviewProfile } from '../preview-profile'
import type { RepositoryPreviewContextProvisioner } from './context-data'

export async function confirmPreviewProfile(window: BrowserWindow, profile: PreviewProfile, provisioner: Pick<RepositoryPreviewContextProvisioner, 'quote'>): Promise<boolean> {
  if (window.isDestroyed()) return false
  const quote = provisioner.quote(profile)
  const data = quote ? `\nDados privados: ${quote.dataPolicy}\nFinalidade: testar o checkout selecionado com corpus isolado.\nOrigem: ${quote.dataPolicy === 'EMPTY' ? 'corpus vazio, sem leitura do canônico' : 'Continuum do host, somente o repositório ' + quote.repositoryId}\nEstimativa SQLite (inclui mídia): ${quote.estimatedBytes} bytes; ${quote.artifacts} Artifacts.\nLimites: ${quote.maxBytes} bytes; ${quote.maxArtifacts} Artifacts.\nSem credenciais, identidade de instalação ou sincronização reversa. A cópia será descartada no encerramento.` : ''
  const response = await dialog.showMessageBox(window, { type: 'warning', title: 'Aprovar perfil de preview',
    message: `Revisar e aprovar ${profile.profileId} revisão ${profile.revision}?`,
    detail: `Repositório: ${profile.repositoryId}\nRuntime: ${profile.runtime} ${profile.runtimeVersion}\nComando: ${profile.command.executable} ${profile.command.args.join(' ')}\nCwd relativo: ${profile.command.cwd}\nModo: ${profile.security.mode}\nGarantias exigidas: ${JSON.stringify(profile.security.requirements)}\nDestinos: ${profile.network.destinations.join(', ')}\nRede aberta consentida: ${profile.network.openNetworkConsent}${data}\nPerfil operacional não é sandbox. Esta aprovação não reduz requisitos nem inicia processos.`,
    buttons: ['Cancelar', 'Aprovar esta revisão e política'], defaultId: 0, cancelId: 0, noLink: true })
  return response.response === 1
}
