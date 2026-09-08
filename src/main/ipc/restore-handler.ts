/*
-T ---
*/

import { ipcMain } from 'electron'
import { RestoreService } from '../core/restore-service'
import { RestoreExecuteOptions } from '../../shared/types'

// Valida se o valor recebido é uma string não vazia
function isValidPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

// Valida se o checkpointId contém apenas caracteres alfanuméricos, underscore e hífen
function isValidCheckpointId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value)
}

export function registerRestoreHandlers(restoreService: RestoreService): void {
  /**
   * restore:preview — Preview da restauração (dry-run, não modifica nada).
   * Parâmetros: repoPath, checkpointId
   * Retorna: { success, data?: RestorePreviewResult, error?: string }
   * O Retorno agora é { plan: RestorePlan } — os campos canRestore, orphanFiles,
   * currentRestorePoint etc. vivem em data.plan.*
   */
  ipcMain.handle('restore:preview', async (_event, repoPath: string, checkpointId: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidCheckpointId(checkpointId)) {
        return { success: false, error: 'checkpointId contém caracteres inválidos' }
      }

      const data = await restoreService.preview(repoPath, checkpointId)
      return { success: true, data }
    } catch (error: any) {
      console.error('[RestoreHandler] Erro ao fazer preview da restauração:', error)
      return { success: false, error: error.message || 'Erro ao fazer preview da restauração' }
    }
  })

  /**
   * restore:execute — Executa a restauração orquestrada.
   * Parâmetros: repoPath, checkpointId, options
   * Retorna: { success, data?: RestoreExecuteResult, error?: string, partial?: boolean }
   */
  ipcMain.handle('restore:execute', async (_event, repoPath: string, checkpointId: string, options: RestoreExecuteOptions) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidCheckpointId(checkpointId)) {
        return { success: false, error: 'checkpointId contém caracteres inválidos' }
      }
      // Valida options
      if (typeof options !== 'object' || options === null || Array.isArray(options)) {
        return { success: false, error: 'options deve ser um objeto' }
      }
      if (typeof options.createSafety !== 'boolean') {
        return { success: false, error: 'options.createSafety deve ser booleano' }
      }
      if (!Array.isArray(options.cleanupFiles)) {
        return { success: false, error: 'options.cleanupFiles deve ser um array' }
      }
      // R2: Valida que cada elemento de cleanupFiles é string
      if (options.cleanupFiles.some(f => typeof f !== 'string')) {
        return { success: false, error: 'Cada elemento de cleanupFiles deve ser uma string' }
      }
      // R3: Valida o plano congelado (opcional) se fornecido
      if (options.plan !== undefined) {
        if (typeof options.plan !== 'object' || options.plan === null) {
          return { success: false, error: 'options.plan deve ser um objeto' }
        }
        if (typeof options.plan.targetCheckpointId !== 'string') {
          return { success: false, error: 'options.plan.targetCheckpointId é obrigatório' }
        }
        if (typeof options.plan.stateHash !== 'string') {
          return { success: false, error: 'options.plan.stateHash é obrigatório' }
        }
      }

      const data = await restoreService.execute(repoPath, checkpointId, options)

      // Se o plano está obsoleto, aborta antes de qualquer execução
      if (data.planStale) {
        return {
          success: false,
          error: 'O estado do projeto mudou desde o preview. Gere um novo preview.',
          data,
          planStale: true
        }
      }

      // Se parcial, retorna success: false para forçar confirmação do usuário
      if (data.partial) {
        return {
          success: false,
          error: `Restauração parcial: ${data.restored} restaurado(s), ${data.failed} falha(ram)`,
          data,
          partial: true
        }
      }

      return { success: true, data }
    } catch (error: any) {
      console.error('[RestoreHandler] Erro ao executar restauração:', error)
      return { success: false, error: error.message || 'Erro ao executar restauração' }
    }
  })

  /**
   * restore:unmark — Desmarca um checkpoint como ponto de restauração.
   * Parâmetros: repoPath, checkpointId
   * Retorna: { success: boolean, error?: string }
   */
  ipcMain.handle('restore:unmark', async (_event, repoPath: string, checkpointId: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidCheckpointId(checkpointId)) {
        return { success: false, error: 'checkpointId contém caracteres inválidos' }
      }

      const success = await restoreService.unmark(repoPath, checkpointId)

      if (success) {
        return { success: true }
      } else {
        return { success: false, error: 'Checkpoint não encontrado' }
      }
    } catch (error: any) {
      console.error('[RestoreHandler] Erro ao desmarcar checkpoint:', error)
      return { success: false, error: error.message || 'Erro ao desmarcar checkpoint' }
    }
  })

  /**
   * restore:mark-manual — Marca um checkpoint como ponto de restauração sem modificar arquivos.
   * Parâmetros: repoPath, checkpointId
   * Retorna: { success: boolean, error?: string }
   */
  ipcMain.handle('restore:mark-manual', async (_event, repoPath: string, checkpointId: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidCheckpointId(checkpointId)) {
        return { success: false, error: 'checkpointId contém caracteres inválidos' }
      }

      const success = await restoreService.markManual(repoPath, checkpointId)

      if (success) {
        return { success: true }
      } else {
        return { success: false, error: 'Checkpoint não encontrado' }
      }
    } catch (error: any) {
      console.error('[RestoreHandler] Erro ao marcar checkpoint como restaurado:', error)
      return { success: false, error: error.message || 'Erro ao marcar checkpoint como restaurado' }
    }
  })
}