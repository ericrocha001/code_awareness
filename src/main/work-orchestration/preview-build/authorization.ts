import { dialog, type BrowserWindow } from 'electron'
import type { BuildCapture } from './capture'
export async function confirmPreviewBuild(window: BrowserWindow | null, capture: BuildCapture, recipe: string) {
  if (window?.isDestroyed()) return false
  const options = { type: 'warning' as const, title: 'Autorizar preparação do build PVO', message: 'Executar o build desta captura congelada?',
    detail: `Repositório: ${capture.selection.repositoryId}\nWorktree: ${capture.selection.worktreeId}\nGeração: ${capture.selection.generation}\nBranch: ${capture.source.branch}\nHEAD: ${capture.source.head}\nDirty: ${capture.source.dirty}\nPerfil: ${capture.profile.profileId} revisão ${capture.profile.revision}\nCaptureId: ${capture.captureId}\nToolchain: ${capture.toolchainId}\nRuntimeId: ${capture.runtimeId}\nReceita: ${recipe}\n\nScripts, plugins e dependências da captura executarão código com os privilégios do usuário. Isolamento operacional não é sandbox de filesystem ou rede. Nenhuma instalação, download ou sessão Preview será iniciada pelo preparador.`,
    buttons: ['Cancelar', 'Autorizar somente este build'], defaultId: 0, cancelId: 0, noLink: true }
  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  return result.response === 1
}
