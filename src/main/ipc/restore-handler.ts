/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Registrar handlers IPC para as operações de restauração orquestrada.
2. Validar parâmetros recebidos antes de delegar ao RestoreService.
3. Capturar erros e retornar respostas estruturadas ao renderer.

Mapa de Relacionamentos do Script

1. restore-service.ts
   - Tipo: Dependência Direta
   - Relação: Instancia e consome RestoreService para todas as operações de restauração.
   - Criticidade: Alta

2. ../../shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece os tipos RestorePreviewResult, RestoreExecuteResult, RestoreExecuteOptions.
   - Criticidade: Alta

Invariantes do Script

1. Handlers IPC nunca devem lançar exceções não tratadas — erros devem ser capturados e retornados como { success: false, error }.
2. Caminhos recebidos por IPC devem sempre ser validados como strings não vazias.
3. Toda resposta de handler deve conter o campo success.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { ipcMain } from 'electron'
import { RestoreService } from '../core/restore-service'
import { RestoreExecuteOptions } from '../../shared/types'

const restoreService = new RestoreService()

// Valida se o valor recebido é uma string não vazia
function isValidPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

// Valida se o checkpointId contém apenas caracteres alfanuméricos, underscore e hífen
function isValidCheckpointId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value)
}

export function registerRestoreHandlers(): void {
  /**
   * restore:preview — Preview da restauração (dry-run, não modifica nada).
   * Parâmetros: repoPath, checkpointId
   * Retorna: { success, data?: RestorePreviewResult, error?: string }
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

      const data = await restoreService.execute(repoPath, checkpointId, options)

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