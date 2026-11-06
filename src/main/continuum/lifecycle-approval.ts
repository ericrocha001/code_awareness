import { BrowserWindow, dialog } from 'electron'
import type { LifecycleApproval, LifecycleReview } from './artifact-lifecycle'

export async function approveLifecycleInDesktop(review: LifecycleReview): Promise<LifecycleApproval | null> {
  const parent = BrowserWindow.getFocusedWindow()
  if (!parent || parent.isDestroyed() || !parent.isVisible() || !parent.isFocused()) return null
  const result = await dialog.showMessageBox(parent, {
    type: 'question', title: 'Aprovar lifecycle do Artifact',
    message: `${review.target.kind} → ${review.toState}`,
    detail: `Repositório: ${review.repositoryId}\nArtifact: ${review.target.artifactId}@${review.target.revision}\nSHA-256: ${review.target.contentHash}\nRazão: ${review.reasonCode}\nSuporte: ${review.supporting ? `${review.supporting.artifactId}@${review.supporting.revision}` : 'nenhum'}\nProvas atuais: ${review.evidence.map(p => p.proofId).join(', ') || 'nenhuma requerida pela política'}\n\nAprovação editorial independente de testes ou merge. Revise todos os critérios e o conteúdo da revisão indicada antes de aprovar. A confirmação registra uma decisão local explícita; a identidade individual não está disponível.`,
    buttons: ['Cancelar', 'Aprovar esta revisão'], defaultId: 0, cancelId: 0,
    checkboxLabel: 'Revisei o conteúdo, todos os critérios e a suficiência das provas desta revisão; autorizo esta decisão.', checkboxChecked: false, noLink: true
  })
  if (result.response !== 1 || !result.checkboxChecked) return null
  return { reviewDigest: review.reviewDigest, source: 'NATIVE_DESKTOP_CONFIRMATION', principalId: null, approvedAt: new Date().toISOString() }
}
