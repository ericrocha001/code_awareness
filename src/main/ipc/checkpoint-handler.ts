/*
-T ---
*/

import { ipcMain } from 'electron'
import { CheckpointService } from '../core/checkpoint-service'
import type { ActionLogPort } from '../core/database-ports'
import { CheckpointDetails } from '../../shared/types'

// Valida se o valor recebido é uma string não vazia
function isValidPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

// Valida se o checkpointId contém apenas caracteres alfanuméricos, underscore e hífen
// Previne path traversal: "../../../etc/passwd" seria rejeitado
function isValidCheckpointId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value)
}

// Valida que, se presentes, os campos de CheckpointDetails são strings
// Defesa em profundidade: o renderer é confiável em compilação, mas runtime pode receber valores inesperados
function validateDetailsFields(details: unknown): string | null {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) {
    return 'details deve ser um objeto'
  }
  const d = details as Record<string, unknown>
  if (d.instructions !== undefined && typeof d.instructions !== 'string') {
    return 'instructions deve ser uma string quando presente'
  }
  if (d.agentSummary !== undefined && typeof d.agentSummary !== 'string') {
    return 'agentSummary deve ser uma string quando presente'
  }
  return null
}

export function registerCheckpointHandlers(checkpointService: CheckpointService, actionLogPort: ActionLogPort): void {
  /**
   * checkpoint:create — Cria um novo checkpoint do repositório.
   * Parâmetros: repoPath, name, details? (CheckpointDetails opcional)
   * Retorna: { success, data?: CheckpointData, error?: string }
   */
  ipcMain.handle('checkpoint:create', async (_event, repoPath: string, name: string, details?: CheckpointDetails) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidPath(name)) {
        return { success: false, error: 'name é obrigatório e não pode ser vazio' }
      }
      if (details !== undefined) {
        const fieldError = validateDetailsFields(details)
        if (fieldError) {
          return { success: false, error: fieldError }
        }
      }

      const data = await checkpointService.createCheckpoint(repoPath, name, details)

      try {
        actionLogPort.insertAction({
          actionType: 'checkpoint_created',
          timestamp: Date.now(),
          checkpointId: data.id,
          checkpointName: name,
          repoPath
        })
      } catch (err) {
        console.error('[CheckpointHandler] Falha ao logar ação no DB:', err)
      }

      return { success: true, data }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao criar checkpoint:', error)
      return { success: false, error: error.message || 'Erro ao criar checkpoint' }
    }
  })

  /**
   * checkpoint:list — Lista todos os checkpoints do repositório.
   * Parâmetros: repoPath
   * Retorna: { success, data?: CheckpointSummary[], error?: string }
   */
  ipcMain.handle('checkpoint:list', async (_event, repoPath: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }

      const data = await checkpointService.listCheckpoints(repoPath)
      return { success: true, data }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao listar checkpoints:', error)
      return { success: false, error: error.message || 'Erro ao listar checkpoints' }
    }
  })

  /**
   * checkpoint:load — Carrega um checkpoint específico pelo ID.
   * Parâmetros: repoPath, checkpointId
   * Retorna: { success, data?: CheckpointData | null, error?: string }
   */
  ipcMain.handle('checkpoint:load', async (_event, repoPath: string, checkpointId: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidCheckpointId(checkpointId)) {
        return { success: false, error: 'checkpointId contém caracteres inválidos' }
      }

      const data = await checkpointService.loadCheckpoint(repoPath, checkpointId)
      return { success: true, data }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao carregar checkpoint:', error)
      return { success: false, error: error.message || 'Erro ao carregar checkpoint' }
    }
  })

  /**
   * checkpoint:delete — Deleta um checkpoint específico.
   * Parâmetros: repoPath, checkpointId
   * Retorna: { success: boolean }
   */
  ipcMain.handle('checkpoint:delete', async (_event, repoPath: string, checkpointId: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidCheckpointId(checkpointId)) {
        return { success: false, error: 'checkpointId contém caracteres inválidos' }
      }

      let cpName = checkpointId
      try {
        const cp = await checkpointService.loadCheckpoint(repoPath, checkpointId)
        if (cp) cpName = cp.name
      } catch (_) {}

      const deleted = await checkpointService.deleteCheckpoint(repoPath, checkpointId)

      if (deleted) {
        try {
          actionLogPort.insertAction({
            actionType: 'checkpoint_deleted',
            timestamp: Date.now(),
            checkpointId,
            checkpointName: cpName,
            repoPath
          })
        } catch (err) {
          console.error('[CheckpointHandler] Falha ao logar ação no DB:', err)
        }
      }

      return { success: deleted }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao deletar checkpoint:', error)
      return { success: false, error: error.message || 'Erro ao deletar checkpoint' }
    }
  })

  /**
   * checkpoint:generate-diff — Gera diff semântico entre dois checkpoints.
   * Parâmetros: repoPath, fromCheckpointId, toCheckpointId (obrigatório)
   * Retorna: { success: boolean, data?: string, error?: string }
   */
  ipcMain.handle('checkpoint:generate-diff', async (_event, repoPath: string, fromCheckpointId: string, toCheckpointId: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidCheckpointId(fromCheckpointId)) {
        return { success: false, error: 'fromCheckpointId contém caracteres inválidos' }
      }
      if (!isValidCheckpointId(toCheckpointId)) {
        return { success: false, error: 'toCheckpointId contém caracteres inválidos' }
      }

      const markdown = await checkpointService.generateDiffBetween(
        repoPath,
        fromCheckpointId,
        toCheckpointId
      )
      return { success: true, data: markdown }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao gerar diff:', error)
      return { success: false, error: error.message || 'Erro ao gerar diff entre checkpoints' }
    }
  })

  /**
   * checkpoint:get-changed-files — Retorna lista de arquivos alterados entre checkpoints.
   * Parâmetros: repoPath, fromCheckpointId, toCheckpointId (obrigatório)
   * Retorna: { success: boolean, data?: CheckpointDiffFile[], error?: string }
   */
  ipcMain.handle('checkpoint:get-changed-files', async (_event, repoPath: string, fromCheckpointId: string, toCheckpointId: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidCheckpointId(fromCheckpointId)) {
        return { success: false, error: 'fromCheckpointId contém caracteres inválidos' }
      }
      if (!isValidCheckpointId(toCheckpointId)) {
        return { success: false, error: 'toCheckpointId contém caracteres inválidos' }
      }

      const changedFiles = await checkpointService.getChangedFiles(
        repoPath,
        fromCheckpointId,
        toCheckpointId
      )
      return { success: true, data: changedFiles }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao obter changed files:', error)
      return { success: false, error: error.message || 'Erro ao obter arquivos alterados' }
    }
  })

  /**
   * checkpoint:update-details — Atualiza metadados editáveis de um checkpoint.
   * Parâmetros: repoPath, checkpointId, details (CheckpointDetails)
   * Retorna: { success: boolean, error?: string }
   */
  ipcMain.handle('checkpoint:update-details', async (_event, repoPath: string, checkpointId: string, details: CheckpointDetails) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidCheckpointId(checkpointId)) {
        return { success: false, error: 'checkpointId contém caracteres inválidos' }
      }
      const fieldError = validateDetailsFields(details)
      if (fieldError) {
        return { success: false, error: fieldError }
      }

      const success = await checkpointService.updateCheckpointMetadata(repoPath, checkpointId, {
        instructions: details.instructions,
        agentSummary: details.agentSummary
      })

      if (success) {
        return { success: true }
      } else {
        return { success: false, error: 'Checkpoint não encontrado' }
      }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao atualizar detalhes do checkpoint:', error)
      return { success: false, error: error.message || 'Erro ao atualizar detalhes do checkpoint' }
    }
  })

  /**
   * checkpoint:set-campaigns — Define as campanhas vinculadas a um checkpoint.
   * Parâmetros: repoPath, checkpointId, campaignIds (string[])
   * Retorna: { success: boolean, error?: string }
   */
  ipcMain.handle('checkpoint:set-campaigns', async (_event, repoPath: string, checkpointId: string, campaignIds: string[]) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidCheckpointId(checkpointId)) {
        return { success: false, error: 'checkpointId contém caracteres inválidos' }
      }
      if (!Array.isArray(campaignIds)) {
        return { success: false, error: 'campaignIds deve ser um array de strings não vazias' }
      }
      for (const id of campaignIds) {
        if (typeof id !== 'string' || id.trim().length === 0) {
          return { success: false, error: 'campaignIds deve ser um array de strings não vazias' }
        }
      }

      const success = await checkpointService.setCheckpointCampaigns(repoPath, checkpointId, campaignIds)

      if (success) {
        return { success: true }
      } else {
        return { success: false, error: 'Checkpoint não encontrado' }
      }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao definir vínculos de campanha:', error)
      return { success: false, error: error.message || 'Erro ao definir vínculos de campanha' }
    }
  })

  /**
   * checkpoint:rename — Renomeia um checkpoint existente.
   * Parâmetros: repoPath, checkpointId, newName
   * Retorna: { success: boolean, error?: string }
   */
  ipcMain.handle('checkpoint:rename', async (_event, repoPath: string, checkpointId: string, newName: string) => {
    try {
      if (!isValidPath(repoPath)) {
        return { success: false, error: 'repoPath é obrigatório e não pode ser vazio' }
      }
      if (!isValidCheckpointId(checkpointId)) {
        return { success: false, error: 'checkpointId contém caracteres inválidos' }
      }
      if (!newName || newName.trim().length === 0) {
        return { success: false, error: 'O novo nome não pode estar vazio' }
      }

      let oldName = checkpointId
      try {
        const cp = await checkpointService.loadCheckpoint(repoPath, checkpointId)
        if (cp) oldName = cp.name
      } catch (_) {}

      const success = await checkpointService.renameCheckpoint(repoPath, checkpointId, newName)

      if (success) {
        try {
          actionLogPort.insertAction({
            actionType: 'checkpoint_renamed',
            timestamp: Date.now(),
            checkpointId,
            checkpointName: newName,
            details: `Renomeado de ${oldName} para ${newName}`,
            repoPath
          })
        } catch (err) {
          console.error('[CheckpointHandler] Falha ao logar ação no DB:', err)
        }

        return { success: true }
      } else {
        return { success: false, error: 'Checkpoint não encontrado' }
      }
    } catch (error: any) {
      console.error('[CheckpointHandler] Erro ao renomear checkpoint:', error)
      return { success: false, error: error.message || 'Erro ao renomear checkpoint' }
    }
  })
}